import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentRow, TodoItem, ViewMode } from "./types.ts";
import type { IconGlyphs } from "./icons.ts";

// Width helpers are injected (see footer.ts rationale): pure functions stay hermetic,
// the real widget injects pi-tui's visibleWidth / truncateToWidth.
export interface WidthUtils {
	measure: (text: string) => number;
	clip: (text: string, width: number, ellipsis: string) => string;
}

export type PaintTheme = Pick<Theme, "fg">;

export interface RenderOpts {
	glyphs: IconGlyphs;
	spin?: string;
	now?: number;
	expanded?: boolean;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

// Pi themes expose only semantic colors, so roles map onto them (no free cyan/green).
const ROLE_COLOR: Record<string, ThemeColor> = {
	explorer: "mdLink",
	delegate: "mdLink",
	executor: "success",
	reviewer: "warning",
	debugger: "error",
	planner: "accent",
	main: "success",
};

function roleColor(role: string): ThemeColor {
	return ROLE_COLOR[role] ?? "text";
}

function agentStatusRank(status: AgentRow["status"]): number {
	if (status === "failed") return 0;
	if (status === "retrying") return 1;
	if (status === "running") return 2;
	if (status === "pending") return 3;
	if (status === "sleeping") return 4;
	return 5;
}

interface AgentTreeEntry {
	row: AgentRow;
	prefix: string;
}

function buildAgentTree(rows: readonly AgentRow[]): AgentTreeEntry[] {
	const sorted = [...rows].sort((a, b) =>
		agentStatusRank(a.status) - agentStatusRank(b.status)
		|| a.startedAt - b.startedAt
		|| a.correlationId.localeCompare(b.correlationId));
	const byId = new Map(sorted.map((row) => [row.correlationId, row]));
	const children = new Map<string, AgentRow[]>();
	const roots: AgentRow[] = [];
	for (const row of sorted) {
		const parent = row.parentCorrelationId;
		if (!parent || parent === row.correlationId || !byId.has(parent)) {
			roots.push(row);
			continue;
		}
		const siblings = children.get(parent) ?? [];
		siblings.push(row);
		children.set(parent, siblings);
	}

	const entries: AgentTreeEntry[] = [];
	const visited = new Set<string>();
	const append = (row: AgentRow, ancestors: string, isLast: boolean): void => {
		if (visited.has(row.correlationId)) return;
		visited.add(row.correlationId);
		entries.push({ row, prefix: `${ancestors}${isLast ? "└─" : "├─"}` });
		const descendants = children.get(row.correlationId) ?? [];
		const nextAncestors = `${ancestors}${isLast ? "  " : "│ "}`;
		descendants.forEach((child, index) => append(child, nextAncestors, index === descendants.length - 1));
	};

	roots.forEach((root, index) => append(root, "", index === roots.length - 1));
	// Broken or cyclic parent references must never hide rows or recurse forever.
	for (const row of sorted) {
		if (!visited.has(row.correlationId)) append(row, "", true);
	}
	return entries;
}

function agentGlyph(
	status: AgentRow["status"],
	glyphs: IconGlyphs,
	spin: string,
): { glyph: string; color: ThemeColor; label?: string } {
	if (status === "failed") return { glyph: glyphs.cross, color: "error" };
	if (status === "done") return { glyph: glyphs.check, color: "success" };
	if (status === "pending") return { glyph: glyphs.pending, color: "dim", label: "pending" };
	if (status === "sleeping") return { glyph: glyphs.dotIdle, color: "warning", label: "sleeping" };
	if (status === "retrying") return { glyph: spin, color: "warning", label: "retrying" };
	return { glyph: spin, color: "accent" };
}

// Empty roster => no lines (the bare-pi guard: nothing to draw, widget stays hidden).
export function renderAgents(
	rows: readonly AgentRow[],
	mode: ViewMode,
	width: number,
	theme: PaintTheme,
	utils: WidthUtils,
	opts: RenderOpts,
): string[] {
	if (rows.length === 0) return [];
	const g = opts.glyphs;
	const ell = theme.fg("dim", g.ellipsis);
	if (mode === "compact") {
		const active = rows.filter((row) => row.status === "running" || row.status === "retrying").length;
		const head = `${theme.fg("text", String(rows.length))} ${theme.fg("muted", "agents")}${active ? theme.fg("dim", ` · ${active} active`) : ""}`;
		const tails = rows
			.filter((r) => r.tail)
			.map((r) => `${theme.fg(roleColor(r.role), r.role)}${theme.fg("dim", ":")} ${theme.fg("dim", r.tail)}`);
		const line = tails.length > 0 ? [head, ...tails].join(theme.fg("dim", g.separator)) : head;
		return [utils.clip(line, width, ell)];
	}
	const spin = opts.spin ?? "~";
	const now = opts.now ?? Date.now();
	const tree = buildAgentTree(rows);
	const maxVisible = width < 40 ? 3 : 6;
	const visible = tree.slice(0, maxVisible);
	const hidden = tree.length - visible.length;

	const lines = visible.map(({ row: r, prefix }) => {
		const status = agentGlyph(r.status, g, spin);
		const rc = roleColor(r.role);
		const segs = [theme.fg("dim", prefix), theme.fg(status.color, status.glyph), theme.fg(rc, r.role)];
		if (status.label) segs.push(theme.fg(status.color, status.label));
		if (r.task) segs.push(r.task);
		if (r.dependencies?.length) {
			segs.push(theme.fg("dim", `← #${r.dependencies.map((dependency) => dependency + 1).join(",#")}`));
		}
		if (r.activeTool) segs.push(theme.fg("accent", `tool ${r.activeTool}`));
		if (r.tail) segs.push(theme.fg("dim", r.tail));
		if (r.toolCount !== undefined) segs.push(theme.fg("muted", `${r.toolCount} tools`));
		if (r.tokens !== undefined) segs.push(theme.fg("muted", `${r.tokens} tok`));
		segs.push(theme.fg("muted", formatDuration(now - r.startedAt)));
		return utils.clip(segs.join(" "), width, ell);
	});
	if (hidden > 0) {
		lines.push(utils.clip(theme.fg("dim", `└─ ${g.ellipsis} ${hidden} more`), width, ell));
	}
	return lines;
}

const TODO_MAX_VISIBLE = 8;
const RECENT_COMPLETED_MS = 30_000;

function todoDisplayRank(item: TodoItem, now: number): number {
	if (item.status === "completed") {
		const recent = item.updatedAt !== undefined && now - item.updatedAt < RECENT_COMPLETED_MS;
		return recent ? 0 : 4;
	}
	if (item.status === "in_progress") return 1;
	if (item.status === "blocked") return 2;
	return 3;
}

function findNextTodo(items: readonly TodoItem[]): TodoItem | undefined {
	return items.find((i) => i.status === "in_progress")
		?? items.find((i) => i.status === "pending" && i.blockedBy.length === 0)
		?? items.find((i) => i.status === "blocked" || i.status === "pending");
}

function todoActorLabel(actor: NonNullable<TodoItem["assignee"]>, items: readonly TodoItem[]): string {
	const collidingIds = new Set(items
		.flatMap((item) => [item.createdBy, item.assignee])
		.filter((candidate): candidate is NonNullable<TodoItem["assignee"]> =>
			Boolean(candidate && candidate.label === actor.label))
		.map((candidate) => candidate.id));
	if (collidingIds.size < 2) return actor.label;
	for (let length = Math.min(4, actor.id.length); length < actor.id.length; length++) {
		const prefix = actor.id.slice(0, length);
		if ([...collidingIds].every((candidate) => candidate === actor.id || !candidate.startsWith(prefix))) {
			return `${actor.label}#${prefix}`;
		}
	}
	return `${actor.label}#${actor.id}`;
}

function todoActor(item: TodoItem, items: readonly TodoItem[]): string {
	if (!item.assignee) return "";
	const assigned = `@${todoActorLabel(item.assignee, items)}`;
	if (!item.createdBy || item.createdBy.id === item.assignee.id) return assigned;
	return `@${todoActorLabel(item.createdBy, items)}→${assigned}`;
}

function todoStateGlyph(
	item: TodoItem,
	glyphs: IconGlyphs,
	spin: string,
	theme: PaintTheme,
): string {
	if (item.status === "completed") return theme.fg("success", glyphs.check);
	if (item.status === "in_progress") return theme.fg("accent", spin);
	if (item.status === "blocked") return theme.fg("error", glyphs.blocked);
	return theme.fg("dim", glyphs.pending);
}

function todoNextLabel(
	item: TodoItem,
	items: readonly TodoItem[],
	glyphs: IconGlyphs,
	spin: string,
	theme: PaintTheme,
): string {
	const actor = todoActor(item, items);
	const subjectColor: ThemeColor = item.status === "blocked"
		? "error"
		: item.status === "in_progress"
			? "text"
			: "muted";
	return [
		todoStateGlyph(item, glyphs, spin, theme),
		actor ? theme.fg("mdLink", actor) : "",
		theme.fg(subjectColor, item.subject),
	].filter(Boolean).join(" ");
}

export function renderTodos(
	items: readonly TodoItem[],
	mode: ViewMode,
	width: number,
	theme: PaintTheme,
	utils: WidthUtils,
	opts: RenderOpts,
): string[] {
	if (items.length === 0) return [];
	const g = opts.glyphs;
	const ell = theme.fg("dim", g.ellipsis);
	const spin = opts.spin ?? "~";
	const now = opts.now ?? Date.now();
	const expanded = opts.expanded !== false;

	if (mode === "compact") {
		const total = items.length;
		const done = items.filter((i) => i.status === "completed").length;
		const pct = total ? Math.round((done / total) * 100) : 0;
		const cell = (st: TodoItem["status"]): string => {
			if (st === "completed") return theme.fg("success", g.barDone);
			if (st === "in_progress") return theme.fg("accent", g.barActive);
			if (st === "blocked") return theme.fg("error", g.blocked);
			return theme.fg("dim", g.barPending);
		};
		const bar = items.map((i) => cell(i.status)).join("");
		const nxt = findNextTodo(items);
		const label = nxt
			? `${theme.fg("dim", g.arrow)} ${todoNextLabel(nxt, items, g, spin, theme)}`
			: done === total ? theme.fg("success", "all done") : "";
		const tail = ` ${theme.fg("muted", `${pct}%`)}` + (label ? ` ${label}` : "");
		const summary = bar + tail;
		const hint = theme.fg("dim", " (Alt+T expand)");
		return [utils.clip(utils.measure(summary + hint) <= width ? summary + hint : summary, width, ell)];
	}

	// summary line (always rendered, width-adaptive: full → compact → minimal)
	const total = items.length;
	const done = items.filter((i) => i.status === "completed").length;
	const running = items.filter((i) => i.status === "in_progress").length;
	const blocked = items.filter((i) => i.status === "blocked").length;
	const members = new Set(items.map((item) => item.assignee?.id).filter(Boolean)).size;
	const sep = theme.fg("dim", g.separator.trim());
	const nxt = findNextTodo(items);
	const nextText = nxt
		? `${theme.fg(nxt.status === "blocked" ? "error" : "dim", g.arrow)} ${todoNextLabel(nxt, items, g, spin, theme)}`
		: theme.fg("success", `${g.check} all done`);

	const fullMeta = [
		`${total} tasks`,
		`${done} done`,
		running ? `${running} running` : "",
		members ? `${members} members` : "",
		blocked ? `${blocked} blocked` : "",
	].filter(Boolean).join(` ${sep} `);
	const compactMeta = `${done}/${total}${sep} ${running} running`;
	const minimalMeta = `${done}/${total}`;

	let meta = minimalMeta;
	for (const candidate of [fullMeta, compactMeta]) {
		const prefix = `${theme.fg("muted", "Todo")} ${theme.fg("dim", candidate)} `;
		if (utils.measure(prefix) + Math.min(18, utils.measure(nextText)) <= width) {
			meta = candidate;
			break;
		}
	}
	const summaryText = `${theme.fg("muted", "Todo")} ${theme.fg("dim", meta)} ${nextText}`;
	const toggleHint = theme.fg("dim", `(Alt+T ${expanded ? "collapse" : "expand"})`);
	const summaryWithHint = `${summaryText} ${toggleHint}`;
	const summaryLine = utils.measure(summaryWithHint) <= width
		? summaryWithHint
		: utils.clip(summaryText, width, ell);

	if (!expanded) return [summaryLine];

	// sorted + capped task rows
	const ordered = [...items].sort((a, b) => todoDisplayRank(a, now) - todoDisplayRank(b, now));
	const visible = ordered.slice(0, TODO_MAX_VISIBLE);
	const rows: string[] = [summaryLine];
	for (const it of visible) {
		let glyph: string;
		let color: ThemeColor;
		let tc: ThemeColor;
		switch (it.status) {
			case "completed":
				glyph = g.check;
				color = "success";
				tc = "dim";
				break;
			case "in_progress":
				glyph = spin;
				color = "accent";
				tc = "text";
				break;
			case "blocked":
				glyph = g.blocked;
				color = "error";
				tc = "error";
				break;
			default:
				glyph = g.pending;
				color = "dim";
				tc = "muted";
		}
		const actor = todoActor(it, items);
		const segments = [`  ${theme.fg(color, glyph)}`];
		if (actor) segments.push(theme.fg("mdLink", actor));
		segments.push(theme.fg(tc, it.subject));
		if (it.skills.length > 0) {
			const primary = it.skills.find((skill) => skill.role === "primary") ?? it.skills[0];
			segments.push(theme.fg("dim", `/${primary.name}${it.skills.length > 1 ? ` +${it.skills.length - 1}` : ""}`));
		}
		if (it.status === "blocked" && it.blockedBy.length > 0) {
			for (const dependencyId of it.blockedBy) {
				const dependency = items.find((candidate) => candidate.id === dependencyId);
				const depGlyph = dependency?.status === "completed"
					? g.check
					: dependency?.status === "in_progress"
						? spin
						: dependency?.status === "blocked"
							? g.blocked
							: dependency
								? g.pending
								: "?";
				segments.push(theme.fg("dim", `← ${depGlyph} ${dependency?.subject ?? "?"}`));
			}
		}
		rows.push(utils.clip(segments.join(" "), width, ell));
	}
	const hidden = ordered.length - visible.length;
	if (hidden > 0) rows.push(utils.clip(theme.fg("dim", `  ${g.ellipsis} ${hidden} more`), width, ell));
	return rows;
}
