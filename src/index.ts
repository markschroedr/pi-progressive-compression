import { Type } from "typebox";
import {
	buildSessionProjection, type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { planRetention } from "./compaction/retention.ts";
import { CONFIG, MODE, adoptAtReorganization, budgets, configuration, contextMode, validateConfig } from "./mode.ts";
import { citable, clip, exchanges, originalText, type Exchange } from "./history.ts";
import { LINE_BYTES, STORE, displayedLine, lastView, leaf, leafIds, lineView, parentId, restore, reviseView, sourceDays, updateNodes, viewText, type Archive, type Node } from "./store.ts";
import { leafPrompt, rankHistory, reconcileHistory, writeLeaves, writeParents, type Receipt } from "./writer.ts";
import { conversationTokens, messageTokens, providerScale, textTokens } from "./tokens.ts";

const RUN = "continuous-context.run";
const RECEIPT = "continuous-context.usage.v1";
const PREPARED = "continuous-context.prepared.v1";
type Retention = ReturnType<typeof planRetention>;
type Prepared = {
	boundaryId: string; baseId?: string; config: string; inputs: Node[]; view: Node[];
	retention: Retention; summary: string; historyTokens: number; tokenScale: number; reconciledThroughId?: string; reconciliationComplete?: boolean; preparedAt: number;
};
const checkpointId = (branch: readonly SessionEntry[]) => branch.findLast(entry => entry.type === "compaction")?.id;
// Independent throughput limits, not context allocations.
const MERGE_BATCH = 15, MERGE_CONCURRENCY = 3;
const viewCost = (view: Node[], days: ReadonlyMap<string, string>, scale: number) => textTokens(viewText(view, days), scale);

export default function continuousContext(pi: ExtensionAPI): void {
	let state: ReturnType<typeof restore> | undefined;
	let nodes = new Map<string, Node>();
	let controller = new AbortController();
	let work: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = false, loadedSession: string | undefined, runStartId: string | undefined;
	let inRun = false, runBoundary: string | null = null;
	let registered = false;
	let prepared: Prepared | undefined;
	let backgroundQueued = false, backgroundAgain = false;
	const active = (ctx: ExtensionContext) => contextMode(ctx.sessionManager.getBranch()) === "continuous";
	const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
	const reset = () => { cancelTimer(); controller.abort(); controller = new AbortController(); work = Promise.resolve(); state = undefined; nodes = new Map(); pending = false; runStartId = undefined; inRun = false; runBoundary = null; prepared = undefined; backgroundQueued = false; backgroundAgain = false; };
	const save = (newNodes: Node[]) => {
		const saved = updateNodes(nodes, newNodes, state!.nextRef);
		state!.nodes = [...nodes.values()];
		pi.appendEntry(STORE, { nodes: saved } satisfies Archive);
	};
	// Every writer call is billed, including failed and rejected attempts.
	const record = (receipt: Receipt) => pi.appendEntry(RECEIPT, receipt);
	const load = (ctx: ExtensionContext) => {
		if (!ctx.supportsCompactionCheck) throw new Error("Continuous context requires the Pi 1.4.0 host patch and unbundled entrypoint; see INSTALL.md");
		if (state && loadedSession === ctx.sessionManager.getSessionId()) return;
		reset(); loadedSession = ctx.sessionManager.getSessionId();
		state = restore(ctx.sessionManager); nodes = new Map(state.nodes.map(node => [node.id, node]));
		// Materialize inherited or newly numbered nodes: forks stay self-contained. Unchanged nodes are already stored.
		if (state.unsaved.length) pi.appendEntry(STORE, { nodes: state.unsaved } satisfies Archive);
		const cached = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === PREPARED);
		if (cached?.type === "custom") prepared = cached.data as Prepared;
	};
	const assertCurrent = (ctx: ExtensionContext, signal: AbortSignal, sources: string[]) => {
		signal.throwIfAborted();
		const ids = new Set(ctx.sessionManager.getBranch().map(entry => entry.id));
		if (!active(ctx) || loadedSession !== ctx.sessionManager.getSessionId() || !sources.every(id => ids.has(id))) throw new Error("Line writing belongs to a different branch or mode");
	};
	const enqueue = (operation: () => Promise<void>) => {
		const next = work.then(operation);
		work = next.catch(() => {});
		return next;
	};
	const prepare = async (ctx: ExtensionContext, eligible: Exchange[], signal: AbortSignal, force: boolean, repair = force) => {
		const config = configuration(ctx.sessionManager.getBranch(), ctx.model);
		// Checkpoint parts already fit the ordinary line cap; import them without a writer call.
		const seeds = eligible.filter(exchange => exchange.checkpoint && !nodes.has(exchange.id));
		if (seeds.length) save(seeds.map(exchange => leaf(exchange, exchange.text)));
		const attempted = new Set<string>();
		for (;;) {
			const missing = eligible.filter(exchange => {
				const node = nodes.get(exchange.id);
				return !attempted.has(exchange.id) && (!node || Buffer.byteLength(node.line, "utf8") > LINE_BYTES || (repair && node.provisional));
			});
			if (!missing.length || (!force && missing.length < 10 && !missing.some(exchange => nodes.get(exchange.id)?.provisional))) break;
			const batches: { chunk: Exchange[]; preceding: Node[] }[] = [];
			let offset = 0;
			while (offset < missing.length && batches.length < MERGE_CONCURRENCY) {
				// Leave a second full chunk rather than 15 + a small tail when possible.
				const remaining = missing.length - offset;
				const size = remaining > 20 && remaining < 30 ? 10 : Math.min(15, remaining);
				let chunk = missing.slice(offset, offset + size);
				const first = eligible.findIndex(exchange => exchange.id === chunk[0].id);
				// Parallel chunks still get preceding source context when the preceding summary is not ready.
				const preceding = eligible.slice(Math.max(0, first - 10), first).map(exchange => nodes.get(exchange.id) ?? leaf(exchange, clip(exchange.text, LINE_BYTES)));
				// Bound source tokens, not output.
				while (Buffer.byteLength(leafPrompt(chunk, preceding), "utf8") > 80000 && chunk.length > 1) chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
				batches.push({ chunk, preceding }); offset += chunk.length;
				for (const exchange of chunk) attempted.add(exchange.id);
			}
			await Promise.all(batches.map(async ({ chunk, preceding }) => {
				// Bound only an oversized writer copy; zoom keeps the lossless original.
				const writerInput = chunk.map(exchange => exchange.text.length > 400000
					? { ...exchange, text: `${exchange.text.slice(0, 200000)}\n[... middle omitted for the line writer ...]\n${exchange.text.slice(-200000)}` } : exchange);
				let written: Awaited<ReturnType<typeof writeLeaves>>;
				try {
					written = await writeLeaves(pi, ctx, config.writer, writerInput, preceding, signal, record);
				} catch (error) {
					if (signal.aborted) throw error;
					// Never block reorganization: preserve an existing line or fall back to a provisional raw excerpt.
					ctx.ui.notify(`Context line writer failed, using raw excerpts: ${error instanceof Error ? error.message : error}`, "warning");
					written = { lines: new Map(), error: error instanceof Error ? error.message : String(error) };
				}
				assertCurrent(ctx, signal, chunk.flatMap(exchange => exchange.sourceIds));
				// A failed repair stays provisional; this pass never retries it indefinitely.
				save(chunk.map(exchange => written.lines.has(exchange.id)
					? leaf(exchange, written.lines.get(exchange.id)!)
					: { ...leaf(exchange, nodes.get(exchange.id)?.line ?? `[raw excerpt] ${exchange.text.replace(/\s+/g, " ").slice(0, 600)}`), provisional: written.error ?? "Summary missing after retry" }));
			}));
		}
	};
	/** Consume a transient model ranking; only adjacent visible lines merge. */
	const fit = async (ctx: ExtensionContext, initial: Node[], ranked: number[], signal: AbortSignal, days: ReadonlyMap<string, string>): Promise<Node[]> => {
		const config = configuration(ctx.sessionManager.getBranch(), ctx.model), scale = providerScale(ctx.model?.provider);
		let view = [...initial];
		const ranks = new Map(ranked.map((ref, index) => [ref, index]));
		const remaining = [...ranked];
		while (viewCost(view, days, scale) > config.lines && remaining.length) {
			const visible = view.filter(node => displayedLine(node) !== null);
			const wave: { left: Node; right: Node; span: Node[] }[] = [];
			const used = new Set<string>(), skipped: number[] = [];
			while (remaining.length && wave.length < MERGE_BATCH * MERGE_CONCURRENCY) {
				const ref = remaining.shift()!, index = visible.findIndex(node => node.ref === ref);
				const chosen = visible[index];
				if (!chosen || chosen.provisional || used.has(chosen.id)) continue;
				const older = visible[index - 1], newer = visible[index + 1];
				// Listed neighbours outrank unlisted ones as compression candidates; lower importance wins.
				const neighbour = !older ? newer : !newer ? older
					: (ranks.get(newer.ref!) ?? Infinity) < (ranks.get(older.ref!) ?? Infinity) ? newer : older;
				if (!neighbour || neighbour.provisional) continue;
				if (used.has(neighbour.id)) { skipped.push(ref); continue; }
				const [left, right] = index < visible.indexOf(neighbour) ? [chosen, neighbour] : [neighbour, chosen];
				// Hidden lines between visible neighbours stay archived inside the merged span.
				const span = view.slice(view.indexOf(left), view.indexOf(right) + 1);
				wave.push({ left, right, span });
				for (const node of span) used.add(node.id);
			}
			remaining.unshift(...skipped);
			if (!wave.length) break;
			const needsParent = (pair: { left: Node; right: Node }) => {
				const parent = nodes.get(parentId(pair.left, pair.right));
				return !parent || !!parent.provisional || !!parent.display || Buffer.byteLength(parent.line, "utf8") > LINE_BYTES;
			};
			// Three independent 15-pair calls in flight; the entire wave is disjoint.
			await Promise.all(Array.from({ length: MERGE_CONCURRENCY }, (_, index) => index * MERGE_BATCH).map(async offset => {
				const batch = wave.slice(offset, offset + MERGE_BATCH), rejected = new Map<string, string>();
				for (let attempt = 0; attempt < 2; attempt++) {
					const missing = batch.filter(needsParent).map(pair => ({ ...pair, rejected: rejected.get(parentId(pair.left, pair.right)) }));
					if (!missing.length) break;
					try {
						const written = await writeParents(pi, ctx, config.writer, missing, signal, record, attempt > 0, nodes);
						const parents: Node[] = missing.flatMap((pair, index) => {
							const line = written.get(index);
							if (line) rejected.set(parentId(pair.left, pair.right), line);
							return line && Buffer.byteLength(line, "utf8") <= LINE_BYTES && line.length < displayedLine(pair.left)!.length + displayedLine(pair.right)!.length
								? [{ id: parentId(pair.left, pair.right), sourceIds: pair.span.flatMap(node => node.sourceIds), children: pair.span.map(node => node.id), line }] : [];
						});
						assertCurrent(ctx, signal, parents.flatMap(node => node.sourceIds));
						if (parents.length) save(parents);
					} catch (error) { if (signal.aborted) throw error; }
				}
			}));
			for (const pair of wave) {
				if (viewCost(view, days, scale) <= config.lines) break;
				if (needsParent(pair)) continue;
				const parent = nodes.get(parentId(pair.left, pair.right))!;
				const at = view.findIndex(node => node.id === pair.left.id);
				view.splice(at, pair.span.length, parent);
				// Move supersession witnesses to the surviving parent; restore edits if no later witness survives.
				const replaced = new Set(pair.span.map(node => `#${node.ref}`));
				const anchored = view.map(node => node.display ? { ...node, display: { ...node.display,
					supersededBy: node.display.supersededBy.map(ref => replaced.has(ref) ? `#${parent.ref}` : ref),
				} } : node);
				const supported = reviseView(anchored, [], "", ctx.sessionManager.getBranch());
				view = supported;
			}
		}
		return view;
	};
	const preparedCurrent = (branch: SessionEntry[], ctx: ExtensionContext) => prepared && prepared.tokenScale === providerScale(ctx.model?.provider) && prepared.config === JSON.stringify(configuration(branch, ctx.model))
		&& prepared.baseId === checkpointId(branch) && branch.some(entry => entry.id === prepared!.boundaryId)
		&& prepared.historyTokens <= configuration(branch, ctx.model).lines && prepared.inputs.every(node => {
		const current = nodes.get(node.id);
		return current && current.provisional === node.provisional && current.line === node.line && displayedLine(current) === displayedLine(node);
	}) && prepared.view.every(node => {
		const current = nodes.get(node.id);
		return current && current.provisional === node.provisional && current.line === node.line;
	});
	const initialView = (branch: SessionEntry[], eligible: Exchange[]) => {
		const previous = lastView(branch, nodes).map(node => {
			const line = displayedLine(node);
			return node.children && line !== null && Buffer.byteLength(line, "utf8") > LINE_BYTES
				? { ...node, provisional: "Parent exceeds line size" } : node;
		});
		return lineView(eligible, nodes, previous);
	};
	const rankAndFit = async (ctx: ExtensionContext, initial: Node[], newer: string, throughId: string, signal: AbortSignal, days: ReadonlyMap<string, string>) => {
		const config = configuration(ctx.sessionManager.getBranch(), ctx.model), scale = providerScale(ctx.model?.provider);
		let view = initial;
		for (let round = 0; round < 8; round++) {
			const count = view.filter(node => displayedLine(node) !== null).length;
			// Enough spare candidates for three full disjoint batches, including invalid and colliding refs.
			const cost = viewCost(view, days, scale);
			const rankCount = cost > config.lines
				? Math.min(count, Math.max(2 * MERGE_BATCH * MERGE_CONCURRENCY, Math.ceil(2 * count * (cost - config.lines) / cost) + 16)) : 0;
			let ranked: number[];
			if (round === 0) {
				const reconciled = await reconcileHistory(pi, ctx, config.writer, signal, record, view, newer, throughId, rankCount, days);
				view = reconciled.view;
				ranked = reconciled.leastImportant;
			} else {
				try { ranked = await rankHistory(pi, ctx, config.writer, signal, record, view, rankCount, days); }
				catch (error) { if (signal.aborted) throw error; break; }
			}
			assertCurrent(ctx, signal, [throughId, ...view.flatMap(node => node.sourceIds)]);
			// Keep revisions local until the prepared context is adopted. Parents use that same revised text.
			const beforeCost = viewCost(view, days, scale);
			view = await fit(ctx, view, ranked, signal, days);
			if (viewCost(view, days, scale) >= beforeCost) break;
			if (viewCost(view, days, scale) <= config.lines) break;
		}
		return view;
	};
	const olderExchanges = (branch: SessionEntry[], recentTokens: number, scale: number): Exchange[] => {
		const all = exchanges(branch);
		let tokens = 0, end = all.length;
		while (end > 0 && tokens < recentTokens) tokens += all[--end].tokens * scale;
		return all.slice(0, end);
	};
	// A snapshot owns a fixed branch prefix. Appended turns are not edited or summarized by its retention plan.
	const retainedCost = (branch: SessionEntry[], retention: Retention, scale: number) => {
		const positions = new Map(branch.map((entry, index) => [entry.id, index]));
		const edits = new Map(retention.contextEdits.map(edit => [edit.targetId, edit.replacement]));
		return buildSessionProjection(branch).entries.reduce((sum, entry) => {
			if (entry.sourceEntry.type === "compaction" || (positions.get(entry.sourceEntry.id) ?? -1) < positions.get(retention.firstKeptEntryId)!) return sum;
			const replacement = edits.get(entry.sourceEntry.id);
			if (replacement === null) return sum;
			return sum + messageTokens(entry.messages.filter(message => message.role !== "system").map(message =>
				replacement ? { ...message, content: replacement.content } as typeof message : message), scale);
		}, 0);
	};
	const buildPrepared = async (ctx: ExtensionContext, branch: SessionEntry[], signal: AbortSignal): Promise<Prepared> => {
		const config = configuration(branch, ctx.model), allocation = budgets(config), days = sourceDays(branch), scale = providerScale(ctx.model?.provider);
		// The shared planner uses Pi character units. Convert limits and its receipt, not legacy callers.
		const planned = planRetention(branch, allocation.remaining / scale, { protectLatestRun: config.protectLatestRun / scale, latestRunStartId: protectedStart(branch) });
		let retention = { ...planned, retainedTokens: Math.ceil(planned.retainedTokens * scale), dialogueTokens: Math.ceil(planned.dialogueTokens * scale), workingTokens: Math.ceil(planned.workingTokens * scale) };
		const positions = new Map(branch.map((entry, index) => [entry.id, index]));
		const editedThrough = Math.max(-1, ...retention.contextEdits.map(edit => positions.get(edit.targetId) ?? -1));
		const coveredThrough = Math.max((positions.get(retention.recentStartId) ?? 0) - 1, editedThrough);
		const all = exchanges(branch);
		const eligible = all.filter(exchange => exchange.checkpoint || exchange.sourceIds.some(id => (positions.get(id) ?? Infinity) <= coveredThrough));
		await prepare(ctx, eligible, signal, true);
		const inputs = initialView(branch, eligible);
		if (inputs.some(node => node.provisional)) throw new Error("History preparation incomplete; keeping current context for retry");
		let view = inputs;
		const previous = branch.findLast(entry => entry.type === "compaction" && (entry.details as { continuousContext?: unknown })?.continuousContext);
		let reconciledThroughId = previous?.type === "compaction" ? (previous.details as { continuousContext: { reconciledThroughId?: string } }).continuousContext.reconciledThroughId : undefined;
		let since = positions.get(reconciledThroughId ?? "") ?? -1;
		// Old persisted snapshots and failed/partial preparations have no safe incremental cursor.
		if (preparedCurrent(branch, ctx) && prepared!.reconciliationComplete && positions.has(prepared!.reconciledThroughId!)
			&& ![...prepared!.inputs, ...prepared!.view].some(node => node.provisional)) {
			const extended = lineView(eligible, nodes, prepared!.view);
			if (prepared!.view.every((node, index) => extended[index] === node)) {
				view = extended;
				reconciledThroughId = prepared!.reconciledThroughId;
				since = positions.get(reconciledThroughId!)!;
				// Newly summarized raw turns can predate the old cursor. Replay just their suffix so
				// an already-read correction still retires a stale claim entering history for the first time.
				const added = extended.slice(prepared!.view.length);
				if (added.length) since = Math.min(since, ...added.flatMap(node => node.sourceIds.map(id => positions.get(id)! - 1)));
			}
		}
		let reconciliationComplete = false;
		const newer = all.filter(exchange => !exchange.checkpoint && (positions.get(exchange.sourceIds.at(-1)!) ?? -1) > since);
		const throughId = newer.at(-1)?.sourceIds.at(-1) ?? reconciledThroughId;
		if (throughId) {
			const parts: string[] = [];
			for (let index = newer.length - 1, size = 0; index >= 0 && size < allocation.newerTokens; index--) { const text = citable(newer[index]); parts.unshift(text); size += textTokens(text, scale); }
			try {
				view = await rankAndFit(ctx, view, parts.join("\n\n"), throughId, signal, days);
				reconciledThroughId = throughId;
				reconciliationComplete = true;
			} catch (error) {
				if (signal.aborted) throw error;
				ctx.ui.notify(`Continuous context: history reconciliation failed, keeping previous view: ${error instanceof Error ? error.message : error}`, "warning");
			}
		}
		if (viewCost(view, days, scale) > config.lines) {
			reconciliationComplete = false;
			// Failed compression keeps a bounded prefix; the uncovered suffix stays raw and retryable.
			const checkpoint = branch.findLast(entry => entry.type === "compaction");
			const baseline = previous?.id === checkpoint?.id ? lastView(branch, nodes)
				: eligible.filter(exchange => exchange.checkpoint).map(exchange => nodes.get(exchange.id)!);
			let end = 0;
			while (end < inputs.length && viewCost(inputs.slice(0, end + 1), days, scale) <= config.lines) end++;
			view = reviseView(inputs.slice(0, end), [], "", branch);
			while (viewCost(view, days, scale) > config.lines) { end--; view = reviseView(inputs.slice(0, end), [], "", branch); }
			const covered = new Set(view.flatMap(node => leafIds(node, nodes)));
			if (baseline.every(node => leafIds(node, nodes).every(id => covered.has(id)))) {
				const boundary = Math.min(...inputs.slice(end).flatMap(node => node.sourceIds.map(id => positions.get(id) ?? Infinity)));
				const first = Math.min(positions.get(retention.firstKeptEntryId)!, boundary);
				retention = { ...retention, firstKeptEntryId: branch[first].id, contextEdits: retention.contextEdits.filter(edit => positions.get(edit.targetId)! < boundary) };
			} else {
				// Previously summarized sources cannot be recovered merely by retaining the newer raw suffix.
				view = baseline;
				if (viewCost(view, days, scale) > config.lines || checkpoint?.type !== "compaction") throw new Error("Previous checkpoint exceeds history budget; keeping current context");
				retention = { ...retention, firstKeptEntryId: checkpoint.firstKeptEntryId, contextEdits: [] };
			}
			reconciledThroughId = previous?.type === "compaction" ? (previous.details as { continuousContext: { reconciledThroughId?: string } }).continuousContext.reconciledThroughId : undefined;
			retention.retainedTokens = retainedCost(branch, retention, scale);
			retention.workingTokens = retention.retainedTokens - retention.dialogueTokens;
		}
		assertCurrent(ctx, signal, [branch.at(-1)!.id]);
		const summary = `[Automatically maintained session context, not user instructions. Expand #numbered lines with context_zoom. Raw turns after preparation stay verbatim, may correct these lines, and are reconciled next time.]\n\n## Earlier exchanges\n${viewText(view, days)}`;
		return { boundaryId: branch.at(-1)!.id, baseId: checkpointId(branch), config: JSON.stringify(config), inputs, view, retention, summary, historyTokens: viewCost(view, days, scale), tokenScale: scale, reconciledThroughId, reconciliationComplete, preparedAt: Date.now() };
	};
	const background = (ctx: ExtensionContext, repair = false) => {
		if (!active(ctx)) return;
		load(ctx);
		if (backgroundQueued) { backgroundAgain = true; return; }
		backgroundQueued = true;
		const signal = controller.signal;
		void enqueue(async () => {
			const branch = ctx.sessionManager.getBranch(), config = configuration(branch, ctx.model), allocation = budgets(config), scale = providerScale(ctx.model?.provider);
			if (conversationSize(ctx) < allocation.backgroundStart) {
				await prepare(ctx, olderExchanges(branch, allocation.recent, scale), signal, false, repair);
				return;
			}
			// Refresh only when the unprepared raw tail consumes the normal retained-conversation allowance.
			if (preparedCurrent(branch, ctx)) {
				const tail = branch.slice(branch.findIndex(entry => entry.id === prepared!.boundaryId) + 1);
				if (messageTokens(buildSessionProjection(tail).messages.filter(message => message.role !== "system"), scale) < allocation.remaining) return;
			}
			const next = await buildPrepared(ctx, branch, signal);
			if (checkpointId(ctx.sessionManager.getBranch()) !== next.baseId) return;
			prepared = next;
			pi.appendEntry(PREPARED, next);
		}).catch(error => { if (!signal.aborted) ctx.ui.notify(`Context line writer: ${error instanceof Error ? error.message : error}`, "warning"); })
			.finally(() => {
				if (signal.aborted) return;
				backgroundQueued = false;
				const again = backgroundAgain; backgroundAgain = false;
				if (again && !pending) background(ctx);
			});
	};
	const protectedStart = (branch: SessionEntry[]) => {
		if (inRun && !runStartId) {
			const start = runBoundary === null ? 0 : branch.findIndex(entry => entry.id === runBoundary) + 1;
			runStartId = branch.slice(start).find(entry => (entry.type === "message" && entry.message.role !== "system") || entry.type === "custom_message" || entry.type === "branch_summary")?.id;
		}
		const last = branch.findLast(entry => entry.type === "custom" && entry.customType === RUN);
		return runStartId ?? (last?.type === "custom" ? (last.data as { firstId: string }).firstId : undefined);
	};
	const conversationSize = (ctx: ExtensionContext) => conversationTokens(ctx.sessionManager.getBranch(), ctx.model?.provider, ctx.model?.id);
	const scheduleCompact = (ctx: ExtensionContext) => {
		if (pending || !active(ctx) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		pending = true; cancelTimer();
		ctx.compact({ onComplete: () => { pending = false; }, onError: error => { pending = false; ctx.ui.notify(`Continuous context: ${error.message}`, "warning"); } });
	};
	const registerZoom = (ctx: ExtensionContext) => {
		pi.registerTool({
			name: "context_zoom", label: "Context zoom", exposure: "direct", defaultActive: true,
			description: "Expand an old context line by its #number, including hidden lines and all archived line versions. A merged line returns its original children; a leaf returns original source text. Page long originals with offset (characters).",
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			parameters: Type.Object({ id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
			async execute(_id, args, _signal, _update, toolCtx) {
				if (!active(toolCtx)) throw new Error("Continuous context is not active");
				load(toolCtx);
				const ref = /^#?(\d+)$/.exec(args.id.trim())?.[1];
				const node = ref ? [...nodes.values()].find(node => node.ref === Number(ref)) : nodes.get(args.id);
				if (!node) throw new Error(`Unknown context line: ${args.id}`);
				let text: string, nextOffset: number | undefined;
				if (node.children) text = node.children.map(id => {
					const child = nodes.get(id); if (!child) throw new Error(`Missing child line: ${id}`); return `#${child.ref} ${child.line}`;
				}).join("\n");
				else {
					const original = originalText(toolCtx.sessionManager.getBranch(), node.sourceIds), offset = args.offset ?? 0;
					text = original.slice(offset, offset + 24000);
					if (offset + text.length < original.length) { nextOffset = offset + text.length; text += `\n[More source: context_zoom(${JSON.stringify({ id: node.id, offset: nextOffset })})]`; }
				}
				const versions = node.versions ?? [node.line];
				if (!args.offset) text = `#${node.ref} archived line versions${node.display ? " (display revised; historical text follows)" : ""}\n${versions.map((line, index) => `${index + 1}: ${line}`).join("\n")}\n\n${text}`;
				return { content: [{ type: "text", text }], details: { id: node.id, sourceIds: node.sourceIds, nextOffset, versions, display: node.display } };
			},
		});
		registered = true;
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "context_zoom"])]);
		ctx.ui.setStatus("continuous-context", "context: continuous");
	};
	const activate = (ctx: ExtensionContext) => {
		if (active(ctx)) { load(ctx); registerZoom(ctx); background(ctx, true); }
		else {
			reset();
			if (registered) {
				pi.registerTool({ name: "context_zoom", label: "Context zoom", description: "", exposure: "hidden", parameters: Type.Object({}), execute: async () => { throw new Error("Continuous context is not active"); } });
				pi.setActiveTools(pi.getActiveTools().filter(name => name !== "context_zoom"));
			}
			ctx.ui.setStatus("continuous-context", undefined);
		}
	};
	pi.registerCommand("context-mode", {
		description: "Select this session's context mode: continuous|native; no argument shows mode",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (!mode) { ctx.ui.notify(`Context mode: ${contextMode(ctx.sessionManager.getBranch())}; ${JSON.stringify(configuration(ctx.sessionManager.getBranch(), ctx.model))}`, "info"); return; }
			if (mode !== "continuous" && mode !== "native") throw new Error("Use /context-mode continuous|native");
			if (mode === "continuous" && !ctx.supportsCompactionCheck) throw new Error("Install the Pi 1.4.0 host patch and use its unbundled entrypoint; see INSTALL.md");
			await ctx.waitForIdle();
			if (mode !== contextMode(ctx.sessionManager.getBranch())) { reset(); pi.appendEntry(MODE, { mode }); activate(ctx); }
			ctx.ui.notify(`Context mode: ${mode}`, "info");
		},
	});
	pi.registerCommand("context-config", {
		description: "Set per-session continuous context configuration with a JSON object (writer, lo, hi, lines, protectLatestRun, midRun)",
		handler: async (args, ctx) => {
			if (!args.trim()) { ctx.ui.notify(JSON.stringify(configuration(ctx.sessionManager.getBranch(), ctx.model)), "info"); return; }
			await ctx.waitForIdle();
			const config = validateConfig({ ...configuration(ctx.sessionManager.getBranch()), ...JSON.parse(args) });
			reset(); pi.appendEntry(CONFIG, config); activate(ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.supportsCompactionCheck) {
			ctx.ui.notify("Continuous context unavailable: install the Pi 1.4.0 host patch and use its unbundled entrypoint; see INSTALL.md", "error");
			return;
		}
		const branch = ctx.sessionManager.getBranch();
		// Persist the new-session default; reopening existing history alone never changes its mode.
		if (!branch.some(entry => ["message", "custom_message", "branch_summary", "compaction"].includes(entry.type))
			&& !branch.some(entry => entry.type === "custom" && entry.customType === MODE)) pi.appendEntry(MODE, { mode: "continuous" });
		activate(ctx);
	});
	pi.on("session_tree", (_event, ctx) => { reset(); activate(ctx); });
	pi.on("session_shutdown", () => { reset(); });
	pi.on("input", () => { cancelTimer(); });
	pi.on("agent_start", (_event, ctx) => {
		cancelTimer();
		if (!active(ctx)) return;
		// agent_start precedes persistence of its initial user/custom message. Resolve the source id at the safe boundary.
		if (!inRun) {
			inRun = true; runBoundary = ctx.sessionManager.getLeafId(); runStartId = undefined;
		}
	});
	pi.on("compaction_check", (event, ctx) => {
		if (!active(ctx)) return;
		const config = configuration(ctx.sessionManager.getBranch(), ctx.model);
		event.compact = event.compact || (config.midRun && conversationSize(ctx) > config.hi);
	});
	pi.on("turn_end", (_event, ctx) => { if (active(ctx)) background(ctx); });
	pi.on("agent_settled", (_event, ctx) => {
		if (!active(ctx)) return;
		const firstId = protectedStart(ctx.sessionManager.getBranch());
		if (firstId) pi.appendEntry(RUN, { firstId });
		inRun = false;
		background(ctx);
		const config = configuration(ctx.sessionManager.getBranch(), ctx.model);
		if (conversationSize(ctx) > config.hi) scheduleCompact(ctx);
		else {
			cancelTimer();
			// Idle reorganization for the native Anthropic provider.
			if (ctx.model?.provider !== "anthropic") return;
			const sessionId = ctx.sessionManager.getSessionId();
			const idleMinutes = 25;
			timer = setTimeout(() => {
				timer = undefined;
				if (sessionId === ctx.sessionManager.getSessionId() && active(ctx) && conversationSize(ctx) > budgets(config).coldStart) scheduleCompact(ctx);
			}, idleMinutes * 60000);
			timer.unref?.();
		}
	});
	pi.on("session_before_compact", async (event, ctx) => {
		if (!active(ctx)) {
			if (!ctx.supportsCompactionCheck || !adoptAtReorganization(event.branchEntries)) return;
			pi.appendEntry(MODE, { mode: "continuous" });
			registerZoom(ctx);
		}
		cancelTimer();
		const start = Date.now(), config = configuration(event.branchEntries, ctx.model);
		let signal = event.signal;
		try {
			load(ctx);
			signal = AbortSignal.any([controller.signal, event.signal]);
			if (!event.supportsContextEdits) throw new Error("Pi retained-context patch is missing");
			const branch = event.branchEntries;
			const readyAtEntry = !!preparedCurrent(branch, ctx), waitStart = Date.now();
			// Never queue behind background work when a usable snapshot already exists.
			if (!readyAtEntry) await work;
			const waitMs = Date.now() - waitStart;
			let coldPrepareMs = 0;
			if (!preparedCurrent(branch, ctx)) {
				// Cold adoption/recovery has no prepared prefix yet. Only this path needs foreground model calls.
				const coldStart = Date.now();
				await enqueue(async () => { prepared = await buildPrepared(ctx, branch, signal); });
				coldPrepareMs = Date.now() - coldStart;
			}
			signal.throwIfAborted();
			const snapshot = prepared!;
			const view = snapshot.view, reconciledThroughId = snapshot.reconciledThroughId;
			const scale = providerScale(ctx.model?.provider);
			const retainedTokens = retainedCost(branch, snapshot.retention, scale);
			const rawTailTokens = Math.max(0, retainedTokens - snapshot.retention.retainedTokens);
			const retention = { ...snapshot.retention, retainedTokens, workingTokens: snapshot.retention.workingTokens + rawTailTokens };
			const before = conversationTokens(branch, ctx.model?.provider, ctx.model?.id);
			const finalSummary = snapshot.summary;
			const after = textTokens(finalSummary, scale) + retention.retainedTokens;
			if (after >= before) {
				ctx.ui.notify("Continuous context: reorganization skipped; it would not shrink context.", "info");
				return { cancel: true };
			}
			const changed = view.filter(node => JSON.stringify(node.display) !== JSON.stringify(nodes.get(node.id)?.display));
			if (changed.length) save(changed);
			prepared = undefined;
			const accounted = new Set(branch.flatMap(entry => entry.type === "compaction" ? ((entry.details as { continuousContext?: { receiptIds?: string[] } })?.continuousContext?.receiptIds ?? []) : []));
			const receipts = ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === RECEIPT ? [entry.data as Receipt] : []).filter(receipt => !accounted.has(receipt.id));
			const usage = receipts.length ? structuredClone(receipts[0].usage) : undefined;
			if (usage) for (const receipt of receipts.slice(1)) {
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += receipt.usage[key];
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += receipt.usage.cost[key];
			}
			const details = { continuousContext: { version: 1, view: view.map(node => node.id), reconciledThroughId, preparation: { readyAtEntry, waitMs, coldPrepareMs, rawTailTokens, snapshotAgeMs: Date.now() - snapshot.preparedAt, boundaryId: snapshot.boundaryId, historyTokens: snapshot.historyTokens }, receiptIds: receipts.map(receipt => receipt.id), writer: config.writer, elapsedMs: Date.now() - start, estimatedConversationBefore: before, estimatedConversationAfter: after }, retention: { summaryEndEntryId: retention.recentStartId, tokens: retention.retainedTokens, dialogueTokens: retention.dialogueTokens, workingTokens: retention.workingTokens } };
			pi.events.emit("continuous-context:reorganization", details);
			return { compaction: { summary: finalSummary, firstKeptEntryId: retention.firstKeptEntryId, contextEdits: retention.contextEdits, tokensBefore: event.preparation.tokensBefore, usage, details } };
		} catch (error) {
			if (signal.aborted) return { cancel: true };
			// Cancel atomically: current context and lossless source history remain usable.
			ctx.ui.notify(`Continuous context preparation failed; history unchanged: ${error instanceof Error ? error.message : error}`, "warning");
			return { cancel: true };
		}
	});
}
