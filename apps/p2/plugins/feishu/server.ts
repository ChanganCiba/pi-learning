// The feishu plugin's server facet: the owner's bots (fleet.ts, credentials in `<data>/feishu.json`), the links of
// sessions to chats with their cursors and pending replies (persisted), the relay between them (relay.ts), and the
// owner's `Feishu` view. A linked session stays where it is: this bridge is the owner's own.
import { num, obj, str } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	type Ctx,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	type Ref,
	record,
	signalOf,
	sleep,
} from "@p2/app/v1";
import { Server, serverOf } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { BindingSchema, Feishu, FeishuIngress, FeishuStore, PendingSchema } from "./contract.ts";
import { Fleet } from "./fleet.ts";
import { Relay, type RelayState, type SessionPort } from "./relay.ts";

const State = defineState("p2.feishu-bindings", {
	schema: obj({
		bindings: record(BindingSchema),
		pending: record(PendingSchema),
		/** Direct chats that wrote to a bot, by chat ID: a p2p chat cannot be listed, only remembered. */
		seen: record(obj({ botId: str(), name: str(), at: num() })),
	}),
	// 2: `seen` persists across restarts (it lived in the bot's memory). 3: a pending reply's `noticeId`.
	version: 3,
	initial: () => ({ bindings: {}, pending: {}, seen: {} }),
	migrate: (old, from) => {
		if (from === 1) return { ...(old as { bindings: object; pending: object }), seen: {} } as never;
		// 2 → 3 only names the optional `noticeId`: the stored values are valid as they are.
		if (from === 2) return old as never;
		throw new Error(`Unknown p2.feishu-bindings version ${from}`);
	},
	persist: true,
	checkpointWhen: () => true,
});

/** Direct chats remembered at most (the oldest forgotten). */
const SEEN_CHATS = 50;

/** Pending turns are checked this often anyway (their session's status change checks them at once). */
const CHECK_MS = 15_000;

/** A failure of the bridge, in the server's log (as the sibling bridges report theirs). */
const report = (error: string) => console.error("p2 feishu:", error);

export default defineFacet((host) => {
	host.serve(FeishuStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const statuses = self.get(StatusStore, {});
		const state = self.state(State);
		const fleet = self.open(
			() => Fleet.open(server.info.value.dataDir, report),
			(opened) => opened.close(),
		);
		/** The context of the store's live loop: replies, deliveries and state changes run under it. */
		let live: Ctx | undefined;
		const during = (): Ctx => {
			if (!live) throw new Error("The Feishu store is not live");
			return live;
		};
		const usable = async (session: string): Promise<string | undefined> => {
			const row = catalog.sessions.value.find((entry) => entry.id === session);
			if (!row) return "its p2 session is gone.";
			if (row.archivedAt !== null) return "its p2 session is archived.";
			return undefined;
		};
		const natives = serverOf(self);
		/** One call of session `session`'s worker (started if needed) as the server, in a scope of its own. */
		const ingress = <T>(
			session: string,
			call: (worker: Ref<typeof FeishuIngress>, ctx: Ctx) => Promise<T>,
		): Promise<T> =>
			// A root scope releases the worker's reference when the call ends; the live routine's would keep them all.
			natives().root(async (ctx) => call(await ctx.get(FeishuIngress, { session }), ctx), BACKGROUND_CONTEXT);
		const sessions: SessionPort = {
			usable,
			deliver: (session, input) => ingress(session, (worker, ctx) => worker.deliver(input, ctx)),
			turn: (session, submissionId) => ingress(session, (worker, ctx) => worker.turn({ submissionId }, ctx)),
			read: (session, id, offset, length) =>
				ingress(session, (worker, ctx) => worker.read({ id, offset, length }, ctx)),
		};
		const relay = new Relay(
			(bot) => fleet.value.connected(bot),
			sessions,
			{
				// The state's drafts are the same JSON as the relay's plain records.
				value: () => state.value as RelayState,
				change: (update) => state.change((draft) => update(draft as RelayState), during()),
			},
			report,
		);
		self.onLive(async (ctx) => {
			live = ctx;
			// One event at a time, in the order the bots received them: a catch-up and a live message never race.
			for (;;) {
				const received = await fleet.value.next(signalOf(ctx));
				if (!received) return;
				const { bot, event } = received;
				// A direct chat is remembered when someone writes in it: the link form offers it, restarts included.
				if (event.kind === "message" && event.message.chatType === "p2p")
					await state.change((draft) => {
						draft.seen[event.message.chatId] = { botId: bot, name: event.message.author.name, at: Date.now() };
						const all = Object.entries(draft.seen).sort(([, a], [, b]) => a.at - b.at);
						for (const [chat] of all.slice(0, Math.max(0, all.length - SEEN_CHATS))) delete draft.seen[chat];
					}, ctx);
				await (event.kind === "message" ? relay.onMessage(bot, event.message) : relay.catchUp(bot)).catch(
					(error: unknown) => report(errorText(error)),
				);
			}
		});
		self.onLive(async (ctx) => {
			while (!signalOf(ctx).aborted) {
				await sleep(CHECK_MS, ctx);
				if (Object.keys(state.value.pending).length)
					await relay.checkPending().catch((error: unknown) => report(errorText(error)));
			}
		});
		// A session's status changed: its turn may have ended.
		let seen: Record<string, string> = {};
		self.on(statuses.statuses, async ({ value }) => {
			const changed = new Set<string>();
			const next: Record<string, string> = {};
			for (const [session, status] of Object.entries(value)) {
				next[session] = `${status.running} ${status.tasks} ${status.busy.join(",")}`;
				if (next[session] !== seen[session]) changed.add(session);
			}
			seen = next;
			if (live && changed.size && Object.keys(state.value.pending).length)
				await relay.checkPending(changed).catch((error: unknown) => report(errorText(error)));
		});
		const connected = (bot: string) => {
			const found = fleet.value.connected(bot);
			if (!found) throw new Error("The Feishu bot is not connected");
			return found;
		};
		/** Drops `session`'s link; its agent stops being told it answers Feishu. */
		const unlink = async (session: string, ctx: Ctx): Promise<void> => {
			await state.change((draft) => {
				for (const [chat, binding] of Object.entries(draft.bindings))
					if (binding.session === session) delete draft.bindings[chat];
			}, ctx);
			// A session that is gone or archived has no worker to tell (and none to start).
			const row = catalog.sessions.value.find((entry) => entry.id === session);
			if (row && row.archivedAt === null)
				await ingress(session, (worker, scope) => worker.unlinked(scope)).catch((error: unknown) =>
					report(`telling the session it is unlinked failed: ${errorText(error)}`),
				);
		};
		return {
			bots: followNative(
				self,
				(changed) => fleet.value.subscribe(changed),
				() => fleet.value.views(),
			),
			bindings: deriveTyped(self, [state], ([value]) =>
				Object.values(value.bindings).sort((a, b) => a.createdAt - b.createdAt),
			),
			addBot: async ({ appId, appSecret }) => ({ id: await fleet.value.add(appId.trim(), appSecret.trim()) }),
			removeBot: async ({ bot }, ctx) => {
				for (const binding of Object.values(state.value.bindings))
					if (binding.botId === bot) await unlink(binding.session, ctx);
				await fleet.value.remove(bot);
				return null;
			},
			chats: async ({ bot }) => {
				const listed = await connected(bot).chats();
				// The persisted direct chats too (the bot's own memory is empty after a restart), newest first.
				const remembered = Object.entries(state.value.seen)
					.filter(([chat, entry]) => entry.botId === bot && !listed.some((known) => known.id === chat))
					.sort(([, a], [, b]) => b.at - a.at)
					.map(([chat, entry]) => ({ id: chat, name: entry.name, type: "p2p" as const }));
				return [...listed, ...remembered];
			},
			link: async ({ session, bot, chat: chatId, wake }, ctx) => {
				const bindings = Object.values(state.value.bindings);
				if (bindings.some((binding) => binding.session === session))
					throw new Error("This session is linked already: unlink it first");
				if (state.value.bindings[chatId]) throw new Error("This chat is linked to another session");
				const row = catalog.sessions.value.find((entry) => entry.id === session);
				if (!row || row.archivedAt !== null) throw new Error("No such session");
				const chat = await connected(bot).chat(chatId);
				await state.change((draft) => {
					draft.bindings[chatId] = {
						botId: bot,
						chatId,
						chatName: chat.name,
						chatType: chat.type,
						session,
						wake,
						// The first wake delivers what comes after linking.
						cursor: Date.now(),
						createdAt: Date.now(),
					};
				}, ctx);
				return null;
			},
			unlink: async ({ session }, ctx) => {
				await unlink(session, ctx);
				return null;
			},
			updateLink: async ({ session, wake }, ctx) => {
				if (!Object.values(state.value.bindings).some((binding) => binding.session === session))
					throw new Error("This session is not linked");
				await state.change((draft) => {
					for (const binding of Object.values(draft.bindings))
						if (binding.session === session) binding.wake = wake;
				}, ctx);
				return null;
			},
		};
	});

	host.serve(Feishu, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Feishu is the owner's");
		const store = self.get(FeishuStore, {});
		return {
			variant: "owner",
			members: {
				bots: store.bots,
				bindings: store.bindings,
				addBot: (args, ctx) => store.addBot(args, ctx),
				removeBot: (args, ctx) => store.removeBot(args, ctx),
				chats: (args, ctx) => store.chats(args, ctx),
				link: (args, ctx) => store.link(args, ctx),
				unlink: (args, ctx) => store.unlink(args, ctx),
				updateLink: (args, ctx) => store.updateLink(args, ctx),
			},
		};
	});
});

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
