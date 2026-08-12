import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type Focusable,
	decodeKittyPrintable,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { effectiveAgentStatus, isExpertLeader, type AgentDisplayStatus } from "./agents-store.ts";
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
import { tuiT } from "./tui-i18n.ts";
import { overlayListRows } from "./viewport.ts";

export interface AgentOverlayParams {
	getAgents: () => readonly AgentRow[];
	getViewingId: () => string | undefined;
	onSelect: (correlationId: string) => void;
	/** Set the selected agent as the editor input target without closing the overlay. */
	onTarget?: (correlationId: string) => void;
	onCommand: (correlationId: string, action: "interrupt" | "steer", message?: string) => void;
	requestRender: () => void;
	close: () => void;
	theme: Theme;
	glyphs: IconGlyphs;
	getTerminalRows?: () => number | undefined;
}

const CARD_CHROME_ROWS = 5;
const COMMAND_ACK_MS = 1_500;
const MAX_STEER_DRAFT_CHARS = 4_096;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const MAX_BUFFERED_PASTE_CHARS = 1_048_576;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
	? new Intl.Segmenter(undefined, { granularity: "grapheme" })
	: undefined;

/** Match the repository's single-line input cleanup without importing across packages. */
function sanitizeDraftInput(data: string): string {
	return data.normalize("NFC").replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function printableDraftInput(data: string): string {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable !== undefined) return kittyPrintable;
	// Escape/CSI-prefixed terminal input is a key sequence, not pasted text.
	if (data.includes("\x1b") || data.includes("\x9b")) return "";
	return sanitizeDraftInput(data);
}

function appendDraftInput(draft: string, data: string, paste = false): string {
	const printable = paste ? sanitizeDraftInput(data) : printableDraftInput(data);
	const remaining = MAX_STEER_DRAFT_CHARS - draft.length;
	if (!printable || remaining <= 0) return draft;
	if (printable.length <= remaining) return draft + printable;

	let end = 0;
	for (const segment of draftSegments(printable)) {
		if (segment.end > remaining) break;
		end = segment.end;
	}
	return draft + printable.slice(0, end);
}

interface DraftInputToken {
	kind: "input" | "paste";
	text: string;
}

class BracketedPasteDecoder {
	private pasting = false;
	private buffer = "";
	private pending = "";

	isPasting(): boolean {
		return this.pasting;
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}

	flushPending(): DraftInputToken[] {
		if (!this.pending) return [];
		const pending = this.pending;
		this.pending = "";
		if (this.pasting) {
			this.appendPaste(pending);
			return [];
		}
		return [{ kind: "input", text: pending }];
	}

	feed(data: string): DraftInputToken[] {
		const tokens: DraftInputToken[] = [];
		let rest = this.pending + data;
		this.pending = "";
		while (rest) {
			if (!this.pasting) {
				const start = rest.indexOf(BRACKETED_PASTE_START);
				if (start < 0) {
					const partial = partialMarkerSuffix(rest, BRACKETED_PASTE_START);
					const input = rest.slice(0, rest.length - partial.length);
					if (input) tokens.push({ kind: "input", text: input });
					this.pending = partial;
					break;
				}
				if (start > 0) tokens.push({ kind: "input", text: rest.slice(0, start) });
				this.pasting = true;
				rest = rest.slice(start + BRACKETED_PASTE_START.length);
				continue;
			}

			const end = rest.indexOf(BRACKETED_PASTE_END);
			if (end < 0) {
				const partial = partialMarkerSuffix(rest, BRACKETED_PASTE_END);
				this.appendPaste(rest.slice(0, rest.length - partial.length));
				this.pending = partial;
				break;
			}
			this.appendPaste(rest.slice(0, end));
			tokens.push({ kind: "paste", text: this.buffer });
			this.buffer = "";
			this.pasting = false;
			rest = rest.slice(end + BRACKETED_PASTE_END.length);
		}
		return tokens;
	}

	private appendPaste(value: string): void {
		const remaining = MAX_BUFFERED_PASTE_CHARS - this.buffer.length;
		if (remaining > 0) this.buffer += value.slice(0, remaining);
	}
}

function partialMarkerSuffix(value: string, marker: string): string {
	const limit = Math.min(value.length, marker.length - 1);
	for (let length = limit; length >= 1; length--) {
		const suffix = value.slice(-length);
		if (marker.startsWith(suffix)) return suffix;
	}
	return "";
}

function removeLastDraftGrapheme(draft: string): string {
	const segments = draftSegments(draft);
	return segments.length === 0 ? draft : draft.slice(0, segments[segments.length - 1].start);
}

function draftSegments(value: string): Array<{ start: number; end: number }> {
	if (graphemeSegmenter) {
		const parts = [...graphemeSegmenter.segment(value)];
		return parts.map((part, index) => ({ start: part.index, end: parts[index + 1]?.index ?? value.length }));
	}

	const segments: Array<{ start: number; end: number }> = [];
	let start = 0;
	for (const char of value) {
		const end = start + char.length;
		segments.push({ start, end });
		start = end;
	}
	return segments;
}

/** Printable text for the search query: single chars, paste and CJK alike. */
function isSearchInput(data: string): boolean {
	return data.length > 0 && [...data].every((ch) => {
		const code = ch.codePointAt(0)!;
		return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
	});
}

export class AgentOverlay implements Component, Focusable {
	focused = false;
	private selectedId: string | undefined;
	private outputScroll: AgentScrollState = { offset: 0, following: true };
	private detailWidth = 80;
	private detailRows = 8;
	private compose: { targetId: string; draft: string; input: BracketedPasteDecoder } | null = null;
	/** Active `/` search mode; the query string may be empty while searching. */
	private searching = false;
	/** Current search query; empty string means no filtering. */
	private search = "";
	private lastAck: { text: string; at: number; error?: boolean } | null = null;
	private ackTimer: ReturnType<typeof setTimeout> | undefined;
	private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly params: AgentOverlayParams) {
		this.selectedId = params.getViewingId();
	}

	invalidate(): void {}
	dispose(): void {
		if (this.ackTimer) clearTimeout(this.ackTimer);
		if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
		this.ackTimer = undefined;
		this.pasteFlushTimer = undefined;
	}

	handleInput(data: string): void {
		if (this.compose) {
			const input = this.compose.input;
			if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
			this.pasteFlushTimer = undefined;
			for (const token of input.feed(data)) this.handleComposeToken(token);
			if (this.compose?.input === input && input.hasPending() && !input.isPasting()) {
				this.pasteFlushTimer = setTimeout(() => {
					this.pasteFlushTimer = undefined;
					if (this.compose?.input !== input) return;
					for (const token of input.flushPending()) this.handleComposeToken(token);
					this.params.requestRender();
				}, 16);
				this.pasteFlushTimer.unref?.();
			}
			this.params.requestRender();
			return;
		}
		const printableInput = decodeKittyPrintable(data);
		const commandInput = printableInput ?? data;
		if (this.searching) {
			// Search mode: printable characters extend the query, backspace trims
			// it. Esc exits and clears; Enter locks the filter so the roster
			// commands (↑↓ / i / s) apply to the narrowed set.
			if (matchesKey(data, Key.escape)) {
				this.searching = false;
				this.search = "";
			} else if (data === "\r" || data === "\n") {
				this.searching = false;
			} else if (data === "\x7f" || data === "\x08") {
				this.search = this.search.slice(0, -1);
			} else if (isSearchInput(commandInput)) {
				this.search += commandInput;
			}
			this.reconcileSelection(this.entries().map((entry) => entry.row));
			this.params.requestRender();
			return;
		}
		if (commandInput === "/") {
			this.searching = true;
			this.search = "";
			this.params.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			// A locked filter (Enter left a non-empty query) is cleared by the
			// first Esc, the second one closes the overlay.
			if (this.search !== "") {
				this.search = "";
				this.reconcileSelection(this.entries().map((entry) => entry.row));
			} else {
				this.params.close();
			}
			this.params.requestRender();
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
			return;
		}
		if (commandInput === "m" && this.selectedId && this.params.onTarget) {
			this.params.onTarget(this.selectedId);
			this.ack(tuiT("overlay.agents.targetAck", { agent: this.agentName(this.selectedId) }));
			return;
		}
		if (commandInput === "i" && this.selectedId) {
			// Interrupt (打断): abort the current turn/tool; the agent stays alive
			// and is told to report and continue.
			this.params.onCommand(this.selectedId, "interrupt");
			this.ack(`interrupt @${this.agentName(this.selectedId)}`);
			return;
		}
		if (commandInput === "s" && this.selectedId) {
			// Steer (引导): interrupt + inject the drafted message. The target is
			// frozen at compose time so later roster changes cannot re-target it.
			this.compose = { targetId: this.selectedId, draft: "", input: new BracketedPasteDecoder() };
			this.params.requestRender();
		}
	}

	private handleComposeToken(token: DraftInputToken): void {
		if (!this.compose) return;
		if (token.kind === "paste") {
			this.compose.draft = appendDraftInput(this.compose.draft, token.text, true);
			return;
		}
		if (matchesKey(token.text, Key.escape)) {
			this.compose = null;
			return;
		}
		if (token.text === "\r" || token.text === "\n") {
			const targetId = this.compose.targetId;
			const draft = this.compose.draft.trim();
			this.compose = null;
			// The compose target is frozen: the steer must never silently
			// re-target another agent because the roster selection moved.
			const target = this.unfilteredEntries().find((entry) => entry.row.correlationId === targetId)?.row;
			if (!target) {
				this.ack(tuiT("overlay.agents.aborted", { agent: this.agentName(targetId) }), true);
			} else if (draft) {
				this.params.onCommand(targetId, "steer", draft);
				this.ack(`steer @${target.name || target.role || target.agent || targetId}: ${draft}`);
			}
			return;
		}
		if (token.text === "\x7f" || token.text === "\x08") {
			this.compose.draft = removeLastDraftGrapheme(this.compose.draft);
			return;
		}
		this.compose.draft = appendDraftInput(this.compose.draft, token.text);
	}

	private ack(text: string, error = false): void {
		this.lastAck = { text, at: Date.now(), ...(error ? { error: true } : {}) };
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.ackTimer = setTimeout(() => {
			this.ackTimer = undefined;
			this.lastAck = null;
			this.params.requestRender();
		}, COMMAND_ACK_MS);
		this.ackTimer.unref?.();
		this.params.requestRender();
	}

	private agentName(correlationId: string): string {
		const row = this.unfilteredEntries().find((entry) => entry.row.correlationId === correlationId)?.row;
		return row?.name || row?.role || row?.agent || correlationId.slice(0, 8);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.min(width, 150));
		const entries = this.entries();
		this.reconcileSelection(entries.map((entry) => entry.row));
		const terminalHeight = this.params.getTerminalRows?.();
		const heightIsCompact = terminalHeight !== undefined && Math.floor(terminalHeight * 0.9) < CARD_CHROME_ROWS + 1;
		if (safeWidth < 20 || heightIsCompact) {
			if (this.compose) {
				const target = this.agentName(this.compose.targetId);
				return [fit(`steer @${target}: ${this.compose.draft}_ · Enter · Esc`, safeWidth)];
			}
			if (this.searching || this.search.trim() !== "") {
				return [fit(`${tuiT("overlay.agents.searchPrompt")} ${this.search}_ (${entries.length}) · Esc`, safeWidth)];
			}
			const selected = entries.find((entry) => entry.row.correlationId === this.selectedId)?.row;
			const title = tuiT("overlay.agents.title");
			return [fit(
				selected
					? `${title} ${entries.length} · ${agentLabel(selected)} · Esc`
					: `${title} · ${tuiT("overlay.agents.none")} · Esc`,
				safeWidth,
			)];
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
		const entries = this.unfilteredEntries();
		const query = this.search.trim();
		if (!query) return entries;
		// A search flattens the tree: the query already broke the hierarchy, so
		// keeping dangling branch glyphs would only add noise to the results.
		return fuzzyFilter(entries, query, (entry) =>
			`${entry.row.name ?? ""} ${entry.row.role} ${entry.row.agent} ${entry.row.task}`,
		).map((entry) => ({ ...entry, prefix: "" }));
	}

	private unfilteredEntries() {
		return buildAgentTree(visibleAgentRows([...this.params.getAgents()]), this.params.glyphs);
	}

	private agentLines(width: number, maxRows: number): string[] {
		const entries = this.entries();
		if (entries.length === 0) {
			return [this.params.theme.fg("dim", fit(
				this.searching || this.search.trim() !== "" ? tuiT("overlay.agents.noMatches") : tuiT("overlay.agents.noAgents"),
				width,
			))];
		}
		const selected = Math.max(0, entries.findIndex((entry) => entry.row.correlationId === this.selectedId));
		const start = visibleStart(selected, entries.length, maxRows);
		return entries.slice(start, start + maxRows).map(({ row, prefix }) => {
			const status = effectiveAgentStatus(row);
			const visual = agentVisual(status, this.params.glyphs);
			const marker = row.correlationId === this.selectedId ? this.params.glyphs.selectMarker : " ";
			const task = row.task ? ` · ${row.task}` : "";
			const expertTag = isExpertLeader(row)
				? `${this.params.theme.fg("accent", tuiT("widget.agent.expert"))} `
				: "";
			return fit(
				`${prefix}${marker} ${this.params.theme.fg(visual.color, visual.glyph)} ${expertTag}${this.params.theme.bold(agentLabel(row))}${task}`,
				width,
			);
		});
	}

	private detailLines(rows: AgentRow[], width: number, maxRows: number): string[] {
		this.detailWidth = width;
		this.detailRows = maxRows;
		if (!this.selectedId) return [this.params.theme.fg("dim", fit(tuiT("overlay.agents.noSelection"), width))];
		return renderSessionDetail(
			rows,
			this.selectedId,
			width,
			this.params.theme,
			maxRows,
			this.outputScroll,
			tuiT("session.previewHint"),
		);
	}

	private header(width: number): string {
		if (this.compose) {
			const target = this.agentName(this.compose.targetId);
			return fit(`steer @${target}: ${this.compose.draft}_`, width);
		}
		if (this.searching || this.search.trim() !== "") {
			const entries = this.entries();
			const total = buildAgentTree(visibleAgentRows([...this.params.getAgents()]), this.params.glyphs).length;
			return fit(`${this.params.theme.fg("accent", tuiT("overlay.agents.searchPrompt"))} ${this.search}_ (${entries.length}/${total})`, width);
		}
		const rows = this.entries().map((entry) => entry.row);
		const statuses = rows.map((row) => effectiveAgentStatus(row));
		const active = statuses.filter((status) => status === "running" || status === "retrying").length;
		const failed = statuses.filter((status) => status === "failed" || status === "stalled").length;
		const ack = this.lastAck && Date.now() - this.lastAck.at < COMMAND_ACK_MS ? this.lastAck : null;
		return fit([
			this.params.theme.bold(tuiT("overlay.agents.title")),
			tuiT("common.total", { count: rows.length }),
			active ? tuiT("common.active", { count: active }) : "",
			failed ? tuiT("common.failed", { count: failed }) : "",
			ack
				? this.params.theme.fg(ack.error ? "error" : "success", ack.error ? `✗ ${ack.text}` : `${this.params.glyphs.check} ${ack.text}`)
				: "",
		].filter(Boolean).join(" · "), width);
	}

	private help(width: number): string {
		if (this.compose) {
			return this.params.theme.fg("dim", fit(tuiT("overlay.agents.composeHelp"), width));
		}
		if (this.searching || this.search.trim() !== "") {
			return this.params.theme.fg("dim", fit(tuiT("overlay.agents.searchHelp"), width));
		}
		return this.params.theme.fg("dim", fit(`${tuiT("overlay.agents.help")} · ${tuiT("overlay.agents.searchHint")}`, width));
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
