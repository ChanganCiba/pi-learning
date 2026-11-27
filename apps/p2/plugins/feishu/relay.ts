// What happens between a Feishu chat and its linked session (server): a message by someone allowed to wake Pi (in a
// group, a mention of the bot; in a direct chat, any message), seen by the link's bot, delivers the messages since the
// link's cursor as one input; a pending reply is posted once its turn ended. Plain logic over ports, so tests run it
// with fake bots and sessions.
import type { Binding, ChatType, OfferedFile, Pending, Wake } from "./contract.ts";

/** A Feishu message as the relay reads it. */
export type FeishuMessage = {
	id: string;
	chatId: string;
	chatType: ChatType;
	/** Feishu's creation time (ms): the chat's order, and the link's cursor. */
	createdAt: number;
	author: { id: string; name: string };
	text: string;
	mentionsBot: boolean;
	attachments: readonly { key: string; name: string; size: number; type: "image" | "file" }[];
};

/** What the relay needs of Feishu. */
export type FeishuPort = {
	readonly botId: string;
	/** The messages of `chatId` created after `afterMs`, oldest first, page by page (`next` continues). */
	messages(
		chatId: string,
		afterMs: number,
		next?: string,
	): Promise<{ items: FeishuMessage[]; next: string | undefined }>;
	/** Reacts to a message (the wake's acknowledgment). */
	react(messageId: string, emojiType: string): Promise<void>;
	/** Posts the grey "thinking" card as the reply to `messageId`: its ID, to settle when the turn ends. */
	notice(chatId: string, messageId: string): Promise<string>;
	/** Patches notice `noticeId` into the turn's outcome (the first card of the answer). */
	settle(noticeId: string, outcome: "green" | "red", text: string): Promise<void>;
	/** Posts `text` (may be empty with files), then each file, as replies to `messageId` when given. */
	reply(
		chatId: string,
		messageId: string | undefined,
		text: string,
		files?: readonly { name: string; data: Uint8Array }[],
	): Promise<void>;
	/** Where attachment `key` of message `messageId` is downloaded from, with the headers the download needs. */
	resource(
		messageId: string,
		key: string,
		type: "image" | "file",
	): Promise<{ url: string; headers: { Authorization: string } }>;
};

export type TurnState =
	| { state: "pending" }
	| { state: "answered"; text: string; thinking?: string; files: OfferedFile[]; answer: number }
	| { state: "stopped" }
	| { state: "unanswered"; reason: string; files: OfferedFile[] };

/** A delivered batch's attachment, for the worker to download. */
export type DeliveredFile = {
	url: string;
	headers: { Authorization: string };
	name: string;
	size: number;
	key: string;
	ref: string;
};

/** What the relay needs of a session (its worker's `FeishuIngress`, the catalog). */
export type SessionPort = {
	/** Whether the session exists and is not archived; why not otherwise. */
	usable(session: string): Promise<string | undefined>;
	deliver(
		session: string,
		input: {
			requestId: string;
			author: { id: string; name: string };
			text: string;
			context: { chat: string; chatType: ChatType; messages: number };
			files: DeliveredFile[];
		},
	): Promise<{ conversation: number; submissionId: number }>;
	turn(session: string, submissionId: number): Promise<TurnState>;
	/** `length` bytes (at most 4 MiB) of offered file `id` from `offset`. */
	read(session: string, id: string, offset: number, length: number): Promise<Uint8Array>;
};

/** The relay's persisted state: bindings by chat, pending replies by the message that woke Pi. */
export type RelayState = { bindings: Record<string, Binding>; pending: Record<string, Pending> };

export type StatePort = {
	value(): RelayState;
	change(update: (draft: RelayState) => void): Promise<void>;
};

/** Messages one batch puts into the input at most: the newest; the header counts the earlier ones left out. */
export const BATCH_CAP = 200;
/** One card's Markdown at most (Feishu takes about 30 KB; a shorter card reads better). */
export const MESSAGE_LIMIT = 4000;
/** Attachments up to this size are downloaded into the session; larger ones are named only. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 20;
/** The answer's reasoning is quoted up to this many characters. */
const THINKING_LIMIT = 600;
/** A pending reply older than this is dropped with a notice: its turn is not going to end on its own. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Answers kept in mind as posted, to post a run's answer once however its inputs settle. */
const REMEMBERED_ANSWERS = 200;
/** Bytes one read of an offered file asks for. */
const READ_CHUNK = 4 * 1024 * 1024;
/** Feishu's limit for one file message. */
const UPLOAD_LIMIT = 30 * 1024 * 1024;

export class Relay {
	readonly #feishu: (bot: string) => FeishuPort | undefined;
	/** Pending replies being checked: two checks at once would post one reply twice. */
	readonly #checking = new Set<string>();
	/** Each chat's delivery under way, the next one chained after it: two wakes in quick succession share a cursor. */
	readonly #lanes = new Map<string, Promise<void>>();
	/** Answers posted lately (session and entry): a run's other inputs, settled later, post nothing. */
	readonly #posted: string[] = [];
	readonly #sessions: SessionPort;
	readonly #state: StatePort;
	readonly #report: (error: string) => void;

	/** `feishu`: bot `bot` while it is connected; `report`: a failure worth the log. */
	constructor(
		feishu: (bot: string) => FeishuPort | undefined,
		sessions: SessionPort,
		state: StatePort,
		report: (error: string) => void,
	) {
		this.#feishu = feishu;
		this.#sessions = sessions;
		this.#state = state;
		this.#report = report;
	}

	#port(bot: string): FeishuPort {
		const port = this.#feishu(bot);
		if (!port) throw new Error("The Feishu bot is not connected");
		return port;
	}

	/** A message bot `bot` received: one that wakes Pi in a chat linked through it delivers. */
	async onMessage(bot: string, message: FeishuMessage): Promise<void> {
		const port = this.#port(bot);
		if (message.author.id === port.botId) return;
		const binding = this.#state.value().bindings[message.chatId];
		if (!binding || binding.botId !== bot || !wakes(binding, message)) return;
		await this.deliver(binding.chatId, message);
	}

	/**
	 * Delivers the batch ending at `trigger` to the binding's session, then advances the cursor and records the pending
	 * reply. A session that cannot take it gets a notice instead. One delivery at a time per chat: a later one starts
	 * from the cursor the earlier one left.
	 */
	async deliver(chatId: string, trigger: FeishuMessage): Promise<void> {
		const run = (this.#lanes.get(chatId) ?? Promise.resolve()).then(() => this.#deliver(chatId, trigger));
		// The lane goes on whether this delivery failed or not; the caller still learns it failed.
		const lane = run.catch(() => {});
		this.#lanes.set(chatId, lane);
		try {
			await run;
		} finally {
			if (this.#lanes.get(chatId) === lane) this.#lanes.delete(chatId);
		}
	}

	async #deliver(chatId: string, trigger: FeishuMessage): Promise<void> {
		const binding = this.#state.value().bindings[chatId];
		if (!binding) return;
		const port = this.#port(binding.botId);
		const refusal = await this.#sessions.usable(binding.session);
		if (refusal) return port.reply(chatId, trigger.id, `Pi is not listening here right now: ${refusal}`);
		// Delivered already (a catch-up, then the same message replayed by a reconnection).
		if (binding.cursor !== null && trigger.createdAt <= binding.cursor) return;
		// The wake is acknowledged at once: a reaction on the message, and a grey "thinking" card that the answer
		// patches in place (one bubble start to finish). Best effort: a chat that takes neither still gets the answer.
		await port.react(trigger.id, "OK").catch(() => {});
		let noticeId: string | undefined;
		try {
			noticeId = (await port.notice(chatId, trigger.id)) || undefined;
		} catch {
			// Without the card, the answer arrives as its own reply.
		}
		// Everything since the cursor; only the newest BATCH_CAP go into the input. Without the history permission
		// (im:message.group_msg), the batch is the trigger alone: the wake still works, the gap is reported.
		const window = new BatchWindow(BATCH_CAP);
		try {
			for await (const message of history(port, chatId, binding.cursor, trigger.createdAt))
				if (message.author.id !== port.botId) window.add(message);
		} catch (error) {
			this.#report(
				`reading ${binding.chatName}'s history failed: ${error instanceof Error ? error.message : error}`,
			);
		}
		if (!window.has(trigger.id)) window.add(trigger);
		const plural = (count: number) => `${count} message${count === 1 ? "" : "s"}`;
		const left = window.omitted
			? `; the ${window.omitted} earliest are left out, the newest ${window.kept} follow`
			: "";
		const where =
			binding.chatType === "group" ? `group "${binding.chatName}"` : `direct chat with ${binding.chatName}`;
		const header = `[Feishu ${where}: ${plural(window.total)} since the last delivery${left}]`;
		const batch = await batchOf(window.messages, port, header);
		let delivered: { conversation: number; submissionId: number };
		try {
			delivered = await this.#sessions.deliver(binding.session, {
				requestId: `feishu:${trigger.id}`,
				author: trigger.author,
				text: batch.text,
				context: { chat: binding.chatName, chatType: binding.chatType, messages: window.total },
				files: batch.files,
			});
		} catch (error) {
			await port.reply(
				chatId,
				trigger.id,
				`Could not reach Pi: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		await this.#state.change((draft) => {
			const current = draft.bindings[chatId];
			if (!current) return;
			current.cursor = trigger.createdAt;
			draft.pending[trigger.id] = {
				botId: binding.botId,
				session: binding.session,
				chatId,
				messageId: trigger.id,
				createdAt: trigger.createdAt,
				...(noticeId === undefined ? {} : { noticeId }),
				submissionId: delivered.submissionId,
				since: Date.now(),
			};
		});
	}

	/**
	 * Bot `bot` (re)connected: what it missed. For each of its links, the newest waking message since the cursor
	 * delivers, as if it had just arrived (one delivery each, the messages before it included).
	 */
	async catchUp(bot: string): Promise<void> {
		const port = this.#port(bot);
		for (const binding of Object.values(this.#state.value().bindings)) {
			if (binding.botId !== bot) continue;
			try {
				let newest: FeishuMessage | undefined;
				for await (const message of history(port, binding.chatId, binding.cursor))
					if (message.author.id !== port.botId && wakes(binding, message)) newest = message;
				if (newest) await this.deliver(binding.chatId, newest);
			} catch (error) {
				// A chat that went away (or a session that cannot take it) skips only itself.
				this.#report(`catching up ${binding.chatName} failed: ${error instanceof Error ? error.message : error}`);
			}
		}
	}

	/**
	 * Posts the replies of the turns that ended (`sessions`: only those, when given). Inputs steered into one turn share
	 * its answer: it is posted once, as the reply to the newest of their messages, with the files of the whole turn.
	 */
	async checkPending(sessions?: ReadonlySet<string>): Promise<void> {
		const now = Date.now();
		const settled: { pending: Pending; turn: TurnState }[] = [];
		try {
			for (const pending of Object.values(this.#state.value().pending)) {
				if ((sessions && !sessions.has(pending.session)) || this.#checking.has(pending.messageId)) continue;
				// A bot that is not connected (or was removed) keeps its replies until it is, or they time out.
				if (!this.#feishu(pending.botId) && now - pending.since < PENDING_TIMEOUT_MS) continue;
				this.#checking.add(pending.messageId);
				const turn = await this.#settled(pending, now);
				if (turn) settled.push({ pending, turn });
				else this.#checking.delete(pending.messageId);
			}
			const runs = new Map<string, { pending: Pending; turn: TurnState }[]>();
			for (const entry of settled) {
				const key =
					entry.turn.state === "answered"
						? `${entry.pending.session}:${entry.turn.answer}`
						: entry.pending.messageId;
				runs.set(key, [...(runs.get(key) ?? []), entry]);
			}
			for (const [key, run] of runs) await this.#post(key, run);
		} finally {
			for (const { pending } of settled) this.#checking.delete(pending.messageId);
		}
	}

	/** Pending reply `pending`'s turn once it ended (timed out: unanswered), else undefined. */
	async #settled(pending: Pending, now: number): Promise<TurnState | undefined> {
		let turn: TurnState;
		try {
			turn = await this.#sessions.turn(pending.session, pending.submissionId);
		} catch (error) {
			this.#report(`reading a turn failed: ${error instanceof Error ? error.message : error}`);
			if (now - pending.since < PENDING_TIMEOUT_MS) return undefined;
			return { state: "unanswered", reason: "the session did not answer in time.", files: [] };
		}
		if (turn.state !== "pending") return turn;
		if (now - pending.since < PENDING_TIMEOUT_MS) return undefined;
		return { state: "unanswered", reason: "the session did not answer in time.", files: [] };
	}

	/** Posts one run's reply (`run`: its pending replies, all settled) to the newest message, then drops them all. */
	async #post(key: string, run: readonly { pending: Pending; turn: TurnState }[]): Promise<void> {
		const ordered = [...run].sort((a, b) => a.pending.createdAt - b.pending.createdAt);
		const newest = ordered.at(-1);
		try {
			// A stopped turn posts nothing, nor does an answer posted before (an input of its run settled after the
			// others were checked).
			const turn = newest?.turn;
			if (newest && (turn?.state === "answered" || turn?.state === "unanswered") && !this.#posted.includes(key)) {
				const port = this.#feishu(newest.pending.botId);
				if (!port) throw new Error("its bot is not connected");
				const files = new Map<string, OfferedFile>();
				for (const { turn } of ordered)
					if (turn.state !== "stopped" && turn.state !== "pending")
						for (const file of turn.files) files.set(file.id, file);
				await this.#reply(port, newest.pending, { ...turn, files: [...files.values()] });
				if (turn.state === "answered") this.#remember(key);
			}
		} catch (error) {
			// A chat that went away: the reply is dropped, as Feishu has nowhere to show it.
			this.#report(`posting a reply failed: ${error instanceof Error ? error.message : error}`);
		}
		await this.#state.change((draft) => {
			for (const { pending } of run) delete draft.pending[pending.messageId];
		});
	}

	#remember(key: string): void {
		this.#posted.push(key);
		if (this.#posted.length > REMEMBERED_ANSWERS) this.#posted.shift();
	}

	/**
	 * Posts a finished turn's reply: its text in cards of at most `MESSAGE_LIMIT` characters, the first replying to the
	 * waking message, then the files the turn offered (within Feishu's limit; larger ones named only).
	 */
	async #reply(
		port: FeishuPort,
		pending: Pending,
		turn: Extract<TurnState, { state: "answered" | "unanswered" }>,
	): Promise<void> {
		let text = turn.state === "answered" ? turn.text : `(No answer: ${turn.reason})`;
		// The answer's reasoning, quoted and cut short, above the answer: the chat sees how Pi got there.
		if (turn.state === "answered" && turn.thinking) {
			const short =
				turn.thinking.length > THINKING_LIMIT ? `${turn.thinking.slice(0, THINKING_LIMIT)}…` : turn.thinking;
			text = `${short
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")}\n\n${text}`;
		}
		const tooLarge = turn.files.filter((file) => file.size > UPLOAD_LIMIT);
		if (tooLarge.length)
			text += `${text ? "\n\n" : ""}Too large for Feishu: ${tooLarge.map((file) => `${file.name} (${megabytes(file.size)})`).join(", ")}`;
		const chunks = chunkText(text);
		for (const [index, chunk] of chunks.entries()) {
			// The first chunk becomes the thinking card's content (the one bubble turns into the answer); a card that
			// cannot be patched any more falls back to a reply of its own.
			if (index === 0 && pending.noticeId !== undefined) {
				try {
					await port.settle(pending.noticeId, turn.state === "answered" ? "green" : "red", chunk);
					continue;
				} catch {
					// Fall through to the plain reply.
				}
			}
			await port.reply(pending.chatId, index === 0 ? pending.messageId : undefined, chunk);
		}
		for (const file of turn.files) {
			if (file.size > UPLOAD_LIMIT) continue;
			try {
				const data = await this.#readFile(pending.session, file);
				await port.reply(pending.chatId, chunks.length ? undefined : pending.messageId, "", [
					{ name: file.name, data },
				]);
			} catch (error) {
				this.#report(`sending ${file.name} failed: ${error instanceof Error ? error.message : error}`);
			}
		}
	}

	/** Offered file `file` of `session`, whole. */
	async #readFile(session: string, file: OfferedFile): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (let offset = 0; offset < file.size; ) {
			const part = await this.#sessions.read(session, file.id, offset, Math.min(READ_CHUNK, file.size - offset));
			if (!part.length) break;
			parts.push(part);
			offset += part.length;
		}
		return Buffer.concat(parts);
	}
}

/** Whether `message` wakes `binding`'s session: by someone allowed, and in a group a mention of the bot. */
export function wakes(binding: Binding, message: FeishuMessage): boolean {
	if (!mayWake(binding.wake, message.author.id)) return false;
	return binding.chatType === "p2p" || message.mentionsBot;
}

/** Whether the author of a message may wake Pi in its binding. */
export function mayWake(wake: Wake, author: string): boolean {
	return wake.anyone || wake.users.includes(author);
}

/**
 * The messages of `chat` created after `cursor` (null: everything Feishu still lists), oldest first, page by page;
 * with `until`, up to and with that time.
 */
async function* history(
	port: FeishuPort,
	chat: string,
	cursor: number | null,
	until?: number,
): AsyncGenerator<FeishuMessage> {
	let next: string | undefined;
	do {
		const page = await port.messages(chat, cursor ?? 0, next);
		for (const message of page.items) {
			if (until !== undefined && message.createdAt > until) return;
			yield message;
		}
		next = page.next;
	} while (next !== undefined);
}

/** The newest `cap` messages of a batch in order, and how many there were in all. */
class BatchWindow {
	readonly #cap: number;
	readonly messages: FeishuMessage[] = [];
	total = 0;

	constructor(cap: number) {
		this.#cap = cap;
	}

	add(message: FeishuMessage): void {
		this.total++;
		this.messages.push(message);
		if (this.messages.length > this.#cap) this.messages.shift();
	}

	has(id: string): boolean {
		return this.messages.some((message) => message.id === id);
	}

	get kept(): number {
		return this.messages.length;
	}

	get omitted(): number {
		return this.total - this.kept;
	}
}

/**
 * A batch's text: under the header, one `Name (<open_id>): text` line (or paragraph) per message, oldest first, the
 * bot's mention written `@Pi`, and attachments too large to download named. The attachments to download, keyed by
 * message and position, with where to get them.
 */
export async function batchOf(
	messages: readonly FeishuMessage[],
	port: FeishuPort,
	header: string,
): Promise<{ text: string; files: DeliveredFile[] }> {
	const files: DeliveredFile[] = [];
	const lines: string[] = [];
	for (const message of messages) {
		const notes: string[] = [];
		for (const [index, attachment] of message.attachments.entries()) {
			if (attachment.size <= MAX_ATTACHMENT && files.length < MAX_FILES) {
				const { url, headers } = await port.resource(message.id, attachment.key, attachment.type);
				files.push({
					url,
					headers,
					name: attachment.name,
					size: attachment.size,
					key: `feishu:${message.id}:${index}`,
					ref: message.id,
				});
			} else notes.push(`[attachment ${attachment.name} (${attachment.size} bytes), not downloaded]`);
		}
		// A group names authors with their open IDs (several people, and wake lists take the IDs); a direct chat has
		// one person: the name alone.
		const who =
			message.chatType === "group" ? `${message.author.name} (<${message.author.id}>)` : message.author.name;
		lines.push(`${who}: ${[message.text, ...notes].filter(Boolean).join("\n")}`);
	}
	return { text: [header, ...lines].join("\n"), files };
}

/** `text` in pieces of at most `limit` characters, split at a line break where possible, else at a space. */
export function chunkText(text: string, limit = MESSAGE_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

function megabytes(size: number): string {
	return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
