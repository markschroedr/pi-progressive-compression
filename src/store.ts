import { readFileSync } from "node:fs";
import { parseSessionEntries, type FileEntry, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { identity, LINE_BYTES, type Exchange } from "./history.ts";

export const STORE = "continuous-context.archive.v1";
export { LINE_BYTES } from "./history.ts";
/** ref: permanent session-local short reference (#123); never reused or renumbered. id: internal source hash. */
export type Display = { line: string | null; throughId: string; supersededBy: string[] };
export type Node = { id: string; ref?: number; sourceIds: string[]; line: string; children?: string[]; provisional?: string; versions?: string[]; display?: Display };
export type LineEdit = { ref: number; line: string | null; supersededBy: string[] };
export const displayedLine = (node: Node): string | null => node.display ? node.display.line : node.line;
/** Local calendar day per source entry, e.g. "Oct09". */
export const sourceDays = (branch: readonly SessionEntry[]) => new Map(branch.map(entry => [entry.id, new Date(entry.timestamp).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).replace(" ", "")]));
/** Date ranges appear only where the day changes, keeping the labels cheap. */
export const viewText = (view: Node[], days?: ReadonlyMap<string, string>) => {
	let previous: string | undefined;
	return view.flatMap(node => {
		const line = displayedLine(node);
		if (line === null) return [];
		const first = days?.get(node.sourceIds[0]), last = days?.get(node.sourceIds.at(-1)!);
		const label = !first || !last || (first === last && first === previous) ? ""
			: first === last ? `[${first}] ` : `[${first}–${last.slice(0, 3) === first.slice(0, 3) ? last.slice(3) : last}] `;
		previous = last ?? previous;
		return [`#${node.ref} ${label}${line}`];
	}).join("\n");
};
const versions = (...texts: (string | undefined)[]) => [...new Set(texts.filter((text): text is string => text !== undefined))];

/** Validate later evidence first. Rejected proposals leave it intact; hidden witnesses lead to their surviving successors. */
export function reviseView(view: Node[], edits: unknown, throughId: string, branch: readonly SessionEntry[] = []): Node[] {
	const byRef = new Map(view.map((node, index) => [node.ref, { node, index }]));
	// A later user message is direct evidence, so a correction applies at the next reorganization.
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const users = new Set(branch.flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [entry.id] : []));
	const changed = new Map<number, LineEdit>();
	for (const raw of Array.isArray(edits) ? edits : []) {
		// Reconciliation reads date-labelled history; a copied label would render twice.
		const edit = typeof raw?.line === "string" ? { ...raw, line: raw.line.trim().replace(/^(\[[A-Z][a-z]{2}\d{2}(–([A-Z][a-z]{2})?\d{2})?\]\s*)+/, "") } : raw;
		const target = edit && byRef.get(edit.ref), current = target && (displayedLine(target.node) ?? target.node.line);
		if (!target || current == null || !Number.isInteger(edit.ref) || changed.has(edit.ref)
			|| !(edit.line === null || (typeof edit.line === "string" && edit.line && Buffer.byteLength(edit.line, "utf8") <= LINE_BYTES && Buffer.byteLength(edit.line, "utf8") < Buffer.byteLength(current, "utf8")))
			|| !Array.isArray(edit.supersededBy) || !edit.supersededBy.length || !edit.supersededBy.every((ref: unknown) => typeof ref === "string")) continue;
		changed.set(edit.ref, edit);
	}
	const revised = [...view];
	const witnesses = (refs: string[], index: number): string[] | undefined => {
		if (!refs.length) return;
		const surviving = new Set<string>();
		for (const witness of refs) {
			const user = /^@(.+)$/.exec(witness)?.[1];
			if (user) {
				if (!users.has(user) || !(positions.get(user)! > (positions.get(view[index].sourceIds.at(-1)!) ?? Infinity))) return;
				surviving.add(witness);
				continue;
			}
			const ref = /^#([1-9]\d*)$/.exec(witness), later = ref && byRef.get(Number(ref[1]));
			if (!later || later.index <= index) return;
			const node = revised[later.index];
			// Later nodes are already validated and their hidden witnesses already point to visible successors.
			for (const anchor of displayedLine(node) === null ? node.display!.supersededBy : [`#${node.ref}`]) surviving.add(anchor);
		}
		return [...surviving];
	};
	for (let index = view.length - 1; index >= 0; index--) {
		const node = view[index], edit = changed.get(node.ref!);
		const anchors = edit && witnesses(edit.supersededBy, index);
		if (edit && anchors) {
			revised[index] = { ...node, versions: versions(...(node.versions ?? []), node.line, edit.line ?? undefined), display: { line: edit.line, throughId, supersededBy: anchors } };
			continue;
		}
		if (!node.display) continue;
		const previous = witnesses(node.display.supersededBy, index);
		if (!previous) revised[index] = { ...node, display: undefined };
		else if (JSON.stringify(previous) !== JSON.stringify(node.display.supersededBy))
			revised[index] = { ...node, display: { ...node.display, supersededBy: previous } };
	}
	return revised;
}
export type Archive = { nodes: Node[] };
export const leaf = (exchange: Exchange, line: string): Node => ({ id: exchange.id, sourceIds: exchange.sourceIds, line });
// Different prepared displays must not overwrite a parent used by an older ready snapshot.
export const parentId = (left: Node, right: Node) => identity([left.id, right.id, displayedLine(left) ?? left.line, displayedLine(right) ?? right.line]);

/** Keep old references zoomable, but rebuild parents whose child summaries changed. */
export function updateNodes(nodes: Map<string, Node>, replacements: Node[], nextRef: () => number): Node[] {
	const changed = new Set(replacements.map(node => node.id));
	const saved: Node[] = replacements.map(node => {
		const previous = nodes.get(node.id);
		return { ...node, ref: node.ref ?? previous?.ref ?? nextRef(), versions: versions(...(previous?.versions ?? []), previous?.line, ...(node.versions ?? []), node.line) };
	});
	for (const node of saved) nodes.set(node.id, node);
	let size: number;
	do {
		size = changed.size;
		for (const node of nodes.values()) {
			if (changed.has(node.id) || !node.children?.some(id => changed.has(id))) continue;
			const stale = { ...node, provisional: "Child summary requires rebuilding" };
			nodes.set(node.id, stale); changed.add(node.id); saved.push(stale);
		}
	} while (changed.size > size);
	return saved;
}

/** Source membership is authoritative, not the branch on which the writer finished. */
export function restore(manager: ExtensionContext["sessionManager"]): Archive & { nextRef: () => number; unsaved: Node[] } {
	const branch = manager.getBranch(), positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const nodes = new Map<string, Node>();
	let maxRef = 0;
	const visited = new Set<string>();
	// Last stored form of each node in this session file; restored nodes that differ must be persisted.
	const stored = new Map<string, string>();
	const scan = (entries: readonly FileEntry[], own: boolean) => {
		const header = entries.find(entry => entry.type === "session");
		const parent = header?.type === "session" ? header.parentSession : undefined;
		if (parent && !visited.has(parent)) {
			visited.add(parent);
			try { scan(parseSessionEntries(readFileSync(parent, "utf8")), false); } catch (error) {
				// A moved/deleted parent must not prevent opening a self-contained clone.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== STORE) continue;
			const data = entry.data as Archive;
			for (const node of data.nodes) {
				// Refs count across every branch and ancestor file, so no number is ever reused.
				maxRef = Math.max(maxRef, node.ref ?? 0);
				if (own) stored.set(node.id, JSON.stringify(node));
				if (node.sourceIds.every(id => positions.has(id))) {
					const previous = nodes.get(node.id);
					// Summaries can be reused across branches; display changes belong to the active checkpoint's branch.
					const display = positions.has(entry.id) && (!node.display || positions.has(node.display.throughId))
						? node.display : (previous?.line === node.line ? previous.display : undefined);
					nodes.set(node.id, { ...node, ref: node.ref ?? previous?.ref,
						versions: versions(...(previous?.versions ?? []), previous?.line, ...(node.versions ?? []), node.line), display });
				}
			}
		}
	};
	const header = manager.getHeader();
	scan([...(header ? [header] : []), ...manager.getEntries()], true);
	const nextRef = () => ++maxRef;
	// Archives written before refs existed: number in source order, children before parents.
	const first = (node: Node) => positions.get(node.sourceIds[0]) ?? 0;
	for (const node of [...nodes.values()].filter(node => !node.ref).sort((a, b) => first(a) - first(b) || a.sourceIds.length - b.sourceIds.length))
		nodes.set(node.id, { ...node, ref: nextRef() });
	// Existing sessions used this reserved marker without recording the failure cause.
	const excerpts = [...nodes.values()].filter(node => !node.children && node.line.startsWith("[raw excerpt] "));
	updateNodes(nodes, excerpts.map(node => ({ ...node, provisional: node.provisional ?? "Legacy excerpt fallback; original failure was not recorded" })), nextRef);
	const restored = [...nodes.values()];
	return { nodes: restored, nextRef, unsaved: restored.filter(node => stored.get(node.id) !== JSON.stringify(node)) };
}
export function lastView(branch: readonly SessionEntry[], nodes: Map<string, Node>): Node[] {
	const entry = branch.findLast(entry => entry.type === "compaction" && (entry.details as { continuousContext?: unknown })?.continuousContext);
	if (entry?.type !== "compaction") return [];
	const ids = (entry.details as { continuousContext: { view: string[] } }).continuousContext.view;
	return ids.flatMap(id => nodes.has(id) ? [nodes.get(id)!] : []);
}
/** Checkpoint parts share a source entry; coverage must compare leaf identities, not source ids alone. */
export const leafIds = (node: Node, nodes: ReadonlyMap<string, Node>): string[] => node.children
	? node.children.flatMap(id => nodes.has(id) ? leafIds(nodes.get(id)!, nodes) : [id]) : [node.id];
export function lineView(exchanges: Exchange[], nodes: Map<string, Node>, previous: Node[]): Node[] {
	const view: Node[] = [];
	let index = 0;
	for (const node of previous) {
		if (node.provisional) break;
		const ids = leafIds(node, nodes);
		if (JSON.stringify(ids) !== JSON.stringify(exchanges.slice(index, index + ids.length).map(exchange => exchange.id))) break;
		view.push(node); index += ids.length;
	}
	for (const exchange of exchanges.slice(index)) {
		const node = nodes.get(exchange.id);
		if (!node) throw new Error(`Missing line for exchange ${exchange.id}`);
		view.push(node);
	}
	return view;
}
