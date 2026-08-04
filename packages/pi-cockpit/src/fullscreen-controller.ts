import type { TUI } from "@earendil-works/pi-tui";
import { EDITOR_END_SENTINEL, EDITOR_START_SENTINEL } from "./claude-editor.ts";
import { acquireMouseReporting, flushMouseReportingWrites, type MouseReportingLease } from "./mouse-reporting.ts";
import { parseSgrMouseEvent } from "./split-pane.ts";

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
	/** Live read of copyOnSelect; consumed by the selection controller (T4). */
	isCopyOnSelect?: () => boolean;
	/** Subscribe to raw terminal input (wheel + selection). */
	subscribeInput?(handler: (data: string) => InputResult): () => void;
	onError?(error: unknown): void;
}

export interface FullscreenController {
	/** Capture the TUI and enter fullscreen (alt screen + render wrap + mouse lease). */
	attach(tui: TUI): void;
	isActive(): boolean;
	getScrollOffset(): number;
	scrollBy(delta: number): void;
	jumpToBottom(): void;
	requestRender(): void;
	dispose(): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
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

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Layout failure reporting must not break pi's renderer.
		}
	};

	const requestRender = (): void => {
		try {
			tui?.requestRender();
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
		const transcriptHeight = Math.max(0, rows - editorRows - chromeKept);
		const maxOffset = Math.max(0, transcript.length - transcriptHeight);
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
		const visibleStart = transcript.length - transcriptHeight - scrollOffset;
		let visibleTranscript = transcript.slice(Math.max(0, visibleStart), Math.max(0, visibleStart + transcriptHeight));
		// Pad the top when the transcript is shorter than its viewport.
		while (visibleTranscript.length < transcriptHeight) visibleTranscript.unshift("");
		if (scrollOffset > 0 && pendingLines > 0 && transcriptHeight > 0) {
			// Replace the bottom transcript row with the new-output hint.
			visibleTranscript[transcriptHeight - 1] = NEW_OUTPUT_HINT.replace("{n}", String(pendingLines));
			hintRow = transcriptHeight; // 1-indexed row just above the editor block
		}
		return [...visibleTranscript, ...editorBlock, ...chrome];
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
			scrollBy(WHEEL_SCROLL_STEP);
			return { consume: true };
		}
		if (mouse.button === WHEEL_DOWN) {
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
			jumpToBottom();
			return { consume: true };
		}
		// Non-wheel mouse passes through (split-pane resize, later selection).
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
		requestRender();
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
			requestRender();
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
