// The owner's `Feishu` as the page holds it from its start (`FeishuSheets`, always mounted for owners): the plugin's
// sheets read it here, so Settings › Feishu and a session's link sheet show at once instead of holding it anew.
import type { Held } from "@p2/app/v1";
import { createContext, useContext } from "react";
import type { Feishu } from "./contract.ts";

/** The held `Feishu` (undefined for guests and before the page holds it). */
export const HeldFeishu = createContext<Held<typeof Feishu> | undefined>(undefined);

/** The owner's `Feishu` as the page holds it. */
export function useFeishu(): Held<typeof Feishu> | undefined {
	return useContext(HeldFeishu);
}
