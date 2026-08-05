import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { readAutocompleteState } from "./autocomplete-probe.ts";

/** Invisible editor start marker consumed by the fullscreen controller (fullscreenInput only). */
export const EDITOR_START_SENTINEL = "\u2063\u2064\u2063\u2064cockpit:editor:start";
/** Invisible editor end marker consumed by the fullscreen controller (fullscreenInput only). */
export const EDITOR_END_SENTINEL = "\u2063\u2064\u2063\u2064cockpit:editor:end";

export const DEFAULT_DOUBLE_ESCAPE_WINDOW_MS = 500;

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
 * Cockpit's CustomEditor: owns the double-Escape state machine and the editor
 * markers the fullscreen controller uses to split transcript / editor / chrome.
 * Installed at session start (reload-gated) via createCockpitClaudeEditorFactory.
 */
export class CockpitClaudeEditor extends CustomEditor {
	private readonly editorOptions: CockpitClaudeEditorOptions;
	private readonly doubleEscapeGate = new DoubleEscapeGate();

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options: CockpitClaudeEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.editorOptions = options;
		if (options.doubleEscapeWindowMs !== undefined) this.doubleEscapeGate.windowMs = options.doubleEscapeWindowMs;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.editorOptions.emitEditorMarkers) return lines;
		return [EDITOR_START_SENTINEL, ...lines, EDITOR_END_SENTINEL];
	}

	override handleInput(data: string): void {
		const enabled = this.editorOptions.doubleEscapeClearInput;
		if (this.isBareEscape(data)) {
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
		if (enabled) this.doubleEscapeGate.onAnyOtherInput();
		super.handleInput(data);
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
}

/** Build the editor factory Cockpit installs when a gated feature is on. */
export function createCockpitClaudeEditorFactory(options: CockpitClaudeEditorOptions) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
		new CockpitClaudeEditor(tui, theme, keybindings, options);
}
