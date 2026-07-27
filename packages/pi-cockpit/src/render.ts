import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentRow, TodoItem, ViewMode } from "./types.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, type PrioritizedSegment, type WidthUtils } from "./layout.ts";
import { fitRows } from "./viewport.ts";

// Re-exported for existing importers; the shared implementation lives in layout.ts.
export type { WidthUtils };

// Below this the layout must degrade to an action-first single column
// (terminal control-center spec).
export const NARROW_WIDTH = 40;

// Dependencies are result-flow edges, never hierarchy, so they stay in their own
// segment. Long chains collapse to a count instead of pushing the task off the row.
const MAX_LISTED_DEPENDENCIES = 3;

function formatDependencies(dependencies: readonly number[], glyphs: IconGlyphs): string {
	const listed = dependencies.slice(0, MAX_LISTED_DEPENDENCIES).map((d) => `#${d + 1}`).join(",");
	const rest = dependencies.length - MAX_LISTED_DEPENDENCIES;
	return `${glyphs.depArrow} ${listed}${rest > 0 ? `,+${rest}` : ""}`;
}

// Weight and strikethrough are channels the hue palette cannot carry, so they are
// part of the paint surface. They stay optional because the theme is injected: the
// unit tests pass a bare `fg` stub, and a missing helper must degrade to plain text
// rather than throw.
export type PaintTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold" | "strikethrough">>;

function bold(theme: PaintTheme, text: string): string {
	return theme.bold ? theme.bold(text) : text;
}

function struck(theme: PaintTheme, text: string): string {
	return theme.strikethrough ? theme.strikethrough(text) : text;
}

export interface RenderOpts {
	glyphs: IconGlyphs;
	spin?: string;
	now?: number;
	expanded?: boolean;
	/**
	 * How the user actually toggles the todo panel. `alt+t` is registered by
	 * pi-maestro-flow, which forwards to cockpit through COCKPIT_TODO_TOGGLE_EVENT,
	 * so it is accurate in the shipped pairing. A standalone install without that
	 * owner overrides this with the always-available `/cockpit todo`.
	 */
	toggleHint?: string;
	/**
	 * Compact agent mode prints its own roster count. When the widget already
	 * renders an "Agents N running" header, that would be the same sentence twice
	 * on adjacent rows — a wasted row out of a very small vertical budget.
	 */
	withHead?: boolean;
	/**
	 * Total rows this call may return, including its own summary and overflow
	 * marker. Undefined means the terminal height is unknown, so the historical
	 * fixed caps apply.
	 */
	maxRows?: number;
}

export const DEFAULT_TOGGLE_HINT = "Alt+T";

// One cell per task stops scaling once the plan outgrows the terminal, so beyond
// that the bar switches to a proportional summary instead of eating the whole line.
function renderTodoBar(
	items: readonly TodoItem[],
	width: number,
	theme: PaintTheme,
	g: IconGlyphs,
): string {
	const cell = (st: TodoItem["status"]): string => {
		if (st === "completed") return theme.fg("success", g.barDone);
		if (st === "in_progress") return theme.fg("warning", g.barActive);
		if (st === "blocked") return theme.fg("error", g.blocked);
		return theme.fg("dim", g.barPending);
	};
	const budget = Math.max(4, Math.floor(width * 0.3));
	if (items.length <= budget) return items.map((i) => cell(i.status)).join("");

	const order: TodoItem["status"][] = ["completed", "in_progress", "blocked", "pending"];
	const counts = order.map((st) => items.filter((i) => i.status === st).length);
	// Largest-remainder allocation so a non-empty bucket never rounds away to zero.
	const exact = counts.map((n) => (n / items.length) * budget);
	const cells = exact.map(Math.floor);
	for (let i = 0; i < cells.length; i++) if (counts[i] > 0 && cells[i] === 0) cells[i] = 1;
	let overflow = cells.reduce((a, b) => a + b, 0) - budget;
	for (let i = cells.length - 1; i >= 0 && overflow > 0; i--) {
		const spare = Math.min(overflow, Math.max(0, cells[i] - 1));
		cells[i] -= spare;
		overflow -= spare;
	}
	return order.map((st, i) => cell(st).repeat(cells[i])).join("");
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

// Role is identity, status is state — they must not share a palette. Reusing
// success/warning/error for roles meant a green row could mean "executor" or
// "done", and every theme inherits that ambiguity. Roles therefore draw from the
// theme's identity colors, which carry no success/failure meaning anywhere.
const ROLE_PALETTE: readonly ThemeColor[] = [
	"syntaxFunction",
	"syntaxType",
	"syntaxString",
	"syntaxVariable",
	"syntaxKeyword",
	"mdLink",
];

// Stable per-name assignment so an unknown role still gets a consistent colour
// instead of collapsing into undifferentiated body text.
function roleColor(role: string): ThemeColor {
	let hash = 0;
	for (let i = 0; i < role.length; i++) hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
	return ROLE_PALETTE[hash % ROLE_PALETTE.length];
}

interface AgentTreeEntry {
	row: AgentRow;
	prefix: string;
}

function buildAgentTree(rows: readonly AgentRow[], glyphs: IconGlyphs): AgentTreeEntry[] {
	const activityOrder = (a: AgentRow, b: AgentRow): number =>
		b.lastActivityAt - a.lastActivityAt || a.correlationId.localeCompare(b.correlationId);
	const byId = new Map(rows.map((row) => [row.correlationId, row]));
	const children = new Map<string, AgentRow[]>();
	const roots: AgentRow[] = [];
	for (const row of rows) {
		const parent = row.parentCorrelationId;
		if (!parent || parent === row.correlationId || !byId.has(parent)) {
			roots.push(row);
			continue;
		}
		const siblings = children.get(parent) ?? [];
		siblings.push(row);
		children.set(parent, siblings);
	}
	roots.sort(activityOrder);
	for (const siblings of children.values()) siblings.sort(activityOrder);

	const entries: AgentTreeEntry[] = [];
	const visited = new Set<string>();
	const append = (row: AgentRow, ancestors: string, isLast: boolean): void => {
		if (visited.has(row.correlationId)) return;
		visited.add(row.correlationId);
		entries.push({ row, prefix: `${ancestors}${isLast ? glyphs.treeLast : glyphs.treeBranch}` });
		const descendants = children.get(row.correlationId) ?? [];
		const nextAncestors = `${ancestors}${isLast ? glyphs.treeSpace : glyphs.treeVertical}`;
		descendants.forEach((child, index) => append(child, nextAncestors, index === descendants.length - 1));
	};

	roots.forEach((root, index) => append(root, "", index === roots.length - 1));
	// Broken or cyclic parent references must never hide rows or recurse forever.
	for (const row of [...rows].sort(activityOrder)) {
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
		const parts = opts.withHead === false ? tails : [head, ...tails];
		if (parts.length === 0) return [];
		return [utils.clip(parts.join(theme.fg("dim", g.separator)), width, ell)];
	}
	const spin = opts.spin ?? "~";
	const now = opts.now ?? Date.now();
	const tree = buildAgentTree(rows, g);
	// Width decides how much a row can say; height decides how many rows exist.
	// The width cap counts roster rows and lets the overflow marker sit on top of
	// it; maxRows is a hard ceiling on everything this call emits, marker included.
	const widthCap = width < NARROW_WIDTH ? 3 : 6;
	const budget = Math.min(widthCap + 1, opts.maxRows ?? Number.POSITIVE_INFINITY);
	const { visible: visibleCount, hidden } = fitRows(tree.length, budget);
	const visible = tree.slice(0, visibleCount);

	// Priorities, not concatenation order, decide what survives a narrow terminal.
	// Identity (tree position, state, role, task) outranks telemetry (tool, tail,
	// counts) so the row still answers "who is doing what" at 40 columns.
	const lines = visible.map(({ row: r, prefix }) => {
		const status = agentGlyph(r.status, g, spin);
		const rc = roleColor(r.role);
		const segs: PrioritizedSegment[] = [
			{ text: theme.fg("dim", prefix), priority: 100, clippable: false },
			{ text: theme.fg(status.color, status.glyph), priority: 99, clippable: false },
		];
		if (status.label) segs.push({ text: theme.fg(status.color, status.label), priority: 95, clippable: false });
		segs.push({ text: theme.fg(rc, r.role), priority: 90 });
		if (r.task) segs.push({ text: r.task, priority: 80, minWidth: 6 });
		segs.push({ text: theme.fg("muted", formatDuration(now - r.startedAt)), priority: 70, clippable: false });
		if (r.dependencies?.length) {
			segs.push({ text: theme.fg("dim", formatDependencies(r.dependencies, g)), priority: 60, clippable: false });
		}
		if (r.activeTool) segs.push({ text: theme.fg("accent", `tool ${r.activeTool}`), priority: 50, minWidth: 8 });
		if (r.tail) segs.push({ text: theme.fg("dim", r.tail), priority: 40, minWidth: 8 });
		if (r.toolCount !== undefined) segs.push({ text: theme.fg("muted", `${r.toolCount} tools`), priority: 20, clippable: false });
		if (r.tokens !== undefined) segs.push({ text: theme.fg("muted", `${r.tokens} tok`), priority: 10, clippable: false });
		return fitLineByPriority(segs, width, utils, " ", g.ellipsis);
	});
	if (hidden > 0) {
		lines.push(utils.clip(theme.fg("dim", `${g.treeLast} ${g.ellipsis} ${hidden} more`), width, ell));
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

// One table for the whole todo surface: the summary's next-task label and the
// expanded rows must not drift apart, and every status has to differ from its
// neighbours by glyph *and* hue *and* weight — hue alone is not a channel a
// colour-blind or monochrome terminal can read.
interface TodoPaint {
	glyph: string;
	glyphColor: ThemeColor;
	subjectColor: ThemeColor;
	bold?: boolean;
	struck?: boolean;
}

function todoPaint(status: TodoItem["status"], glyphs: IconGlyphs, spin: string): TodoPaint {
	if (status === "completed") {
		return { glyph: glyphs.check, glyphColor: "success", subjectColor: "dim", struck: true };
	}
	if (status === "in_progress") {
		return { glyph: spin, glyphColor: "warning", subjectColor: "text", bold: true };
	}
	if (status === "blocked") {
		return { glyph: glyphs.blocked, glyphColor: "error", subjectColor: "error" };
	}
	return { glyph: glyphs.pending, glyphColor: "accent", subjectColor: "text" };
}

function todoSubject(paint: TodoPaint, subject: string, theme: PaintTheme): string {
	const text = theme.fg(paint.subjectColor, subject);
	if (paint.struck) return struck(theme, text);
	return paint.bold ? bold(theme, text) : text;
}

function todoNextLabel(
	item: TodoItem,
	items: readonly TodoItem[],
	glyphs: IconGlyphs,
	spin: string,
	theme: PaintTheme,
): string {
	const actor = todoActor(item, items);
	const paint = todoPaint(item.status, glyphs, spin);
	return [
		theme.fg(paint.glyphColor, paint.glyph),
		actor ? theme.fg("mdLink", actor) : "",
		todoSubject(paint, item.subject, theme),
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
	const toggleHint = opts.toggleHint ?? DEFAULT_TOGGLE_HINT;

	if (mode === "compact") {
		const total = items.length;
		const done = items.filter((i) => i.status === "completed").length;
		const blocked = items.filter((i) => i.status === "blocked").length;
		const pct = total ? Math.round((done / total) * 100) : 0;
		const nxt = findNextTodo(items);
		const label = nxt
			? `${theme.fg("dim", g.arrow)} ${todoNextLabel(nxt, items, g, spin, theme)}`
			: done === total ? theme.fg("success", `${g.check} all done`) : "";
		const segs: PrioritizedSegment[] = [
			{ text: renderTodoBar(items, width, theme, g), priority: 60, clippable: false },
			{ text: theme.fg("muted", `${pct}%`), priority: 90, clippable: false },
		];
		// A glyph run is opaque to a screen reader, so the blocked count is spelled out.
		if (blocked > 0) segs.push({ text: theme.fg("error", `${blocked} blocked`), priority: 95, clippable: false });
		if (label) segs.push({ text: label, priority: 100, minWidth: 8 });
		segs.push({ text: theme.fg("dim", `(${toggleHint} expand)`), priority: 10, clippable: false });
		return [fitLineByPriority(segs, width, utils, " ", g.ellipsis)];
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

	// The next actionable task outranks the counts: it is the one token that tells
	// the user what to do, so it must survive when the terminal is narrow.
	const summarySegs: PrioritizedSegment[] = [
		{ text: theme.fg("syntaxFunction", "Todo"), priority: 40, clippable: false },
		{ text: theme.fg("dim", `${done}/${total}`), priority: 80, clippable: false },
		{ text: nextText, priority: 100, minWidth: 8 },
	];
	if (blocked > 0) {
		summarySegs.push({ text: theme.fg("error", `${blocked} blocked`), priority: 90, clippable: false });
	}
	if (running > 0) {
		summarySegs.push({ text: theme.fg("dim", `${running} running`), priority: 50, clippable: false });
	}
	if (members > 0) {
		summarySegs.push({ text: theme.fg("dim", `${members} members`), priority: 30, clippable: false });
	}
	summarySegs.push({
		text: theme.fg("dim", `(${toggleHint} ${expanded ? "collapse" : "expand"})`),
		priority: 10,
		clippable: false,
	});
	const summaryLine = fitLineByPriority(summarySegs, width, utils, ` ${sep} `, g.ellipsis);

	if (!expanded) return [summaryLine];

	// sorted + capped task rows
	const ordered = [...items].sort((a, b) => todoDisplayRank(a, now) - todoDisplayRank(b, now));
	// The summary line is already spent, so the task rows compete for what is left.
	const budget = Math.min(
		TODO_MAX_VISIBLE + 1,
		opts.maxRows !== undefined ? opts.maxRows - 1 : Number.POSITIVE_INFINITY,
	);
	const { visible: visibleCount, hidden } = fitRows(ordered.length, budget);
	const visible = ordered.slice(0, visibleCount);
	const rows: string[] = [summaryLine];
	for (const it of visible) {
		const paint = todoPaint(it.status, g, spin);
		const actor = todoActor(it, items);
		const segments = [`  ${theme.fg(paint.glyphColor, paint.glyph)}`];
		if (actor) segments.push(theme.fg("mdLink", actor));
		segments.push(todoSubject(paint, it.subject, theme));
		if (it.skills.length > 0) {
			const primary = it.skills.find((skill) => skill.role === "primary") ?? it.skills[0];
			segments.push(theme.fg("dim", `/${primary.name}${it.skills.length > 1 ? ` +${it.skills.length - 1}` : ""}`));
		}
		if (it.status === "blocked" && it.blockedBy.length > 0) {
			for (const dependencyId of it.blockedBy) {
				const dependency = items.find((candidate) => candidate.id === dependencyId);
				const depGlyph = dependency ? todoPaint(dependency.status, g, spin).glyph : "?";
				segments.push(theme.fg("dim", `← ${depGlyph} ${dependency?.subject ?? "?"}`));
			}
		}
		rows.push(utils.clip(segments.join(" "), width, ell));
	}
	if (hidden > 0) rows.push(utils.clip(theme.fg("dim", `  ${g.ellipsis} ${hidden} more`), width, ell));
	return rows;
}
