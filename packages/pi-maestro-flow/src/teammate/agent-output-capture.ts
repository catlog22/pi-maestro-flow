/**
 * agent-output-capture — persist teammate results to `agent://`.
 *
 * Shared by the `tool_result` hook (foreground dispatches, whose details carry
 * the full results) and the `teammate:complete` event listener (background /
 * detached dispatches, whose root tool_result carries empty results). Graph
 * results may lack a task name on the SingleResult; the progress snapshot
 * carries the authoritative correlationId -> name mapping and is used as a
 * fallback so `agent://<task-name>` resolves for graph nodes.
 *
 * A task with an `outputSchema` persists its schema-valid structured output;
 * a plain task persists its final assistant message text instead, so
 * `agent://` records exist for every settled task.
 */

import { persistAgentOutput } from "./agent-output-store.ts";

interface StructuredResultLike {
  correlationId?: unknown;
  originCwd?: unknown;
  name?: unknown;
  agent?: unknown;
  structuredOutput?: unknown;
  /** Final assistant text carried by background `teammate:complete` events. */
  output?: unknown;
  /** Foreground transcript (SingleResult.messages); last assistant text is used. */
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

interface ProgressLike {
  correlationId?: unknown;
  name?: unknown;
}

/** Last non-empty assistant message text; falls back to the last non-empty message. */
function finalMessageText(messages: StructuredResultLike["messages"]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (text) return text;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (text) return text;
  }
  return undefined;
}

/**
 * Persist one or more settled results into `<cwd>/.pi/agents/`. Entries
 * without a correlation id or any output are skipped; persistence failures
 * are swallowed (capture must never break tool execution).
 */
export async function persistStructuredResults(
  results: unknown,
  progress: unknown,
  fallbackCwd?: string,
): Promise<void> {
  const namesByCid = new Map<string, string>();
  if (Array.isArray(progress)) {
    for (const entry of progress) {
      if (entry === null || typeof entry !== "object") continue;
      const p = entry as ProgressLike;
      if (typeof p.correlationId === "string" && typeof p.name === "string") {
        namesByCid.set(p.correlationId, p.name);
      }
    }
  }
  if (!Array.isArray(results)) return;
  for (const raw of results) {
    if (raw === null || typeof raw !== "object") continue;
    const result = raw as StructuredResultLike;
    const correlationId = typeof result.correlationId === "string" ? result.correlationId : "";
    const cwd = typeof result.originCwd === "string" && result.originCwd.length > 0
      ? result.originCwd
      : fallbackCwd;
    if (!correlationId || !cwd) continue;
    let output = result.structuredOutput;
    if (output === undefined) {
      const text = typeof result.output === "string" ? result.output.trim() : "";
      output = text.length > 0 ? text : finalMessageText(result.messages);
    }
    if (output === undefined) continue;
    const name = typeof result.name === "string" ? result.name : namesByCid.get(correlationId);
    try {
      await persistAgentOutput(
        correlationId,
        name,
        typeof result.agent === "string" ? result.agent : undefined,
        output,
        cwd,
      );
    } catch (err) {
      console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
