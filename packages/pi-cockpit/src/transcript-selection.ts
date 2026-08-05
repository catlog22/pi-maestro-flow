import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Transcript drag-selection with copy-on-release for fullscreen mode.
 *
 * Selection is anchored on a button-0 press inside the transcript viewport and
 * followed on drag; release copies the visible plain text of the selected
 * flowing region via copyToClipboard (native platform tools with OSC 52
 * fallback). The region is a normal text-style selection: the first row runs
 * from the anchor column to its line end, middle rows cover the full line, and
 * the last row runs from the line start to the focus column (mirrored when
 * dragging upward). Only transcript rows can be selected — the editor and
 * trailing chrome are never in range. ANSI/OSC styling is excluded from the
 * copied text, while the visual highlight is composed with reverse video over
 * the selected cells.
 */

export interface SelectionRect {
	minRow: number;
	maxRow: number;
	minCol: number;
	maxCol: number;
	singleCell: boolean;
}

export interface TranscriptSelectionOptions {
	/** Live read of copyOnSelect; selection only acts while true. */
	isEnabled(): boolean;
	/** Rows in the current transcript viewport. */
	getTranscriptHeight(): number;
	/** Visible transcript lines of the current viewport (with ANSI). */
	getViewportLines(): string[];
	notify(message: string, level: "warning" | "info"): void;
	/** Injectable copy for tests; defaults to pi's copyToClipboard. */
	copy?(text: string): Promise<void>;
	onError?(error: unknown): void;
}

export interface TranscriptSelectionController {
	isSelecting(): boolean;
	/** Button-0 press at a terminal cell (1-indexed x/y). */
	press(x: number, y: number): void;
	/** Drag motion at a terminal cell (1-indexed x/y). */
	motion(x: number, y: number): void;
	/** Button-0 release; returns true when a copy was attempted. */
	release(x: number, y: number): Promise<boolean>;
	/** Cancel any active selection. */
	clear(): void;
	/** Apply the reverse-video highlight to a viewport line (rowIndex 0-based). */
	highlight(line: string, rowIndex: number): string;
}

/** ANSI CSI / OSC / APC escape sequence at a string position, or null. */
function ansiCodeAt(str: string, pos: number): { code: string; length: number } | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;
	const next = str[pos + 1];
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[mGKHJ]/.test(str[j])) j++;
		if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos };
		return null;
	}
	if (next === "]" || next === "_") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return { code: str.substring(pos, j + 1), length: j + 1 - pos };
			if (str[j] === "\x1b" && str[j + 1] === "\\") return { code: str.substring(pos, j + 2), length: j + 2 - pos };
			j++;
		}
		return null;
	}
	if (next === "(" || next === ")") {
		// Character-set designation (ESC ( B etc.) — zero width.
		if (pos + 2 < str.length) return { code: str.substring(pos, pos + 3), length: 3 };
		return null;
	}
	return null;
}

function stripAnsi(text: string): string {
	if (!text.includes("\x1b")) return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ansi = ansiCodeAt(text, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

/** Plain visible text of [startCol, endCol) — ANSI excluded, columns cell-aware. */
function extractPlainSegment(line: string, startCol: number, endCol: number): string {
	const raw = sliceByColumn(line, startCol, Math.max(0, endCol - startCol));
	return stripAnsi(raw);
}

/** Reverse-video highlight over the [startCol, endCol) cells of an ANSI line. */
function highlightSegment(line: string, startCol: number, endCol: number): string {
	const width = visibleWidth(line);
	if (width <= startCol) return line;
	const len = Math.max(0, Math.min(endCol, width) - startCol);
	if (len <= 0) return line;
	const before = sliceByColumn(line, 0, startCol);
	const selected = sliceByColumn(line, startCol, len);
	const after = sliceByColumn(line, startCol + len, width - startCol - len);
	return `${before}\x1b[7m${selected}\x1b[27m${after}`;
}

export function createTranscriptSelectionController(options: TranscriptSelectionOptions): TranscriptSelectionController {
	let anchor: { row: number; col: number } | null = null;
	let focus: { row: number; col: number } | null = null;

	const clampY = (y: number): number => Math.max(1, Math.min(y, Math.max(1, options.getTranscriptHeight())));

	const rect = (): SelectionRect | null => {
		if (!anchor || !focus) return null;
		const minRow = Math.min(anchor.row, focus.row);
		const maxRow = Math.max(anchor.row, focus.row);
		const minCol = Math.min(anchor.col, focus.col);
		const maxCol = Math.max(anchor.col, focus.col);
		return { minRow, maxRow, minCol, maxCol, singleCell: minRow === maxRow && minCol === maxCol };
	};

	/**
	 * Flowing-selection cell range for one viewport row: first row anchor→EOL,
	 * last row 0→focus (mirrored when dragging upward), middle rows full line.
	 */
	const segmentFor = (row: number, lineWidth: number): { start: number; end: number } | null => {
		if (!anchor || !focus) return null;
		const top = Math.min(anchor.row, focus.row);
		const bottom = Math.max(anchor.row, focus.row);
		if (row < top || row > bottom) return null;
		if (top === bottom) {
			// Single-row drag: plain horizontal selection between the two columns.
			const start = Math.min(anchor.col, focus.col);
			return { start, end: Math.max(anchor.col, focus.col) + 1 };
		}
		const forward = focus.row >= anchor.row;
		if (row === top) {
			const start = forward ? anchor.col : focus.col;
			return { start, end: lineWidth };
		}
		if (row === bottom) {
			const endCol = forward ? focus.col : anchor.col;
			return { start: 0, end: endCol + 1 };
		}
		return { start: 0, end: lineWidth };
	};

	const extractText = (): string => {
		const region = rect();
		if (!region) return "";
		const lines = options.getViewportLines();
		const parts: string[] = [];
		for (let row = region.minRow; row <= region.maxRow; row++) {
			const line = lines[row] ?? "";
			const segment = segmentFor(row, visibleWidth(line));
			if (!segment) continue;
			parts.push(extractPlainSegment(line, segment.start, segment.end).trimEnd());
		}
		return parts.join("\n");
	};

	return {
		isSelecting: () => anchor !== null && focus !== null,
		press(x, y) {
			const height = options.getTranscriptHeight();
			if (height <= 0 || y > height) return; // never select in editor/chrome
			anchor = { row: y - 1, col: Math.max(0, x - 1) };
			focus = { ...anchor };
		},
		motion(x, y) {
			if (!anchor) return;
			const clamped = clampY(y);
			if (clamped > options.getTranscriptHeight()) return;
			focus = { row: clamped - 1, col: Math.max(0, x - 1) };
		},
		async release(x, y) {
			if (!anchor) {
				focus = null;
				return false;
			}
			const clamped = clampY(y);
			if (clamped > options.getTranscriptHeight()) {
				anchor = null;
				focus = null;
				return false;
			}
			focus = { row: clamped - 1, col: Math.max(0, x - 1) };
			const region = rect();
			if (!region || region.singleCell) {
				// A plain click (no drag) does not select or copy.
				anchor = null;
				focus = null;
				return false;
			}
			// Drag selection is a basic fullscreen capability (native terminal
			// selection is disabled by mouse reporting), so the highlight always
			// works. Only the auto-copy on release is gated by copyOnSelect.
			if (!options.isEnabled()) {
				anchor = null;
				focus = null;
				return false;
			}
			const text = extractText();
			const copy = options.copy ?? copyToClipboard;
			try {
				await copy(text);
				const lineCount = text.length > 0 ? text.split("\n").length : 0;
				options.notify(
					lineCount > 1
						? `Copied ${text.length} chars · ${lineCount} lines`
						: `Copied ${text.length} chars`,
					"info",
				);
				anchor = null;
				focus = null;
			} catch (error) {
				// Keep the selection so the user can retry; surface the failure.
				options.onError?.(error);
				options.notify(
					`Copy failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			return true;
		},
		clear() {
			anchor = null;
			focus = null;
		},
		highlight(line, rowIndex) {
			if (!anchor || !focus) return line;
			const region = rect();
			if (!region || region.singleCell) return line;
			const segment = segmentFor(rowIndex, visibleWidth(line));
			if (!segment) return line;
			return highlightSegment(line, segment.start, segment.end);
		},
	};
}
