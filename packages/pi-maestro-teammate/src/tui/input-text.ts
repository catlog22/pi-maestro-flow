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
      tokens.push({ kind: "paste", text: sanitizeSingleLineInput(this.buffer) });
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
