// What a session's worker does for any chat bridge (Discord, Feishu): an attachment downloaded into the session's
// uploads, the files a conversation offered during a turn, and how a submission's turn ended. Shared by the bridges'
// `*Ingress` facets; nothing here knows which chat it serves.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { type Context, type Ctx, type Ref, safeFileName } from "@p2/app/v1";
import { DOWNLOADS, displayName, FILE_CHUNK, type Files, UPLOADS } from "@p2/app/v1/node";

/**
 * The downloads' ref of a conversation's offered files (`send_file`'s `offeredBy`): passed in, as this file is copied
 * into each bridge's worker facet and may import nothing of a third plugin.
 */
export type OfferedRef = (conversation: number) => string;

/** Attachments up to this size are downloaded (the composer's upload limit). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The image types the model may get inline (the composer's: files/uploads.ts). */
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** A chat attachment to download: where from (with the headers the download needs), and the upload's key and ref. */
export type Download = {
	url: string;
	headers?: Record<string, string>;
	name: string;
	size: number;
	key: string;
	ref: string;
};

/** A file the agent offered in a turn (`send_file`): the session's download. */
export type Offered = { id: string; name: string; size: number };

/** How a submission's turn ended, as the bridges post it. */
export type TurnState =
	| { state: "pending" }
	| { state: "answered"; text: string; files: Offered[]; answer: number }
	| { state: "stopped" }
	| { state: "unanswered"; reason: string; files: Offered[] };

/**
 * Downloads a chat attachment into the session's uploads (its key makes a retry find it); its upload ID, or undefined
 * when it is too large or the download failed (reported by the caller's bridge, which knows the chat).
 */
export async function download(
	files: Ref<typeof Files>,
	file: Download,
	source: string,
	ctx: Ctx,
): Promise<{ id: string } | { error: string } | undefined> {
	const existing = await files.byKey({ space: UPLOADS, key: file.key }, ctx);
	if (existing) return { id: file.key };
	if (file.size > MAX_UPLOAD_BYTES) return undefined;
	const path = `${file.key.replaceAll(":", "-")}-${safeFileName(file.name)}`;
	const begun = await files.begin(
		{
			space: UPLOADS,
			path,
			mime: IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream",
			source,
			key: file.key,
			ref: file.ref,
			meta: { name: file.name },
		},
		ctx,
	);
	if (begun.kind === "exists") return { id: file.key };
	try {
		const response = await fetch(file.url, { signal: ctx.abortSignal, headers: file.headers ?? {} });
		if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
		let offset = 0;
		let pending = Buffer.alloc(0);
		const reader = response.body.getReader();
		for (;;) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= FILE_CHUNK) {
				await files.append({ upload: begun.upload, offset, bytes: pending.subarray(0, FILE_CHUNK) }, ctx);
				offset += FILE_CHUNK;
				pending = pending.subarray(FILE_CHUNK);
				if (offset > MAX_UPLOAD_BYTES) throw new Error("Attachment too large");
			}
		}
		if (pending.length) await files.append({ upload: begun.upload, offset, bytes: pending }, ctx);
		await files.finish(begun.upload, ctx);
		return { id: file.key };
	} catch (error) {
		// The upload is abandoned; the download's failure is what the caller reports.
		await files.cancel(begun.upload, ctx).catch(() => {});
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The files conversation `conversation` offered (`send_file`, also from scripts) between `start` and `end` (ms since
 * the epoch): a turn's, oldest first.
 */
export async function offered(
	files: Ref<typeof Files>,
	offeredBy: OfferedRef,
	conversation: number,
	start: number,
	end: number,
	ctx: Ctx,
): Promise<Offered[]> {
	const found: Offered[] = [];
	let after: string | undefined;
	do {
		const page = await files.byRef(
			{ space: DOWNLOADS, ref: offeredBy(conversation), ...(after ? { after } : {}) },
			ctx,
		);
		for (const file of page.items)
			if (file.key && file.created >= start && file.created <= end)
				found.push({ id: file.key, name: displayName(file), size: file.size });
		after = page.next;
	} while (after !== undefined);
	return found;
}

/**
 * Submission `submissionId`'s turn: still pending, answered (the answer's text), stopped (aborted, or withdrawn while
 * queued), or ended without an answer; with the files its conversation offered during it.
 */
export async function readTurn(
	durable: Harness,
	files: Ref<typeof Files>,
	offeredBy: OfferedRef,
	submissionId: number,
	context: Context,
	ctx: Ctx,
): Promise<TurnState> {
	const submission = await durable.submission(submissionId as SubmissionId, context);
	// Gone: withdrawn while queued (a stop).
	if (!submission) return { state: "stopped" };
	const record = await submission.status(context);
	if (record.type !== "input") return { state: "unanswered", reason: "Not an input.", files: [] };
	if (record.status === "queued" || record.status === "placed") return { state: "pending" };
	if (record.status === "unanswered" && record.reason === "aborted") return { state: "stopped" };
	// The turn's span: from its input (its message's time) to its answer, or until now without one.
	const input =
		record.entry === undefined ? undefined : await entryOf(durable, record.conversationId, record.entry, context);
	const start = input?.model?.[0]?.timestamp ?? 0;
	if (record.status === "unanswered")
		return {
			state: "unanswered",
			reason: record.reason || "The turn ended without an answer.",
			files: await offered(files, offeredBy, record.conversationId, start, Date.now(), ctx),
		};
	const answer = await entryOf(durable, record.conversationId, record.answer, context);
	const message = answer?.model?.[0] as AssistantMessage | undefined;
	if (message?.stopReason === "aborted") return { state: "stopped" };
	const text = (message?.content ?? [])
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("")
		.trim();
	const sent = await offered(files, offeredBy, record.conversationId, start, message?.timestamp ?? Date.now(), ctx);
	return text || sent.length
		? { state: "answered", text, files: sent, answer: record.answer }
		: {
				state: "unanswered",
				reason:
					message?.stopReason === "error"
						? (message.errorMessage ?? "The model failed.")
						: "The answer has no text.",
				files: sent,
			};
}

/** Entry `id` of `conversationId`. */
export async function entryOf(
	durable: Harness,
	conversationId: ConversationId,
	id: EntryId,
	context: Context,
): Promise<EntryRecord | undefined> {
	const conversation = await durable.conversation(conversationId, context);
	const page = await conversation?.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context);
	return page?.items[0];
}
