// Feishu's Open API as the bot uses it (server): the tenant access token (cached until it is about to expire), the
// bot's identity, its groups, a chat's messages, replies (text as a card with Markdown, files and images uploaded
// first), and where a message's attachment is downloaded from. Every answer is a trust boundary: Feishu's JSON.
import type { ChatType } from "./contract.ts";

/** A message as the API lists it or an event carries it; `content` is Feishu's JSON text for `msgType`. */
export type ApiMessage = {
	messageId: string;
	chatId: string;
	createdAt: number;
	senderId: string;
	senderType: string;
	msgType: string;
	content: string;
	mentions: { key: string; openId: string; name: string }[];
};

export type UploadFile = { name: string; data: Uint8Array };

/** The largest file one message carries (Feishu's limit for files; images are smaller: 10 MiB). */
export const FILE_LIMIT = 30 * 1024 * 1024;
export const IMAGE_LIMIT = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export class FeishuApi {
	readonly #domain: string;
	readonly #appId: string;
	readonly #appSecret: string;
	#token: { value: string; expiresAt: number } | undefined;

	constructor(domain: string, appId: string, appSecret: string) {
		this.#domain = domain;
		this.#appId = appId;
		this.#appSecret = appSecret;
	}

	/** The tenant access token, fetched again a minute before it expires. */
	async token(): Promise<string> {
		if (this.#token && this.#token.expiresAt - Date.now() > 60_000) return this.#token.value;
		const response = await fetch(`${this.#domain}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
			signal: AbortSignal.timeout(15_000),
		});
		const answer = (await response.json()) as {
			code?: number;
			msg?: string;
			tenant_access_token?: string;
			expire?: number;
		};
		if (answer.code !== 0 || !answer.tenant_access_token)
			throw new Error(`Feishu refused the app's credentials: ${answer.msg ?? `code ${answer.code}`}`);
		this.#token = { value: answer.tenant_access_token, expiresAt: Date.now() + (answer.expire ?? 7200) * 1000 };
		return this.#token.value;
	}

	/** The headers a download of a message's resource needs (the token, short-lived). */
	async authorization(): Promise<{ Authorization: string }> {
		return { Authorization: `Bearer ${await this.token()}` };
	}

	/** The bot: its name, open ID and avatar. */
	async bot(): Promise<{ name: string; openId: string; avatarUrl: string | undefined }> {
		// This answer's `bot` sits beside `code`, not under `data` as every other answer's payload does.
		const envelope = await this.#call<{ bot?: { app_name?: string; open_id?: string; avatar_url?: string } }>(
			"GET",
			"/open-apis/bot/v3/info",
			undefined,
			"envelope",
		);
		const bot = envelope.bot ?? {};
		if (!bot.open_id) throw new Error("Feishu named no bot for this app: turn on the Bot capability");
		return { name: bot.app_name ?? "Pi", openId: bot.open_id, avatarUrl: bot.avatar_url || undefined };
	}

	/** The groups the bot is in. */
	async groups(): Promise<{ id: string; name: string }[]> {
		const groups: { id: string; name: string }[] = [];
		let pageToken: string | undefined;
		do {
			const query = new URLSearchParams({ page_size: "100" });
			if (pageToken) query.set("page_token", pageToken);
			const data = await this.#call<{
				items?: { chat_id?: string; name?: string }[];
				has_more?: boolean;
				page_token?: string;
			}>("GET", `/open-apis/im/v1/chats?${query}`);
			for (const item of data.items ?? [])
				if (item.chat_id) groups.push({ id: item.chat_id, name: item.name || item.chat_id });
			pageToken = data.has_more ? data.page_token : undefined;
		} while (pageToken);
		return groups;
	}

	/** A group's name (a direct chat has none to read: the person's name is the chat's). */
	async groupName(chatId: string): Promise<string | undefined> {
		try {
			const data = await this.#call<{ name?: string }>("GET", `/open-apis/im/v1/chats/${chatId}`);
			return data.name || undefined;
		} catch {
			return undefined;
		}
	}

	/** A user's name by open ID; undefined without the contact permission. */
	async userName(openId: string): Promise<string | undefined> {
		try {
			const data = await this.#call<{ user?: { name?: string } }>(
				"GET",
				`/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
			);
			return data.user?.name || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The messages of `chatId` created after `afterMs` (exclusive), oldest first, one page (Feishu's `start_time` is in
	 * seconds, so the page is filtered to the millisecond here); `next` continues the chat's history.
	 */
	async messages(
		chatId: string,
		afterMs: number,
		pageToken?: string,
	): Promise<{ items: ApiMessage[]; next: string | undefined }> {
		const query = new URLSearchParams({
			container_id_type: "chat",
			container_id: chatId,
			start_time: String(Math.floor(afterMs / 1000)),
			sort_type: "ByCreateTimeAsc",
			page_size: "50",
		});
		if (pageToken) query.set("page_token", pageToken);
		const data = await this.#call<{
			items?: {
				message_id?: string;
				chat_id?: string;
				create_time?: string;
				msg_type?: string;
				sender?: { id?: string; sender_type?: string };
				body?: { content?: string };
				mentions?: { key?: string; id?: string; name?: string }[];
				deleted?: boolean;
			}[];
			has_more?: boolean;
			page_token?: string;
		}>("GET", `/open-apis/im/v1/messages?${query}`);
		const items: ApiMessage[] = [];
		for (const item of data.items ?? []) {
			const createdAt = Number(item.create_time ?? "0");
			if (!item.message_id || item.deleted || createdAt <= afterMs) continue;
			items.push({
				messageId: item.message_id,
				chatId: item.chat_id ?? chatId,
				createdAt,
				senderId: item.sender?.id ?? "",
				senderType: item.sender?.sender_type ?? "user",
				msgType: item.msg_type ?? "text",
				content: item.body?.content ?? "",
				mentions: (item.mentions ?? []).flatMap((mention) =>
					mention.key && mention.id ? [{ key: mention.key, openId: mention.id, name: mention.name ?? "" }] : [],
				),
			});
		}
		return { items, next: data.has_more ? data.page_token : undefined };
	}

	/** Posts `text` as a card with Markdown to `chatId`, as a reply to `messageId` when given. */
	async sendText(chatId: string, messageId: string | undefined, text: string): Promise<void> {
		const card = { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] };
		await this.#send(chatId, messageId, "interactive", JSON.stringify(card));
	}

	/** Uploads `file` and posts it (an image as an image, else as a file). */
	async sendFile(chatId: string, messageId: string | undefined, file: UploadFile): Promise<void> {
		const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
		if (IMAGE_EXTENSIONS.has(extension) && file.data.length <= IMAGE_LIMIT) {
			const form = new FormData();
			form.set("image_type", "message");
			form.set("image", new Blob([file.data as BlobPart]), file.name);
			const data = await this.#call<{ image_key?: string }>("POST", "/open-apis/im/v1/images", form);
			if (!data.image_key) throw new Error("Feishu returned no image key");
			await this.#send(chatId, messageId, "image", JSON.stringify({ image_key: data.image_key }));
			return;
		}
		const form = new FormData();
		form.set("file_type", "stream");
		form.set("file_name", file.name);
		form.set("file", new Blob([file.data as BlobPart]), file.name);
		const data = await this.#call<{ file_key?: string }>("POST", "/open-apis/im/v1/files", form);
		if (!data.file_key) throw new Error("Feishu returned no file key");
		await this.#send(chatId, messageId, "file", JSON.stringify({ file_key: data.file_key }));
	}

	/** Where a message's image or file is downloaded from (with `authorization()`). */
	resourceUrl(messageId: string, key: string, type: "image" | "file"): string {
		return `${this.#domain}/open-apis/im/v1/messages/${messageId}/resources/${key}?type=${type}`;
	}

	async #send(chatId: string, messageId: string | undefined, msgType: string, content: string): Promise<void> {
		if (messageId)
			await this.#call("POST", `/open-apis/im/v1/messages/${messageId}/reply`, { msg_type: msgType, content });
		else
			await this.#call("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
				receive_id: chatId,
				msg_type: msgType,
				content,
			});
	}

	/** One call: `data` of Feishu's envelope (or the whole envelope), or the error it names. */
	async #call<T>(
		method: "GET" | "POST",
		path: string,
		body?: FormData | object,
		shape: "data" | "envelope" = "data",
	): Promise<T> {
		const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
		let payload: string | FormData | undefined;
		if (body instanceof FormData) payload = body;
		else if (body !== undefined) {
			headers["content-type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const response = await fetch(`${this.#domain}${path}`, {
			method,
			headers,
			body: payload,
			signal: AbortSignal.timeout(60_000),
		});
		const answer = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T };
		if (answer.code !== 0) throw new Error(`Feishu: ${answer.msg ?? `HTTP ${response.status}`} (${answer.code})`);
		if (shape === "envelope") return answer as T;
		return answer.data ?? ({} as T);
	}
}

/** The chat type an event or listing names. */
export function chatTypeOf(value: unknown): ChatType {
	return value === "group" ? "group" : "p2p";
}
