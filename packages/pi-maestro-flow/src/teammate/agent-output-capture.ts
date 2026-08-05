/**
 * agent-output-capture — persist teammate structured results to `agent://`.
 *
 * Shared by the `tool_result` hook (foreground dispatches, whose details carry
 * the full results) and the `teammate:complete` event listener (background /
 * detached dispatches, whose root tool_result carries empty results). Graph
 * results may lack a task name on the SingleResult; the progress snapshot
 * carries the authoritative correlationId -> name mapping and is used as a
 * fallback so `agent://<task-name>` resolves for graph nodes.
 */

import { persistAgentOutput } from "./agent-output-store.ts";

interface StructuredResultLike {
  correlationId?: unknown;
  originCwd?: unknown;
  name?: unknown;
  agent?: unknown;
  structuredOutput?: unknown;
}

interface ProgressLike {
  correlationId?: unknown;
  name?: unknown;
}

/**
 * Persist one or more structured results into `<cwd>/.pi/agents/`. Entries
 * without a correlation id or structured output are skipped; persistence
 * failures are swallowed (capture must never break tool execution).
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
    if (!correlationId || !cwd || result.structuredOutput === undefined) continue;
    const name = typeof result.name === "string" ? result.name : namesByCid.get(correlationId);
    try {
      await persistAgentOutput(
        correlationId,
        name,
        typeof result.agent === "string" ? result.agent : undefined,
        result.structuredOutput,
        cwd,
      );
    } catch (err) {
      console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
