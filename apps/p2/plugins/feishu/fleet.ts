// The owner's Feishu bots (server, a native of `FeishuStore`): their credentials in `<data>/feishu.json` (0600), one
// connected `Bot` each, their views, and what they all receive in one queue (oldest first) for the store's routine.
import { randomBytes } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalText } from "@p2/app/v1/node";
import { Bot, type BotEvent } from "./bot.ts";
import type { BotView } from "./contract.ts";

/** feishu.json: each app's credentials by p2's ID for it. */
type BotsFile = { bots: Record<string, { appId: string; appSecret: string; addedAt: number }> };

/** What a bot of the fleet received (a message, or its (re)connection), and which bot. */
export type Received = { bot: string; event: BotEvent };

export class Fleet {
	readonly #path: string;
	readonly #file: BotsFile;
	readonly #bots = new Map<string, Bot>();
	readonly #listeners = new Set<() => void>();
	readonly #queue: Received[] = [];
	readonly #waiters = new Set<() => void>();
	readonly #report: (error: string) => void;

	private constructor(path: string, file: BotsFile, report: (error: string) => void) {
		this.#path = path;
		this.#file = file;
		this.#report = report;
	}

	/** The fleet of `dataDir`'s feishu.json, each bot connecting in the background. */
	static async open(dataDir: string, report: (error: string) => void): Promise<Fleet> {
		const path = join(dataDir, "feishu.json");
		const fleet = new Fleet(path, parseBots(await optionalText(path), report), report);
		for (const [id, { appId, appSecret }] of Object.entries(fleet.#file.bots))
			void fleet.#start(id).connect(appId, appSecret);
		return fleet;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	/** Every bot with its status, oldest first. */
	views(): BotView[] {
		return Object.entries(this.#file.bots)
			.sort(([, a], [, b]) => a.addedAt - b.addedAt)
			.map(([id]) => ({ id, status: this.#bots.get(id)?.status ?? { state: "connecting" as const } }));
	}

	/** Bot `id` while it is connected. */
	connected(id: string): Bot | undefined {
		const bot = this.#bots.get(id);
		return bot?.connected ? bot : undefined;
	}

	/** Connects a new app and keeps it once Feishu accepted it: its ID. */
	async add(appId: string, appSecret: string): Promise<string> {
		if (Object.values(this.#file.bots).some((entry) => entry.appId === appId))
			throw new Error("This app is added already");
		const id = `f${randomBytes(4).toString("hex")}`;
		const bot = this.#candidate(id);
		const status = await bot.connect(appId, appSecret);
		if (status.state !== "connected") {
			bot.close();
			throw new Error(status.state === "error" ? status.error : "Feishu did not answer");
		}
		this.#adopt(id, bot);
		this.#file.bots[id] = { appId, appSecret, addedAt: Date.now() };
		await this.#save();
		this.#changed();
		return id;
	}

	/** Disconnects and forgets bot `id`. */
	async remove(id: string): Promise<void> {
		this.#bots.get(id)?.close();
		this.#bots.delete(id);
		delete this.#file.bots[id];
		await this.#save();
		this.#changed();
	}

	/** The next received event, or undefined when `signal` aborts. */
	async next(signal: AbortSignal): Promise<Received | undefined> {
		while (!signal.aborted) {
			const received = this.#queue.shift();
			if (received) return received;
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#waiters.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				this.#waiters.add(wake);
				signal.addEventListener("abort", wake, { once: true });
			});
		}
		return undefined;
	}

	close(): void {
		for (const bot of this.#bots.values()) bot.close();
		this.#bots.clear();
	}

	/** A bot `id` that is not one of the fleet's yet (credentials being tried); it delivers once adopted. */
	#candidate(id: string): Bot {
		const bot: Bot = new Bot(
			(event) => {
				if (this.#bots.get(id) === bot) this.#push({ bot: id, event });
			},
			(error) => this.#report(`bot ${id}: ${error}`),
		);
		return bot;
	}

	/** Makes `bot` the fleet's bot `id`; one connected already catches up at once. */
	#adopt(id: string, bot: Bot): void {
		this.#bots.set(id, bot);
		bot.subscribe(() => this.#changed());
		if (bot.connected) this.#push({ bot: id, event: { kind: "ready" } });
	}

	#push(received: Received): void {
		this.#queue.push(received);
		for (const wake of [...this.#waiters]) wake();
	}

	#start(id: string): Bot {
		const bot = this.#candidate(id);
		this.#adopt(id, bot);
		return bot;
	}

	async #save(): Promise<void> {
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#file, null, "\t")}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, this.#path);
	}
}

/** feishu.json (a trust boundary: the owner may edit it): the bots. Unreadable: no bots, reported. */
function parseBots(text: string | undefined, report: (error: string) => void): BotsFile {
	if (!text?.trim()) return { bots: {} };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		report("feishu.json is not valid JSON; no bots run");
		return { bots: {} };
	}
	const bots: BotsFile["bots"] = {};
	const listed =
		value && typeof value === "object" && "bots" in value && value.bots && typeof value.bots === "object"
			? value.bots
			: {};
	for (const [id, entry] of Object.entries(listed))
		if (
			entry &&
			typeof entry === "object" &&
			typeof entry.appId === "string" &&
			entry.appId &&
			typeof entry.appSecret === "string" &&
			entry.appSecret
		)
			bots[id] = {
				appId: entry.appId,
				appSecret: entry.appSecret,
				addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
			};
	return { bots };
}
