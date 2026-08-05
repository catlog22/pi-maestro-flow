import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { effectiveAgentStatus, type AgentDisplayStatus } from "./agents-store.ts";
import { scrollBy, type AgentScrollState } from "./agent-scroll.ts";
import type { IconGlyphs } from "./icons.ts";
import { visibleStart } from "./layout.ts";
import { buildAgentTree } from "./render.ts";
import {
	renderSessionDetail,
	sessionDetailBodyLength,
	sessionDetailWindowRows,
} from "./session-detail.ts";
import { visibleAgentRows } from "./stack-widget.ts";
import type { AgentRow } from "./types.ts";
import { overlayListRows } from "./viewport.ts";

export interface AgentOverlayParams {
	getAgents: () => readonly AgentRow[];
	getViewingId: () => string | undefined;
	onSelect: (correlationId: string) => void;
	requestRender: () => void;
	close: () => void;
	theme: Theme;
	glyphs: IconGlyphs;
	getTerminalRows?: () => number | undefined;
}

const CARD_CHROME_ROWS = 5;

export class AgentOverlay implements Component, Focusable {
	focused = false;
	private selectedId: string | undefined;
	private outputScroll: AgentScrollState = { offset: 0, following: true };
	private detailWidth = 80;
	private detailRows = 8;

	constructor(private readonly params: AgentOverlayParams) {
		this.selectedId = params.getViewingId();
	}

	invalidate(): void {}
	dispose(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.params.close();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selectIndex(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selectIndex(this.entries().length - 1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOutput(-Math.max(1, this.detailRows - 2));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOutput(Math.max(1, this.detailRows - 2));
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, 150));
		const entries = this.entries();
		this.reconcileSelection(entries.map((entry) => entry.row));
		const terminalHeight = this.params.getTerminalRows?.();
		const heightIsCompact = terminalHeight !== undefined && Math.floor(terminalHeight * 0.9) < CARD_CHROME_ROWS + 1;
		if (safeWidth < 20 || heightIsCompact) {
			const selected = entries.find((entry) => entry.row.correlationId === this.selectedId)?.row;
			return [fit(selected ? `Agents ${entries.length} · ${agentLabel(selected)} · Esc` : "Agents · none · Esc", safeWidth)];
		}
		return safeWidth < 88
			? this.renderNarrow(safeWidth, entries.map((entry) => entry.row))
			: this.renderWide(safeWidth, entries.map((entry) => entry.row));
	}

	private renderWide(width: number, rows: AgentRow[]): string[] {
		const inner = width - 2;
		const leftWidth = Math.max(30, Math.floor((inner - 3) * 0.38));
		const rightWidth = inner - leftWidth - 3;
		const contentRows = overlayListRows(this.params.getTerminalRows?.(), CARD_CHROME_ROWS);
		const list = this.agentLines(leftWidth, contentRows);
		const detail = this.detailLines(rows, rightWidth, contentRows);
		const bodyRows = Math.max(list.length, detail.length, 1);
		const body: string[] = [this.header(inner), this.rule(inner)];
		for (let index = 0; index < bodyRows; index++) {
			body.push(`${pad(list[index] ?? "", leftWidth)} ${this.params.glyphs.box.vertical} ${pad(detail[index] ?? "", rightWidth)}`);
		}
		body.push(this.help(inner));
		return this.card(body, width);
	}

	private renderNarrow(width: number, rows: AgentRow[]): string[] {
		const inner = width - 2;
		const contentRows = overlayListRows(this.params.getTerminalRows?.(), CARD_CHROME_ROWS);
		const listRows = Math.max(1, Math.min(4, Math.floor(contentRows * 0.35)));
		const list = this.agentLines(inner, listRows);
		const detailRows = Math.max(2, contentRows - list.length - 1);
		const detail = this.detailLines(rows, inner, detailRows);
		return this.card([
			this.header(inner),
			this.rule(inner),
			...list,
			this.rule(inner),
			...detail,
			this.help(inner),
		], width);
	}

	private entries() {
		return buildAgentTree(visibleAgentRows([...this.params.getAgents()]), this.params.glyphs);
	}

	private agentLines(width: number, maxRows: number): string[] {
		const entries = this.entries();
		if (entries.length === 0) return [this.params.theme.fg("dim", fit("No agents", width))];
		const selected = Math.max(0, entries.findIndex((entry) => entry.row.correlationId === this.selectedId));
		const start = visibleStart(selected, entries.length, maxRows);
		return entries.slice(start, start + maxRows).map(({ row, prefix }) => {
			const status = effectiveAgentStatus(row);
			const visual = agentVisual(status, this.params.glyphs);
			const marker = row.correlationId === this.selectedId ? this.params.glyphs.selectMarker : " ";
			const task = row.task ? ` · ${row.task}` : "";
			return fit(
				`${prefix}${marker} ${this.params.theme.fg(visual.color, visual.glyph)} ${this.params.theme.bold(agentLabel(row))}${task}`,
				width,
			);
		});
	}

	private detailLines(rows: AgentRow[], width: number, maxRows: number): string[] {
		this.detailWidth = width;
		this.detailRows = maxRows;
		if (!this.selectedId) return [this.params.theme.fg("dim", fit("No agent selected", width))];
		return renderSessionDetail(
			rows,
			this.selectedId,
			width,
			this.params.theme,
			maxRows,
			this.outputScroll,
			"PgUp/PgDn scroll output",
		);
	}

	private header(width: number): string {
		const rows = this.entries().map((entry) => entry.row);
		const statuses = rows.map((row) => effectiveAgentStatus(row));
		const active = statuses.filter((status) => status === "running" || status === "retrying").length;
		const failed = statuses.filter((status) => status === "failed" || status === "stalled").length;
		return fit([
			this.params.theme.bold("Agents"),
			`${rows.length} total`,
			active ? `${active} active` : "",
			failed ? `${failed} failed` : "",
		].filter(Boolean).join(" · "), width);
	}

	private help(width: number): string {
		return this.params.theme.fg("dim", fit("Esc close · ↑↓ agent · Home/End jump · PgUp/PgDn output", width));
	}

	private rule(width: number): string {
		return this.params.theme.fg("borderMuted", this.params.glyphs.box.horizontal.repeat(Math.max(1, width)));
	}

	private card(rows: string[], width: number): string[] {
		const box = this.params.glyphs.box;
		const edge = box.horizontal.repeat(Math.max(0, width - 2));
		const background = (value: string) => this.params.theme.bg("customMessageBg", value);
		return [
			background(this.params.theme.fg("borderMuted", `${box.topLeft}${edge}${box.topRight}`)),
			...rows.map((row) => background(pad(` ${row}`, width))),
			background(this.params.theme.fg("borderMuted", `${box.bottomLeft}${edge}${box.bottomRight}`)),
		];
	}

	private moveSelection(delta: number): void {
		const rows = this.entries().map((entry) => entry.row);
		if (rows.length === 0) return;
		const current = Math.max(0, rows.findIndex((row) => row.correlationId === this.selectedId));
		this.selectRow(rows[(current + delta + rows.length) % rows.length]);
	}

	private selectIndex(index: number): void {
		const rows = this.entries().map((entry) => entry.row);
		if (rows.length === 0) return;
		this.selectRow(rows[Math.max(0, Math.min(index, rows.length - 1))]);
	}

	private selectRow(row: AgentRow): void {
		this.selectedId = row.correlationId;
		this.outputScroll = { offset: 0, following: true };
		this.params.onSelect(row.correlationId);
		this.params.requestRender();
	}

	private reconcileSelection(rows: AgentRow[]): void {
		if (rows.some((row) => row.correlationId === this.selectedId)) return;
		this.selectedId = rows[0]?.correlationId;
		this.outputScroll = { offset: 0, following: true };
		if (this.selectedId) this.params.onSelect(this.selectedId);
	}

	private scrollOutput(delta: number): void {
		if (!this.selectedId) return;
		const rows = this.entries().map((entry) => entry.row);
		const total = sessionDetailBodyLength(rows, this.selectedId, this.detailWidth);
		const budget = Math.max(1, sessionDetailWindowRows(total, this.detailRows));
		this.outputScroll = scrollBy(this.outputScroll, delta, total, budget);
		this.params.requestRender();
	}
}

function agentLabel(row: AgentRow): string {
	return `@${row.name || row.role || row.agent || "agent"}`;
}

function agentVisual(status: AgentDisplayStatus, glyphs: IconGlyphs): { glyph: string; color: ThemeColor } {
	if (status === "failed" || status === "stalled") return { glyph: glyphs.cross, color: "error" };
	if (status === "terminated") return { glyph: glyphs.cross, color: "warning" };
	if (status === "done" || status === "result-ready") return { glyph: glyphs.check, color: "success" };
	if (status === "pending") return { glyph: glyphs.pending, color: "dim" };
	if (status === "sleeping") return { glyph: glyphs.dotIdle, color: "warning" };
	return { glyph: glyphs.dotRunning, color: "accent" };
}

function fit(value: string, width: number): string {
	return truncateToWidth(value, Math.max(1, width), "…");
}

function pad(value: string, width: number): string {
	const fitted = fit(value, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
