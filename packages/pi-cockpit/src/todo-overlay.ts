import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeExtensionStatusText } from "./extension-status.ts";
import type { IconGlyphs } from "./icons.ts";
import { fitLineByPriority, visibleStart, type PrioritizedSegment } from "./layout.ts";
import {
	todoActor,
	todoIdOrder,
	todoPaint,
	todoStatusRank,
	todoSubject,
} from "./render.ts";
import type { TodoItem } from "./types.ts";
import { tuiStatus, tuiT } from "./tui-i18n.ts";
import { overlayListRows } from "./viewport.ts";

export interface TodoOverlayParams {
	getTodos: () => readonly TodoItem[];
	requestRender: () => void;
	close: () => void;
	theme: Theme;
	glyphs: IconGlyphs;
	/** Live terminal height, so the card can use the space it already reserves. */
	getTerminalRows?: () => number | undefined;
	/** Select this task when the overlay first renders. */
	initialTodoId?: string;
}

// Rows the card spends on itself: two borders, header, separator, help line.
const CARD_CHROME_ROWS = 5;

type TodoOverlayMode = "list" | "detail";

export class TodoOverlay implements Component, Focusable {
	focused = false;
	private mode: TodoOverlayMode = "list";
	private selected = 0;
	private selectedId: string | undefined;

	constructor(private readonly params: TodoOverlayParams) {
		this.selectedId = params.initialTodoId;
	}

	invalidate(): void {}
	tick(): void {}
	dispose(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.mode === "detail") this.mode = "list";
			else this.params.close();
			this.params.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selectIndex(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selectIndex(this.todos().length - 1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedTodo()) this.mode = this.mode === "detail" ? "list" : "detail";
			this.params.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, 140));
		this.clampState();
		if (safeWidth < 20) return [this.renderCompact(safeWidth)];
		if (this.mode === "detail") return this.renderDetail(safeWidth);
		if (safeWidth < 88) return this.renderList(safeWidth);
		return this.renderWide(safeWidth);
	}

	private renderCompact(width: number): string {
		const todo = this.selectedTodo();
		const g = this.params.glyphs;
		const text = todo
			? `${this.glyphFor(todo.status)} ${this.orderOf(todo)} ${todo.subject}${g.separator}Esc`
			: `Todo${g.separator}${tuiT("overlay.todo.empty", { mark: g.emptyMark, separator: g.separator })}${g.separator}Esc`;
		return this.params.theme.bg("customMessageBg", pad(text, width));
	}

	// How many todo rows the card can show before it has to start paging.
	private listRows(): number {
		return overlayListRows(this.params.getTerminalRows?.(), CARD_CHROME_ROWS);
	}

	private renderList(width: number): string[] {
		const inner = width - 2;
		const todos = this.todos();
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		if (todos.length === 0) {
			rows.push(fitLine(this.emptyState(), inner));
		} else {
			const page = this.listRows();
			const start = visibleStart(this.selected, todos.length, page);
			for (let index = start; index < Math.min(todos.length, start + page); index++) {
				if (index === this.selected) selectedRows.add(rows.length);
				rows.push(this.todoRow(todos[index], index === this.selected, inner));
			}
		}
		rows.push(this.helpLine(inner));
		return this.card(rows, width, selectedRows);
	}

	private renderWide(width: number): string[] {
		const inner = width - 2;
		const leftWidth = Math.max(32, Math.floor((inner - 3) * 0.42));
		const rightWidth = inner - leftWidth - 3;
		const todos = this.todos();
		const page = this.listRows();
		const start = visibleStart(this.selected, todos.length, page);
		const left = todos.slice(start, start + page).map((todo, offset) =>
			this.todoRow(todo, start + offset === this.selected, leftWidth));
		// The detail pane grows with the list so a tall card is not half empty,
		// but the dependency breakdown keeps the larger share — that is what the
		// pane is for.
		const right = this.detailLines(this.selectedTodo(), todos, rightWidth, Math.max(5, page - 3));
		const rowCount = Math.max(left.length, right.length, 1);
		const rows = [this.header(inner), this.separator(inner)];
		const selectedRows = new Set<number>();
		for (let index = 0; index < rowCount; index++) {
			if (todos.length > 0 && start + index === this.selected) selectedRows.add(rows.length);
			rows.push(`${pad(left[index] ?? "", leftWidth)} ${this.params.glyphs.box.vertical} ${pad(right[index] ?? "", rightWidth)}`);
		}
		rows.push(this.helpLine(inner));
		return this.card(rows, width, selectedRows);
	}

	private renderDetail(width: number): string[] {
		const inner = width - 2;
		const todos = this.todos();
		const rows = [
			this.header(inner),
			this.separator(inner),
			...this.detailLines(this.selectedTodo(), todos, inner, 16),
			this.helpLine(
				inner,
				tuiT("overlay.todo.detailHelp", { keys: this.params.glyphs.upDown }).split("|"),
			),
		];
		return this.card(rows, width);
	}

	private todoRow(todo: TodoItem, selected: boolean, width: number): string {
		const theme = this.params.theme;
		const g = this.params.glyphs;
		const paint = todoPaint(todo.status, g);
		const marker = selected ? g.selectMarker : " ";
		const actor = todoActor(todo, this.todos(), g.transferArrow);
		const segments = [
			`${marker} ${theme.fg(paint.glyphColor, paint.glyph)}`,
			this.orderOf(todo),
		];
		if (actor) segments.push(theme.fg("mdLink", actor));
		segments.push(todoSubject(paint, clean(todo.subject), theme));
		if (todo.status === "blocked" && todo.blockedBy.length > 0) {
			segments.push(theme.fg("dim", `${g.ellipsis} ${todo.blockedBy.length}`));
		}
		return fitLine(segments.join(" "), width);
	}

	private detailLines(
		todo: TodoItem | undefined,
		todos: readonly TodoItem[],
		width: number,
		max: number,
	): string[] {
		if (!todo) return [fitLine(this.emptyState(), width)];
		const theme = this.params.theme;
		const g = this.params.glyphs;
		const lines: string[] = [
			fitLine(
				`${theme.fg(todoPaint(todo.status, g).glyphColor, theme.bold(`${this.glyphFor(todo.status)} ${clean(todo.subject)}`))}`,
				width,
			),
			field(tuiT("overlay.todo.field.id"), todo.id, width),
			field(tuiT("overlay.todo.field.status"), tuiStatus(todo.status), width),
			field(tuiT("overlay.todo.field.assignee"), todo.assignee ? `@${clean(todo.assignee.label)}` : "", width),
			field(tuiT("overlay.todo.field.createdBy"), todo.createdBy ? `@${clean(todo.createdBy.label)}` : "", width),
		];
		if (todo.blockedBy.length > 0) {
			const deps = todo.blockedBy.map((id) => {
				const dep = todos.find((candidate) => candidate.id === id);
				const depGlyph = dep ? this.glyphFor(dep.status) : "?";
				return `${depGlyph} ${dep ? clean(dep.subject) : id}`;
			});
			lines.push(fitLine(theme.fg("dim", tuiT("overlay.todo.field.blockedBy")), width));
			for (const dep of deps.slice(0, max)) lines.push(fitLine(`  ${dep}`, width));
			if (deps.length > max) {
				lines.push(fitLine(theme.fg("dim", `${g.ellipsis} ${deps.length - max} more`), width));
			}
		}
		if (todo.skills.length > 0) {
			lines.push(field(
				tuiT("overlay.todo.field.skills"),
				todo.skills.map((skill) => `${clean(skill.name)}${skill.role ? ` (${clean(skill.role)})` : ""}`).join(", "),
				width,
			));
		}
		return lines;
	}

	private emptyState(): string {
		const g = this.params.glyphs;
		return tuiT("overlay.todo.empty", { mark: g.emptyMark, separator: g.separator });
	}

	private header(width: number): string {
		const todos = this.todos();
		const total = todos.length;
		const done = todos.filter((t) => t.status === "completed").length;
		const running = todos.filter((t) => t.status === "in_progress").length;
		const blocked = todos.filter((t) => t.status === "blocked").length;
		const pending = todos.filter((t) => t.status === "pending").length;
		const theme = this.params.theme;
		const g = this.params.glyphs;
		const segs: PrioritizedSegment[] = [
			{ text: tuiT("overlay.todo.title"), priority: 60, minWidth: 6 },
			{ text: theme.fg("dim", tuiT("common.total", { count: total })), priority: 50, clippable: false },
		];
		if (running) segs.push({ text: theme.fg("accent", tuiT("common.running", { count: running })), priority: 70, clippable: false });
		if (blocked) segs.push({ text: theme.fg("error", tuiT("common.blocked", { count: blocked })), priority: 90, clippable: false });
		if (pending) segs.push({ text: theme.fg("dim", tuiT("common.pending", { count: pending })), priority: 40, clippable: false });
		if (done) segs.push({ text: theme.fg("success", tuiT("common.done", { count: done })), priority: 30, clippable: false });
		return fitLineByPriority(segs, width, { measure: visibleWidth, clip: truncateToWidth }, g.separator, g.ellipsis);
	}

	private helpLine(width: number, segments?: readonly string[]): string {
		const g = this.params.glyphs;
		return fitSegments(
			width,
			segments ?? tuiT("overlay.todo.help", { keys: g.upDown }).split("|"),
			g.separator,
		);
	}

	private separator(width: number): string {
		return this.params.theme.fg("borderMuted", this.params.glyphs.box.horizontal.repeat(Math.max(1, width)));
	}

	private card(rows: string[], width: number, selectedRows: ReadonlySet<number> = new Set()): string[] {
		const theme = this.params.theme;
		const box = this.params.glyphs.box;
		const edge = box.horizontal.repeat(Math.max(0, width - 2));
		const border = (glyph: string) => theme.bg("customMessageBg", theme.fg("borderMuted", glyph));
		const out = [border(`${box.topLeft}${edge}${box.topRight}`)];
		rows.forEach((row, index) => {
			out.push(theme.bg(selectedRows.has(index) ? "selectedBg" : "customMessageBg", pad(` ${row}`, width)));
		});
		out.push(border(`${box.bottomLeft}${edge}${box.bottomRight}`));
		return out;
	}

	private move(delta: number): void {
		this.selectIndex(wrapIndex(this.selected + delta, this.todos().length));
	}

	private selectIndex(index: number): void {
		this.selected = clampIndex(index, this.todos().length);
		this.selectedId = this.todos()[this.selected]?.id;
		this.params.requestRender();
	}

	private clampState(): void {
		const todos = this.todos();
		const preserved = this.selectedId === undefined
			? -1
			: todos.findIndex((t) => t.id === this.selectedId);
		this.selected = preserved >= 0 ? preserved : clampIndex(this.selected, todos.length);
		this.selectedId = todos[this.selected]?.id;
	}

	private todos(): readonly TodoItem[] {
		return orderTodos(this.params.getTodos());
	}

	private selectedTodo(): TodoItem | undefined {
		return this.todos()[this.selected];
	}

	private orderOf(todo: TodoItem): string {
		const todos = this.todos();
		return `${todos.findIndex((candidate) => candidate.id === todo.id) + 1}/${todos.length}`;
	}

	private glyphFor(status: TodoItem["status"]): string {
		return todoPaint(status, this.params.glyphs).glyph;
	}
}

// Same ordering as render.ts renderTodos: status rank first, then creation id,
// then lexicographic — keeps the overlay's row order stable with the inline panel.
export function orderTodos(todos: readonly TodoItem[]): TodoItem[] {
	return [...todos].sort((a, b) =>
		todoStatusRank(a.status) - todoStatusRank(b.status)
		|| todoIdOrder(a.id) - todoIdOrder(b.id)
		|| (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function clean(value: string | undefined): string {
	return value === undefined ? "" : sanitizeExtensionStatusText(value);
}

function wrapIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index + length) % length;
}

function clampIndex(index: number, length: number): number {
	return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[], separator: string): string {
	const kept: string[] = [];
	for (const segment of segments) {
		if (visibleWidth([...kept, segment].join(separator)) > width) break;
		kept.push(segment);
	}
	return kept.length ? kept.join(separator) : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
	const fitted = fitLine(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function field(label: string, value: string, width: number): string {
	return fitLine(`${pad(label, 10)} ${clean(value)}`, width);
}

