// Feishu's long connection for event subscriptions (server): the app asks `/callback/ws/endpoint` for a WebSocket URL,
// connects, pings on the interval the endpoint names, and gets each subscribed event as a protobuf frame (`pbbp2.Frame`,
// possibly in several fragments) that it acknowledges in the same frame with `{"code":200}`. Written against the
// official Node SDK's client (its wire format is this file's codec), with `ws` as every host package has it.
import WebSocket from "ws";

/** A frame of the connection (the SDK's `pbbp2.Frame`; `service` and `method` as it numbers them). */
export type Frame = {
	seqId: bigint;
	logId: bigint;
	service: number;
	method: number;
	headers: { key: string; value: string }[];
	payloadEncoding?: string;
	payloadType?: string;
	payload?: Uint8Array;
	logIdNew?: string;
};

/** `method` of a control frame (ping, pong) and of a data frame (an event). */
const CONTROL = 0;
const DATA = 1;

/** What the connection reports: an event (its JSON body as Feishu sent it), or that it (re)connected. */
export type ConnectionEvent = { kind: "event"; body: unknown } | { kind: "ready" };

export type ConnectionOptions = {
	appId: string;
	appSecret: string;
	/** Feishu's API origin (Lark international: `https://open.larksuite.com`). */
	domain: string;
	onEvent: (event: ConnectionEvent) => void;
	/** A failure of the connection (a refused app: terminal; otherwise it reconnects). */
	onError: (error: string, terminal: boolean) => void;
};

/** What the endpoint answers besides the URL (seconds). */
type ClientConfig = { PingInterval: number; ReconnectCount: number; ReconnectInterval: number; ReconnectNonce: number };

/** Fragments of one event are kept this long at most. */
const FRAGMENT_TTL_MS = 10_000;

/** One app's long connection, reconnecting until closed. */
export class Connection {
	readonly #options: ConnectionOptions;
	#socket: WebSocket | undefined;
	#serviceId = 0;
	#config: ClientConfig = { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 };
	#ping: ReturnType<typeof setTimeout> | undefined;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#attempts = 0;
	#closed = false;
	/** Fragments of events by message ID, until all arrived. */
	readonly #fragments = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>();

	constructor(options: ConnectionOptions) {
		this.#options = options;
	}

	/** Whether the socket is open now. */
	get open(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** Connects; resolves once the first connection is up, or with the reason it could not be made (terminal or not). */
	async start(): Promise<{ ok: true } | { ok: false; error: string; terminal: boolean }> {
		const result = await this.#connect();
		if (!result.ok && !result.terminal) this.#scheduleRetry();
		return result;
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#ping);
		clearTimeout(this.#retry);
		const socket = this.#socket;
		this.#socket = undefined;
		if (socket) {
			socket.removeAllListeners();
			// `ws` reports the abort of a closing socket as an error on a later tick: a sink keeps it from throwing.
			socket.on("error", () => {});
			socket.terminate();
		}
	}

	async #connect(): Promise<{ ok: true } | { ok: false; error: string; terminal: boolean }> {
		if (this.#closed) return { ok: false, error: "closed", terminal: true };
		let endpoint: { url: string; config: ClientConfig };
		try {
			endpoint = await this.#endpoint();
		} catch (error) {
			const terminal = error instanceof Refused;
			return { ok: false, error: error instanceof Error ? error.message : String(error), terminal };
		}
		if (this.#closed) return { ok: false, error: "closed", terminal: true };
		this.#config = endpoint.config;
		this.#serviceId = Number(new URL(endpoint.url).searchParams.get("service_id") ?? "0");
		const socket = new WebSocket(endpoint.url);
		const opened = await new Promise<string | undefined>((resolve) => {
			socket.once("open", () => resolve(undefined));
			socket.once("error", (error) => resolve(error.message));
			setTimeout(() => resolve("the connection timed out"), 30_000).unref();
		});
		if (opened !== undefined || this.#closed) {
			socket.removeAllListeners();
			socket.on("error", () => {});
			socket.terminate();
			return { ok: false, error: opened ?? "closed", terminal: this.#closed };
		}
		this.#socket = socket;
		this.#attempts = 0;
		socket.on("message", (data) => this.#receive(data));
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			clearTimeout(this.#ping);
			if (!this.#closed) this.#scheduleRetry();
		});
		this.#pingLoop();
		// Every connection may have missed events (the first one: while the server was down).
		this.#options.onEvent({ kind: "ready" });
		return { ok: true };
	}

	/** The WebSocket URL and the connection's parameters, from Feishu's endpoint; `Refused` when the app is wrong. */
	async #endpoint(): Promise<{ url: string; config: ClientConfig }> {
		const response = await fetch(`${this.#options.domain}/callback/ws/endpoint`, {
			method: "POST",
			headers: { "content-type": "application/json", locale: "zh" },
			body: JSON.stringify({ AppID: this.#options.appId, AppSecret: this.#options.appSecret }),
			signal: AbortSignal.timeout(15_000),
		});
		// Trust boundary: Feishu's answer.
		const answer = (await response.json()) as {
			code?: number;
			msg?: string;
			data?: { URL?: string; ClientConfig?: Partial<ClientConfig> };
		};
		if (answer.code !== 0) {
			const message = `Feishu refused the connection: ${answer.msg ?? `code ${answer.code}`}`;
			// 1000040343: an internal error, worth trying again; everything else names the app or its permissions.
			if (answer.code === 1000040343) throw new Error(message);
			throw new Refused(message);
		}
		const url = answer.data?.URL;
		if (!url) throw new Error("Feishu's endpoint named no URL");
		const given = answer.data?.ClientConfig ?? {};
		return {
			url,
			config: {
				PingInterval: given.PingInterval ?? 120,
				ReconnectCount: given.ReconnectCount ?? -1,
				ReconnectInterval: given.ReconnectInterval ?? 120,
				ReconnectNonce: given.ReconnectNonce ?? 30,
			},
		};
	}

	#scheduleRetry(): void {
		if (this.#closed) return;
		const { ReconnectCount, ReconnectInterval, ReconnectNonce } = this.#config;
		if (ReconnectCount >= 0 && this.#attempts >= ReconnectCount) {
			this.#options.onError(`gave up after ${this.#attempts} reconnection attempts`, true);
			return;
		}
		// The first retry after a nonce (the server's jitter), the next ones on the interval.
		const delay = this.#attempts === 0 ? Math.random() * ReconnectNonce * 1000 : ReconnectInterval * 1000;
		this.#attempts++;
		clearTimeout(this.#retry);
		this.#retry = setTimeout(() => {
			void this.#connect().then((result) => {
				if (result.ok) return;
				this.#options.onError(result.error, result.terminal);
				if (!result.terminal) this.#scheduleRetry();
			});
		}, delay);
	}

	#pingLoop(): void {
		clearTimeout(this.#ping);
		if (this.open)
			this.#send({
				seqId: 0n,
				logId: 0n,
				service: this.#serviceId,
				method: CONTROL,
				headers: [{ key: "type", value: "ping" }],
			});
		this.#ping = setTimeout(() => this.#pingLoop(), this.#config.PingInterval * 1000);
	}

	#receive(data: WebSocket.RawData): void {
		const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
		let frame: Frame;
		try {
			frame = decodeFrame(bytes);
		} catch (error) {
			this.#options.onError(`an undecodable frame: ${error instanceof Error ? error.message : error}`, false);
			return;
		}
		const headers = Object.fromEntries(frame.headers.map(({ key, value }) => [key, value]));
		if (frame.method === CONTROL) {
			if (headers.type === "pong" && frame.payload) this.#pong(frame.payload);
			return;
		}
		if (frame.method !== DATA || headers.type !== "event" || !frame.payload) return;
		const body = this.#assemble(headers, frame.payload);
		if (body === undefined) return;
		// Acknowledged at once: the work it starts is the owner's (a delivery); a slow ack makes Feishu resend.
		this.#send({
			...frame,
			headers: [...frame.headers, { key: "biz_rt", value: "0" }],
			payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
		});
		this.#options.onEvent({ kind: "event", body });
	}

	/** A pong's payload: the connection's parameters, which Feishu may change. */
	#pong(payload: Uint8Array): void {
		try {
			const given = JSON.parse(new TextDecoder().decode(payload)) as Partial<ClientConfig>;
			this.#config = { ...this.#config, ...given };
		} catch {
			// A pong Feishu did not write as JSON changes nothing.
		}
	}

	/** The event once every fragment of it arrived (`sum` parts, this one `seq`), parsed; undefined before. */
	#assemble(headers: Record<string, string>, payload: Uint8Array): unknown {
		const sum = Number(headers.sum ?? "1");
		const seq = Number(headers.seq ?? "0");
		const id = headers.message_id ?? "";
		if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) return undefined;
		const now = Date.now();
		for (const [key, entry] of this.#fragments) if (now - entry.at > FRAGMENT_TTL_MS) this.#fragments.delete(key);
		let entry = this.#fragments.get(id);
		if (!entry || entry.parts.length !== sum) {
			entry = { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: now };
			this.#fragments.set(id, entry);
		}
		entry.parts[seq] = payload;
		if (!entry.parts.every((part) => part !== undefined)) return undefined;
		this.#fragments.delete(id);
		const whole = Buffer.concat(entry.parts as Uint8Array[]);
		try {
			return JSON.parse(new TextDecoder().decode(whole));
		} catch {
			this.#options.onError("an event that is not JSON", false);
			return undefined;
		}
	}

	#send(frame: Frame): void {
		if (this.open) this.#socket?.send(encodeFrame(frame));
	}
}

/** Feishu refused the app (its ID, secret or permissions): no retry helps. */
class Refused extends Error {}

/*
 * The frame's protobuf encoding, by hand: five varint and string fields, one repeated message. Field numbers as the
 * SDK's `pbbp2.proto`: 1 SeqID (uint64), 2 LogID (uint64), 3 service (int32), 4 method (int32), 5 headers (Header:
 * 1 key, 2 value), 6 payload_encoding, 7 payload_type, 8 payload (bytes), 9 LogIDNew.
 */

/** `frame` as the connection sends it. */
export function encodeFrame(frame: Frame): Uint8Array {
	const out = new ByteWriter();
	out.varint(8).uvarint(frame.seqId);
	out.varint(16).uvarint(frame.logId);
	out.varint(24).int32(frame.service);
	out.varint(32).int32(frame.method);
	for (const header of frame.headers) {
		const inner = new ByteWriter();
		inner.varint(10).string(header.key);
		inner.varint(18).string(header.value);
		out.varint(42).bytes(inner.finish());
	}
	if (frame.payloadEncoding !== undefined) out.varint(50).string(frame.payloadEncoding);
	if (frame.payloadType !== undefined) out.varint(58).string(frame.payloadType);
	if (frame.payload !== undefined) out.varint(66).bytes(frame.payload);
	if (frame.logIdNew !== undefined) out.varint(74).string(frame.logIdNew);
	return out.finish();
}

/** The frame `bytes` encode; throws on malformed input (a trust boundary: the wire). */
export function decodeFrame(bytes: Uint8Array): Frame {
	const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] };
	const reader = new ByteReader(bytes);
	while (!reader.done) {
		const tag = reader.uvarint();
		const field = Number(tag >> 3n);
		const wire = Number(tag & 7n);
		switch (field) {
			case 1:
				frame.seqId = reader.uvarint();
				break;
			case 2:
				frame.logId = reader.uvarint();
				break;
			case 3:
				frame.service = Number(BigInt.asIntN(32, reader.uvarint()));
				break;
			case 4:
				frame.method = Number(BigInt.asIntN(32, reader.uvarint()));
				break;
			case 5: {
				const inner = new ByteReader(reader.bytes());
				const header = { key: "", value: "" };
				while (!inner.done) {
					const innerTag = inner.uvarint();
					const innerField = Number(innerTag >> 3n);
					if (innerField === 1) header.key = inner.string();
					else if (innerField === 2) header.value = inner.string();
					else inner.skip(Number(innerTag & 7n));
				}
				frame.headers.push(header);
				break;
			}
			case 6:
				frame.payloadEncoding = reader.string();
				break;
			case 7:
				frame.payloadType = reader.string();
				break;
			case 8:
				frame.payload = reader.bytes();
				break;
			case 9:
				frame.logIdNew = reader.string();
				break;
			default:
				reader.skip(wire);
		}
	}
	return frame;
}

class ByteWriter {
	#parts: number[] = [];

	varint(value: number): this {
		return this.uvarint(BigInt(value));
	}

	uvarint(value: bigint): this {
		let rest = value;
		while (rest >= 0x80n) {
			this.#parts.push(Number(rest & 0x7fn) | 0x80);
			rest >>= 7n;
		}
		this.#parts.push(Number(rest));
		return this;
	}

	/** A negative int32 is ten bytes on the wire, as protobuf writes it. */
	int32(value: number): this {
		return this.uvarint(BigInt.asUintN(64, BigInt(value)));
	}

	bytes(value: Uint8Array): this {
		this.varint(value.length);
		for (const byte of value) this.#parts.push(byte);
		return this;
	}

	string(value: string): this {
		return this.bytes(new TextEncoder().encode(value));
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.#parts);
	}
}

class ByteReader {
	readonly #bytes: Uint8Array;
	#at = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	get done(): boolean {
		return this.#at >= this.#bytes.length;
	}

	uvarint(): bigint {
		let value = 0n;
		let shift = 0n;
		for (;;) {
			const byte = this.#bytes[this.#at++];
			if (byte === undefined) throw new Error("truncated varint");
			value |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7n;
			if (shift > 63n) throw new Error("varint too long");
		}
	}

	bytes(): Uint8Array {
		const length = Number(this.uvarint());
		if (this.#at + length > this.#bytes.length) throw new Error("truncated bytes");
		const value = this.#bytes.subarray(this.#at, this.#at + length);
		this.#at += length;
		return value;
	}

	string(): string {
		return new TextDecoder().decode(this.bytes());
	}

	/** Past a field of wire type `wire` this codec does not keep. */
	skip(wire: number): void {
		if (wire === 0) this.uvarint();
		else if (wire === 1) this.#at += 8;
		else if (wire === 2) this.bytes();
		else if (wire === 5) this.#at += 4;
		else throw new Error(`unsupported wire type ${wire}`);
	}
}
