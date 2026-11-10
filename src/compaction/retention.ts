import {
	buildSessionProjection, estimateTokens,
	type CompactionEntry, type ContextEditableContent, type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type Message = ReturnType<typeof buildSessionProjection>["messages"][number];
type Item = { id: string; message: Message };
type Edit = NonNullable<CompactionEntry["contextEdits"]>[number];
const marker = "\n[Middle omitted for retention; original remains in session history.]\n";
const codeExtensions = /\.(?:[cm]?[jt]sx?|rs|py|go|java|c|cc|cpp|h|hpp|svelte|vue|swift|sh|sql)$/i;

function clip(text: string, tokens: number): string {
	const chars = Math.max(marker.length, Math.floor(tokens * 4));
	if (text.length <= chars) return text;
	const half = Math.floor((chars - marker.length) / 2);
	return text.slice(0, half) + marker + text.slice(text.length - (chars - marker.length - half));
}
function cost(items: Item[]): number {
	return items.reduce((sum, item) => sum + estimateTokens(item.message), 0);
}
function replace(item: Item, content: ContextEditableContent): Item {
	return { ...item, message: { ...item.message, content } as Message };
}
function textOnly(item: Item, tokens: number): Item | undefined {
	const message = item.message;
	if (!("content" in message)) return item;
	const text = typeof message.content === "string" ? message.content
		: message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	return text ? replace(item, [{ type: "text", text: clip(text, tokens) }]) : undefined;
}
/** One text budget per message, not per block. Non-text attachments stay intact. */
function trimText(item: Item, tokens: number): Item {
	const message = item.message;
	if (!("content" in message)) return item;
	if (typeof message.content === "string") return replace(item, clip(message.content, tokens));
	let length = 0;
	for (const block of message.content) if (block.type === "text") length += block.text.length;
	if (length <= tokens * 4) return item;
	// Preserve block order. Share the cap proportionally across text blocks.
	return replace(item, message.content.map(block => block.type === "text"
		? { ...block, text: clip(block.text, tokens * block.text.length / length) } : block) as ContextEditableContent);
}
function dialogue(items: Item[]): Item[] {
	return items.flatMap(item => {
		switch (item.message.role) {
			case "user": return [trimText(item, 5000)];
			case "assistant": { const text = textOnly(item, 500); return text ? [text] : []; }
			case "toolResult": return [];
			case "custom": return [trimText(item, 2000)];
			default: return [item];
		}
	});
}
/** Never split an assistant call batch from its results, even with interleaved input. */
function exchanges(items: Item[]): Item[][] {
	const groups: Item[][] = [];
	let pending = new Set<string>();
	for (const item of items) {
		if (pending.size === 0) groups.push([]);
		groups.at(-1)!.push(item);
		const m = item.message;
		if (m.role === "assistant") for (const block of m.content) {
			if (block.type === "toolCall") pending.add(block.id);
		}
		if (m.role === "toolResult") pending.delete(m.toolCallId);
	}
	if (pending.size) throw new Error("Cannot compact an unfinished tool batch");
	return groups;
}
function suffix(groups: Item[][], budget: number): Item[] {
	let size = 0, start = groups.length;
	while (start > 0) {
		const next = cost(groups[start - 1]);
		if (size + next > budget) break;
		size += next;
		start--;
	}
	return groups.slice(start).flat();
}
function userTurns(items: Item[]): Item[][] {
	const groups: Item[][] = [];
	for (const item of items) {
		if (item.message.role === "user" || !groups.length) groups.push([]);
		groups.at(-1)!.push(item);
	}
	return groups;
}
function working(items: Item[]): Item[] {
	const batches = exchanges(items);
	const protectedBatch = batches.findLastIndex(batch => batch.some(item => item.message.role === "assistant" && item.message.content.some(block => block.type === "toolCall")));
	return batches.flatMap((batch, index) => {
		const reads = new Map<string, { path: string; offset?: number; limit?: number }>();
		for (const item of batch) if (item.message.role === "assistant") {
			for (const block of item.message.content) if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string")
				reads.set(block.id, block.arguments as { path: string; offset?: number; limit?: number });
		}
		let trimmed = batch.map(item => {
			if (item.message.role !== "toolResult") return item;
			const read = reads.get(item.message.toolCallId);
			// No shell/Code Mode parsing. Mixed or unknown results only get the generic text cap.
			if (index !== protectedBatch && read && codeExtensions.test(read.path) && !item.message.isError) {
				return replace(item, item.message.content.map(block => block.type === "text" ? {
					type: "text", text: `[Code read omitted: ${read.path}, offset=${read.offset ?? 1}, limit=${read.limit ?? "default"}. Original remains in session history.]`,
				} : block));
			}
			return trimText(item, 2000);
		});
		const resultCost = cost(trimmed.filter(item => item.message.role === "toolResult"));
		if (resultCost > 4000) trimmed = trimmed.map(item => item.message.role === "toolResult"
			? trimText(item, 4000 * estimateTokens(item.message) / resultCost) : item);
		return trimmed;
	});
}

/** Aborted responses can persist calls that never ran and therefore have no result.
 * Remove only those calls from the context view; never invent execution results.
 * Completed calls and unfinished non-aborted responses keep their strict pairing.
 */
function withoutAbortedCalls(items: Item[]): Item[] {
	const results = new Set(items.flatMap(item => item.message.role === "toolResult" ? [item.message.toolCallId] : []));
	return items.flatMap(item => {
		const message = item.message;
		if (message.role !== "assistant" || message.stopReason !== "aborted") return [item];
		const content = message.content.filter(block => block.type !== "toolCall" || results.has(block.id));
		if (content.length === message.content.length) return [item];
		return content.length ? [replace(item, content)] : [];
	});
}

/** Continuous mode: older tool results get one 2k text budget; fresh tool rounds stay lossless. */
function continuousWork(items: Item[], protectedIds: Set<string>): Item[] {
	return items.flatMap(item => {
		if (protectedIds.has(item.id)) return [item];
		if (item.message.role === "toolResult") return [trimText(item, 2000)];
		if (item.message.role !== "assistant") return [item];
		const content = item.message.content.filter(block => block.type !== "thinking");
		return content.length ? [replace(item, content as ContextEditableContent)] : [];
	});
}

/** Remove complete unprotected middle groups. Fresh evidence may exceed the soft run cap. */
function capRun(items: Item[], cap: number, protectedIds: Set<string>): Item[] {
	const groups = exchanges(items);
	while (cost(groups.flat()) > cap) {
		const removable = groups.flatMap((group, index) => group.some(item => protectedIds.has(item.id)) ? [] : [index]);
		if (!removable.length) break;
		groups.splice(removable[Math.floor(removable.length / 2)], 1);
	}
	return groups.flat();
}

/** Pure retention policy for the directly retained context. It never decides the summary input:
 * the caller summarizes everything before `recentStartId` (or Pi's cutoff, if later), untrimmed.
 */
export function planRetention(entries: SessionEntry[], budget = 20000, options?: { protectLatestRun: number; latestRunStartId?: string }) {
	const projection = buildSessionProjection(entries);
	const originals: Item[] = projection.entries.flatMap(entry => entry.sourceEntry.type === "compaction" ? []
		: entry.messages.filter(message => message.role !== "system").map(message => ({ id: entry.sourceEntry.id, message })));
	const all = withoutAbortedCalls(originals);
	if (!all.length || budget <= 0) throw new Error("No retention budget or conversation available");
	const recentBudget = Math.floor(budget * 0.4);
	const lastUser = all.findLastIndex(item => item.message.role === "user");
	const batches = exchanges(all);
	const runStart = options?.latestRunStartId ? all.findIndex(item => item.id === options.latestRunStartId) : -1;
	let latestStart = runStart >= 0 ? runStart : lastUser < 0 ? 0 : all.findIndex(item => item.id === batches.find(batch => batch.some(item => item.id === all[lastUser].id))![0].id);
	const protectedIds = new Set<string>();
	if (options) {
		const fresh = batches.filter(batch => batch.some(item => item.message.role === "assistant" && item.message.content.some(block => block.type === "toolCall"))).slice(-3);
		for (const item of fresh.flat()) protectedIds.add(item.id);
		if (lastUser >= 0) protectedIds.add(all[lastUser].id);
		const lastAssistant = all.findLast(item => item.message.role === "assistant");
		if (lastAssistant) protectedIds.add(lastAssistant.id);
		// A new user turn does not expire the three fresh tool rounds from the previous turn.
		const firstProtected = all.findIndex(item => protectedIds.has(item.id));
		if (firstProtected >= 0) latestStart = Math.min(latestStart, firstProtected);
	}
	const latest = all.slice(latestStart);
	const beforeLatest = dialogue(all.slice(0, latestStart));
	let recent: Item[];
	if (options) {
		recent = capRun(continuousWork(latest, protectedIds), options.protectLatestRun, protectedIds);
	} else if (lastUser >= 0 && cost(latest) <= recentBudget) {
		recent = suffix(exchanges(all), recentBudget);
	} else if (lastUser >= 0 && cost(latest) + cost(beforeLatest) <= budget) {
		// Borrow unused dialogue allocation to keep the entire latest turn unchanged.
		recent = latest;
	} else {
		const groups = exchanges(working(all));
		// The freshest complete batch can borrow space, but never break the total budget.
		const newest = cost(groups.at(-1) ?? []);
		recent = suffix(groups, Math.min(budget, Math.max(recentBudget, newest)));
	}
	let boundary = recent.length ? all.findIndex(item => item.id === recent[0].id) : all.length;
	const effectiveBudget = options ? Math.max(budget, cost(recent)) : budget;
	let older = suffix(userTurns(dialogue(all.slice(0, boundary))), effectiveBudget - cost(recent));
	// Lend unused budget to earlier work. Dialogue already selected keeps its space,
	// because the moved span only replaces its own lossy dialogue form.
	const spare = effectiveBudget - cost(older) - cost(recent);
	if (spare > 0 && boundary > 0) {
		const earlier = suffix(exchanges(options ? continuousWork(all.slice(0, boundary), protectedIds) : working(all.slice(0, boundary))), spare);
		if (earlier.length) {
			recent = [...earlier, ...recent];
			boundary = all.findIndex(item => item.id === recent[0].id);
			older = suffix(userTurns(dialogue(all.slice(0, boundary))), effectiveBudget - cost(recent));
		}
	}
	if (options) {
		// Earlier working history can still contain thinking. Keep only fresh signed continuation blocks.
		const dropOldThinking = (items: Item[]) => items.flatMap(item => {
			if (protectedIds.has(item.id) || item.message.role !== "assistant" || !item.message.content.some(block => block.type === "thinking")) return [item];
			const content = item.message.content.filter(block => block.type !== "thinking");
			return content.length ? [replace(item, content as ContextEditableContent)] : [];
		});
		older = dropOldThinking(older);
		recent = dropOldThinking(recent);
	}
	const retained = [...older, ...recent];
	// Continuous mode accepts a longer retained context rather than failing.
	if (!retained.length || (!options && cost(retained) > effectiveBudget)) throw new Error("Cannot fit a complete retained exchange within the retention budget");
	const firstKeptEntryId = retained[0].id;
	const cut = originals.findIndex(item => item.id === firstKeptEntryId);
	const selected = new Map(retained.map(item => [item.id, item]));
	const contextEdits: Edit[] = [];
	for (const original of originals.slice(cut)) {
		const replacement = selected.get(original.id);
		if (!replacement) contextEdits.push({ targetId: original.id, replacement: null });
		else if (JSON.stringify(replacement.message) !== JSON.stringify(original.message)) {
			if (!("content" in replacement.message)) throw new Error("Unsupported retained message edit");
			contextEdits.push({ targetId: original.id, replacement: { content: replacement.message.content as ContextEditableContent } });
		}
	}
	return {
		firstKeptEntryId, contextEdits,
		// Older dialogue is lossy (tool exchanges and thinking omitted), so the summary must cover it.
		recentStartId: recent[0]?.id ?? retained[0].id,
		retainedTokens: cost(retained), dialogueTokens: cost(older), workingTokens: cost(recent),
	};
}
