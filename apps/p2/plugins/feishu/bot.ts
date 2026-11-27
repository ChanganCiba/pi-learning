// One Feishu bot (server, part of `FeishuStore`'s fleet): an app's long connection and API client, its status (the
// bot's identity, live), the messages it receives handed to its owner, and the direct chats it has seen (a direct chat
// cannot be listed: the person must write first). Behind `FeishuPort`, what the relay uses (tests give it a fake).
import { type ApiMessage, chatTypeOf, FeishuApi } from "./api.ts";
import { Connection } from "./connection.ts";
import type { BotStatus, Chat } from "./contract.ts";
import type { FeishuMessage, FeishuPort } from "./relay.ts";

/** Feishu's API origin. */
export const FEISHU_DOMAIN = "https://open.feishu.cn";

/** What a bot hands its fleet: a message it received, or that it (re)connected and may have missed some. */
export type BotEvent = { kind: "message"; message: FeishuMessage } | { kind: "ready" };

/** Direct chats remembered per bot (the most recent ones). */
const SEEN_CHATS = 50;

export class Bot implements FeishuPort {
	status: BotStatus = { state: "connecting" };
	#api: FeishuApi | undefined;
	#connection: Connection | undefined;
	#openId = "";
	readonly #listeners = new Set<() => void>();
	readonly #onEvent: (event: BotEvent) => void;
	readonly #report: (error: string) => void;
	/** Direct chats that wrote to the bot, newest last: their IDs and the person's name. */
	readonly #seen = new Map<string, string>();
	/** People's names by open ID, as the contact API gave them (or a mention did). */
	readonly #names = new Map<string, string>();

	/** A bot that hands what it receives (never its own messages) and each (re)connection to `onEvent`. */
	constructor(onEvent: (event: BotEvent) => void, report: (error: string) => void) {
		this.#onEvent = onEvent;
		this.#report = report;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#set(status: BotStatus): void {
		this.status = status;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Whether the long connection is up. */
	get connected(): boolean {
		return this.status.state === "connected" && (this.#connection?.open ?? false);
	}

	/**
	 * Connects with the app's credentials, replacing a connection: its status once Feishu accepted or refused them. A
	 * connection that drops is made again by itself.
	 */
	async connect(appId: string, appSecret: string): Promise<BotStatus> {
		this.#connection?.close();
		this.#set({ state: "connecting" });
		const api = new FeishuApi(FEISHU_DOMAIN, appId, appSecret);
		let identity: Awaited<ReturnType<FeishuApi["bot"]>>;
		try {
			identity = await api.bot();
		} catch (error) {
			this.#set({ state: "error", error: error instanceof Error ? error.message : String(error) });
			return this.status;
		}
		const connection = new Connection({
			appId,
			appSecret,
			domain: FEISHU_DOMAIN,
			onEvent: (event) => {
				if (this.#connection !== connection) return;
				if (event.kind === "ready") this.#onEvent({ kind: "ready" });
				else void this.#event(event.body);
			},
			onError: (error, terminal) => {
				if (this.#connection !== connection) return;
				if (terminal) this.#set({ state: "error", error });
				else this.#report(error);
			},
		});
		this.#api = api;
		this.#connection = connection;
		this.#openId = identity.openId;
		const started = await connection.start();
		if (this.#connection !== connection) return this.status;
		if (!started.ok && started.terminal) {
			this.#set({ state: "error", error: started.error });
			return this.status;
		}
		this.#set({
			state: "connected",
			name: identity.name,
			appId,
			openId: identity.openId,
			...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
		});
		return this.status;
	}

	close(): void {
		this.#connection?.close();
		this.#connection = undefined;
		this.#api = undefined;
	}

	#client(): FeishuApi {
		if (!this.#api || this.status.state !== "connected") throw new Error("The Feishu bot is not connected");
		return this.#api;
	}

	get botId(): string {
		return this.#openId;
	}

	/** The chats the bot can be linked to: its groups, then the direct chats it has seen. */
	async chats(): Promise<Chat[]> {
		const groups = (await this.#client().groups()).map((group) => ({ ...group, type: "group" as const }));
		const direct = [...this.#seen].reverse().map(([id, name]) => ({ id, name, type: "p2p" as const }));
		return [...groups.sort((a, b) => a.name.localeCompare(b.name)), ...direct];
	}

	/** A chat's name and type: a group's from Feishu, a direct chat's the person's. */
	async chat(id: string): Promise<Chat> {
		const seen = this.#seen.get(id);
		if (seen !== undefined) return { id, name: seen, type: "p2p" };
		const name = await this.#client().groupName(id);
		if (name === undefined)
			throw new Error("No such chat: the bot must be in the group, or the person must write to it first");
		return { id, name, type: "group" };
	}

	async messages(chatId: string, afterMs: number, next?: string) {
		const page = await this.#client().messages(chatId, afterMs, next);
		const chatType = this.#seen.has(chatId) ? "p2p" : "group";
		const items: FeishuMessage[] = [];
		for (const item of page.items) items.push(await this.#message(item, chatType));
		return { items, next: page.next };
	}

	async reply(
		chatId: string,
		messageId: string | undefined,
		text: string,
		files: readonly { name: string; data: Uint8Array }[] = [],
	): Promise<void> {
		const api = this.#client();
		if (text) await api.sendText(chatId, messageId, text);
		for (const file of files) await api.sendFile(chatId, messageId, file);
	}

	async resource(messageId: string, key: string, type: "image" | "file") {
		const api = this.#client();
		return { url: api.resourceUrl(messageId, key, type), headers: await api.authorization() };
	}

	/** An event of the long connection (a trust boundary: Feishu's JSON): a received message is handed on. */
	async #event(body: unknown): Promise<void> {
		const event = body as {
			header?: { event_type?: string };
			event?: {
				sender?: { sender_id?: { open_id?: string }; sender_type?: string };
				message?: {
					message_id?: string;
					chat_id?: string;
					chat_type?: string;
					create_time?: string;
					message_type?: string;
					content?: string;
					mentions?: { key?: string; id?: { open_id?: string }; name?: string }[];
				};
			};
		};
		if (event.header?.event_type !== "im.message.receive_v1") return;
		const raw = event.event?.message;
		if (!raw?.message_id || !raw.chat_id) return;
		const sender = event.event?.sender;
		const item: ApiMessage = {
			messageId: raw.message_id,
			chatId: raw.chat_id,
			createdAt: Number(raw.create_time ?? Date.now()),
			senderId: sender?.sender_id?.open_id ?? "",
			senderType: sender?.sender_type ?? "user",
			msgType: raw.message_type ?? "text",
			content: raw.content ?? "",
			mentions: (raw.mentions ?? []).flatMap((mention) =>
				mention.key && mention.id?.open_id
					? [{ key: mention.key, openId: mention.id.open_id, name: mention.name ?? "" }]
					: [],
			),
		};
		const chatType = chatTypeOf(raw.chat_type);
		const message = await this.#message(item, chatType);
		if (chatType === "p2p" && message.author.id !== this.#openId) {
			this.#seen.delete(raw.chat_id);
			this.#seen.set(raw.chat_id, message.author.name);
			if (this.#seen.size > SEEN_CHATS) this.#seen.delete(this.#seen.keys().next().value as string);
		}
		this.#onEvent({ kind: "message", message });
	}

	/** An API message as the relay reads it: its text from its content, its author named, its attachments. */
	async #message(item: ApiMessage, chatType: FeishuMessage["chatType"]): Promise<FeishuMessage> {
		for (const mention of item.mentions) if (mention.name) this.#names.set(mention.openId, mention.name);
		const parsed = parseContent(item.msgType, item.content, item.mentions, this.#openId);
		return {
			id: item.messageId,
			chatId: item.chatId,
			chatType,
			createdAt: item.createdAt,
			author: { id: item.senderId, name: await this.#name(item.senderId, item.senderType) },
			text: parsed.text,
			mentionsBot: item.mentions.some((mention) => mention.openId === this.#openId),
			attachments: parsed.attachments,
		};
	}

	/** A sender's name: from a mention or the contact API, cached; else a short form of the open ID. */
	async #name(openId: string, senderType: string): Promise<string> {
		if (openId === this.#openId) return this.status.state === "connected" ? this.status.name : "Pi";
		const known = this.#names.get(openId);
		if (known !== undefined) return known;
		if (senderType !== "user") return `app ${openId.slice(-6)}`;
		const name = (await this.#api?.userName(openId)) ?? `user ${openId.slice(-6)}`;
		this.#names.set(openId, name);
		return name;
	}
}

/**
 * A message's text and attachments from Feishu's content JSON: `text` as written (its mention keys replaced by names,
 * the bot's by `@Pi`), `post` flattened to lines, an image or a file as one attachment; other kinds named.
 */
export function parseContent(
	msgType: string,
	content: string,
	mentions: readonly { key: string; openId: string; name: string }[],
	botId: string,
): { text: string; attachments: FeishuMessage["attachments"] } {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return { text: content, attachments: [] };
	}
	const body = (value ?? {}) as Record<string, unknown>;
	const named = (text: string) => {
		let out = text;
		for (const mention of mentions)
			out = out.replaceAll(mention.key, mention.openId === botId ? "@Pi" : `@${mention.name || mention.openId}`);
		return out.trim();
	};
	switch (msgType) {
		case "text":
			return { text: named(typeof body.text === "string" ? body.text : ""), attachments: [] };
		case "post": {
			const lines: string[] = [];
			if (typeof body.title === "string" && body.title) lines.push(body.title);
			const paragraphs = Array.isArray(body.content) ? body.content : [];
			for (const paragraph of paragraphs) {
				if (!Array.isArray(paragraph)) continue;
				lines.push(
					paragraph
						.map((part: Record<string, unknown>) => {
							if (part.tag === "text" || part.tag === "a") return String(part.text ?? "");
							if (part.tag === "at")
								return part.user_id === botId ? "@Pi" : `@${String(part.user_name ?? part.user_id ?? "")}`;
							if (part.tag === "img") return "[image]";
							return "";
						})
						.join(""),
				);
			}
			return { text: named(lines.join("\n")), attachments: [] };
		}
		case "image":
			return {
				text: "",
				attachments:
					typeof body.image_key === "string"
						? [{ key: body.image_key, name: `${body.image_key}.png`, size: 0, type: "image" }]
						: [],
			};
		case "file":
			return {
				text: "",
				attachments:
					typeof body.file_key === "string"
						? [
								{
									key: body.file_key,
									name: typeof body.file_name === "string" ? body.file_name : body.file_key,
									size: 0,
									type: "file",
								},
							]
						: [],
			};
		default:
			return { text: `[${msgType} message]`, attachments: [] };
	}
}
