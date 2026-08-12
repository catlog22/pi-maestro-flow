/**
 * Qoder-like fixed completion envelope for expert/teammate results.
 * Pure formatter — callers opt in; does not rewrite all tool paths by default.
 */

export interface ExpertResultInput {
  agentId: string;
  agentName?: string;
  content: string;
  exitCode?: number;
  taskType?: string;
  /** When true, skip double-wrapping if content already has RESULT header */
  skipIfPresent?: boolean;
}

export function formatExpertResult(input: ExpertResultInput): string {
  const agentId = String(input.agentId || "unknown");
  const name = input.agentName ? String(input.agentName) : undefined;
  const body = String(input.content ?? "").trimEnd();

  if (input.skipIfPresent !== false && /---\s*RESULT\s*---/i.test(body)) {
    return body.endsWith("\n") ? body : `${body}\n`;
  }

  const who = name
    ? `Agent ${name} has completed.`
    : "Expert has completed.";
  const lines = [
    who,
    "No need to reply to this envelope.",
    `agentId: ${agentId} (verbatim)`,
  ];
  if (input.taskType) lines.push(`taskType: ${input.taskType}`);
  if (typeof input.exitCode === "number") lines.push(`exitCode: ${input.exitCode}`);
  lines.push("outputContent:");
  lines.push("--- RESULT ---");
  lines.push(body || "(no output)");
  return `${lines.join("\n")}\n`;
}

/** Parse agentId from an envelope if present. */
export function parseExpertResultAgentId(text: string): string | null {
  const m = String(text).match(/agentId:\s*([^\s(]+)/i);
  return m?.[1] ?? null;
}
