// A session's Feishu link (its Session sheet → Feishu). Linked: the bot and chat (fixed), who may wake Pi (editable,
// saved in place and applied at once), and Unlink. Not linked: the form that links it: the bot, a chat no other
// session has (its groups, the direct chats that wrote to it), and who may wake Pi.
import { BACKGROUND_CONTEXT, liveWith } from "@p2/app/v1";
import { closeLayers, errorText, openLayer, Sheet, useObject, useReadable } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { SESSIONS_OWNER, Sessions } from "../sessions/contract.ts";
import { back, botName } from "./BotsSheet.tsx";
import type { Binding, Chat, Wake } from "./contract.ts";
import { useFeishu } from "./held.ts";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** Who may wake Pi, as the form edits it: anyone in the chat, or the listed open IDs (one per line). */
type Access = { who: "anyone" | "users"; users: string };

/** Feishu open IDs (`ou_…`), one per line or comma-separated. */
const ids = (text: string): string[] =>
	text
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => /^ou_[0-9a-f]{6,}$/i.test(id));

const accessOf = (wake: Wake): Access => ({ who: wake.anyone ? "anyone" : "users", users: wake.users.join("\n") });

const wakeOf = (access: Access): Wake =>
	access.who === "anyone" ? { anyone: true, users: [] } : { anyone: false, users: ids(access.users) };

/** What is missing for `access` to be saved: someone who may wake Pi. */
const nobody = (access: Access) => access.who === "users" && !ids(access.users).length;

/** Session `session`'s Feishu sheet. */
export function LinkSheet({ session }: { session: string }) {
	const feishu = useFeishu();
	const bindings = useReadable(feishu?.bindings);
	const linked = bindings?.find((binding) => binding.session === session);
	return (
		<Sheet title="Feishu" onClose={closeLayers} onBack={back} className="feishu-sheet">
			{!bindings ? (
				<p className="empty-note">Loading…</p>
			) : linked ? (
				<Linked binding={linked} />
			) : (
				<LinkForm session={session} bindings={bindings} />
			)}
		</Sheet>
	);
}

/** Who may wake Pi: anyone in the chat, or the listed users. */
function WakeFields({
	access,
	update,
	chatType,
}: {
	access: Access;
	update: (patch: Partial<Access>) => void;
	chatType: Chat["type"] | undefined;
}) {
	return (
		<>
			<span className="label">Who may wake Pi</span>
			<label className="check">
				<input type="radio" checked={access.who === "anyone"} onChange={() => update({ who: "anyone" })} />
				{chatType === "p2p" ? "The person in this chat" : "Anyone in the chat"}
			</label>
			<label className="check">
				<input type="radio" checked={access.who === "users"} onChange={() => update({ who: "users" })} />
				Only these users
			</label>
			{access.who === "users" && (
				<label className="field feishu-indent">
					<span className="label">Open IDs</span>
					<textarea
						className="input mono"
						rows={2}
						placeholder="ou_…, one per line"
						value={access.users}
						onChange={(event) => update({ users: event.target.value })}
						{...NO_AUTOCORRECT}
					/>
					<span className="muted small">
						A person's open ID is in the batch Pi receives (`Name (&lt;ou_…&gt;)`), and in the Feishu admin
						console.
					</span>
				</label>
			)}
			{chatType === "group" && (
				<p className="muted small">In a group, a message wakes Pi only when it mentions the bot.</p>
			)}
		</>
	);
}

/** A linked session: the bot and chat (fixed), who may wake Pi (saved in place), and Unlink. */
function Linked({ binding }: { binding: Binding }) {
	const feishu = useFeishu();
	const bot = useReadable(feishu?.bots)?.find((each) => each.id === binding.botId);
	const saved = accessOf(binding.wake);
	const [edited, setEdited] = useState<Access>();
	const access = edited ?? saved;
	const changed = edited !== undefined && JSON.stringify(edited) !== JSON.stringify(saved);
	const [busy, setBusy] = useState<"saving" | "unlinking">();
	const [error, setError] = useState<string>();
	const [note, setNote] = useState<string>();
	const run = (kind: "saving" | "unlinking", operation: () => Promise<unknown>, done?: () => void) => {
		setBusy(kind);
		setError(undefined);
		setNote(undefined);
		operation()
			.then(done, (reason: unknown) => setError(errorText(reason)))
			.finally(() => setBusy(undefined));
	};
	return (
		<form
			className="stack feishu-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!feishu || !changed || nobody(access)) return;
				run(
					"saving",
					() => feishu.updateLink({ session: binding.session, wake: wakeOf(access) }, BACKGROUND_CONTEXT),
					() => {
						setEdited(undefined);
						setNote("Saved: in effect now.");
					},
				);
			}}
		>
			<p className="muted small">
				{binding.chatType === "group"
					? "Mentioning the bot in the group wakes this session; its answer is posted as the reply."
					: "A message to the bot wakes this session; its answer is posted as the reply."}
			</p>
			<div className="list">
				<div className="feishu-row">
					<span>Bot</span>
					<small className="row-value">{bot ? botName(bot) : "Removed"}</small>
				</div>
				<div className="feishu-row">
					<span>{binding.chatType === "group" ? "Group" : "Direct chat"}</span>
					<small className="row-value">{binding.chatName}</small>
				</div>
			</div>
			<WakeFields
				access={access}
				update={(patch) => setEdited({ ...access, ...patch })}
				chatType={binding.chatType}
			/>
			{error && <output className="notice error">{error}</output>}
			{note && <output className="notice">{note}</output>}
			<div className="inline-form">
				<button
					type="submit"
					className="button primary"
					disabled={busy !== undefined || !changed || nobody(access)}
				>
					{busy === "saving" ? "Saving…" : "Save"}
				</button>
				{changed && (
					<button type="button" className="text-action" onClick={() => setEdited(undefined)}>
						Undo changes
					</button>
				)}
			</div>
			<div className="list">
				<button
					type="button"
					className="row-button danger"
					disabled={busy !== undefined || !feishu}
					onClick={() =>
						feishu && run("unlinking", () => feishu.unlink({ session: binding.session }, BACKGROUND_CONTEXT))
					}
				>
					<span>{busy === "unlinking" ? "Unlinking…" : "Unlink"}</span>
				</button>
			</div>
		</form>
	);
}

/** The chats `bot` can be linked to (undefined until loaded), and why they could not be read. */
function useChats(bot: string | undefined) {
	const feishu = useFeishu();
	const [chats, setChats] = useState<{ bot: string; value: Chat[] }>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!feishu || !bot) return;
		let current = true;
		feishu.chats({ bot }, BACKGROUND_CONTEXT).then(
			(value) => {
				if (current) setChats({ bot, value });
			},
			(reason: unknown) => {
				if (current) setError(errorText(reason));
			},
		);
		return () => {
			current = false;
		};
	}, [feishu, bot]);
	return { chats: chats !== undefined && chats.bot === bot ? chats.value : undefined, error };
}

function LinkForm({ session, bindings }: { session: string; bindings: readonly Binding[] }) {
	const feishu = useFeishu();
	const bots = (useReadable(feishu?.bots) ?? []).filter((bot) => bot.status.state === "connected");
	const sessions = useReadable(liveWith(useObject(Sessions, {}), ...SESSIONS_OWNER)?.sessions) ?? [];
	const [chosenBot, setChosenBot] = useState("");
	const [chatId, setChatId] = useState("");
	const [access, setAccess] = useState<Access>({ who: "anyone", users: "" });
	const [linkError, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const bot = bots.find((each) => each.id === (chosenBot || (bots.length === 1 ? bots[0]?.id : "")));
	const { chats, error: chatsError } = useChats(bot?.id);
	const chat = chats?.find((each) => each.id === chatId);
	const error = linkError ?? chatsError;
	const takenBy = (id: string) => {
		const owner = bindings.find((binding) => binding.chatId === id);
		return owner && (sessions.find((each) => each.id === owner.session)?.title ?? "another session");
	};
	const missing = [
		!bot && "a bot",
		bot && (!chat || takenBy(chat.id)) && "a chat",
		nobody(access) && "who may wake Pi",
	].filter((entry): entry is string => Boolean(entry));
	const groups = chats?.filter((each) => each.type === "group") ?? [];
	const direct = chats?.filter((each) => each.type === "p2p") ?? [];
	return (
		<form
			className="stack feishu-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!feishu || !bot || !chat || missing.length) return;
				setBusy(true);
				setError(undefined);
				feishu
					.link({ session, bot: bot.id, chat: chat.id, wake: wakeOf(access) }, BACKGROUND_CONTEXT)
					.catch((reason: unknown) => setError(errorText(reason)))
					.finally(() => setBusy(false));
			}}
		>
			<p className="muted small">
				Link this session to a Feishu chat: a message there wakes it (in a group, one that mentions the bot), and
				its answer goes back as the reply. The session keeps working where it is now.
			</p>
			<div className="field">
				<span className="label">Bot</span>
				{bots.length ? (
					<select
						className="input"
						aria-label="Bot"
						value={bot?.id ?? ""}
						onChange={(event) => {
							setChosenBot(event.target.value);
							setChatId("");
						}}
					>
						{bots.length > 1 && <option value="">Pick a bot</option>}
						{bots.map((each) => (
							<option key={each.id} value={each.id}>
								{botName(each)}
							</option>
						))}
					</select>
				) : (
					<span className="muted small">
						No connected bot.{" "}
						<button
							type="button"
							className="text-action"
							onClick={() => openLayer({ kind: "sheet", name: "feishu" }, { fromDrawer: true })}
						>
							Add one under Feishu
						</button>
					</span>
				)}
			</div>
			{bot && (
				<label className="field">
					<span className="label">Chat</span>
					<select className="input" value={chatId} onChange={(event) => setChatId(event.target.value)}>
						<option value="">{chats ? "Pick a chat" : "Loading chats…"}</option>
						{groups.length > 0 && (
							<optgroup label="Groups">
								{groups.map((each) => {
									const taken = takenBy(each.id);
									return (
										<option key={each.id} value={each.id} disabled={Boolean(taken)}>
											{each.name}
											{taken ? ` (taken: ${taken})` : ""}
										</option>
									);
								})}
							</optgroup>
						)}
						{direct.length > 0 && (
							<optgroup label="Direct chats">
								{direct.map((each) => {
									const taken = takenBy(each.id);
									return (
										<option key={each.id} value={each.id} disabled={Boolean(taken)}>
											{each.name}
											{taken ? ` (taken: ${taken})` : ""}
										</option>
									);
								})}
							</optgroup>
						)}
					</select>
					{chats && !chats.length && (
						<span className="muted small">
							No chats yet: add the bot to a group, or send it a direct message, then reopen this sheet.
						</span>
					)}
					{chats && chats.length > 0 && !direct.length && (
						<span className="muted small">A direct chat shows here once you have written to the bot.</span>
					)}
				</label>
			)}
			<WakeFields
				access={access}
				update={(patch) => setAccess((current) => ({ ...current, ...patch }))}
				chatType={chat?.type}
			/>
			{error && <output className="notice error">{error}</output>}
			<button type="submit" className="button primary" disabled={busy || missing.length > 0 || !feishu}>
				{busy ? "Linking…" : "Link"}
			</button>
			{missing.length > 0 && <p className="muted small">Still to pick: {missing.join(", ")}.</p>}
		</form>
	);
}
