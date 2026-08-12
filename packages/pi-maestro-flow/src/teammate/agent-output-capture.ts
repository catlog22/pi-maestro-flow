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

import { persistAgentOutputChecked } from "./agent-output-store.ts";

interface StructuredResultLike {
  correlationId?: unknown;
  publicationId?: unknown;
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

/** Remove results already durably acknowledged by the per-result publication path. */
export function filterUnacknowledgedResults(
  results: unknown,
  acknowledged: { has(publicationId: string): boolean },
): unknown {
  if (!Array.isArray(results)) return results;
  return results.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const publicationId = (entry as { publicationId?: unknown }).publicationId;
    return typeof publicationId !== "string" || !acknowledged.has(publicationId);
  });
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

/** Outcome summary used by the per-result publication acknowledgement. */
export interface PersistStructuredResultsSummary {
  stored: number;
  skipped: number;
  failed: number;
}

/**
 * Persist one or more published or settled results into the global per-workspace
 * output bucket (~/.pi/teammate-output/<workspace>/).
 * Invalid entries are counted as skipped and I/O failures as failed so callers
 * that need a durable acknowledgement do not mistake a no-op for success.
 */
export async function persistStructuredResults(
  results: unknown,
  progress: unknown,
  fallbackCwd?: string,
): Promise<PersistStructuredResultsSummary> {
  const summary: PersistStructuredResultsSummary = { stored: 0, skipped: 0, failed: 0 };
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
  if (!Array.isArray(results)) return summary;
  for (const raw of results) {
    if (raw === null || typeof raw !== "object") {
      summary.skipped += 1;
      continue;
    }
    const result = raw as StructuredResultLike;
    const correlationId = typeof result.correlationId === "string" ? result.correlationId : "";
    const cwd = typeof result.originCwd === "string" && result.originCwd.length > 0
      ? result.originCwd
      : fallbackCwd;
    if (!correlationId || !cwd) {
      summary.skipped += 1;
      continue;
    }
    let output = result.structuredOutput;
    if (output === undefined) {
      const text = typeof result.output === "string" ? result.output.trim() : "";
      output = text.length > 0 ? text : finalMessageText(result.messages);
    }
    if (output === undefined) {
      summary.skipped += 1;
      continue;
    }
    const publicationId = typeof result.publicationId === "string" ? result.publicationId : undefined;
    const name = typeof result.name === "string" ? result.name : namesByCid.get(correlationId);
    try {
      const outcome = await persistAgentOutputChecked(
        correlationId,
        name,
        typeof result.agent === "string" ? result.agent : undefined,
        output,
        cwd,
        publicationId,
      );
      if (outcome === "stored") summary.stored += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

/** Register one result's persistence promise with a teammate publication event. */
export function capturePublishedAgentResult(
  event: unknown,
  onStored?: (publicationId: string) => void,
): boolean {
  if (!event || typeof event !== "object") return false;
  const payload = event as { result?: unknown; waitUntil?: unknown; acknowledgeResource?: unknown };
  if (typeof payload.waitUntil !== "function" || !payload.result) return false;
  const result = payload.result as { correlationId?: unknown; publicationId?: unknown };
  const correlationId = typeof result.correlationId === "string" ? result.correlationId : "unknown";
  const publicationId = typeof result.publicationId === "string" ? result.publicationId : undefined;
  const resourceId = publicationId ?? correlationId;
  const persistence = persistStructuredResults([payload.result], undefined).then((summary) => {
    if (summary.stored !== 1) {
      throw new Error(
        `agent://${resourceId} persistence was not acknowledged `
        + `(stored=${summary.stored}, skipped=${summary.skipped}, failed=${summary.failed})`,
      );
    }
    if (typeof payload.acknowledgeResource === "function") {
      (payload.acknowledgeResource as (uri: string) => void)(`agent://${resourceId}`);
    }
    if (publicationId) onStored?.(publicationId);
  });
  (payload.waitUntil as (promise: Promise<unknown>) => void)(persistence);
  return true;
}
