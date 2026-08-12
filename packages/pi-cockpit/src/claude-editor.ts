import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, getKeybindings, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { readAutocompleteState } from "./autocomplete-probe.ts";
import { tuiT } from "./tui-i18n.ts";

/** Invisible editor start marker consumed by the fullscreen controller (fullscreenInput only). */
export const EDITOR_START_SENTINEL = "\u2063\u2064\u2063\u2064cockpit:editor:start";
/** Invisible editor end marker consumed by the fullscreen controller (fullscreenInput only). */
export const EDITOR_END_SENTINEL = "\u2063\u2064\u2063\u2064cockpit:editor:end";

export const DEFAULT_DOUBLE_ESCAPE_WINDOW_MS = 500;

/** Cursor state when the user is typing rather than browsing history. */
const NOT_BROWSING = -1;

export interface CockpitEditorRouteTarget {
  label: string;
  sigil?: "@" | "#";
  paint: (text: string) => string;
}

export interface CockpitClaudeEditorOptions {
	/** Enable the double bare-Escape clear-input state machine. */
	doubleEscapeClearInput: boolean;
	/** Emit editor start/end markers in render() for the fullscreen controller. */
	emitEditorMarkers: boolean;
	/** Guard: true while pi is streaming or a capturing overlay is open (never arm). */
	isBusy?: () => boolean;
	/** Called after a double-Escape clears a non-empty draft. */
	onClear?: () => void;
	/** Called if clearing the draft throws. */
	onError?: (error: unknown) => void;
	/** Double-Escape window in ms (default 500). */
	doubleEscapeWindowMs?: number;
	/** Persistent prompt history, newest first. Read on every keystroke. */
	getEntries?: () => readonly string[];
	/** Called for every submitted prompt (including slash commands and `!` lines). */
	record?: (text: string) => void;
	/** Immutable route prefix painted inside the editor, never included in text. */
	getRouteTarget?: () => CockpitEditorRouteTarget | undefined;
	/** Called with the constructed editor so the host can push route updates. */
	onEditor?: (editor: CockpitClaudeEditor) => void;
}

export interface DoubleEscapeDecision {
	/** true: this Escape was consumed (draft cleared) and must not reach the editor. */
	consumed: boolean;
	/** true: this Escape reset any pending arm (autocomplete, busy, empty, probe failure). */
	reset: boolean;
}

export interface DoubleEscapeGateInput {
	autocomplete: "active" | "inactive" | "unknown";
	busy: boolean;
	textEmpty: boolean;
}

/**
 * Pure double bare-Escape state machine, unit-testable without an editor.
 *
 * A first bare Escape on a non-empty, focused, non-streaming draft arms a
 * timer; a second bare Escape inside the window consumes and clears. Any
 * autocomplete cancellation, busy/streaming state, empty draft, other input or
 * window expiry resets the arm — preserving pi's native first-Escape meaning
 * and its empty-draft double-Escape (rewind/tree).
 */
export class DoubleEscapeGate {
	private lastEscapeAt = 0;
	/** Double-Escape window in ms; configurable for tests. */
	windowMs: number;
	private readonly now: () => number;

	constructor(windowMs: number = DEFAULT_DOUBLE_ESCAPE_WINDOW_MS, now: () => number = Date.now) {
		this.windowMs = windowMs;
		this.now = now;
	}

	onEscape(input: DoubleEscapeGateInput): DoubleEscapeDecision {
		if (input.autocomplete === "unknown") {
			// Probe failed: fail open, never clear, keep native Esc behaviour.
			this.lastEscapeAt = 0;
			return { consumed: false, reset: true };
		}
		if (input.autocomplete === "active" || input.busy || input.textEmpty) {
			// This Escape cancels autocomplete / is busy / owns the empty-draft
			// double-Escape; it must not arm a pair.
			this.lastEscapeAt = 0;
			return { consumed: false, reset: true };
		}
		const now = this.now();
		if (this.lastEscapeAt !== 0 && now - this.lastEscapeAt <= this.windowMs) {
			this.lastEscapeAt = 0;
			return { consumed: true, reset: false };
		}
		this.lastEscapeAt = now;
		return { consumed: false, reset: false };
	}

	/** Any non-Escape input between the two Escapes cancels the pair. */
	onAnyOtherInput(): void {
		this.lastEscapeAt = 0;
	}
}

/**
 * Cockpit's unified CustomEditor: owns the double-Escape state machine, the
 * editor markers the fullscreen controller uses, the persistent ↑/↓ prompt
 * history, and the input route-target prefix. Installed at session start
 * (reload-gated) via createCockpitClaudeEditorFactory.
 */
export class CockpitClaudeEditor extends CustomEditor {
	private readonly editorOptions: CockpitClaudeEditorOptions;
	private readonly doubleEscapeGate = new DoubleEscapeGate();
	/** History browsing cursor: NOT_BROWSING while typing, else an index into getEntries(). */
	private index = NOT_BROWSING;
	/** What the user had typed before browsing started, restored on the way back down. */
	private draft = "";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options: CockpitClaudeEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.editorOptions = options;
		if (options.doubleEscapeWindowMs !== undefined) this.doubleEscapeGate.windowMs = options.doubleEscapeWindowMs;
		options.onEditor?.(this);
	}

	/** Submitted prompts go to the persistent store, never to the base in-memory list. */
	override addToHistory(text: string): void {
		this.editorOptions.record?.(text);
	}

	/** Programmatic writes (submit clears, `ui.setEditorText`) end history browsing. */
	override setText(text: string): void {
		this.index = NOT_BROWSING;
		super.setText(text);
	}

	override render(width: number): string[] {
		const target = this.editorOptions.getRouteTarget?.();
		const lines = target ? this.renderWithRouteTarget(width, target) : super.render(width);
		const marked = this.editorOptions.emitEditorMarkers
			? [EDITOR_START_SENTINEL, ...lines, EDITOR_END_SENTINEL]
			: lines;
		const total = this.editorOptions.getEntries?.().length ?? 0;
		if (!this.browsing() || total === 0) return marked;
		return [...marked, historyBanner(this.index + 1, total, width, this.getPaddingX(), this.borderColor)];
	}

	override handleInput(data: string): void {
		if (this.isBareEscape(data)) {
			const enabled = this.editorOptions.doubleEscapeClearInput;
			if (enabled) {
				const probe = readAutocompleteState(this);
				const autocomplete: DoubleEscapeGateInput["autocomplete"] = probe.unknown
					? "unknown"
					: probe.active
						? "active"
						: "inactive";
				const decision = this.doubleEscapeGate.onEscape({
					autocomplete,
					busy: this.editorOptions.isBusy?.() ?? false,
					textEmpty: this.getText().trim() === "",
				});
				if (decision.consumed) {
					this.clearDraft();
					return;
				}
			}
			super.handleInput(data);
			return;
		}
		if (this.editorOptions.doubleEscapeClearInput) this.doubleEscapeGate.onAnyOtherInput();
		const keys = getKeybindings();
		if (keys.matches(data, "tui.editor.cursorUp") && this.canBrowseOlder()) {
			this.step(1);
			return;
		}
		if (keys.matches(data, "tui.editor.cursorDown") && this.canBrowseNewer()) {
			this.step(-1);
			return;
		}
		super.handleInput(data);
		// Editing the recalled text means the user left history behind.
		if (this.browsing() && this.getText() !== this.editorOptions.getEntries?.()[this.index]) {
			this.index = NOT_BROWSING;
		}
	}

	/** Repaint after a cross-extension input-target change. */
	refreshRouteTarget(): void {
		this.tui.requestRender();
	}

	private isBareEscape(data: string): boolean {
		return matchesKey(data, "escape") && !isKeyRelease(data) && !isKeyRepeat(data);
	}

	private clearDraft(): void {
		try {
			this.setText("");
			this.editorOptions.onClear?.();
		} catch (error) {
			this.editorOptions.onError?.(error);
		}
	}

	private renderWithRouteTarget(width: number, target: CockpitEditorRouteTarget): string[] {
		const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const token = truncateToWidth(`${target.sigil ?? "@"}${target.label}:`, Math.max(1, layoutWidth - 1), "…");
		const injected = `${token}${visibleWidth(token) < layoutWidth ? " " : ""}`;

		// Editor has no render-prefix API. Temporarily project the immutable target
		// into its layout state so native wrapping and cursor placement stay correct,
		// then restore the real editable state before returning.
		const state = (this as unknown as EditorWithRenderState).state;
		const originalLines = state.lines;
		const originalCursorCol = state.cursorCol;
		state.lines = [`${injected}${originalLines[0] ?? ""}`, ...originalLines.slice(1)];
		if (state.cursorLine === 0) state.cursorCol += injected.length;
		try {
			const rendered = super.render(width);
			const routeLine = rendered.findIndex((line) => line.includes(token));
			if (routeLine >= 0) {
				rendered[routeLine] = rendered[routeLine]!.replace(token, target.paint(token));
			}
			return rendered.map((line) => truncateToWidth(line, Math.max(1, width), ""));
		} finally {
			state.lines = originalLines;
			state.cursorCol = originalCursorCol;
		}
	}

	private browsing(): boolean {
		return this.index > NOT_BROWSING;
	}

	/**
	 * Mirrors the base editor's own gating: on the first line, and either already
	 * browsing or with the cursor at the very start (which includes an empty editor) —
	 * anywhere else Up is a plain cursor move.
	 */
	private canBrowseOlder(): boolean {
		if (this.isShowingAutocomplete() || this.getCursor().line !== 0) return false;
		return this.browsing() || this.getCursor().col === 0;
	}

	private canBrowseNewer(): boolean {
		if (!this.browsing() || this.isShowingAutocomplete()) return false;
		return this.getCursor().line === this.getLines().length - 1;
	}

	private step(delta: number): void {
		const entries = this.editorOptions.getEntries?.() ?? [];
		const next = this.index + delta;
		if (next < NOT_BROWSING || next >= entries.length) return;
		if (!this.browsing()) this.draft = this.getText();
		// super.setText, so the index we are about to record survives.
		super.setText(next === NOT_BROWSING ? this.draft : entries[next] ?? "");
		this.index = next;
	}
}

/** Compact history position label, indented to the editor's content. */
export function historyBanner(
	position: number,
	total: number,
	width: number,
	paddingX: number,
	paint: (value: string) => string,
): string {
	const indent = " ".repeat(Math.max(0, paddingX));
	const inner = Math.max(1, width - indent.length * 2);
	const label = tuiT("editor.historyBanner", { position, total });
	return indent + paint(truncateToWidth(label, inner, "…"));
}

interface EditorRenderState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface EditorWithRenderState {
	state: EditorRenderState;
}

/** Build the editor factory Cockpit installs for its gated editor features. */
export function createCockpitClaudeEditorFactory(options: CockpitClaudeEditorOptions) {
	const factory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
		new CockpitClaudeEditor(tui, theme, keybindings, options);
	// Global-symbol marker so a later (possibly re-evaluated) extension instance
	// can recognise its own factory left in pi's editor slot across resume/reload
	// and never misreport it as owned by another extension.
	(factory as { [COCKPIT_EDITOR_FACTORY_MARKER]?: true })[COCKPIT_EDITOR_FACTORY_MARKER] = true;
	return factory;
}

/** True when the factory in pi's editor slot is one Cockpit installed. */
export function isCockpitClaudeEditorFactory(factory: unknown): boolean {
	return (
		typeof factory === "function" &&
		(factory as { [COCKPIT_EDITOR_FACTORY_MARKER]?: true })[COCKPIT_EDITOR_FACTORY_MARKER] === true
	);
}

/** Global registry key (same symbol identity across module re-evaluations). */
export const COCKPIT_EDITOR_FACTORY_MARKER = Symbol.for("cockpit.claudeEditorFactory");
