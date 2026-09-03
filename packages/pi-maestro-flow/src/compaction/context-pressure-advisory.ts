import type { ContextPressureSnapshot } from "./auto-compaction.ts";
import type { FlowToolResult } from "../tools/tool-result.ts";

/** Stable markers keep Agent-visible result augmentation idempotent. */
export const CONTEXT_PRESSURE_ADVISORY_MARKER = "[context-pressure-advisory]";
export const CONTEXT_TRANSITION_FAILURE_MARKER = "[new-context-transition-failed]";
/** Recommend a manual reset only in the latter half of the prune→hard window. */
export const NEW_CONTEXT_ADVISORY_INTERVAL_FRACTION = 0.5;

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

export function newContextAdvisoryWindow(
  snapshot: ContextPressureSnapshot,
): { startTokens: number; endTokens: number } | undefined {
  const pruneTokens = snapshot.pruneTokens;
  const hardThresholdTokens = snapshot.hardThresholdTokens;
  if (pruneTokens === undefined
    || !Number.isFinite(pruneTokens)
    || !Number.isFinite(hardThresholdTokens)
    || hardThresholdTokens <= pruneTokens) return undefined;
  const startTokens = Math.ceil(
    pruneTokens + (hardThresholdTokens - pruneTokens) * NEW_CONTEXT_ADVISORY_INTERVAL_FRACTION,
  );
  return { startTokens, endTokens: hardThresholdTokens };
}

function isInLateAutoPruneAdvisoryWindow(snapshot: ContextPressureSnapshot): boolean {
  if (snapshot.band !== "auto-prune") return false;
  const window = newContextAdvisoryWindow(snapshot);
  return window !== undefined
    && snapshot.estimatedTokens >= window.startTokens
    && snapshot.estimatedTokens < window.endTokens;
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
  if (!newContextEnabled || !snapshot) return undefined;

  const usage = `${formatTokens(snapshot.estimatedTokens)}/${formatTokens(snapshot.contextWindow)} tokens`;
  const hard = `hard threshold ${formatTokens(snapshot.hardThresholdTokens)} (${formatTokens(snapshot.remainingToHard)} remaining)`;
  const checkpoint = "This reminder is emitted only after a completion-form Todo advance; active Todo work and non-Todo activity are not interrupted or reminded.";
  const decision = "Inspect the task activated in this same result. Call the standalone new_context tool only when a next phase exists, progress/context/resources are persisted, the next phase is loosely coupled and recoverable from the capsule, and no messages are pending. Otherwise continue or settle. Do not carry this advisory forward to an unrelated Todo.";

  if (snapshot.band === "critical") {
    return `${CONTEXT_PRESSURE_ADVISORY_MARKER} Context pressure is critical (${usage}; ${hard}). This Todo completion is the safe checkpoint: prioritize new_context before beginning the next Todo when the recovery conditions are satisfied. Automatic compaction remains the capacity-safety fallback during active work or when it is already pending. ${checkpoint} ${decision}`;
  }

  if (!isInLateAutoPruneAdvisoryWindow(snapshot)) return undefined;
  const window = newContextAdvisoryWindow(snapshot)!;
  const reminderWindow = `${formatTokens(window.startTokens)}–${formatTokens(window.endTokens)} tokens`;
  return `${CONTEXT_PRESSURE_ADVISORY_MARKER} Context pressure is in the late auto-prune reminder window (${usage}; ${hard}); automatic pruning may be active. The New Context reminder window is ${reminderWindow}; below it, continue working because a reset is too early. ${checkpoint} ${decision}`;
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
