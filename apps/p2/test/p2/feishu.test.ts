// Pi on Feishu: the long connection's frame codec against the official SDK's encoder, and the relay between chats and
// sessions with a fake Feishu and a fake session (who wakes Pi in a group and a direct chat, batches since the cursor,
// pending replies split into cards, refusals, a catch-up).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContent } from "../../plugins/feishu/bot.ts";
import { decodeFrame, encodeFrame, type Frame } from "../../plugins/feishu/connection.ts";
import type { Binding } from "../../plugins/feishu/contract.ts";
import {
	type Command,
	type CommandPort,
	chunkText,
	commandOf,
	type FeishuMessage,
	type FeishuPort,
	MESSAGE_LIMIT,
	PENDING_TIMEOUT_MS,
	Relay,
	type RelayState,
	type SessionPort,
	type TurnState,
	wakes,
} from "../../plugins/feishu/relay.ts";

const BOT = "ou_bot";

describe("feishu frames", () => {
	it("round-trips a frame with headers and a payload", () => {
		const frame: Frame = {
			seqId: 7n,
			logId: 2n ** 40n,
			service: 123,
			method: 1,
			headers: [
				{ key: "type", value: "event" },
				{ key: "message_id", value: "m1" },
			],
			payloadType: "json",
			payload: new TextEncoder().encode('{"a":1}'),
			logIdNew: "x",
		};
		assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
	});

	it("encodes a ping as the SDK does", () => {
		// `pbbp2.Frame.encode({SeqID:0, LogID:0, service:5, method:0, headers:[{key:"type", value:"ping"}]})`.
		const expected = Uint8Array.from([
			8, 0, 16, 0, 24, 5, 32, 0, 42, 12, 10, 4, 116, 121, 112, 101, 18, 4, 112, 105, 110, 103,
		]);
		const frame: Frame = { seqId: 0n, logId: 0n, service: 5, method: 0, headers: [{ key: "type", value: "ping" }] };
		assert.deepEqual(encodeFrame(frame), expected);
	});

	it("writes a negative int32 as protobuf does and skips unknown fields", () => {
		const frame: Frame = { seqId: 1n, logId: 1n, service: -1, method: -2, headers: [] };
		const bytes = encodeFrame(frame);
		assert.equal(bytes.length, 2 + 2 + 11 + 11);
		assert.deepEqual(decodeFrame(bytes), frame);
		// A field 15 (varint) and a field 16 (bytes) the codec does not know.
		const extra = Uint8Array.from([...bytes, 120, 9, 130, 1, 2, 1, 2]);
		assert.deepEqual(decodeFrame(extra), frame);
	});

	it("rejects a truncated frame", () => {
		assert.throws(() => decodeFrame(Uint8Array.from([66, 10, 1])), /truncated/);
	});
});

describe("feishu content", () => {
	it("reads text with mentions, the bot's as @Pi", () => {
		const mentions = [
			{ key: "@_user_1", openId: BOT, name: "Pi" },
			{ key: "@_user_2", openId: "ou_ann", name: "Ann" },
		];
		assert.deepEqual(parseContent("text", '{"text":"@_user_1 ask @_user_2 please"}', mentions, BOT), {
			text: "@Pi ask @Ann please",
			attachments: [],
		});
	});

	it("flattens a post and names an image", () => {
		const post = JSON.stringify({
			title: "Plan",
			content: [
				[
					{ tag: "text", text: "Step " },
					{ tag: "a", text: "one", href: "https://x" },
				],
				[
					{ tag: "at", user_id: BOT, user_name: "Pi" },
					{ tag: "text", text: " go" },
				],
			],
		});
		assert.equal(parseContent("post", post, [], BOT).text, "Plan\nStep one\n@Pi go");
		assert.deepEqual(parseContent("image", '{"image_key":"img_1"}', [], BOT).attachments, [
			{ key: "img_1", name: "img_1.png", size: 0, type: "image" },
		]);
		assert.equal(parseContent("sticker", "{}", [], BOT).text, "[sticker message]");
	});
});

let serial = 100;
function message(text: string, options: Partial<FeishuMessage> = {}): FeishuMessage {
	serial++;
	return {
		id: `m${serial}`,
		chatId: "g1",
		chatType: "group",
		createdAt: serial * 1000,
		author: { id: "ou_ann", name: "Ann" },
		text,
		mentionsBot: text.includes("@Pi"),
		attachments: [],
		...options,
	};
}

/** A fake Feishu: chats with their messages, and what the bot posted. */
class FakeFeishu implements FeishuPort {
	readonly botId = BOT;
	readonly history = new Map<string, FeishuMessage[]>();
	readonly posted: { chat: string; replyTo: string | undefined; text: string; files?: string[] }[] = [];
	readonly requests: { chat: string; after: number }[] = [];
	readonly reacted: { message: string; emoji: string }[] = [];
	async react(messageId: string, emoji: string) {
		this.reacted.push({ message: messageId, emoji });
	}
	/** Thinking cards by ID, with what they were patched into. */
	readonly notices = new Map<string, { replyTo: string; outcome?: string; text?: string }>();
	noticesFail = false;
	async notice(_chat: string, messageId: string): Promise<string> {
		if (this.noticesFail) throw new Error("no permission");
		const id = `n${this.notices.size + 1}`;
		this.notices.set(id, { replyTo: messageId });
		return id;
	}
	async settle(noticeId: string, outcome: "green" | "red", text: string) {
		const known = this.notices.get(noticeId);
		if (!known) throw new Error("gone");
		known.outcome = outcome;
		known.text = text;
	}
	say(chat: string, entry: FeishuMessage): FeishuMessage {
		const said = { ...entry, chatId: chat };
		this.history.set(chat, [...(this.history.get(chat) ?? []), said]);
		return said;
	}
	async messages(chatId: string, afterMs: number, next?: string) {
		this.requests.push({ chat: chatId, after: afterMs });
		const all = (this.history.get(chatId) ?? []).filter((entry) => entry.createdAt > afterMs);
		const start = next ? Number(next) : 0;
		const items = all.slice(start, start + 2);
		return { items, next: start + 2 < all.length ? String(start + 2) : undefined };
	}
	async reply(
		chat: string,
		replyTo: string | undefined,
		text: string,
		files: readonly { name: string; data: Uint8Array }[] = [],
	) {
		assert(text.length <= MESSAGE_LIMIT);
		assert(text || files.length, "never an empty message");
		this.posted.push({ chat, replyTo, text, ...(files.length ? { files: files.map((file) => file.name) } : {}) });
	}
	async resource(messageId: string, key: string, type: "image" | "file") {
		return { url: `https://feishu.test/${messageId}/${key}?type=${type}`, headers: { Authorization: "Bearer t" } };
	}
}

/** A fake session: what it was handed, and the turns' states the test sets. */
class FakeSessions implements SessionPort {
	refusal: string | undefined;
	readonly unlinkedSessions: string[] = [];
	async unlinked(session: string) {
		this.unlinkedSessions.push(session);
	}
	readonly delivered: Parameters<SessionPort["deliver"]>[1][] = [];
	readonly turns = new Map<number, TurnState>();
	readonly bytes = new Map<string, Uint8Array>();
	async usable() {
		return this.refusal;
	}
	async deliver(_session: string, input: Parameters<SessionPort["deliver"]>[1]) {
		this.delivered.push(input);
		const submissionId = this.delivered.length;
		this.turns.set(submissionId, { state: "pending" });
		return { conversation: 1, submissionId };
	}
	async turn(_session: string, submissionId: number): Promise<TurnState> {
		return this.turns.get(submissionId) ?? { state: "unanswered", reason: "gone", files: [] };
	}
	async read(_session: string, id: string, offset: number, length: number) {
		return (this.bytes.get(id) ?? new Uint8Array()).subarray(offset, offset + length);
	}
}

function binding(patch: Partial<Binding> = {}): Binding {
	return {
		botId: "bot-a",
		chatId: "g1",
		chatName: "Team",
		chatType: "group",
		session: "s1",
		wake: { anyone: false, users: ["ou_ann"] },
		cursor: null,
		createdAt: 1,
		...patch,
	};
}

function setup(initial: Binding = binding()) {
	const feishu = new FakeFeishu();
	const sessions = new FakeSessions();
	let state: RelayState = { bindings: { [initial.chatId]: initial }, pending: {} };
	const offline = new Set<string>();
	const errors: string[] = [];
	const commands: CommandPort = {
		location: async () => ({ cwd: "/work", env: null }),
		createSession: async ({ project }) => {
			commandCalls.push(`create:${project ?? ""}`);
			return { id: "s2", title: "Fresh" };
		},
		projects: async () => [{ name: "learning", path: "/learn" }],
		createProject: async (name, path) => {
			commandCalls.push(`project:${name}:${path}`);
		},
	};
	const commandCalls: string[] = [];
	const relay = new Relay(
		(bot) => (offline.has(bot) ? undefined : feishu),
		sessions,
		commands,
		{
			value: () => state,
			change: async (update) => {
				const draft = structuredClone(state);
				update(draft);
				state = draft;
			},
		},
		(error) => errors.push(error),
	);
	return { feishu, sessions, relay, offline, errors, commandCalls, state: () => state };
}

describe("feishu relay", () => {
	it("wakes on a mention in a group and on any message in a direct chat, by someone allowed", () => {
		const group = binding();
		assert.equal(wakes(group, message("@Pi hi")), true);
		assert.equal(wakes(group, message("hi")), false);
		assert.equal(wakes(group, message("@Pi hi", { author: { id: "ou_bob", name: "Bob" } })), false);
		assert.equal(
			wakes(
				binding({ wake: { anyone: true, users: [] } }),
				message("@Pi hi", { author: { id: "ou_bob", name: "Bob" } }),
			),
			true,
		);
		const direct = binding({ chatType: "p2p" });
		assert.equal(wakes(direct, message("hi")), true);
		assert.equal(wakes(direct, message("hi", { author: { id: "ou_bob", name: "Bob" } })), false);
	});

	it("delivers the messages since the cursor as one batch and replies when the turn ends", async () => {
		const { feishu, sessions, relay, state } = setup();
		feishu.say("g1", message("context from Bob", { author: { id: "ou_bob", name: "Bob" } }));
		feishu.say("g1", message("the bot said", { author: { id: BOT, name: "Pi" } }));
		const wake = feishu.say(
			"g1",
			message("@Pi what now?", { attachments: [{ key: "img_1", name: "a.png", size: 0, type: "image" }] }),
		);
		await relay.onMessage("bot-a", wake);
		assert.equal(sessions.delivered.length, 1);
		const [input] = sessions.delivered;
		assert.equal(input?.requestId, `feishu:${wake.id}`);
		assert.match(input?.text ?? "", /^\[Feishu group "Team": 2 messages since the last delivery\]\n/);
		assert.match(input?.text ?? "", /Bob \(<ou_bob>\): context from Bob\nAnn \(<ou_ann>\): @Pi what now\?/);
		assert.deepEqual(
			input?.files.map((file) => [file.key, file.url]),
			[[`feishu:${wake.id}:0`, `https://feishu.test/${wake.id}/img_1?type=image`]],
		);
		assert.deepEqual(feishu.reacted, [{ message: wake.id, emoji: "OK" }]);
		assert.equal(state().bindings.g1?.cursor, wake.createdAt);
		assert.equal(Object.keys(state().pending).length, 1);
		// The turn ends: the answer goes back as the reply to the waking message, in cards.
		sessions.turns.set(1, {
			state: "answered",
			text: "x".repeat(MESSAGE_LIMIT + 10),
			files: [{ id: "f1", name: "out.txt", size: 3 }],
			answer: 9,
		});
		sessions.bytes.set("f1", new TextEncoder().encode("abc"));
		await relay.checkPending();
		// The thinking card became the answer's first card; the rest are their own messages.
		assert.deepEqual(
			[...feishu.notices.values()].map((notice) => [notice.replyTo, notice.outcome, notice.text?.length]),
			[[wake.id, "green", MESSAGE_LIMIT]],
		);
		assert.deepEqual(
			feishu.posted.map((post) => [post.replyTo, post.text.length, post.files]),
			[
				[undefined, 10, undefined],
				[undefined, 0, ["out.txt"]],
			],
		);
		assert.deepEqual(state().pending, {});
	});

	it("ignores a message the cursor already covers and a message of another bot's link", async () => {
		const { feishu, sessions, relay } = setup(binding({ cursor: 500_000 }));
		await relay.onMessage("bot-a", feishu.say("g1", message("@Pi old", { createdAt: 400_000 })));
		assert.equal(sessions.delivered.length, 0);
		await relay.onMessage("bot-b", feishu.say("g1", message("@Pi other bot")));
		assert.equal(sessions.delivered.length, 0);
	});

	it("replies on its own when the thinking card could not be posted", async () => {
		const { feishu, sessions, relay } = setup();
		feishu.noticesFail = true;
		const wake = feishu.say("g1", message("@Pi hi"));
		await relay.onMessage("bot-a", wake);
		sessions.turns.set(1, { state: "answered", text: "plain", files: [], answer: 1 });
		await relay.checkPending();
		assert.deepEqual(feishu.posted, [{ chat: "g1", replyTo: wake.id, text: "plain" }]);
	});

	it("answers a session that cannot take the batch with a notice", async () => {
		const { feishu, sessions, relay } = setup();
		sessions.refusal = "its p2 session is archived.";
		const wake = feishu.say("g1", message("@Pi hi"));
		await relay.onMessage("bot-a", wake);
		assert.deepEqual(feishu.posted, [
			{ chat: "g1", replyTo: wake.id, text: "Pi is not listening here right now: its p2 session is archived." },
		]);
	});

	it("catches up on the newest waking message after a reconnection", async () => {
		const { feishu, sessions, relay } = setup();
		feishu.say("g1", message("@Pi first"));
		feishu.say("g1", message("chatter"));
		const newest = feishu.say("g1", message("@Pi second"));
		await relay.catchUp("bot-a");
		assert.equal(sessions.delivered.length, 1);
		assert.match(sessions.delivered[0]?.text ?? "", /3 messages since the last delivery/);
		assert.equal(sessions.delivered[0]?.requestId, `feishu:${newest.id}`);
		// Paged history: the fake gives two a page.
		assert(feishu.requests.length >= 2);
	});

	it("posts an answer once for inputs steered into one turn, and times out a turn that never ends", async () => {
		const { feishu, sessions, relay, state } = setup();
		const first = feishu.say("g1", message("@Pi a"));
		await relay.onMessage("bot-a", first);
		const second = feishu.say("g1", message("@Pi b"));
		await relay.onMessage("bot-a", second);
		sessions.turns.set(1, { state: "answered", text: "shared", files: [], answer: 5 });
		sessions.turns.set(2, { state: "answered", text: "shared", files: [], answer: 5 });
		await relay.checkPending();
		// The answer patches the newest wake's thinking card once; the first wake's card stays as it was.
		assert.deepEqual(
			[...feishu.notices.values()].map((notice) => [notice.replyTo, notice.outcome, notice.text]),
			[
				[first.id, undefined, undefined],
				[second.id, "green", "shared"],
			],
		);
		const third = feishu.say("g1", message("@Pi c"));
		await relay.onMessage("bot-a", third);
		const pending = state().pending[third.id];
		assert(pending);
		pending.since -= PENDING_TIMEOUT_MS + 1;
		await relay.checkPending();
		assert.deepEqual([...feishu.notices.values()].at(-1), {
			replyTo: third.id,
			outcome: "red",
			text: "(No answer: the session did not answer in time.)",
		});
	});

	it("keeps a reply while its bot is offline", async () => {
		const { feishu, sessions, relay, offline, state } = setup();
		const wake = feishu.say("g1", message("@Pi hi"));
		await relay.onMessage("bot-a", wake);
		sessions.turns.set(1, { state: "answered", text: "later", files: [], answer: 1 });
		offline.add("bot-a");
		await relay.checkPending();
		assert.equal(feishu.posted.length, 0);
		assert.equal(Object.keys(state().pending).length, 1);
		offline.delete("bot-a");
		await relay.checkPending();
		assert.deepEqual([...feishu.notices.values()], [{ replyTo: wake.id, outcome: "green", text: "later" }]);
	});

	it("names authors without IDs in a direct chat and quotes thinking above the answer", async () => {
		const { feishu, sessions, relay } = setup(binding({ chatId: "p1", chatType: "p2p", chatName: "Ann" }));
		const wake = feishu.say("p1", message("hi", { chatId: "p1", chatType: "p2p" }));
		await relay.onMessage("bot-a", wake);
		assert.match(sessions.delivered[0]?.text ?? "", /delivery\]\nhi$/);
		sessions.turns.set(1, { state: "answered", text: "done", thinking: "step one\nstep two", files: [], answer: 1 });
		await relay.checkPending();
		assert.equal([...feishu.notices.values()][0]?.text, "> step one\n> step two\n\ndone");
	});

	it("runs slash commands instead of delivering, and /new switches the chat's session", async () => {
		const { feishu, sessions, relay, commandCalls, state } = setup();
		assert.deepEqual(commandOf("@Pi /help"), { name: "help", args: [] } satisfies Command);
		assert.equal(commandOf("/etc/hosts 怎么改"), undefined);
		await relay.onMessage("bot-a", feishu.say("g1", message("@Pi /help")));
		assert.equal(sessions.delivered.length, 0);
		assert.match(feishu.posted[0]?.text ?? "", /^可用指令：/);
		await relay.onMessage("bot-a", feishu.say("g1", message("@Pi /projects")));
		assert.match(feishu.posted[1]?.text ?? "", /learning（\/learn）/);
		await relay.onMessage("bot-a", feishu.say("g1", message("@Pi /new learning")));
		assert.deepEqual(commandCalls, ["create:learning"]);
		assert.equal(state().bindings.g1?.session, "s2");
		assert.deepEqual(sessions.unlinkedSessions, ["s1"]);
		assert.match(feishu.posted[2]?.text ?? "", /已新建会话「Fresh」/);
		// The command messages stay out of the next batch.
		const wake = feishu.say("g1", message("@Pi now work"));
		await relay.onMessage("bot-a", wake);
		assert.doesNotMatch(sessions.delivered[0]?.text ?? "", /\/help|\/projects|\/new/);
	});

	it("splits text at line breaks within the limit", () => {
		const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
		assert.deepEqual(
			chunkText(text).map((chunk) => chunk.length),
			[3000, 3000],
		);
	});
});
