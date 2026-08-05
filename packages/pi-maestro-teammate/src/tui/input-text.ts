import { visibleWidth } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_PASTE_CHARS = 1_048_576;

export interface DecodedInputToken {
  kind: "input" | "paste";
  text: string;
}

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function sanitizeSingleLineInput(value: string): string {
  return value.normalize("NFC").replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Multi-line variant for the composer: CRLF/CR become LF, tabs expand to two
 * spaces, and control characters are stripped while newlines survive.
 */
export function sanitizeMultiLineInput(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function removeLastGrapheme(value: string): string {
  const ranges = graphemeRanges(value);
  return ranges.length === 0 ? value : value.slice(0, ranges[ranges.length - 1].start);
}

export function previousGraphemeBoundary(value: string, index: number): number {
  let previous = 0;
  for (const range of graphemeRanges(value)) {
    if (range.end >= index) return range.start;
    previous = range.end;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, index: number): number {
  for (const range of graphemeRanges(value)) {
    if (range.start >= index || (range.start < index && index < range.end)) return range.end;
  }
  return value.length;
}

export class BracketedPasteDecoder {
  private pasting = false;
  private buffer = "";
  private pending = "";
  private readonly multiline: boolean;

  constructor(options?: { multiline?: boolean }) {
    this.multiline = options?.multiline ?? false;
  }

  feed(data: string): DecodedInputToken[] {
    const tokens: DecodedInputToken[] = [];
    let rest = this.pending + data;
    this.pending = "";
    while (rest) {
      if (!this.pasting) {
        const start = rest.indexOf(PASTE_START);
        if (start < 0) {
          const partial = partialMarkerSuffix(rest, PASTE_START);
          const input = rest.slice(0, rest.length - partial.length);
          if (input) tokens.push({ kind: "input", text: input });
          this.pending = partial;
          break;
        }
        if (start > 0) tokens.push({ kind: "input", text: rest.slice(0, start) });
        this.pasting = true;
        rest = rest.slice(start + PASTE_START.length);
        continue;
      }
      const end = rest.indexOf(PASTE_END);
      if (end < 0) {
        const partial = partialMarkerSuffix(rest, PASTE_END);
        this.appendPaste(rest.slice(0, rest.length - partial.length));
        this.pending = partial;
        break;
      }
      this.appendPaste(rest.slice(0, end));
      tokens.push({
        kind: "paste",
        text: this.multiline ? sanitizeMultiLineInput(this.buffer) : sanitizeSingleLineInput(this.buffer),
      });
      this.buffer = "";
      this.pasting = false;
      rest = rest.slice(end + PASTE_END.length);
    }
    return tokens;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  flushPending(): DecodedInputToken[] {
    if (!this.pending) return [];
    const pending = this.pending;
    this.pending = "";
    if (this.pasting) {
      this.appendPaste(pending);
      return [];
    }
    return [{ kind: "input", text: pending }];
  }

  private appendPaste(value: string): void {
    const remaining = MAX_PASTE_CHARS - this.buffer.length;
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

/** One wrapped visual line of a draft. Offsets are code-unit indexes into the draft. */
export interface DraftLayoutLine {
  /** Offset of the line's first grapheme. */
  start: number;
  /** Offset one past the line's last grapheme (a hard break's "\n" is included). */
  end: number;
  /** Visible text of the line (never includes the trailing "\n"). */
  text: string;
  /** Visible column width of the line. */
  width: number;
}

export interface DraftCursorLayout {
  lines: DraftLayoutLine[];
  cursorRow: number;
  cursorCol: number;
}

/**
 * Wrap a draft into visual lines at grapheme boundaries. "\n" is a hard
 * break; a soft wrap only happens when the next grapheme would overflow
 * `width` and the line is non-empty. A trailing newline yields a final empty
 * line, mirroring how editors show a blank row after a hard break.
 */
export function wrapDraftLines(draft: string, width: number): DraftLayoutLine[] {
  const lines: DraftLayoutLine[] = [];
  let lineStart = 0;
  let col = 0;
  for (const range of graphemeRanges(draft)) {
    const g = draft.slice(range.start, range.end);
    if (g === "\n") {
      lines.push({ start: lineStart, end: range.end, text: draft.slice(lineStart, range.start), width: col });
      lineStart = range.end;
      col = 0;
      continue;
    }
    const w = visibleWidth(g);
    if (col > 0 && col + w > width) {
      lines.push({ start: lineStart, end: range.start, text: draft.slice(lineStart, range.start), width: col });
      lineStart = range.start;
      col = 0;
    }
    col += w;
  }
  lines.push({ start: lineStart, end: draft.length, text: draft.slice(lineStart), width: col });
  return lines;
}

/**
 * Locate the cursor within the wrapped layout. The cursor is always kept at a
 * grapheme boundary, so its column is the visible width of the line prefix up
 * to the cursor offset.
 */
export function layoutDraftCursor(draft: string, cursor: number, width: number): DraftCursorLayout {
  const lines = wrapDraftLines(draft, width);
  let cursorRow = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    // A cursor right after a hard break belongs to the next visual line; the
    // last line's end (== draft length) stays on the last line.
    if (cursor >= line.start && (cursor < line.end || (isLast && cursor <= line.end))) {
      cursorRow = i;
      break;
    }
  }
  const line = lines[cursorRow];
  return {
    lines,
    cursorRow,
    cursorCol: visibleWidth(draft.slice(line.start, Math.min(cursor, line.end))),
  };
}

/**
 * Offset of the grapheme boundary in `line` closest to (not past) `targetCol`.
 * Used for vertical movement: the cursor keeps its column when crossing wrapped
 * rows and clamps to the visual end of shorter lines.
 */
export function cursorForColumn(draft: string, line: DraftLayoutLine, targetCol: number): number {
  const text = line.text;
  if (!text || targetCol <= 0) return line.start;
  let col = 0;
  for (const range of graphemeRanges(text)) {
    const w = visibleWidth(text.slice(range.start, range.end));
    const nextCol = col + w;
    if (nextCol >= targetCol) {
      return line.start + (nextCol === targetCol ? range.end : range.start);
    }
    col = nextCol;
  }
  return line.start + text.length;
}

function graphemeRanges(value: string): Array<{ start: number; end: number }> {
  if (!segmenter) {
    const ranges: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (const char of value) {
      const end = start + char.length;
      ranges.push({ start, end });
      start = end;
    }
    return ranges;
  }
  const parts = [...segmenter.segment(value)];
  return parts.map((entry, index) => ({ start: entry.index, end: parts[index + 1]?.index ?? value.length }));
}
