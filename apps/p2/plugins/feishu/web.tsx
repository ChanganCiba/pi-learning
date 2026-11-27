// The feishu plugin's web facet: Settings › Feishu (the owner's bots, BotsSheet.tsx), the Session sheet's Feishu row
// and the session's link sheet (LinkSheet.tsx), and the transcript's note on a delivered batch. The sheets render from
// the sidebar foot's slot, which stays mounted while they stack on the Session sheet.
import { contribute, defineFacet } from "@p2/app/v1";
import {
	ChevronIcon,
	openLayer,
	SettingsSections,
	Slots,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { TranscriptEntries } from "../chat/contract.ts";
import { AddBotSheet, BotSheet, BotsSheet } from "./BotsSheet.tsx";
import { FEISHU_BATCH, Feishu } from "./contract.ts";
import { HeldFeishu } from "./held.ts";
import { LinkSheet } from "./LinkSheet.tsx";
import "./style.css";

/**
 * Every Feishu sheet on top: the bots' as a page of Settings, a session's link on its own. Mounted from the page's
 * start, it holds the owner's `Feishu` for them (`held.ts`): they open without a round trip.
 */
function FeishuSheets() {
	const list = useSheet("feishu");
	const add = useSheet("feishu-add");
	const bot = useSheet("feishu-bot");
	const link = useSheet("feishu-link");
	const owner = useOwner();
	const feishu = useObject(Feishu, owner ? {} : undefined);
	if (!owner) return null;
	return (
		<HeldFeishu.Provider value={feishu}>
			{list && <BotsSheet />}
			{add && <AddBotSheet />}
			{bot?.locator && <BotSheet id={bot.locator} />}
			{link?.locator && <LinkSheet session={link.locator} />}
		</HeldFeishu.Provider>
	);
}

/** The Session sheet's Feishu row: the session's chat, or "Not linked". */
function SessionRow() {
	const session = useRoute().session;
	const bindings = useReadable(useObject(Feishu, {})?.bindings);
	if (!session) return null;
	const linked = bindings?.find((binding) => binding.session === session);
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => openLayer({ kind: "sheet", name: "feishu-link", locator: session })}
		>
			<span>Feishu</span>
			<small className="row-value">{linked ? linked.chatName : "Not linked"}</small>
			<ChevronIcon />
		</button>
	);
}

/** A batch's note in the transcript: where it came from. */
function batchDisplay(data: unknown) {
	const feishu = (data as { feishu?: { chat?: unknown; chatType?: unknown; messages?: unknown } } | null)?.feishu;
	if (!feishu || typeof feishu.chat !== "string") return undefined;
	const where = feishu.chatType === "group" ? `group ${feishu.chat}` : `chat with ${feishu.chat}`;
	const count = typeof feishu.messages === "number" ? feishu.messages : 0;
	return { note: `Feishu ${where} · ${count} message${count === 1 ? "" : "s"}` };
}

export default defineFacet((host) => {
	contribute(host, "p2.web-feishu", (self) => {
		self.contribute(SettingsSections, { feishu: { label: "Feishu", order: 61, Sheet: FeishuSheets } });
		self.contribute(Slots, { "session-rows:feishu": SessionRow });
		self.contribute(TranscriptEntries, { [FEISHU_BATCH]: batchDisplay });
	});
});
