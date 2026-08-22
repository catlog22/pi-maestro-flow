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

const AGENT_PREFIX = "agent://";
const FILE_PREFIX = "file:";

export function parseBriefingEntry(entry: string): ParsedBriefingEntry {
  if (entry.startsWith(AGENT_PREFIX)) {
    return { kind: "agent", value: entry.slice(AGENT_PREFIX.length) };
  }
  if (entry.startsWith(FILE_PREFIX)) {
    return { kind: "file", value: entry.slice(FILE_PREFIX.length) };
  }
  return { kind: "text", value: entry };
}

/**
 * Append the briefing section to a task prompt. Pure string assembly: no I/O,
 * no expansion of references. Empty briefings return the prompt unchanged.
 */
export function assembleTaskPrompt(prompt: string, briefing?: string[]): string {
  if (!briefing || briefing.length === 0) return prompt;
  const lines = [
    "",
    "",
    "## Briefing",
    "Agent entries use the resource tool; file paths are relative to your cwd. Load references only when needed; text entries are already inline.",
    ...briefing.map((entry) => {
      const parsed = parseBriefingEntry(entry);
      switch (parsed.kind) {
        case "agent":
          return `- [agent] ${AGENT_PREFIX}${parsed.value}`;
        case "file":
          return `- [file] ${parsed.value}`;
        default:
          return `- [text] ${parsed.value}`;
      }
    }),
  ];
  return prompt + lines.join("\n");
}
