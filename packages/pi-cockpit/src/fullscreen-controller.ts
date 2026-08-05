import type { TUI } from "@earendil-works/pi-tui";
import { EDITOR_END_SENTINEL, EDITOR_START_SENTINEL } from "./claude-editor.ts";
import { acquireMouseReporting, flushMouseReportingWrites, type MouseReportingLease } from "./mouse-reporting.ts";
import { parseSgrMouseEvent } from "./split-pane.ts";
import {
	createTranscriptSelectionController,
	type TranscriptSelectionController,
} from "./transcript-selection.ts";
import { registerTerminalCleanup } from "./terminal-cleanup.ts";

export const COCKPIT_FULLSCREEN_WIDGET_KEY = "cockpit-fullscreen-anchor";
export const COCKPIT_FULLSCREEN_MARKER = Symbol.for("pi-cockpit.fullscreen-render");

const ALT_SCREEN_ENTER = "\u001b[?1049h";
const ALT_SCREEN_EXIT = "\u001b[?1049l";

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_SCROLL_STEP = 3;
/** New-output hint replaces the bottom transcript row while scrolled up. */
const NEW_OUTPUT_HINT = "\u001b[7m ↑ {n} new · click to bottom \u001b[27m";

type RenderFunction = TUI["render"];
type InputResult = { consume?: boolean; data?: string } | undefined;

interface RenderMarker {
	owner: object;
	original: RenderFunction;
}

export interface FullscreenControllerOptions {
	/** Live read of copyOnSelect; consumed by the selection controller. */
	isCopyOnSelect?: () => boolean;
	/** Subscribe to raw terminal input (wheel + selection). */
	subscribeInput?(handler: (data: string) => InputResult): () => void;
	onError?(error: unknown): void;
	/** User notification surface (e.g. ctx.ui.notify). */
	notify?(message: string, level: "warning" | "info"): void;
	/** Injectable copy for selection tests; defaults to pi's copyToClipboard. */
	copy?(text: string): Promise<void>;
}

export interface FullscreenController {
	/** Capture the TUI and enter fullscreen (alt screen + render wrap + mouse lease). */
	attach(tui: TUI): void;
	isActive(): boolean;
	getScrollOffset(): number;
	scrollBy(delta: number): void;
	jumpToBottom(): void;
	/** force=true resets the TUI diff state for a clean full redraw (surface switch). */
	requestRender(force?: boolean): void;
	dispose(): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Reset pi's differential-renderer baseline so the next frame diffs against the
 * alternate screen's own content (exactly the seeded composed frame) instead of
 * the main-screen document. Fields mirror TUI's render state; cast because they
 * are not part of the public surface.
 */
function seedBaseline(tui: TUI, frame: string[], width: number): void {
	const state = tui as unknown as {
		previousLines: string[];
		previousWidth: number;
		previousHeight: number;
		previousViewportTop: number;
		maxLinesRendered: number;
		cursorRow: number;
		hardwareCursorRow: number;
	};
	state.previousLines = frame;
	state.previousWidth = width;
	state.previousHeight = Math.max(1, Math.trunc(tui.terminal.rows) || 1);
	state.previousViewportTop = 0;
	state.maxLinesRendered = frame.length;
	state.cursorRow = Math.max(0, frame.length - 1);
	state.hardwareCursorRow = Math.max(0, frame.length - 1);
}

export function createFullscreenController(options: FullscreenControllerOptions = {}): FullscreenController {
	const owner = {};
	let tui: TUI | undefined;
	let originalRender: RenderFunction | undefined;
	let wrappedRender: RenderFunction | undefined;
	let mouseLease: MouseReportingLease | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let disposed = false;
	// Lines-from-bottom viewport over the transcript. 0 = live follow.
	let scrollOffset = 0;
	// New transcript lines that arrived while scrolled up (anchor preserved).
	let pendingLines = 0;
	// Row (1-indexed) of the last rendered new-output hint; 0 when none.
	let hintRow = 0;
	// Transcript length at the previous compose, to detect growth while anchored.
	// -1 = not yet measured (first compose establishes the baseline, not "new").
	let lastTranscriptLength = -1;
	// Visible transcript viewport from the last compose (with ANSI), for selection.
	let viewportLines: string[] = [];
	let transcriptHeight = 0;
	const selection = createTranscriptSelectionController({
		isEnabled: () => options.isCopyOnSelect?.() ?? false,
		getTranscriptHeight: () => transcriptHeight,
		getViewportLines: () => viewportLines,
		notify: (message, level) => options.notify?.(message, level),
		copy: options.copy,
		onError: options.onError,
	});

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Layout failure reporting must not break pi's renderer.
		}
	};

	const requestRender = (force = false): void => {
		try {
			tui?.requestRender(force);
		} catch {
			// The TUI may already be shutting down.
		}
	};

	const write = (sequence: string): void => {
		try {
			tui?.terminal.write(sequence);
		} catch {
			// Best-effort: teardown may race terminal disposal (T5 adds a retry).
		}
	};

	const compose = (rendered: string[], terminalRows: number): string[] => {
		const startIndex = rendered.findIndex((line) => line.includes(EDITOR_START_SENTINEL));
		if (startIndex < 0) return rendered;
		const endIndex = rendered.findIndex((line, index) => index > startIndex && line.includes(EDITOR_END_SENTINEL));
		if (endIndex < 0) return rendered;
		const transcript = rendered.slice(0, startIndex);
		const editorBlock = rendered.slice(startIndex + 1, endIndex);
		const trailingChrome = rendered.slice(endIndex + 1);
		const rows = Math.max(1, Math.trunc(terminalRows) || 1);
		const editorRows = Math.max(1, editorBlock.length);
		const chromeRows = trailingChrome.length;
		// The editor must never be truncated; on a very short terminal drop chrome
		// first and then the transcript, keeping the editor whole.
		const chromeKept = Math.max(0, Math.min(chromeRows, rows - editorRows));
		const chrome = chromeKept === chromeRows ? trailingChrome : trailingChrome.slice(0, chromeKept);
		const transcriptHeightFor = Math.max(0, rows - editorRows - chromeKept);
		const maxOffset = Math.max(0, transcript.length - transcriptHeightFor);
		hintRow = 0;
		// Growing transcript while anchored: keep the visible anchor (offset moves
		// down by delta) and surface the new lines via the hint (C4).
		if (scrollOffset > 0 && lastTranscriptLength >= 0 && transcript.length > lastTranscriptLength) {
			const delta = transcript.length - lastTranscriptLength;
			pendingLines += delta;
			scrollOffset += delta;
		}
		lastTranscriptLength = transcript.length;
		scrollOffset = clamp(scrollOffset, 0, maxOffset);
		transcriptHeight = transcriptHeightFor;
		const visibleStart = transcript.length - transcriptHeightFor - scrollOffset;
		let visibleTranscript = transcript.slice(Math.max(0, visibleStart), Math.max(0, visibleStart + transcriptHeightFor));
		// Pad the top when the transcript is shorter than its viewport.
		while (visibleTranscript.length < transcriptHeightFor) visibleTranscript.unshift("");
		viewportLines = visibleTranscript;
		// Composite the active selection highlight over the transcript viewport.
		if (selection.isSelecting()) {
			visibleTranscript = visibleTranscript.map((line, index) => selection.highlight(line, index));
		}
		if (scrollOffset > 0 && pendingLines > 0 && transcriptHeightFor > 0) {
			// Replace the bottom transcript row with the new-output hint.
			visibleTranscript[transcriptHeight - 1] = NEW_OUTPUT_HINT.replace("{n}", String(pendingLines));
			hintRow = transcriptHeight; // 1-indexed row just above the editor block
		}
		const result = [...visibleTranscript, ...editorBlock, ...chrome];
		return result;
	};

	const scrollBy = (delta: number): void => {
		if (tui === undefined) return;
		const target = scrollOffset + delta;
		scrollOffset = Math.max(0, target);
		if (scrollOffset === 0) pendingLines = 0;
		requestRender();
	};

	const jumpToBottom = (): void => {
		scrollOffset = 0;
		pendingLines = 0;
		requestRender();
	};

	const handleInput = (data: string): InputResult => {
		const mouse = parseSgrMouseEvent(data);
		if (!mouse) return undefined;
		if (mouse.button === WHEEL_UP) {
			selection.clear();
			scrollBy(WHEEL_SCROLL_STEP);
			return { consume: true };
		}
		if (mouse.button === WHEEL_DOWN) {
			selection.clear();
			scrollBy(-WHEEL_SCROLL_STEP);
			return { consume: true };
		}
		// Clicking the new-output hint jumps to the live bottom.
		if (
			!mouse.release &&
			!mouse.motion &&
			(mouse.button & 3) === 0 &&
			scrollOffset > 0 &&
			pendingLines > 0 &&
			hintRow > 0 &&
			mouse.y === hintRow
		) {
			selection.clear();
			jumpToBottom();
			return { consume: true };
		}
		// Drag selection is a basic fullscreen capability: native terminal selection
		// is disabled while mouse reporting is on, so press/drag/release always
		// routes to the selection controller (highlight works regardless of
		// copyOnSelect); only the auto-copy on release is gated by that setting.
		if (mouse.y <= transcriptHeight) {
			if (!mouse.release && !mouse.motion && (mouse.button & 3) === 0) {
				selection.press(mouse.x, mouse.y);
				requestRender();
				return { consume: true };
			}
			if (mouse.motion && (mouse.button & 31) === 0) {
				selection.motion(mouse.x, mouse.y);
				requestRender();
				return { consume: true };
			}
			if (mouse.release && (mouse.button & 31) === 0) {
				void selection.release(mouse.x, mouse.y);
				requestRender();
				return { consume: true };
			}
		}
		// Non-wheel mouse passes through (split-pane resize).
		return undefined;
	};

	const attach = (nextTui: TUI): void => {
		if (disposed) return;
		if (tui === nextTui) return;
		if (tui) throw new Error("Cockpit fullscreen is already attached to another TUI");
		const existing = (nextTui.render as RenderFunction & Record<symbol, RenderMarker | undefined>)[COCKPIT_FULLSCREEN_MARKER];
		if (existing?.owner === owner) return;
		if (existing) throw new Error("Cockpit fullscreen is already attached to this TUI");

		tui = nextTui;
		originalRender = nextTui.render;
		const previousRender = nextTui.render;
		wrappedRender = function (this: TUI, width: number): string[] {
			const rendered = previousRender.call(nextTui, width);
			try {
				return compose(rendered, nextTui.terminal.rows);
			} catch (error) {
				reportError(error);
				return rendered;
			}
		};
		Object.defineProperty(wrappedRender, COCKPIT_FULLSCREEN_MARKER, {
			value: { owner, original: previousRender } satisfies RenderMarker,
			configurable: false,
			enumerable: false,
			writable: false,
		});
		nextTui.render = wrappedRender;
		try {
			mouseLease = acquireMouseReporting(nextTui, "button");
		} catch (error) {
			reportError(error);
		}
		// Crash safety: restore the terminal if the process dies while the alternate
		// screen is active (reload/exit/SIGINT). Ref-counted owner; kept for the
		// process lifetime so the comprehensive restore also covers graceful exits
		// where pi's own restore may be incomplete.
		try {
			registerTerminalCleanup((sequence) => nextTui.terminal.write(sequence));
		} catch (error) {
			reportError(error);
		}
		if (options.subscribeInput) {
			try {
				unsubscribeInput = options.subscribeInput(handleInput);
			} catch (error) {
				reportError(error);
			}
		}
		write(ALT_SCREEN_ENTER);
		scrollOffset = 0;
		pendingLines = 0;
		lastTranscriptLength = -1;
		// Deterministic entry (OpenTUI's invalidate()+present() pattern): the
		// alternate screen is a fresh blank surface, but pi's differential renderer
		// keeps the main-screen baseline and can race an in-flight render across
		// the surface switch — skipping rows that were never painted (the editor
		// and fixed dock vanish). Seed the alt screen with the composed frame
		// directly and reset pi's diff baseline to that frame, so subsequent
		// renders only write changed rows (no flicker, no full redraw per frame).
		try {
			const width = nextTui.terminal.columns;
			const frame = compose(previousRender.call(nextTui, width), nextTui.terminal.rows);
			nextTui.terminal.write(`\x1b[2J\x1b[H${frame.join("\r\n")}\r\n`);
			seedBaseline(nextTui, frame, width);
		} catch (error) {
			reportError(error);
			requestRender(true);
		}
	};

	return {
		attach,
		isActive: () => tui !== undefined && !disposed,
		getScrollOffset: () => scrollOffset,
		scrollBy,
		jumpToBottom,
		requestRender,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
			write(ALT_SCREEN_EXIT);
			mouseLease?.release();
			mouseLease = undefined;
			if (unsubscribeInput) {
				try {
					unsubscribeInput();
				} catch {
					// best-effort
				}
				unsubscribeInput = undefined;
			}
			if (tui) flushMouseReportingWrites(tui);
			// Keep the terminal cleanup registered for the process lifetime. On a
			// graceful exit, dispose runs BEFORE process.exit, so releasing the
			// cleanup here would remove the comprehensive exit-flush (kitty/mouse/
			// raw restore) that must run as a safety net in case pi's own restore is
			// incomplete on the user's terminal.
			selection.clear();
			// Leaving the alternate screen returns to the main screen; force a full
			// redraw so the main-screen document is repainted instead of diffed
			// against the stale alt-screen frame.
			requestRender(true);
			tui = undefined;
			originalRender = undefined;
			wrappedRender = undefined;
			scrollOffset = 0;
			pendingLines = 0;
			hintRow = 0;
			lastTranscriptLength = -1;
		},
	};
}
