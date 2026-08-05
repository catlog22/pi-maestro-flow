export interface DecodedInputToken {
    kind: "input" | "paste";
    text: string;
}
export declare function sanitizeSingleLineInput(value: string): string;
/**
 * Multi-line variant for the composer: CRLF/CR become LF, tabs expand to two
 * spaces, and control characters are stripped while newlines survive.
 */
export declare function sanitizeMultiLineInput(value: string): string;
export declare function removeLastGrapheme(value: string): string;
export declare function previousGraphemeBoundary(value: string, index: number): number;
export declare function nextGraphemeBoundary(value: string, index: number): number;
export declare class BracketedPasteDecoder {
    private pasting;
    private buffer;
    private pending;
    private readonly multiline;
    constructor(options?: {
        multiline?: boolean;
    });
    feed(data: string): DecodedInputToken[];
    hasPending(): boolean;
    flushPending(): DecodedInputToken[];
    private appendPaste;
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
export declare function wrapDraftLines(draft: string, width: number): DraftLayoutLine[];
/**
 * Locate the cursor within the wrapped layout. The cursor is always kept at a
 * grapheme boundary, so its column is the visible width of the line prefix up
 * to the cursor offset.
 */
export declare function layoutDraftCursor(draft: string, cursor: number, width: number): DraftCursorLayout;
/**
 * Offset of the grapheme boundary in `line` closest to (not past) `targetCol`.
 * Used for vertical movement: the cursor keeps its column when crossing wrapped
 * rows and clamps to the visual end of shorter lines.
 */
export declare function cursorForColumn(draft: string, line: DraftLayoutLine, targetCol: number): number;
