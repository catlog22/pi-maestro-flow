import type { ContextPressureSnapshot } from "./auto-compaction.ts";
import type { FlowToolResult } from "../tools/tool-result.ts";

/** Stable markers keep Agent-visible result augmentation idempotent. */
export const CONTEXT_PRESSURE_ADVISORY_MARKER = "[context-pressure-advisory]";
export const CONTEXT_TRANSITION_FAILURE_MARKER = "[new-context-transition-failed]";

export interface TodoCompletionAdvanceInput {
  action?: unknown;
  id?: unknown;
  summary?: unknown;
  transition?: unknown;
}

function formatTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function isCompletionFormAdvance(input: TodoCompletionAdvanceInput): boolean {
  return input.action === "advance"
    && typeof input.id === "string"
    && input.id.trim().length > 0
    && typeof input.summary === "string"
    && input.summary.trim().length > 0;
}

/**
 * Build the bounded Agent-facing guidance for one successful Todo completion.
 * This helper is pure: callers provide the effective new-context gate and the
 * already-derived pressure snapshot, so no second settings or threshold read
 * can drift from the compaction policy.
 */
export function buildContextPressureAdvisory(
  snapshot: ContextPressureSnapshot | undefined,
  newContextEnabled: boolean,
): string | undefined {
  if (!newContextEnabled || !snapshot || snapshot.band === "normal") return undefined;

  const usage = `${formatTokens(snapshot.estimatedTokens)}/${formatTokens(snapshot.contextWindow)} tokens`;
  const hard = `hard threshold ${formatTokens(snapshot.hardThresholdTokens)} (${formatTokens(snapshot.remainingToHard)} remaining)`;
  const decision = "This advance has already committed the completed Todo and may have activated the next one. Inspect the current Todo result before acting. Call the standalone new_context tool only when a next phase still exists, this completion is a durable semantic boundary, progress/context/resources are persisted, the next phase is loosely coupled and recoverable from the capsule, and no messages are pending. Otherwise continue or settle in the current context. Do not carry this advisory forward to an unrelated Todo.";

  switch (snapshot.band) {
    case "nudge":
      return `${CONTEXT_PRESSURE_ADVISORY_MARKER} Context pressure is in the nudge band (${usage}; ${hard}). No reset is required; automatic compaction remains the token-pressure owner. ${decision}`;
    case "auto-prune":
      return `${CONTEXT_PRESSURE_ADVISORY_MARKER} Context pressure is in the auto-prune band (${usage}; ${hard}); automatic pruning may be active. ${decision}`;
    case "critical":
      return `${CONTEXT_PRESSURE_ADVISORY_MARKER} Context pressure is critical (${usage}; ${hard}). Automatic compaction owns token-pressure recovery. Do not call new_context in response to this advisory; continue or settle in the current context.`;
    default:
      return undefined;
  }
}

function appendAgentVisibleText(result: FlowToolResult, marker: string, message: string): FlowToolResult {
  if (result.content.some((item) => item.type === "text" && "text" in item && item.text.includes(marker))) {
    return result;
  }
  const content = [...result.content];
  const textIndex = content.findIndex((item) => item.type === "text" && "text" in item);
  if (textIndex === -1) content.push({ type: "text", text: message });
  else {
    const item = content[textIndex];
    if (item?.type === "text" && "text" in item) content[textIndex] = { ...item, text: `${item.text}\n\n${message}` };
  }
  return { ...result, content };
}

/** Make a post-commit reset scheduling failure visible to the Agent, not only the TUI/details channel. */
export function appendTodoContextTransitionFailure(result: FlowToolResult, reason: string): FlowToolResult {
  const message = `${CONTEXT_TRANSITION_FAILURE_MARKER} Todo committed, but the new_context reset could not be scheduled: ${reason}. Continue in the current context unless you explicitly retry after resolving the conflict.`;
  return appendAgentVisibleText(result, CONTEXT_TRANSITION_FAILURE_MARKER, message);
}

/**
 * Append pressure guidance to the Agent-visible text of a successful,
 * completion-form Todo advance. Details/TUI-only metadata is intentionally not
 * used as the delivery channel.
 */
export function appendTodoContextPressureAdvisory(
  result: FlowToolResult,
  input: TodoCompletionAdvanceInput,
  snapshot: ContextPressureSnapshot | undefined,
  newContextEnabled: boolean,
): FlowToolResult {
  const details = result.details as { transition?: unknown } | undefined;
  if (result.isError === true || details?.transition === "new_context") return result;
  if (!isCompletionFormAdvance(input)) return result;

  const advisory = buildContextPressureAdvisory(snapshot, newContextEnabled);
  if (!advisory) return result;

  return appendAgentVisibleText(result, CONTEXT_PRESSURE_ADVISORY_MARKER, advisory);
}
