// Pi on Feishu (browser-safe contracts): the owner's Feishu apps (bots) run on the p2 server over Feishu's long
// connection; a session linked to a chat through one of them gets, at a message by someone allowed to wake Pi (in a
// group: a mention of the bot; in a direct chat: any message), the messages since the link's cursor as one input, and
// its answer goes back as a reply. Unlike Discord, the session stays where it is: this is the owner's personal bridge.
import { arr, bool, bytes, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, MAX_ATTACHMENTS, method, param, remote, serverHost, sessionHost } from "@p2/app/v1";

/** Entry kind of a delivered batch: a person's message (its data is message data) with the Feishu details. */
export const FEISHU_BATCH = "feishu.batch";

/** Who may wake Pi in a chat: anyone, or the listed Feishu users (open IDs). */
export const WakeSchema = obj({
	anyone: bool(),
	users: arr(str({ maxLength: 64 }), { maxItems: 100 }),
});
export type Wake = Static<typeof WakeSchema>;

export const ChatTypeSchema = union([literal("p2p"), literal("group")]);
export type ChatType = Static<typeof ChatTypeSchema>;

/** One chat linked to one session, through one bot. A session has at most one, a chat at most one. */
export const BindingSchema = obj({
	/** The bot that listens (an ID of `feishu.json`'s bots). */
	botId: str(),
	chatId: str(),
	chatName: str(),
	chatType: ChatTypeSchema,
	session: str(),
	wake: WakeSchema,
	/** The creation time (ms) of the last Feishu message delivered (null: none yet). */
	cursor: union([num(), nul()]),
	createdAt: num(),
});
export type Binding = Static<typeof BindingSchema>;

/** A delivered batch waiting for its turn's answer, to go back as a reply to the message that woke Pi. */
export const PendingSchema = obj({
	botId: str(),
	session: str(),
	chatId: str(),
	messageId: str(),
	/** The waking message's creation time (ms): inputs of one run reply to the newest. */
	createdAt: num(),
	/** The grey thinking card posted at the wake, patched into the answer (absent: it could not be posted). */
	noticeId: opt(str()),
	submissionId: num(),
	since: num(),
});
export type Pending = Static<typeof PendingSchema>;

/** A chat the bot can be linked to: a group it is in, or a direct chat of someone who wrote to it. */
export const ChatSchema = obj({ id: str(), name: str(), type: ChatTypeSchema });
export type Chat = Static<typeof ChatSchema>;

/** A bot's connection as the owner sees it. */
export const BotStatusSchema = union([
	obj({ state: literal("connecting") }),
	obj({ state: literal("error"), error: str() }),
	obj({ state: literal("connected"), name: str(), appId: str(), openId: str(), avatarUrl: opt(str()) }),
]);
export type BotStatus = Static<typeof BotStatusSchema>;

/** One configured bot: its ID (stable, p2's own) and its connection. */
export const BotSchema = obj({ id: str(), status: BotStatusSchema });
export type BotView = Static<typeof BotSchema>;

/** Linking a session to a chat: the bot and chat, and who may wake Pi. */
export const LinkSchema = obj({ session: str(), bot: str(), chat: str(), wake: WakeSchema });
export type Link = Static<typeof LinkSchema>;

const AppId = str({ minLength: 4, maxLength: 64 });
const AppSecret = str({ minLength: 8, maxLength: 200 });

/** The owner's methods on bots and links (the store serves them; the owner's view forwards them). */
const OWNER_METHODS = {
	/** Connects a new app with its credentials and keeps it: its ID; refused with Feishu's reason (nothing kept). */
	addBot: method(obj({ appId: AppId, appSecret: AppSecret }), obj({ id: str() })),
	/** Removes bot `bot`; its sessions are unlinked. */
	removeBot: method(obj({ bot: str() })),
	/** The chats bot `bot` can be linked to: its groups, and the direct chats it has seen messages from. */
	chats: method(obj({ bot: str() }), arr(ChatSchema)),
	/** Links a session to a chat and listens. Refused when the session or the chat is linked already. */
	link: method(LinkSchema),
	/** Stops listening for `session`. */
	unlink: method(obj({ session: str() })),
	/** Changes who may wake Pi, in place (read at each message). */
	updateLink: method(obj({ session: str(), wake: WakeSchema })),
};

/** The bots, the links and the relay between Feishu and sessions (server, host-internal, host lifetime). */
export const FeishuStore = local("p2.feishu-store", {
	version: 1,
	params: {},
	members: { bots: arr(BotSchema), bindings: arr(BindingSchema), ...OWNER_METHODS },
});

/** The owner's bots and links. */
export const Feishu = remote("p2.feishu", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	state: { bots: arr(BotSchema), bindings: arr(BindingSchema) },
	methods: OWNER_METHODS,
});

/** A file the agent offered in a turn (`send_file`): the session's download, to send back to the chat. */
export const OfferedFileSchema = obj({ id: str(), name: str(), size: num() });
export type OfferedFile = Static<typeof OfferedFileSchema>;

/**
 * A Feishu attachment to download into the session's uploads (at most 25 MiB): its resource URL with the headers the
 * download needs (the bot's token, short-lived).
 */
export const FeishuFileSchema = obj({
	url: str(),
	headers: obj({ Authorization: str() }),
	name: str(),
	size: num(),
	key: str(),
	ref: str(),
});

/** What the server hands a session's worker (server only): batches and finished turns. */
export const FeishuIngress = remote("p2.feishu-ingress", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	methods: {
		/** The session is no longer linked: its agent's Feishu prompt section goes. */
		unlinked: method(),
		/**
		 * Places a batch as one input of the main conversation, steering the turn under way while it is busy (the
		 * batch joins it); a retried `requestId` is placed once. Its agent learns that it answers Feishu.
		 */
		deliver: method(
			obj({
				requestId: str({ maxLength: 200 }),
				author: obj({ id: str(), name: str() }),
				text: str({ maxLength: 200_000 }),
				context: obj({ chat: str(), chatType: ChatTypeSchema, messages: int() }),
				files: arr(FeishuFileSchema, { maxItems: MAX_ATTACHMENTS }),
			}),
			obj({ conversation: int(), submissionId: num() }),
		),
		/** The submission's turn: pending, answered, stopped, or ended without an answer; with its offered files. */
		turn: method(
			obj({ submissionId: num() }),
			union([
				obj({ state: literal("pending") }),
				obj({
					state: literal("answered"),
					text: str(),
					thinking: opt(str()),
					files: arr(OfferedFileSchema),
					answer: num(),
				}),
				obj({ state: literal("stopped") }),
				obj({ state: literal("unanswered"), reason: str(), files: arr(OfferedFileSchema) }),
			]),
		),
		/** `length` bytes (at most 4 MiB) of offered file `id` from `offset` (fewer at its end). */
		read: method(
			obj({ id: str(), offset: int({ minimum: 0 }), length: int({ minimum: 1, maximum: 4 * 1024 * 1024 }) }),
			bytes(),
		),
	},
});
