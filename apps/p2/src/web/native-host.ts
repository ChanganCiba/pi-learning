// p2-mac's bridge, when this page runs in its window: `window.webkit.messageHandlers.piHost` (HostBridge.swift). Each
// message is answered with a reply; what the app answers is page input to it, checked here.

import type { ThemePreference } from "./theme.ts";

/** The messages the app answers; `choose-folder` opens the system's folder dialog over the window. */
export type HostMessage =
	| { type: "theme" }
	| { type: "set-theme"; preference: ThemePreference }
	| { type: "choose-folder"; path: string };

export type PiHost = { postMessage(message: HostMessage): unknown };

/** The bridge, when this page runs in p2-mac. */
export function nativeHost(): PiHost | undefined {
	return (window as { webkit?: { messageHandlers?: { piHost?: PiHost } } }).webkit?.messageHandlers?.piHost;
}

/**
 * Opens the system's folder dialog starting at `path`; the chosen folder's path, or null when cancelled or when this
 * page does not run in p2-mac.
 */
export async function chooseFolder(path: string): Promise<string | null> {
	const host = nativeHost();
	if (!host) return null;
	try {
		const answer = (await host.postMessage({ type: "choose-folder", path })) as { path?: unknown } | null;
		return typeof answer?.path === "string" ? answer.path : null;
	} catch {
		return null;
	}
}
