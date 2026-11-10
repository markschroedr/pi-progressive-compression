import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { legacyCheckpoint } from "./history.ts";

export const MODE = "continuous-context.mode";
export const CONFIG = "continuous-context.config";
export type Mode = "continuous" | "native";
export function contextMode(branch: readonly SessionEntry[]): Mode {
	const entry = branch.findLast(entry => entry.type === "custom" && entry.customType === MODE);
	return entry?.type === "custom" && (entry.data as { mode?: string })?.mode === "continuous" ? "continuous" : "native";
}
// Unselected existing chats adopt at reorganization; explicit native mode always wins.
export function adoptAtReorganization(branch: readonly SessionEntry[]): boolean {
	return !branch.some(entry => entry.type === "custom" && entry.customType === MODE)
		&& !!legacyCheckpoint(branch);
}
export type Config = { writer: string; lo: number; hi: number; lines: number; protectLatestRun: number; midRun: boolean };
export const defaults: Config = { writer: "current", lo: 60000, hi: 200000, lines: 40000, protectLatestRun: 40000, midRun: true };
/** Context allocations follow the configured budgets; protocol and writer limits do not. */
export function budgets(config: Config) {
	const remaining = config.lo - config.lines, span = config.hi - config.lo;
	return {
		history: config.lines,
		remaining,
		recent: Math.max(1, Math.floor(remaining * 0.4)),
		// Whole-history preparation takes tens of seconds; reserve half the span for it to finish.
		backgroundStart: Math.floor(config.lo + span / 2),
		coldStart: Math.floor(config.lo + span / 2),
		newerTokens: config.lo,
	};
}
export function configuration(branch: readonly SessionEntry[], _model?: { id: string }): Config {
	const entry = branch.findLast(entry => entry.type === "custom" && entry.customType === CONFIG);
	return validateConfig(entry?.type === "custom" ? entry.data : {});
}
export function validateConfig(value: unknown): Config {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON config object");
	for (const key of Object.keys(value)) if (!(key in defaults)) throw new Error(`Unknown context setting: ${key}`);
	const result = { ...defaults, ...value } as Config;
	if (typeof result.midRun !== "boolean") throw new Error("midRun must be a boolean");
	if (typeof result.writer !== "string" || (result.writer !== "current" && !/^[^/]+\/.+$/.test(result.writer))) throw new Error("Writer must be current or provider/model");
	for (const key of ["lo", "hi", "lines", "protectLatestRun"] as const) {
		if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid context budget: ${key}`);
	}
	if (result.hi <= result.lo || result.lo <= result.lines) throw new Error("Require hi > lo > lines");
	return result;
}
