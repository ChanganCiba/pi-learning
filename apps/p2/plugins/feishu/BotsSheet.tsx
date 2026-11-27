// The owner's Feishu bots (Settings › Feishu): the list with each bot's status, adding one by its app's credentials,
// and a bot's own sheet (identity, its linked sessions read-only, removing it). Linking a session to a chat happens
// from the session (LinkSheet.tsx), not here.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	ChevronIcon,
	closeLayers,
	errorText,
	getNavigation,
	navigate,
	openLayer,
	Sheet,
	useObject,
	useReadable,
} from "@p2/app/v1/web";
import { useState } from "react";
import { Sessions } from "../sessions/contract.ts";
import type { BotStatus, BotView } from "./contract.ts";
import { useFeishu } from "./held.ts";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** Back to the sheet below (the header's Back). */
export const back = () => void getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, -1) }));

/** A bot's name: its Feishu app's once connected. */
export function botName(bot: BotView): string {
	return bot.status.state === "connected" ? bot.status.name : "Feishu bot";
}

/** What a bot's row says of its status. */
function statusText(status: BotStatus): string {
	if (status.state === "connecting") return "Connecting…";
	if (status.state === "error") return "Not connected";
	return "Connected";
}

/** Settings › Feishu: the bots, and Add bot. */
export function BotsSheet() {
	const bots = useReadable(useFeishu()?.bots);
	return (
		<Sheet title="Feishu" onClose={closeLayers} className="feishu-sheet">
			<div className="list">
				<span className="label">Bots</span>
				{bots?.map((bot) => (
					<button
						type="button"
						key={bot.id}
						className="row-button"
						onClick={() => openLayer({ kind: "sheet", name: "feishu-bot", locator: bot.id })}
					>
						<span>{botName(bot)}</span>
						<small className="row-value">{statusText(bot.status)}</small>
						<ChevronIcon />
					</button>
				))}
				{bots && !bots.length && <p className="empty-note">No bots yet.</p>}
				<button
					type="button"
					className="row-button"
					onClick={() => openLayer({ kind: "sheet", name: "feishu-add" })}
				>
					<span>Add bot</span>
					<ChevronIcon />
				</button>
			</div>
			<p className="muted small feishu-hint">
				To let a chat talk to a session, open the session's sheet and choose Feishu.
			</p>
		</Sheet>
	);
}

/** Add bot: the app's ID and secret, Connect; once Feishu accepts them, the bot's sheet replaces this one. */
export function AddBotSheet() {
	const feishu = useFeishu();
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const ready = appId.trim().length >= 4 && appSecret.trim().length >= 8;
	return (
		<Sheet title="Add bot" onClose={closeLayers} onBack={back} className="feishu-sheet">
			<ol className="feishu-steps muted small">
				<li>
					At{" "}
					<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
						open.feishu.cn/app
					</a>{" "}
					create a custom app and turn on its Bot capability.
				</li>
				<li>
					Permissions: <span className="mono">im:message</span>,{" "}
					<span className="mono">im:message.group_at_msg:readonly</span>,{" "}
					<span className="mono">im:message.p2p_msg:readonly</span>, <span className="mono">im:resource</span>.
				</li>
				<li>
					Events: receive them over a <strong>long connection</strong>, and subscribe to{" "}
					<span className="mono">im.message.receive_v1</span>. Publish the app.
				</li>
				<li>Paste the App ID and App Secret from Credentials.</li>
			</ol>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (!feishu || busy || !ready) return;
					setBusy(true);
					setError(undefined);
					feishu.addBot({ appId: appId.trim(), appSecret: appSecret.trim() }, BACKGROUND_CONTEXT).then(
						({ id }) => {
							const nav = getNavigation();
							void nav.replace({
								...nav.route,
								layers: [...nav.route.layers.slice(0, -1), { kind: "sheet", name: "feishu-bot", locator: id }],
							});
						},
						(reason: unknown) => {
							setError(errorText(reason));
							setBusy(false);
						},
					);
				}}
			>
				<input
					className="input mono"
					autoComplete="off"
					aria-label="App ID"
					placeholder="App ID (cli_…)"
					value={appId}
					onChange={(event) => setAppId(event.target.value)}
					{...NO_AUTOCORRECT}
				/>
				<input
					className="input mono"
					type="password"
					autoComplete="off"
					aria-label="App Secret"
					placeholder="App Secret"
					value={appSecret}
					onChange={(event) => setAppSecret(event.target.value)}
					{...NO_AUTOCORRECT}
				/>
				{error && <output className="notice error">{error}</output>}
				<button type="submit" className="button primary" disabled={busy || !ready}>
					{busy ? "Connecting…" : "Connect"}
				</button>
			</form>
		</Sheet>
	);
}

/** A bot's sheet: who it is, its linked sessions, removing it. */
export function BotSheet({ id }: { id: string }) {
	const feishu = useFeishu();
	const bots = useReadable(feishu?.bots);
	const bindings = useReadable(feishu?.bindings) ?? [];
	const sessions = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions) ?? [];
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [removing, setRemoving] = useState(false);
	const bot = bots?.find((each) => each.id === id);
	if (!bot)
		return (
			<Sheet title="Bot" onClose={closeLayers} onBack={back} className="feishu-sheet">
				<p className="empty-note">{bots ? "This bot is gone." : "Loading…"}</p>
			</Sheet>
		);
	const status = bot.status;
	const links = bindings.filter((binding) => binding.botId === id);
	return (
		<Sheet title={botName(bot)} onClose={closeLayers} onBack={back} className="feishu-sheet">
			<p className="muted small">
				{status.state === "connected"
					? `Connected as ${status.name} (${status.appId}).`
					: status.state === "connecting"
						? "Connecting…"
						: status.error}
			</p>
			<p className="muted small">
				Add the bot to a group from the group's settings, or write to it directly; then link a session to that chat
				from the session's sheet.
			</p>
			<div className="list">
				<span className="label">Linked sessions</span>
				{links.map((binding) => {
					const session = sessions.find((each) => each.id === binding.session);
					return (
						<button
							type="button"
							key={binding.chatId}
							className="row-button"
							onClick={() => navigate({ session: binding.session, conversation: session?.main ?? 1 })}
						>
							<span>{binding.chatName}</span>
							<small className="row-value">{session?.title ?? binding.session}</small>
							<ChevronIcon />
						</button>
					);
				})}
				{!links.length && <p className="empty-note">None. Link a session from its sheet.</p>}
			</div>
			{error && <output className="notice error">{error}</output>}
			<div className="list">
				{removing ? (
					<div className="stack">
						<p className="muted small">
							Remove {botName(bot)}?
							{links.length
								? ` Its ${links.length} linked session${links.length === 1 ? " is" : "s are"} unlinked.`
								: ""}
						</p>
						<div className="inline-form">
							<button
								type="button"
								className="button danger"
								disabled={busy}
								onClick={() => {
									if (!feishu) return;
									setBusy(true);
									setError(undefined);
									feishu
										.removeBot({ bot: id }, BACKGROUND_CONTEXT)
										.then(back, (reason: unknown) => setError(errorText(reason)))
										.finally(() => setBusy(false));
								}}
							>
								Remove
							</button>
							<button type="button" className="text-action" onClick={() => setRemoving(false)}>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button type="button" className="row-button danger" onClick={() => setRemoving(true)}>
						<span>Remove bot</span>
					</button>
				)}
			</div>
		</Sheet>
	);
}
