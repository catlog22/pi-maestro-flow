import { Buffer } from "node:buffer";

export const SEARCH_OUTPUT_MAX_BYTES = 50 * 1024;

/** Return a UTF-8 prefix without splitting a code point or encoding a huge row. */
function utf8Prefix(text: string, maxBytes: number): string {
  let head = text.slice(0, maxBytes);
  // A character-count slice can itself split an astral code point.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const bytes = Buffer.from(head, "utf8");
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Keep only a bounded preview while still measuring every selected row. */
export class SearchText {
  text = "";
  originalBytes = 0;
  private returnedBytes = 0;
  private rows = 0;
  private clipped = false;

  push(row: string): void {
    const text = this.rows++ ? `\n${row}` : row;
    const bytes = Buffer.byteLength(text, "utf8");
    this.originalBytes += bytes;
    if (this.clipped) return;
    const remaining = SEARCH_OUTPUT_MAX_BYTES - this.returnedBytes;
    const prefix = bytes <= remaining ? text : utf8Prefix(text, remaining);
    this.text += prefix;
    this.returnedBytes += Buffer.byteLength(prefix, "utf8");
    this.clipped = bytes > remaining;
  }
}

/** The final cap includes engine/limit notes and the byte-truncation notice. */
export function finishSearchText(body: { text: string; originalBytes?: number }, notes: string[] = []) {
  const noteText = notes.length ? `\n\n[${notes.join("; ")}]` : "";
  // This measures selected/observed output, not matches beyond scan or row limits.
  const originalBytes = (body.originalBytes ?? Buffer.byteLength(body.text, "utf8"))
    + Buffer.byteLength(noteText, "utf8");
  const byteTruncated = originalBytes > SEARCH_OUTPUT_MAX_BYTES;
  let text: string;
  if (byteTruncated) {
    // Keep normal semantic notes visible, but bound even a huge engine error note.
    const boundedNotes = utf8Prefix(noteText, 8 * 1024);
    const notice = `\n\n[Output byte truncation: exceeds ${SEARCH_OUTPUT_MAX_BYTES} bytes. Narrow path, glob, or pattern; use read on an existing matched file with bounded offset/limit to inspect omitted text.]`;
    const suffix = boundedNotes + notice;
    text = utf8Prefix(body.text, SEARCH_OUTPUT_MAX_BYTES - Buffer.byteLength(suffix, "utf8")) + suffix;
  } else {
    text = body.text + noteText;
  }
  return {
    text,
    details: {
      byteTruncated,
      originalBytes,
      returnedBytes: Buffer.byteLength(text, "utf8"),
      maxBytes: SEARCH_OUTPUT_MAX_BYTES,
    },
  };
}
