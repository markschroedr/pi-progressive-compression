import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import { estimateTokens, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const LINE_BYTES = 1000;
type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
export type Exchange = { id: string; sourceIds: string[]; text: string; tokens: number; messages: Message[]; checkpoint?: boolean };
export const identity = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
const PREVIEW = 2000, REPORT = 6000;
export function clip(text: string, chars = PREVIEW): string {
	if (text.length <= chars) return text;
	const half = Math.floor(chars / 2);
	return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(-half)}`;
}
function clipValues(value: unknown): unknown {
	if (typeof value === "string") return clip(value);
	if (Array.isArray(value)) return value.map(clipValues);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clipValues(value)]));
	return value;
}
/** Writer view with provenance. User and visible assistant text stay whole; tool results are numbered previews
 * that the writer may expand; historical thinking is omitted. Only real user messages carry the [User] label. */
export function render(messages: readonly Message[], expand: ReadonlySet<number> = new Set(), expandChars = 40000, ids?: readonly string[]): string {
	const parts: string[] = [];
	let result = 0;
	for (const [index, message] of messages.entries()) {
		if (message.role === "user") { const text = contentText(message.content, ""); if (text) parts.push(`[User${ids ? ` @${ids[index]}` : ""}]: ${text}`); }
		else if (message.role === "custom") { const text = contentText(message.content, ""); if (text) parts.push(`[Notification ${message.customType}]: ${clip(text, REPORT)}`); }
		else if (message.role === "bashExecution") { if (!message.excludeFromContext) parts.push(`[User shell command]: ${message.command}\n${clip(message.output)}`); }
		else if (message.role === "branchSummary") parts.push(`[Branch summary]: ${message.summary}`);
		else if (message.role === "assistant") {
			const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
			if (text.trim()) parts.push(`[Assistant]: ${text}`);
			const calls = message.content.flatMap(block => block.type === "toolCall" ? [`${block.name}(${JSON.stringify(clipValues(block.arguments))})`] : []);
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			result++;
			parts.push(`[Tool result ${result}: ${message.toolName}${message.isError ? ", error" : ""}]: ${clip(contentText(message.content, ""), expand.has(result) ? expandChars : PREVIEW)}`);
		}
	}
	return parts.join("\n\n");
}
/** Reconciliation view: user messages carry @ids that edits may cite as evidence. sourceIds parallel messages. */
export const citable = (exchange: Exchange) => exchange.checkpoint ? exchange.text : render(exchange.messages, new Set(), undefined, exchange.sourceIds);
/** Cutover mode: can be removed after rollout, or kept for other users adopting continuous context. */
export function legacyCheckpoint(branch: readonly SessionEntry[]) {
	const checkpoint = branch.findLast(entry => entry.type === "compaction" && !(entry.details as { continuousContext?: unknown })?.continuousContext);
	if (checkpoint?.type !== "compaction") return;
	// Detailed checkpoints cover through summaryEndEntryId (exclusive); native checkpoints use firstKeptEntryId.
	const boundary = (checkpoint.details as { retention?: { summaryEndEntryId?: string } })?.retention?.summaryEndEntryId ?? checkpoint.firstKeptEntryId;
	const start = branch.findIndex(entry => entry.id === boundary);
	if (start < 0 || start > branch.indexOf(checkpoint) || !checkpoint.summary.trim()) return;
	return { checkpoint, start };
}
/** Group each checkpoint section into ordinary bounded lines, without a model call. */
export function checkpointParts(summary: string): string[] {
	const parts: string[] = [], headings: string[] = [];
	// Match the ordinary merge target: 80% of the shared line budget, not a separate cutover threshold.
	const targetBytes = Math.floor(LINE_BYTES * 0.8);
	let block: string[] = [], section: string[] = [];
	const emit = (blocks: string[], heading: string) => {
		let prefix = heading ? `${heading}: ` : "";
		if (Buffer.byteLength(prefix, "utf8") > LINE_BYTES / 2) { emit([heading], ""); prefix = ""; }
		let line = prefix;
		const flush = () => { if (line !== prefix) parts.push(line); line = prefix; };
		for (const block of blocks) {
			const text = block.trim().replace(/\s+/gu, " ");
			if (Buffer.byteLength(prefix + text, "utf8") <= LINE_BYTES) {
				const separator = line === prefix ? "" : " ";
				// Keep whole bullets together; allow the last bullet to borrow up to the ordinary hard cap.
				if (Buffer.byteLength(line, "utf8") >= targetBytes || Buffer.byteLength(line + separator + text, "utf8") > LINE_BYTES) flush();
				line += (line === prefix ? "" : " ") + text;
				continue;
			}
			flush();
			// Only an oversized individual block needs word/Unicode-boundary splitting.
			for (const word of text.split(" ")) {
				const separator = line === prefix ? "" : " ";
				if (Buffer.byteLength(line + separator + word, "utf8") <= LINE_BYTES) { line += separator + word; continue; }
				flush();
				for (const character of word) {
					if (Buffer.byteLength(line + character, "utf8") > LINE_BYTES) flush();
					line += character;
				}
			}
		}
		flush();
	};
	const flushBlock = () => { if (block.length) section.push(block.join(" ")); block = []; };
	const flush = () => { flushBlock(); if (section.length) emit(section, headings.filter(Boolean).join(" > ")); section = []; };
	for (const line of summary.split(/\r?\n/u)) {
		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (heading) { flush(); headings.length = heading[1].length; headings[heading[1].length - 1] = heading[2].trim(); }
		else if (!line.trim()) flushBlock();
		else { if (/^(?:[-*+]|\d+[.)])\s/u.test(line)) flushBlock(); block.push(line.trim()); }
	}
	flush();
	return parts;
}
/** Raw post-checkpoint exchanges; archived originals before the checkpoint stay on disk. */
export function exchanges(branch: readonly SessionEntry[]): Exchange[] {
	const adoption = legacyCheckpoint(branch);
	const result: Exchange[] = adoption ? checkpointParts(adoption.checkpoint.summary).map((text, index) => ({
		id: `checkpoint:${adoption.checkpoint.id}:${identity([String(index), text])}`, sourceIds: [adoption.checkpoint.id], text,
		tokens: Math.ceil(text.length / 4), messages: [], checkpoint: true,
	})) : [];
	if (adoption) branch = branch.slice(adoption.start);
	let ids: string[] = [], messages: ReturnType<typeof sessionEntryToContextMessages> = [], tokens = 0;
	const pending = new Set<string>();
	const flush = () => {
		if (!ids.length) return;
		result.push({ id: identity(ids), sourceIds: ids, text: render(messages), tokens, messages });
		ids = []; messages = []; tokens = 0;
	};
	const results = new Set(branch.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
	for (const entry of branch) {
		if (entry.type === "compaction" || entry.type === "context_edit") continue;
		for (let message of sessionEntryToContextMessages(entry)) {
			if (message.role === "system") continue;
			if (message.role === "user" && pending.size === 0) flush();
			if (message.role === "assistant") {
				if (message.stopReason === "aborted" || message.stopReason === "error") message = { ...message, content: message.content.filter(block => block.type !== "toolCall" || results.has(block.id)) };
				for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
			}
			if (message.role === "toolResult") pending.delete(message.toolCallId);
			ids.push(entry.id); messages.push(message); tokens += estimateTokens(message);
			// User input is its own exchange. Agent work ends only at complete step boundaries.
			if (pending.size === 0 && (message.role === "user" || tokens >= 10000)) flush();
		}
	}
	// An incomplete step cannot acquire a stable line yet.
	if (pending.size === 0) flush();
	return result;
}

export function originalText(branch: readonly SessionEntry[], sourceIds: readonly string[]): string {
	const ids = new Set(sourceIds);
	// Pi's summary serializer clips each tool result. Zoom must page the lossless original instead.
	return branch.filter(entry => ids.has(entry.id)).map(entry => JSON.stringify({ id: entry.id, messages: sessionEntryToContextMessages(entry) })).join("\n");
}
