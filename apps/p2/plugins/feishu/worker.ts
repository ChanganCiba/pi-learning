// The feishu plugin's worker facet: what the server hands a session's worker. A batch becomes one input of the main
// conversation, its attachments downloaded into the session's uploads first; a turn's answer is read from Durable when
// the server asks. The shared parts (downloads, turns) are the chat bridges' (../discord/ingress.ts).
import { defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { contribute, defineFacet, forbidden, type MessageData } from "@p2/app/v1";
import { durableContext, Files, findDownload } from "@p2/app/v1/node";
import { Extensions, harnessOf, isTopLevel, mainConversation } from "@p2/app/v1/worker";
import { Conversation } from "../chat/contract.ts";
import { download, readTurn } from "../discord/ingress.ts";
import { Attachments } from "../files/contract.ts";
import { offeredBy } from "../send-file/contract.ts";
import { type ChatType, FEISHU_BATCH, FeishuIngress } from "./contract.ts";

/**
 * The session's Feishu link as its agent learns it (session-scoped): the chat. Written at each delivery, cleared when
 * the session is unlinked.
 */
export const FeishuLinkDoc = defineDoc<{ link: { chat: string; chatType: ChatType } | null }>({
	kind: "p2.feishu-link",
	version: 1,
	scope: "session",
	initial: () => ({ link: null }),
	checkpointWhen: () => true,
});

/**
 * What an agent answering Feishu must know, in a few sentences: stable for a link (it changes only with the chat), so
 * the prompt's cached prefix stays.
 */
export function feishuPrompt(where: string): string {
	return [
		`Your input comes from ${where}; your final answer of each turn is posted there as the reply (as Markdown), with`,
		"the files you offer with send_file during the turn sent after it. Nothing else is posted (not intermediate",
		"text, thinking or tool output), so make the final answer complete on its own. In a group, each line names its",
		"author with their open ID, as in `Ann (<ou_1234>): text`; a direct chat's lines are the person's words alone.",
		"Keep answers concise: they are read on a phone.",
	].join(" ");
}

/** The Feishu section: on for the main agent of a linked session. */
export const feishuExtension = defineExtension({
	name: "p2-feishu",
	sections: [
		section("feishu", async (input, context) => {
			const doc = await input.read.snapshot(FeishuLinkDoc, context);
			if (!doc?.link) return undefined;
			const where =
				doc.link.chatType === "group"
					? `the Feishu group "${doc.link.chat}"`
					: `a Feishu direct chat with ${doc.link.chat}`;
			return (await isTopLevel(input.read, input.conversationId, context)) ? feishuPrompt(where) : undefined;
		}),
	],
});

export default defineFacet((host) => {
	contribute(host, "p2.feishu-extension", (self) => {
		self.contribute(Extensions, { [feishuExtension.name]: feishuExtension });
	});

	host.serve(FeishuIngress, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const harness = harnessOf(self);
		const files = self.get(Files, {});
		const attachments = self.get(Attachments, {});
		return {
			deliver: async ({ requestId, author, text, context, files: downloads }, ctx) => {
				const durable = harness().durable;
				const target = await mainConversation(durable, durableContext(ctx));
				await durable.commit(async (tx) => {
					(await tx.doc(FeishuLinkDoc)).link = { chat: context.chat, chatType: context.chatType };
				}, durableContext(ctx));
				const ids: { id: string; name: string }[] = [];
				for (const file of downloads) {
					const got = await download(files, file, "feishu", ctx);
					if (got === undefined) continue;
					// A failed download is said in the input: the agent knows what it did not get.
					if ("error" in got) text += `\n[attachment ${file.name} could not be downloaded: ${got.error}]`;
					else ids.push({ id: got.id, name: file.name });
				}
				const resolved = ids.length
					? await attachments.resolve({ ids: ids.map((entry) => entry.id), conversation: target }, ctx)
					: [];
				const who = { kind: "guest" as const, id: `feishu:${author.id}`, name: `${author.name} · Feishu` };
				const data: MessageData & { feishu: typeof context } = {
					author: who,
					text,
					attachments: ids,
					feishu: context,
				};
				const chat = await ctx.get(Conversation, { conversation: target });
				const { submissionId } = await chat.submit(
					{
						text,
						requestId,
						// A batch while a turn runs joins it: its answer replies to the newest message.
						whenBusy: "steer",
						author: who,
						...(resolved.length ? { files: resolved } : {}),
						entry: { kind: FEISHU_BATCH, data },
					},
					ctx,
				);
				return { conversation: target, submissionId };
			},
			unlinked: async (ctx) => {
				await harness().durable.commit(async (tx) => {
					(await tx.doc(FeishuLinkDoc)).link = null;
				}, durableContext(ctx));
				return null;
			},
			turn: ({ submissionId }, ctx) =>
				readTurn(harness().durable, files, offeredBy, submissionId, durableContext(ctx), ctx),
			read: async ({ id, offset, length }, ctx) => {
				const found = await findDownload(files, id, ctx);
				if (!found) throw new Error("No such file");
				return files.read({ id: found.file.id, offset, length }, ctx);
			},
		};
	});
});
