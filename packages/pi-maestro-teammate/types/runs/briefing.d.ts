/**
 * Task briefing appended to a child's task prompt.
 *
 * `agent://<id>` and `file:<path>` stay as lazy references; literal text is
 * already inline. The child decides whether loading each reference is worth it,
 * so a dispatch stays cheap even when the caller holds large prior results.
 */
export type BriefingEntryKind = "agent" | "file" | "text";
export interface ParsedBriefingEntry {
    kind: BriefingEntryKind;
    value: string;
}
export declare function parseBriefingEntry(entry: string): ParsedBriefingEntry;
/**
 * Append the briefing section to a task prompt. Pure string assembly: no I/O,
 * no expansion of references. Empty briefings return the prompt unchanged.
 */
export declare function assembleTaskPrompt(prompt: string, briefing?: string[]): string;
