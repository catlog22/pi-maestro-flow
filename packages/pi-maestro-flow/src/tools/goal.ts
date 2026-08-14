import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  consumeModelFailoverSettlement,
  FAILOVER_TERMINAL_EVENT,
  snapshotModelFailoverSettlement,
  type ModelFailoverSettlementSnapshot,
} from "../providers/model-failover.ts";
import type { WorkflowCoordinator } from "../session/coordinator.ts";
import { activeWorkflowRun, type WorkflowSession, type WorkflowSnapshot } from "../session/types.ts";
import {
  renderGoalPanel,
  type GoalDetailEntry,
  type GoalPauseReason,
  type GoalWidgetPhase,
} from "../tui/goal-widget.ts";
import {
  MAX_COMPLETION_SUMMARY_CHARS,
  MAX_OBJECTIVE_LENGTH,
  acceptanceValidationError,
  configureGoalVerification,
  hasMatchingWorkflowBinding,
  isOverflow,
  isRetryableGoalFailure,
  normalizeAcceptance,
  redactAcceptanceCommandForDisplay,
  verifyGoalCompletion,
  type AgentStopReason,
  type AssistantMessageLike,
} from "./goal-verification.ts";
import {
  detachTasksFromGoal,
  getVisibleTasks,
  persistLoadedTodoStateForGoalDetachRecovery,
} from "./todo.ts";

export {
  buildCanonicalEvidence,
  canonicalCompletionBlockers,
  collectVerifierEvidence,
  isRetryableGoalFailure,
  parseVerifierOutput,
  setAcceptanceRunnerForTest,
  setGoalVerifierRunnerForTest,
} from "./goal-verification.ts";
export type { AcceptanceResult, VerifierVerdict } from "./goal-verification.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "done";
export type PauseReason = GoalPauseReason;

export interface GoalCompactionEntry {
  id: string;
  objective: string;
  status: GoalStatus;
  pauseReason?: PauseReason;
  iteration: number;
  tokensUsed: number;
  tokenBudget?: number;
  verificationFailures?: number;
  infraErrorStreak?: number;
  lastVerificationFailure?: string;
  acceptance?: string[];
  planHandoffKey?: string;
  workflowSessionId?: string;
}

export interface GoalCompactionSnapshot {
  stateVersion: number;
  currentGoalId?: string;
  goals: GoalCompactionEntry[];
}

export interface ActiveGoal {
  id: string;
  text: string;
  status: GoalStatus;
  pauseReason?: PauseReason;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  workflowSessionId?: string;
  planHandoffKey?: string;
  workflowSessionGeneration?: string;
  verificationFailures?: number;
  /**
   * Consecutive verifier *infrastructure* errors, counted separately from
   * verificationFailures so an unreachable verifier never spends the Goal's own
   * failure budget — while still being bounded. Reset by any verdict that made it
   * out of the verifier, and by resume.
   */
  infraErrorStreak?: number;
  lastVerificationFailure?: string;
  acceptance?: string[];
  prevTokensUsed?: number;
  lowProgressCount?: number;
}

interface ContinuationPending {
  goalId: string;
  iteration: number;
  marker: string;
}

export interface GoalContext {
  cwd: string;
  ui: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget?: ExtensionContext["ui"]["setWidget"];
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  abort?: () => void;
  sessionManager?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_KEY = "goal";
const GOAL_WIDGET_KEY = "goal-panel";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const TODO_STATE_ENTRY_TYPE = "todo-state";
/** Schema version of the persisted `goal-state` entry, mirrored into compaction metadata. */
const GOAL_STATE_VERSION = 2;
const MAX_RETAINED_GOALS = 64;
const MAX_RETAINED_GOAL_PAYLOAD_BYTES = 64 * 1024;
const CONTINUATION_MARKER_PREFIX = "maestro-goal-continuation:";
const LOW_PROGRESS_TOKEN_DELTA = 500;
const MAX_LOW_PROGRESS_CONTINUATIONS = 3;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activeGoal: ActiveGoal | undefined;
let stagedActiveGoal: ActiveGoal | undefined;
let goalRegistry: ActiveGoal[] = [];
let pendingTodoDetachGoalIds: string[] = [];
let extensionApi: ExtensionAPI | undefined;
let onGoalStateChanged: (() => void) | undefined;
let goalPanelOwnedExternally = false;
let goalDisplayContext: GoalContext | undefined;
let baseCwd = "";
let continuationPending: ContinuationPending | undefined;
let suspendedContinuation: ContinuationPending | undefined;
// Set while a compaction is in flight and the Goal was active when it started.
// Lets onCompact tell a compaction-preempted interruption (pauseAfterEnd, no
// pauseReason) apart from a deliberate stop, and auto-resume only the former.
let compactionInFlight = false;
let goalRecovery: {
  goalId: string;
  kind: "compaction_retry" | "provider_retry";
  attempt?: number;
  maxRetries?: number;
} | undefined;
let latestGoalAttempt: {
  goalId: string;
  epoch: number;
  assistant?: AssistantMessageLike;
} | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let verificationInFlight: { goalId: string; updatedAt: number; epoch: number } | undefined;
let goalLifecycleEpoch = 0;
let goalSessionId: string | undefined;
let goalLoopOwner: { goalId: string; epoch: number } | undefined;
let workflowCoordinator: WorkflowCoordinator | undefined;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
// Cockpit static mode mirror: while on, the per-second elapsed tick freezes
// and the panel hides the live duration — same contract as every other
// cockpit surface (agent rows, sidebar, thinking label).
let goalStaticMode = false;
let disposeFailoverTerminal: (() => void) | undefined;
const issuedGoalMarkers = new Set<string>();

configureGoalVerification({
  get statusKey() { return STATUS_KEY; },
  get baseCwd() { return baseCwd; },
  get extensionApi() { return extensionApi; },
  get goalLifecycleEpoch() { return goalLifecycleEpoch; },
  get activeGoal() { return stagedActiveGoal ?? activeGoal; },
  set activeGoal(value) { stagedActiveGoal = value; },
  get verificationInFlight() { return verificationInFlight; },
  set verificationInFlight(value) { verificationInFlight = value; },
  getWorkflowSnapshot() { return workflowCoordinator?.status(); },
  refreshWorkflowSnapshot() {
    return workflowCoordinator?.refreshSnapshot?.() ?? Promise.resolve(workflowCoordinator?.status());
  },
  pauseGoal,
  updateUsage,
  persistGoal,
  commitVerifiedCompletion,
  updateStatusLine,
  updateGoalWidget,
  showCompletionStatus,
});

// ---------------------------------------------------------------------------
// Public: LLM tool contract
// ---------------------------------------------------------------------------

export interface GoalGetParams {
  action: "get";
}

export interface GoalCreateParams {
  action: "create";
  objective: string;
  tokenBudget?: string;
  planHandoffKey?: string;
  acceptance?: string[];
}

export interface GoalUpdateParams {
  action: "update";
  objective: string;
  acceptance?: string[];
}
export interface GoalCompleteParams { action: "complete"; summary: string; }

export type GoalParams = GoalGetParams | GoalCreateParams | GoalUpdateParams | GoalCompleteParams;

export type GoalCommandParams =
  | { action: "status" }
  | { action: "create"; objective: string; tokenBudget?: string }
  | { action: "stop" }
  | { action: "resume"; tokenBudget?: string }
  | { action: "clear" };

// ---------------------------------------------------------------------------
// Public: LLM goal tool execute
// ---------------------------------------------------------------------------

export async function executeGoal(
  params: GoalParams,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean; terminate?: boolean }> {
  switch (params.action) {
    case "get":
      return showStatus(ctx);
    case "create": {
      if (typeof params.objective !== "string" || params.objective.trim().length === 0) {
        return { text: "Goal create requires a non-empty objective.", isError: true };
      }
      return handleCreate(params.objective, params.tokenBudget, ctx, params.planHandoffKey, params.acceptance);
    }
    case "update": {
      if (typeof params.objective !== "string" || params.objective.trim().length === 0) {
        return { text: "Goal update requires a non-empty objective.", isError: true };
      }
      return handleUpdate(params.objective, ctx, params.acceptance);
    }
    case "complete": {
      if (typeof params.summary !== "string" || params.summary.trim().length === 0) {
        return { text: "Goal complete requires a non-empty summary.", isError: true };
      }
      const completionSummary = params.summary.trim();
      if (completionSummary.length > MAX_COMPLETION_SUMMARY_CHARS) {
        return {
          text: `Goal completion summary too long (${completionSummary.length}/${MAX_COMPLETION_SUMMARY_CHARS}).`,
          isError: true,
        };
      }
      const outcome = await verifyGoalCompletion(completionSummary, ctx);
      return {
        text: outcome.status === "done"
          ? "Goal done (verified)."
          : `Goal completion was not verified; continue the active Goal. Reason: ${outcome.reason}`,
        isError: false,
      };
    }
    default:
      return { text: "Unknown action. Valid: get, create, update, complete", isError: true };
  }
}

export async function executeGoalCommand(
  params: GoalCommandParams,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean }> {
  switch (params.action) {
    case "status": return showStatus(ctx);
    case "create": return handleCreate(params.objective, params.tokenBudget, ctx);
    case "stop": return handleStop(ctx);
    case "resume": return handleResume(params.tokenBudget, ctx);
    case "clear": return handleClear(ctx);
  }
}

// ---------------------------------------------------------------------------
// Public: /goal command registration
// ---------------------------------------------------------------------------

export function registerGoalCommand(pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Manage goals (no budget by default): /goal status | /goal create [--tokens 100k] <objective> | /goal stop | /goal resume [--tokens 100k] | /goal clear",
    getArgumentCompletions: goalArgumentCompletions,
    async handler(args: string, ctx: GoalContext) {
      const result = parseGoalCommand(args);
      if (typeof result === "string") {
        ctx.ui.notify(result, "warning");
        return;
      }
      const response = await executeGoalCommand(result, ctx);
      if (response.isError) ctx.ui.notify(response.text, "warning");
    },
  });
}

export function goalArgumentCompletions(prefix: string) {
  const options = [
    { value: "status", label: "status", description: "Show the current Goal" },
    { value: "create ", label: "create <objective>", description: "Create a Goal without a Token budget (default)" },
    { value: "create --tokens 100k ", label: "create --tokens 100k <objective>", description: "Create with an explicit budget; accepts plain, k, or m values" },
    { value: "stop", label: "stop", description: "Stop and persist the current Goal" },
    { value: "resume", label: "resume", description: "Resume without changing the budget" },
    { value: "resume --tokens 100k", label: "resume --tokens 100k", description: "Set or replace the Token budget, then resume" },
    { value: "clear", label: "clear", description: "Abandon and remove the current Goal" },
  ];
  const normalized = prefix.trimStart().toLowerCase();
  const matches = options.filter((option) => option.value.toLowerCase().startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

// ---------------------------------------------------------------------------
// Public: event hooks
// ---------------------------------------------------------------------------

export function initGoal(pi: ExtensionAPI) {
  extensionApi = pi;
  disposeFailoverTerminal?.();
  disposeFailoverTerminal = pi.events?.on?.(FAILOVER_TERMINAL_EVENT, onFailoverTerminal);
}

export function setWorkflowCoordinator(coordinator: WorkflowCoordinator | undefined): void {
  workflowCoordinator = coordinator;
}

/**
 * Cockpit static-mode mirror. While on, the per-second elapsed tick freezes
 * and the panel hides the live duration (event-driven state changes still
 * update normally). Turning it back off resumes the tick immediately.
 */
export function setGoalStaticMode(staticMode: boolean): void {
  if (goalStaticMode === staticMode) return;
  goalStaticMode = staticMode;
  const ctx = goalDisplayContext;
  const goal = activeGoal;
  if (!ctx || !goal || goal.status !== "active") return;
  // Repaint now so the panel hides (or restores) the elapsed immediately
  // instead of waiting for the next state change or per-second tick.
  updateStatusLine(ctx, goal);
}

/** Cooperatively withdraw or restore Flow's below-editor Goal panel. */
export function setGoalPanelOwnership(ownedExternally: boolean, ctx?: GoalContext): void {
  if (ctx) goalDisplayContext = ctx;
  goalPanelOwnedExternally = ownedExternally;
  const displayCtx = ctx ?? goalDisplayContext;
  if (!displayCtx) return;
  if (ownedExternally || !activeGoal) {
    displayCtx.ui.setWidget?.(GOAL_WIDGET_KEY, undefined, { placement: "belowEditor" });
    return;
  }
  updateGoalWidget(displayCtx, activeGoal, currentGoalPhase());
}

export function reconcileWorkflowGoal(snapshot: WorkflowSnapshot, ctx: GoalContext): ActiveGoal | undefined {
  const session = snapshot.session;
  if (snapshot.canonicalClaim?.status === "invalid") {
    if (activeGoal?.workflowSessionId && activeGoal.status === "active") {
      fenceGoalLifecycle();
      const paused = pauseGoal(activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
    }
    return activeGoal;
  }
  if (!session) {
    if (activeGoal?.workflowSessionId && activeGoal.status === "active") {
      fenceGoalLifecycle();
      const paused = pauseGoal(activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
    }
    return activeGoal;
  }

  const currentGoal = activeGoal;
  if (currentGoal?.workflowSessionId && (
    currentGoal.workflowSessionId !== session.sessionId
    || currentGoal.workflowSessionGeneration !== snapshot.sessionGeneration
  )) {
    fenceGoalLifecycle();
    const paused = pauseGoal(currentGoal, "gate");
    persistGoal(paused);
    if (session.status === "sealed" || session.status === "archived") {
      updateStatusLine(ctx, paused);
      return paused;
    }
    const replacement = createWorkflowGoal(session, ctx, snapshot.sessionGeneration);
    persistGoal(replacement);
    updateStatusLine(ctx, replacement);
    return replacement;
  }

  if (session.status === "sealed" || session.status === "archived") return activeGoal;
  const failedGate = session.runs.flatMap((run) => run.gates)
    .some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
  if (!activeGoal) {
    const created = createWorkflowGoal(session, ctx, snapshot.sessionGeneration, failedGate);
    persistGoal(created);
    updateStatusLine(ctx, created);
    return created;
  }
  if (activeGoal.workflowSessionId === session.sessionId && failedGate && activeGoal.status === "active") {
    cancelContinuation();
    const paused = pauseGoal(activeGoal, "gate");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
  }
  return activeGoal;
}

export async function onSessionStart(
  ctx: GoalContext,
  event: { reason?: "startup" | "reload" | "new" | "resume" | "fork" } = {},
) {
  goalLifecycleEpoch++;
  verificationInFlight = undefined;
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  clearCompletionTimer();
  clearElapsedTimer();
  clearContinuation();
  clearRecovery();
  baseCwd = ctx.cwd;
  goalDisplayContext = ctx;
  goalSessionId = currentSessionId(ctx);
  if (event.reason === "new" || event.reason === "fork") {
    goalRegistry = [];
    pendingTodoDetachGoalIds = [];
    activeGoal = undefined;
    stagedActiveGoal = undefined;
  } else {
    activeGoal = loadGoalFromSession(ctx, goalSessionId);
    stagedActiveGoal = undefined;
  }
  if (!activeGoal) {
    clearGoalDisplay(ctx);
    return;
  }

  updateStatusLine(ctx, activeGoal);
  if (event.reason === "resume") await handleResume(undefined, ctx);
}

/** Complete pending Goal-to-Todo cleanup only after Todo restored its durable session state. */
export function recoverPendingGoalTodoDetachesAfterTodoStart(ctx: GoalContext): number {
  return recoverPendingGoalTodoDetaches(ctx, true);
}

export function onSessionShutdown(ctx: GoalContext) {
  goalLifecycleEpoch++;
  verificationInFlight = undefined;
  if (activeGoal) persistGoal(activeGoal);
  activeGoal = undefined;
  stagedActiveGoal = undefined;
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  goalSessionId = undefined;
  clearContinuation();
  clearRecovery();
  clearGoalDisplay(ctx);
  goalDisplayContext = undefined;
  clearCompletionTimer();
  clearElapsedTimer();
  compactionInFlight = false;
}

export function onBeforeCompact(ctx: GoalContext) {
  if (!activeGoal || activeGoal.status !== "active") return;
  const compactingGoal = { ...activeGoal };
  updateUsage(compactingGoal, ctx);
  suspendedContinuation = continuationPending ? { ...continuationPending } : undefined;
  compactionInFlight = true;
  persistGoal(compactingGoal);
  updateStatusLine(ctx, compactingGoal);
}

export function onCompactionCancelled(ctx?: GoalContext) {
  compactionInFlight = false;
  const displayCtx = ctx ?? goalDisplayContext;
  const suspended = suspendedContinuation;
  suspendedContinuation = undefined;
  if (suspended && !continuationPending && activeGoal?.id === suspended.goalId) {
    continuationPending = suspended;
    if (!isWorkflowContinuationMarker(suspended.marker)) issuedGoalMarkers.add(suspended.marker);
  }
  if (activeGoal?.status === "active" && displayCtx) {
    persistGoal(activeGoal);
    updateStatusLine(displayCtx, activeGoal);
  }
}

export async function onCompact(
  event: unknown,
  ctx: GoalContext,
  options: { deferContinuation?: boolean } = {},
) {
  const compactionRan = compactionInFlight;
  compactionInFlight = false;
  suspendedContinuation = undefined;
  if (!activeGoal || activeGoal.status !== "active") {
    if (
      compactionRan
      && activeGoal?.status === "paused"
      && activeGoal.pauseReason === undefined
    ) {
      // Compaction preempted this Goal's in-flight continuation turn, so
      // pauseAfterEnd paused it with no pauseReason (interruption). The user
      // did not cancel (that path ends in onCompactionCancelled), so compaction
      // completion auto-resumes instead of stranding the Goal paused.
      clearRecovery();
      const resumedGoal = activateResumedGoal(activeGoal);
      persistGoal(resumedGoal);
      updateStatusLine(ctx, resumedGoal);
      ctx.ui.notify(`Goal auto-resumed after compaction: ${resumedGoal.text}`, "info");
      // Re-send the continuation now: the follow-up triggers a fresh turn
      // against the compacted context. deferContinuation only coordinates
      // provider-pressure failover, which never leaves a Goal in this state.
      const sent = await sendContinuation(ctx, resumedGoal);
      if (!sent && ctx.isIdle?.() !== true) armGoalLoop(resumedGoal);
      return;
    }
    clearRecovery();
    return;
  }
  const restored = loadGoalFromSession(ctx, goalSessionId);
  const compactedGoal = restored?.id === activeGoal.id ? { ...restored } : { ...activeGoal };
  updateUsage(compactedGoal, ctx);
  persistGoal(compactedGoal);
  updateStatusLine(ctx, compactedGoal);

  const wasPiRetry = isPiRetry(event, activeGoal.id);
  const attemptAwaitingSettlement = hasUnsettledAttempt(activeGoal.id);
  if (!wasPiRetry && !attemptAwaitingSettlement) clearRecoveryFor(activeGoal.id);
  const coordinator = workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (
    coordinator
    &&
    hasMatchingWorkflowBinding(activeGoal, workflowSnapshot)
    && workflowSnapshot?.session?.activeRunId
  ) {
    try {
      await coordinator.brief();
    } catch (error) {
      const paused = pauseGoal(activeGoal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
      ctx.ui.notify(`Goal paused because active Run brief recovery failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
  }
  if (wasPiRetry || attemptAwaitingSettlement || hasPending(ctx) || options.deferContinuation) return;
  await sendContinuation(ctx, activeGoal);
}

export function onInput(event: { source?: string; text?: string }) {
  if (event.source === "extension") {
    if (rejectContinuationReplay(event.text ?? "")) return { action: "handled" as const };
    return;
  }
  clearRecovery();
}

export function onBeforeAgentStart(event: { prompt: string }) {
  markDelivered(event.prompt);
}

export async function onAgentEnd(event: { messages: unknown[] }, ctx: GoalContext) {
  if (!activeGoal || activeGoal.status !== "active") return;
  if (goalLoopOwner?.goalId !== activeGoal.id || goalLoopOwner.epoch !== goalLifecycleEpoch) return;

  const goalId = activeGoal.id;
  const finalMsg = findFinalAssistant(event.messages);
  latestGoalAttempt = {
    goalId,
    epoch: goalLifecycleEpoch,
    ...(finalMsg ? { assistant: finalMsg } : {}),
  };

  if (finalMsg && (finalMsg.stopReason === "aborted" || finalMsg.stopReason === "error") && isRetryable(finalMsg)) {
    markGoalRecovery(goalId, isOverflow(finalMsg) ? "compaction_retry" : "provider_retry");
  } else {
    clearRecoveryFor(goalId);
  }
  updateStatusLine(ctx, activeGoal);
}

export function onProviderPressureSettled(ctx: GoalContext) {
  const arbitrationSnapshot = snapshotModelFailoverSettlement();
  if (arbitrationSnapshot) consumeModelFailoverSettlement(arbitrationSnapshot.recoveryId);
  latestGoalAttempt = undefined;
  if (!activeGoal || activeGoal.status !== "active") return;
  clearRecoveryFor(activeGoal.id);
  updateStatusLine(ctx, activeGoal);
}

export async function onAgentSettled(ctx: GoalContext) {
  if (!activeGoal || activeGoal.status !== "active") return;
  if (goalLoopOwner?.goalId !== activeGoal.id || goalLoopOwner.epoch !== goalLifecycleEpoch) return;

  const goalId = activeGoal.id;
  const arbitrationSnapshot = snapshotModelFailoverSettlement();
  const capturedObservation = latestGoalAttempt;
  const observationMissing = !capturedObservation
    || capturedObservation.goalId !== goalId
    || capturedObservation.epoch !== goalLifecycleEpoch;
  const arbitration = arbitrationSnapshot
    ? consumeModelFailoverSettlement(arbitrationSnapshot.recoveryId)
    : undefined;
  if (arbitrationSnapshot && !arbitration) return;
  if (observationMissing) {
    // A stale arbitration snapshot (for example failover fired during a
    // non-Goal turn) was consumed above. It has no attempt correlation, so it
    // must never drive this Goal's outcome; ignore it and keep the Goal as-is.
    return;
  }
  latestGoalAttempt = undefined;

  if (arbitration?.outcome === "fallback-scheduled") {
    markGoalRecovery(goalId, "provider_retry");
    updateStatusLine(ctx, activeGoal);
    return;
  }

  const observation = observationMissing
    ? {
        goalId,
        epoch: goalLifecycleEpoch,
        assistant: {
          role: "assistant" as const,
          stopReason: arbitration?.outcome === "cancelled" ? "aborted" : "error",
          errorMessage: arbitration?.failure ?? "Agent settled without a Goal attempt observation",
        },
      }
    : capturedObservation;
  const observedFailure = observation.assistant?.stopReason === "aborted"
    || observation.assistant?.stopReason === "error";
  const outcome = observationMissing ? "failed" : arbitration?.outcome ?? (observedFailure ? "failed" : "success");
  if (outcome !== "success") {
    clearRecoveryFor(goalId);
    goalLoopOwner = undefined;
    const cancelled = outcome === "cancelled" || observation.assistant?.stopReason === "aborted";
    pauseAfterEnd(ctx, activeGoal, cancelled
      ? { role: "assistant", stopReason: "aborted" }
      : {
          role: "assistant",
          stopReason: "error",
          errorMessage: arbitration?.failure
            ?? (outcome === "replay-blocked" ? arbitration?.replayFence.blockedReason : undefined)
            ?? observation.assistant?.errorMessage,
        });
    return;
  }

  clearRecoveryFor(goalId);
  const hadPending = continuationPending?.goalId === goalId;
  const settledGoal = hadPending ? { ...activeGoal } : increment(activeGoal);
  updateUsage(settledGoal, ctx);

  if (settledGoal.tokenBudget !== undefined && settledGoal.tokensUsed >= settledGoal.tokenBudget) {
    goalLoopOwner = undefined;
    cancelContinuation();
    const paused = pauseGoal(settledGoal, "budget");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
    ctx.ui.notify(`Goal token budget reached: ${fmtBudget(paused)}`, "warning");
    return;
  }

  persistGoal(settledGoal);
  updateStatusLine(ctx, settledGoal);

  if (hadPending) {
    if (hasPending(ctx)) return;
    if (continuationPending?.goalId === goalId) continuationPending = undefined;
  }

  if (!activeGoal || activeGoal.id !== goalId || activeGoal.status !== "active") return;
  if (hasPending(ctx)) return;

  const tokenDelta = activeGoal.tokensUsed - (activeGoal.prevTokensUsed ?? 0);
  const lowProgressCount = tokenDelta < LOW_PROGRESS_TOKEN_DELTA
    ? (activeGoal.lowProgressCount ?? 0) + 1
    : 0;
  if (lowProgressCount >= MAX_LOW_PROGRESS_CONTINUATIONS) {
    goalLoopOwner = undefined;
    cancelContinuation();
    const paused = pauseGoal(activeGoal, "stalled");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
    ctx.ui.notify(`Goal paused: ${MAX_LOW_PROGRESS_CONTINUATIONS} consecutive continuations with minimal progress (<${LOW_PROGRESS_TOKEN_DELTA} tokens each). Use /goal resume to retry.`, "warning");
    return;
  }
  const continuationGoal = { ...activeGoal, prevTokensUsed: activeGoal.tokensUsed, lowProgressCount };
  persistGoal(continuationGoal);

  await sendContinuation(ctx, continuationGoal);
}

export function getActiveGoal(): ActiveGoal | undefined {
  return activeGoal ? { ...activeGoal } : undefined;
}

export function getCurrentGoal(): ActiveGoal | undefined {
  return activeGoal ? { ...activeGoal } : undefined;
}

export function getGoalList(): ActiveGoal[] {
  return [...goalRegistry]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((goal) => ({ ...goal }));
}

export function getGoalById(goalId: string): ActiveGoal | undefined {
  if (activeGoal?.id === goalId) return { ...activeGoal };
  const found = goalRegistry.find((goal) => goal.id === goalId);
  return found ? { ...found } : undefined;
}

export function switchCurrentGoal(
  goalId: string,
  ctx?: GoalContext,
  opts: { resume?: boolean } = {},
): ActiveGoal | undefined {
  const target = goalRegistry.find((goal) => goal.id === goalId);
  if (!target) return undefined;
  const nextGoal = opts.resume && target.status === "paused"
    ? { ...target, status: "active" as const, pauseReason: undefined, verificationFailures: 0, infraErrorStreak: 0, updatedAt: Date.now() }
    : target;
  persistGoal(nextGoal);
  if (ctx) updateStatusLine(ctx, nextGoal);
  return { ...nextGoal };
}

export function addGoal(
  objective: string,
  ctx: GoalContext,
  opts: { tokenBudget?: number; planHandoffKey?: string; acceptance?: string[] } = {},
): ActiveGoal {
  const goal = createGoal(objective, opts.tokenBudget, currentTokenTotal(ctx) ?? 0, opts.planHandoffKey, normalizeAcceptance(opts.acceptance));
  persistGoal(goal);
  updateStatusLine(ctx, goal);
  return { ...goal };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleCreate(
  objective: string,
  budget: string | undefined,
  ctx: GoalContext,
  planHandoffKey?: string,
  acceptance?: unknown,
): Promise<{ text: string; isError: boolean }> {
  const err = validateObjective(objective);
  if (err) return { text: err, isError: true };

  const acceptanceError = acceptanceValidationError(acceptance);
  if (acceptanceError) return { text: acceptanceError, isError: true };

  const tokenBudget = budget ? parseTokenBudget(budget) : undefined;
  if (budget && tokenBudget === undefined) return { text: `Invalid token budget: ${budget}`, isError: true };

  if (activeGoal && activeGoal.status !== "done") {
    return {
      text: `A Goal already exists (${activeGoal.status}): ${activeGoal.text}. Use /goal stop, /goal resume, or /goal clear.`,
      isError: true,
    };
  }

  const goal = createGoal(objective, tokenBudget, currentTokenTotal(ctx) ?? 0, planHandoffKey, normalizeAcceptance(acceptance));
  persistGoal(goal);
  cancelContinuation();
  clearRecovery();
  if (ctx.isIdle?.() !== true) armGoalLoop(goal);
  updateStatusLine(ctx, goal);
  ctx.ui.notify(`Goal started: ${objective}`, "info");
  await sendGoalPrompt(ctx, goal);
  updateStatusLine(ctx, goal);
  return { text: `Goal started (id: ${goal.id}): ${objective}`, isError: false };
}

async function handleUpdate(
  objective: string,
  ctx: GoalContext,
  acceptance?: unknown,
): Promise<{ text: string; isError: boolean }> {
  if (!activeGoal) return { text: "No active goal to update.", isError: true };
  const err = validateObjective(objective);
  if (err) return { text: err, isError: true };
  const acceptanceError = acceptanceValidationError(acceptance);
  if (acceptanceError) return { text: acceptanceError, isError: true };

  const nextGoal = { ...activeGoal };
  updateUsage(nextGoal, ctx);
  nextGoal.text = objective.trim();
  nextGoal.updatedAt = Date.now();
  if (acceptance !== undefined) nextGoal.acceptance = normalizeAcceptance(acceptance);
  persistGoal(nextGoal);
  updateStatusLine(ctx, nextGoal);

  const resumed = await handleResume(undefined, ctx);
  if (resumed.isError) {
    return { text: `Goal updated but could not resume: ${resumed.text}`, isError: true };
  }
  return { text: `Goal updated and resumed (id: ${activeGoal?.id}): ${activeGoal?.text ?? objective.trim()}`, isError: false };
}

async function handleStop(ctx: GoalContext): Promise<{ text: string; isError: boolean }> {
  if (!activeGoal) return { text: "No active goal.", isError: false };
  if (activeGoal.status === "paused") return { text: `Goal is already stopped: ${activeGoal.text}`, isError: false };
  if (activeGoal.status !== "active") return { text: `Goal is ${activeGoal.status}.`, isError: true };

  const stoppedGoal = { ...activeGoal };
  updateUsage(stoppedGoal, ctx);
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  cancelContinuation();
  await fenceWorkflowContinuation();
  const paused = pauseGoal(stoppedGoal, "user");
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  ctx.ui.notify(`Goal stopped by user: ${paused.text}`, "info");
  abortTurn(ctx);
  return { text: `Goal stopped: ${paused.text}`, isError: false };
}

async function handleClear(ctx: GoalContext): Promise<{ text: string; isError: boolean }> {
  await fenceWorkflowContinuation();
  if (!activeGoal) {
    cancelContinuation();
    clearRecovery();
    const hadPendingDetaches = pendingTodoDetachGoalIds.length > 0;
    recoverPendingGoalTodoDetaches(ctx);
    if (!hadPendingDetaches) clearPersistedGoal();
    clearGoalDisplay(ctx);
    return { text: "No active goal.", isError: false };
  }
  const text = activeGoal.text;
  clearActive(ctx);
  ctx.ui.notify(`Goal cleared: ${text}`, "warning");
  return { text: `Goal cleared: ${text}`, isError: false };
}

// ---------------------------------------------------------------------------
// User-controlled resume
// ---------------------------------------------------------------------------

async function handleResume(
  budget: string | undefined,
  ctx: GoalContext,
): Promise<{ text: string; isError: boolean }> {
  if (!activeGoal) return { text: "No active goal.", isError: true };
  if (activeGoal.status === "active") {
    const sent = await sendResumePrompt(ctx, activeGoal);
    if (!sent && ctx.isIdle?.() !== true) armGoalLoop(activeGoal);
    updateStatusLine(ctx, activeGoal);
    return {
      text: sent ? `Goal continuation requested: ${activeGoal.text}` : `Goal is already active: ${activeGoal.text}`,
      isError: false,
    };
  }
  if (activeGoal.status !== "paused") return { text: `Goal is ${activeGoal.status}.`, isError: true };

  const resumedGoal = { ...activeGoal };
  updateUsage(resumedGoal, ctx);
  if (budget) {
    const tokenBudget = parseTokenBudget(budget);
    if (tokenBudget === undefined) return { text: `Invalid token budget: ${budget}`, isError: true };
    resumedGoal.tokenBudget = tokenBudget;
    resumedGoal.updatedAt = Date.now();
  }

  if (resumedGoal.tokenBudget !== undefined && resumedGoal.tokensUsed >= resumedGoal.tokenBudget) {
    persistGoal(resumedGoal);
    updateStatusLine(ctx, resumedGoal);
    ctx.ui.notify(`Token budget still reached: ${fmtBudget(resumedGoal)}`, "warning");
    return { text: `Token budget still reached: ${fmtBudget(resumedGoal)}`, isError: true };
  }

  clearRecovery();
  const activated = activateResumedGoal(resumedGoal);
  persistGoal(activated);
  updateStatusLine(ctx, activated);
  ctx.ui.notify(`Goal resumed: ${activated.text}`, "info");
  const sent = await sendResumePrompt(ctx, activated);
  if (!sent && ctx.isIdle?.() !== true) armGoalLoop(activated);
  updateStatusLine(ctx, activated);
  return { text: `Goal resumed: ${activated.text}`, isError: false };
}

function showStatus(ctx: GoalContext): { text: string; isError: boolean } {
  if (!activeGoal) {
    clearGoalDisplay(ctx);
    return { text: "No goal set.", isError: false };
  }
  const refreshed = { ...activeGoal };
  updateUsage(refreshed, ctx);
  persistGoal(refreshed);
  updateStatusLine(ctx, refreshed);
  return { text: goalSummary(refreshed), isError: false };
}

// ---------------------------------------------------------------------------
// Command parser (/goal user command)
// ---------------------------------------------------------------------------

export function parseGoalCommand(args: string): GoalCommandParams | string {
  const tokens = tokenize(args.trim());
  if (tokens.length === 0) return { action: "status" };

  const [first, ...rest] = tokens;
  if (first === "status" || first === "get") {
    return rest.length === 0 ? { action: "status" } : "Usage: /goal status";
  }
  if (first === "stop") {
    return rest.length === 0 ? { action: "stop" } : "Usage: /goal stop";
  }
  if (first === "clear") return rest.length === 0 ? { action: "clear" } : "Usage: /goal clear";
  if (["pause", "set", "done", "complete"].includes(first ?? "")) {
    return "This legacy Goal command is no longer supported. Use /goal create, /goal stop, /goal resume, or /goal clear; request completion explicitly with the goal tool's complete action.";
  }

  if (first === "resume") {
    if (rest.length === 0) return { action: "resume" };
    if (rest.length === 2 && rest[0] === "--tokens") {
      return { action: "resume", tokenBudget: rest[1] };
    }
    return "Usage: /goal resume [--tokens 100k]";
  }

  // Explicit create or shorthand objective.
  let tokenBudget: string | undefined;
  const remaining = first === "create" ? [...rest] : [...tokens];
  if (remaining[0] === "--tokens") {
    if (!remaining[1]) return "Usage: /goal create --tokens 100k <objective>";
    tokenBudget = remaining[1];
    remaining.splice(0, 2);
    if (remaining.length === 0) return "Usage: /goal create --tokens 100k <objective>";
  }

  if (remaining.length === 0) return "Usage: /goal create [--tokens 100k] <objective>";
  return { action: "create", objective: remaining.join(" "), tokenBudget };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) tokens.push(current); current = ""; continue; }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Goal state transitions
// ---------------------------------------------------------------------------

function createGoal(
  text: string,
  tokenBudget: number | undefined,
  baseline: number,
  planHandoffKey?: string,
  acceptance?: string[],
): ActiveGoal {
  const now = Date.now();
  return {
    id: randomUUID(), text, status: "active",
    startedAt: now, updatedAt: now, iteration: 0,
    tokenBudget, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: baseline,
    ...(planHandoffKey ? { planHandoffKey } : {}),
    ...(acceptance && acceptance.length > 0 ? { acceptance } : {}),
  };
}

function pauseGoal(goal: ActiveGoal, reason?: PauseReason): ActiveGoal {
  const { pauseReason: _pauseReason, ...rest } = goal;
  return { ...rest, status: "paused", ...(reason ? { pauseReason: reason } : {}), updatedAt: Date.now() };
}

/** Reactivate a paused Goal with the same field set handleResume applies. */
function activateResumedGoal(goal: ActiveGoal): ActiveGoal {
  return {
    ...goal,
    status: "active" as const,
    pauseReason: undefined,
    verificationFailures: 0,
    infraErrorStreak: 0,
    lowProgressCount: 0,
    prevTokensUsed: goal.tokensUsed,
    updatedAt: Date.now(),
  };
}

function createWorkflowGoal(
  session: WorkflowSession,
  ctx: GoalContext,
  sessionGeneration: string | undefined,
  failedGate?: boolean,
): ActiveGoal {
  const blocked = failedGate ?? session.runs.flatMap((run) => run.gates)
    .some((gate) => gate.blocking && ["failed", "blocked"].includes(gate.status));
  const definition = session.definitionOfDone.trim();
  const objective = definition ? `${session.intent}\n\nDefinition of done: ${definition}` : session.intent;
  return {
    ...createGoal(objective, undefined, currentTokenTotal(ctx) ?? 0),
    workflowSessionId: session.sessionId,
    ...(sessionGeneration ? { workflowSessionGeneration: sessionGeneration } : {}),
    ...(blocked ? { status: "paused" as const, pauseReason: "gate" as const } : {}),
  };
}

function fenceGoalLifecycle(): void {
  goalLifecycleEpoch++;
  verificationInFlight = undefined;
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  clearCompletionTimer();
  cancelContinuation();
  clearRecovery();
}

function increment(goal: ActiveGoal): ActiveGoal {
  return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

function updateUsage(goal: ActiveGoal, ctx: GoalContext) {
  const currentTokens = currentTokenTotal(ctx);
  if (currentTokens !== undefined) {
    goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, currentTokens - goal.baselineTokens));
  }
  goal.timeUsedSeconds = Math.max(0, Math.floor((Date.now() - goal.startedAt) / 1000));
  goal.updatedAt = Date.now();
}

function clearActive(ctx: GoalContext, keepInRegistry = false) {
  cancelContinuation();
  clearRecovery();
  const clearedGoal = activeGoal;
  if (clearedGoal && !keepInRegistry) {
    const nextRegistry = goalRegistry.filter((entry) => entry.id !== clearedGoal.id);
    const nextPending = [...new Set([...pendingTodoDetachGoalIds, clearedGoal.id])];
    persistGoalSelection(undefined, nextRegistry, nextPending);
    const detached = recoverPendingGoalTodoDetaches(ctx);
    if (detached > 0) {
      ctx.ui.notify(
        `Goal cleared; unbound ${detached} task${detached === 1 ? "" : "s"} from its quality gate.`,
        "info",
      );
    }
  } else {
    persistGoalSelection(undefined, goalRegistry, pendingTodoDetachGoalIds);
  }
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  clearElapsedTimer();
  clearGoalDisplay(ctx);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function registryWithGoal(goal: ActiveGoal): ActiveGoal[] {
  const next = [...goalRegistry];
  const index = next.findIndex((entry) => entry.id === goal.id);
  if (index >= 0) next[index] = goal;
  else next.push(goal);
  return next;
}

function persistGoal(goal: ActiveGoal): void {
  const nextRegistry = retainGoalRegistry(
    registryWithGoal(goal),
    goal.id,
    visibleTodoGoalIds(),
    new Set(pendingTodoDetachGoalIds),
  );
  try {
    appendGoalState(goal, nextRegistry, pendingTodoDetachGoalIds);
  } catch (error) {
    if (stagedActiveGoal === goal) stagedActiveGoal = undefined;
    throw error;
  }
  goalRegistry = nextRegistry;
  activeGoal = goal;
  stagedActiveGoal = undefined;
  onGoalStateChanged?.();
}

function clearPersistedGoal(): void {
  persistGoalSelection(undefined, goalRegistry, pendingTodoDetachGoalIds);
}

function persistGoalSelection(
  currentGoal: ActiveGoal | undefined,
  nextRegistry: ActiveGoal[],
  nextPendingTodoDetachGoalIds: string[],
): void {
  const retainedRegistry = retainGoalRegistry(
    nextRegistry,
    currentGoal?.id,
    visibleTodoGoalIds(),
    new Set(nextPendingTodoDetachGoalIds),
  );
  appendGoalState(currentGoal, retainedRegistry, nextPendingTodoDetachGoalIds);
  goalRegistry = retainedRegistry;
  activeGoal = currentGoal;
  stagedActiveGoal = undefined;
  pendingTodoDetachGoalIds = nextPendingTodoDetachGoalIds;
  onGoalStateChanged?.();
}

function appendGoalState(
  currentGoal: ActiveGoal | undefined,
  goals: ActiveGoal[],
  pendingDetaches: string[],
): void {
  extensionApi?.appendEntry?.(GOAL_STATE_ENTRY_TYPE, {
    version: GOAL_STATE_VERSION,
    sessionId: goalSessionId,
    goal: currentGoal ?? null,
    goals,
    currentGoalId: currentGoal?.id,
    ...(pendingDetaches.length > 0 ? { pendingTodoDetachGoalIds: pendingDetaches } : {}),
  });
}

function commitVerifiedCompletion(goal: ActiveGoal, ctx: GoalContext): void {
  const referencedGoalIds = visibleTodoGoalIds();
  const needsTodoDetach = referencedGoalIds.has(goal.id);
  const pendingWithCompletion = needsTodoDetach
    ? [...new Set([...pendingTodoDetachGoalIds, goal.id])]
    : [...pendingTodoDetachGoalIds];
  const verifiedRegistry = retainGoalRegistry(
    registryWithGoal(goal),
    goal.id,
    referencedGoalIds,
    new Set(pendingWithCompletion),
  );

  appendGoalState(goal, verifiedRegistry, pendingWithCompletion);
  goalRegistry = verifiedRegistry;
  activeGoal = goal;
  stagedActiveGoal = undefined;
  pendingTodoDetachGoalIds = pendingWithCompletion;
  cancelContinuation();
  clearRecovery();
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  clearElapsedTimer();

  if (needsTodoDetach) detachTasksFromGoal(goal.id);

  const settledPending = pendingWithCompletion.filter((goalId) => goalId !== goal.id);
  const settledRegistry = retainGoalRegistry(
    goalRegistry,
    undefined,
    visibleTodoGoalIds(),
    new Set(settledPending),
  );
  appendGoalState(undefined, settledRegistry, settledPending);
  goalRegistry = settledRegistry;
  activeGoal = undefined;
  stagedActiveGoal = undefined;
  pendingTodoDetachGoalIds = settledPending;
  onGoalStateChanged?.();
}

function visibleTodoGoalIds(): Set<string> {
  return new Set(getVisibleTasks().flatMap((task) => task.goalId ? [task.goalId] : []));
}

function persistedTodoGoalIds(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): Set<string> {
  const entry = entries
    .filter((candidate) => candidate.type === "custom" && candidate.customType === TODO_STATE_ENTRY_TYPE)
    .pop();
  const data = entry?.data;
  if (!data || typeof data !== "object") return new Set();
  const rawTasks = (data as { tasks?: unknown }).tasks;
  if (!rawTasks || typeof rawTasks !== "object" || Array.isArray(rawTasks)) return new Set();
  const goalIds = new Set<string>();
  for (const rawTask of Object.values(rawTasks)) {
    if (!rawTask || typeof rawTask !== "object") continue;
    const task = rawTask as { goalId?: unknown; status?: unknown };
    if (task.status !== "deleted" && typeof task.goalId === "string" && task.goalId) {
      goalIds.add(task.goalId);
    }
  }
  return goalIds;
}

function retainedGoalPayloadBytes(goals: ActiveGoal[], currentGoalId: string | undefined): number {
  const currentGoal = currentGoalId ? goals.find((goal) => goal.id === currentGoalId) : undefined;
  return Buffer.byteLength(JSON.stringify({
    goal: currentGoal ?? null,
    goals,
    currentGoalId: currentGoal?.id,
  }), "utf8");
}

function retainGoalRegistry(
  goals: ActiveGoal[],
  currentGoalId: string | undefined,
  referencedGoalIds: ReadonlySet<string>,
  pendingDetachGoalIds: ReadonlySet<string>,
): ActiveGoal[] {
  const removable = goals
    .filter((goal) => goal.status === "done"
      && goal.id !== currentGoalId
      && (!referencedGoalIds.has(goal.id) || pendingDetachGoalIds.has(goal.id)))
    .sort((left, right) => (
      left.startedAt - right.startedAt
      || left.updatedAt - right.updatedAt
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    ));
  let retained = [...goals];
  for (const goal of removable) {
    if (retained.length <= MAX_RETAINED_GOALS
      && retainedGoalPayloadBytes(retained, currentGoalId) <= MAX_RETAINED_GOAL_PAYLOAD_BYTES) break;
    const index = retained.indexOf(goal);
    if (index >= 0) retained.splice(index, 1);
  }
  const payloadBytes = retainedGoalPayloadBytes(retained, currentGoalId);
  if (retained.length > MAX_RETAINED_GOALS || payloadBytes > MAX_RETAINED_GOAL_PAYLOAD_BYTES) {
    throw new Error(
      `Goal registry exceeds its retained-history bound (${retained.length}/${MAX_RETAINED_GOALS} goals, ${payloadBytes}/${MAX_RETAINED_GOAL_PAYLOAD_BYTES} bytes) and cannot be pruned without dropping an active contract.`,
    );
  }
  return retained;
}

function recoverPendingGoalTodoDetaches(ctx: GoalContext, todoStateJustLoaded = false): number {
  if (pendingTodoDetachGoalIds.length === 0) return 0;
  let detached = 0;
  for (const goalId of pendingTodoDetachGoalIds) detached += detachTasksFromGoal(goalId);
  if (detached === 0 && todoStateJustLoaded) persistLoadedTodoStateForGoalDetachRecovery();
  persistGoalSelection(activeGoal, goalRegistry, []);
  return detached;
}

/** Bind the root UI/UCL to durable Goal state changes. */
export function setGoalStateChangeListener(listener: (() => void) | undefined): void {
  onGoalStateChanged = listener;
}

function loadGoalFromSession(ctx: GoalContext, sessionId: string | undefined): ActiveGoal | undefined {
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
  const entry = entries.filter((e) => e.type === "custom" && e.customType === GOAL_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as {
    sessionId?: string;
    goal?: ActiveGoal | null;
    goals?: unknown;
    currentGoalId?: string;
    pendingTodoDetachGoalIds?: unknown;
  } | undefined;
  if (data?.sessionId && sessionId && data.sessionId !== sessionId) {
    goalRegistry = [];
    pendingTodoDetachGoalIds = [];
    return undefined;
  }
  const loadedPendingDetaches = Array.isArray(data?.pendingTodoDetachGoalIds)
    ? data.pendingTodoDetachGoalIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const referencedGoalIds = persistedTodoGoalIds(entries);
  for (const goalId of visibleTodoGoalIds()) referencedGoalIds.add(goalId);

  if (Array.isArray(data?.goals)) {
    const loadedGoals = data.goals.filter(isGoal).map(normalizeLoadedGoal);
    const completedReferencedGoalIds = loadedGoals
      .filter((goal) => goal.status === "done" && referencedGoalIds.has(goal.id))
      .map((goal) => goal.id);
    const nextPendingDetaches = [...new Set([...loadedPendingDetaches, ...completedReferencedGoalIds])];
    const loadedCurrent = loadedGoals.find((goal) => goal.id === data.currentGoalId);
    const current = loadedCurrent?.status === "done" ? undefined : loadedCurrent;
    const retainedRegistry = retainGoalRegistry(
      loadedGoals,
      current?.id,
      referencedGoalIds,
      new Set(nextPendingDetaches),
    );
    const needsRepair = nextPendingDetaches.length !== loadedPendingDetaches.length
      || current?.id !== data.currentGoalId
      || retainedRegistry.length !== loadedGoals.length;
    if (needsRepair) appendGoalState(current, retainedRegistry, nextPendingDetaches);
    goalRegistry = retainedRegistry;
    pendingTodoDetachGoalIds = nextPendingDetaches;
    return current;
  }

  const legacy = isGoal(data?.goal) ? normalizeLoadedGoal(data.goal) : undefined;
  const completedReferencedGoalIds = legacy?.status === "done" && referencedGoalIds.has(legacy.id)
    ? [legacy.id]
    : [];
  const nextPendingDetaches = [...new Set([...loadedPendingDetaches, ...completedReferencedGoalIds])];
  const current = legacy?.status === "done" ? undefined : legacy;
  const retainedRegistry = legacy
    ? retainGoalRegistry([legacy], current?.id, referencedGoalIds, new Set(nextPendingDetaches))
    : [];
  if (legacy && (nextPendingDetaches.length !== loadedPendingDetaches.length || current !== legacy)) {
    appendGoalState(current, retainedRegistry, nextPendingDetaches);
  }
  goalRegistry = retainedRegistry;
  pendingTodoDetachGoalIds = nextPendingDetaches;
  return current;
}

function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
  // Goals persisted before "error" was dropped from the union still carry it;
  // Omit is required because intersecting keeps the narrower declared type.
  const rawGoal = goal as Omit<ActiveGoal, "pauseReason"> & { pauseReason?: unknown };
  if (rawGoal.pauseReason !== "error") return goal;
  const { pauseReason: _pauseReason, ...normalized } = rawGoal;
  return normalized;
}

function currentSessionId(ctx: GoalContext): string | undefined {
  const manager = ctx.sessionManager as {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  } | undefined;
  return manager?.getSessionId?.() ?? manager?.getSessionFile?.();
}

function isGoal(v: unknown): v is ActiveGoal {
  if (!v || typeof v !== "object") return false;
  const g = v as Partial<ActiveGoal>;
  return (
    typeof g.id === "string" && typeof g.text === "string" &&
    ["active", "paused", "done"].includes(String(g.status)) &&
    typeof g.startedAt === "number" && typeof g.updatedAt === "number" &&
    typeof g.iteration === "number" &&
    typeof g.tokensUsed === "number" && typeof g.baselineTokens === "number" &&
    (g.pauseReason === undefined || ["user", "budget", "gate", "error", "stalled"].includes(String(g.pauseReason))) &&
    (g.planHandoffKey === undefined || typeof g.planHandoffKey === "string") &&
    (g.workflowSessionId === undefined || typeof g.workflowSessionId === "string") &&
    (g.workflowSessionGeneration === undefined || typeof g.workflowSessionGeneration === "string")
    && (g.verificationFailures === undefined || (typeof g.verificationFailures === "number" && g.verificationFailures >= 0))
    && (g.infraErrorStreak === undefined || (typeof g.infraErrorStreak === "number" && g.infraErrorStreak >= 0))
    && (g.acceptance === undefined || (Array.isArray(g.acceptance) && g.acceptance.every((item) => typeof item === "string")))
    && (g.lastVerificationFailure === undefined || typeof g.lastVerificationFailure === "string")
    && (g.prevTokensUsed === undefined || typeof g.prevTokensUsed === "number")
    && (g.lowProgressCount === undefined || (typeof g.lowProgressCount === "number" && g.lowProgressCount >= 0))
  );
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildGoalPrompt(goal: ActiveGoal): string {
  const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${fmtTokens(goal.tokenBudget)}.`;
  return `Goal mode is active. Complete this goal fully:\n\n${goalBlock(goal)}${budgetLine}\n\n${rules("this goal")}`;
}

function buildResumePrompt(goal: ActiveGoal): string {
  const budgetLine = goal.tokenBudget === undefined ? "" : `\nToken budget: ${fmtBudget(goal)} used.`;
  return `The goal was resumed. Continue:\n\n${goalBlock(goal)}${budgetLine}\n\n${rules("this goal")}`;
}

function buildContinuePrompt(
  goal: ActiveGoal,
  marker: string,
  workflowSnapshot: WorkflowSnapshot | undefined,
): string {
  const activeRun = workflowSnapshot && hasMatchingWorkflowBinding(goal, workflowSnapshot)
    ? activeWorkflowRun(workflowSnapshot)
    : undefined;
  const runAnchor = activeRun
    ? `\n\n<active_run id="${escapeXml(activeRun.runId)}">Run \`maestro run brief ${activeRun.runId}\` before the next execution action.</active_run>`
    : "";
  const failureContext = goal.lastVerificationFailure
    ? `\n\n<last_verification_failure>\n${escapeXml(goal.lastVerificationFailure)}\n</last_verification_failure>`
    : "";
  const progress = goal.tokenBudget !== undefined
    ? ` Progress: ${fmtTokens(goal.tokensUsed)}/${fmtTokens(goal.tokenBudget)} tokens, iteration #${goal.iteration}.`
    : ` Iteration #${goal.iteration}, ${fmtTokens(goal.tokensUsed)} tokens used.`;
  return `Continue the active goal — keep working, do not summarize or re-plan:\n\n${goalBlock(goal)}${failureContext}${runAnchor}\n\n${progress} ${rules("this goal")}\n\n${markerComment(marker)}`;
}

function goalBlock(goal: ActiveGoal): string {
  return `<goal_objective>\n${escapeXml(goal.text)}\n</goal_objective>`;
}

function rules(label: string): string {
  return `Keep going until ${label} is completely resolved end-to-end. Do not redefine ${label} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives. Before requesting completion, audit ${label} requirement by requirement, then call goal complete with a concise evidence summary. An independent verifier owns the done transition.`;
}

// ---------------------------------------------------------------------------
// Prompt delivery
// ---------------------------------------------------------------------------

async function sendGoalPrompt(ctx: GoalContext, goal: ActiveGoal) {
  return sendHandoffPrompt(ctx, goal, buildGoalPrompt(goal));
}
async function sendResumePrompt(ctx: GoalContext, goal: ActiveGoal) {
  return sendHandoffPrompt(ctx, goal, buildResumePrompt(goal));
}

async function sendHandoffPrompt(ctx: GoalContext, goal: ActiveGoal, prompt: string): Promise<boolean> {
  // An LLM tool call already carries its result in the current turn. Queuing the
  // same handoff as a follow-up leaves a stale editable user message that can
  // surface much later (for example, while explicit completion verification runs).
  if (ctx.isIdle?.() !== true) return false;
  armGoalLoop(goal);
  const sent = await sendPrompt(ctx, prompt);
  if (!sent) disarmGoalLoop(goal.id);
  return sent;
}

async function sendContinuation(ctx: GoalContext, goal: ActiveGoal) {
  if (continuationPending?.goalId === goal.id) return false;
  if (hasPending(ctx)) return false;
  let marker = `${goal.id}:${goal.iteration}:${randomUUID()}`;
  let genericMarker = true;
  const coordinator = workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (coordinator && hasMatchingWorkflowBinding(goal, workflowSnapshot)) {
    try {
      marker = coordinator.continuationMarker(goal.iteration);
      genericMarker = false;
    } catch (error) {
      const paused = pauseGoal(goal, "gate");
      persistGoal(paused);
      updateStatusLine(ctx, paused);
      ctx.ui.notify(`Goal paused by Workflow Coordinator: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
  }
  if (genericMarker) issuedGoalMarkers.add(marker);
  continuationPending = { goalId: goal.id, iteration: goal.iteration, marker };
  if (!genericMarker && (!workflowCoordinator || !workflowCoordinator.acceptsContinuation(marker))) {
    if (continuationPending?.marker === marker) continuationPending = undefined;
    const paused = pauseGoal(goal, "gate");
    persistGoal(paused);
    updateStatusLine(ctx, paused);
    ctx.ui.notify("Goal continuation was fenced by the Workflow Coordinator.", "warning");
    return false;
  }
  armGoalLoop(goal);
  const sent = await sendPrompt(ctx, buildContinuePrompt(goal, marker, workflowSnapshot));
  if (!sent) {
    disarmGoalLoop(goal.id);
    issuedGoalMarkers.delete(marker);
    if (continuationPending?.marker === marker) continuationPending = undefined;
    const paused = pauseGoal(goal);
    persistGoal(paused);
    updateStatusLine(ctx, paused);
  }
  if (activeGoal?.id === goal.id && activeGoal.status === "active") updateStatusLine(ctx, activeGoal);
  return sent;
}

function armGoalLoop(goal: ActiveGoal): void {
  goalLoopOwner = { goalId: goal.id, epoch: goalLifecycleEpoch };
}

function disarmGoalLoop(goalId: string): void {
  if (goalLoopOwner?.goalId === goalId) goalLoopOwner = undefined;
}

async function sendPrompt(ctx: GoalContext, prompt: string): Promise<boolean> {
  if (!extensionApi) return false;
  try {
    extensionApi.sendMessage({
      customType: "maestro-goal-internal",
      content: prompt,
      display: false,
      details: { source: "goal", internal: true },
    }, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
    markDelivered(prompt);
    return true;
  } catch (error) {
    ctx.ui.notify(`Goal prompt failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Continuation tracking
// ---------------------------------------------------------------------------

function cancelContinuation() {
  if (continuationPending) {
    const marker = continuationPending.marker;
    if (!isWorkflowContinuationMarker(marker)) {
      issuedGoalMarkers.delete(marker);
    }
  }
  continuationPending = undefined;
  suspendedContinuation = undefined;
}

function clearContinuation() {
  continuationPending = undefined;
  suspendedContinuation = undefined;
  issuedGoalMarkers.clear();
}

const MARKER_RE = new RegExp(
  `<!--\\s*${CONTINUATION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s>]+)\\s*-->`,
);

function rejectContinuationReplay(text: string): boolean {
  const marker = MARKER_RE.exec(text)?.[1];
  if (!marker) return false;
  if (isWorkflowContinuationMarker(marker)) {
    return !workflowCoordinator || !workflowCoordinator.acceptsContinuation(marker);
  }
  return !issuedGoalMarkers.delete(marker);
}
function markDelivered(prompt: string) {
  const marker = MARKER_RE.exec(prompt)?.[1];
  if (!marker) return;
  if (!isWorkflowContinuationMarker(marker)) issuedGoalMarkers.delete(marker);
  if (continuationPending?.marker === marker) continuationPending = undefined;
  if (suspendedContinuation?.marker === marker) suspendedContinuation = undefined;
}
function isWorkflowContinuationMarker(marker: string): boolean {
  return marker.includes("maestro-workflow-continuation:");
}
function markerComment(marker: string): string { return `<!-- ${CONTINUATION_MARKER_PREFIX}${marker} -->`; }

// ---------------------------------------------------------------------------
// Interruption handling
// ---------------------------------------------------------------------------

function pauseAfterEnd(ctx: GoalContext, goal: ActiveGoal, assistant: AssistantMessageLike) {
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  cancelContinuation();
  abortTurn(ctx);
  const paused = pauseGoal(goal);
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  const reason = assistant.stopReason === "aborted" ? "interruption" : "agent error";
  const details = assistant.errorMessage ? ` (${assistant.errorMessage.slice(0, 157)})` : "";
  ctx.ui.notify(`Goal paused after ${reason}${details}. Use /goal resume to continue.`, "warning");
}

function isRetryable(a: AssistantMessageLike): boolean {
  return isRetryableGoalFailure(a);
}

function isPiRetry(event: unknown, goalId: string): boolean {
  const e = event as { willRetry?: unknown; reason?: unknown };
  if (e.willRetry === true) return true;
  return goalRecovery?.goalId === goalId && goalRecovery.kind === "compaction_retry"
    && (e.reason === undefined || e.reason === "overflow");
}

function markGoalRecovery(goalId: string, kind: "compaction_retry" | "provider_retry"): void {
  goalRecovery = { goalId, kind };
}

/**
 * Terminal failover handoff failure delivered asynchronously after the
 * settlement that marked the Goal as provider-retrying. Pauses the Goal with
 * the real failure so it does not remain in a retry state indefinitely.
 */
function onFailoverTerminal(data: unknown): void {
  const ctx = goalDisplayContext;
  if (!activeGoal || activeGoal.status !== "active" || !ctx) return;
  const snapshot = data as ModelFailoverSettlementSnapshot | undefined;
  const failure = snapshot?.failure ?? "Model fallback could not start.";
  clearRecoveryFor(activeGoal.id);
  goalLoopOwner = undefined;
  latestGoalAttempt = undefined;
  cancelContinuation();
  const paused = pauseGoal(activeGoal);
  persistGoal(paused);
  updateStatusLine(ctx, paused);
  ctx.ui.notify(`Goal paused: ${failure}`, "warning");
}

function hasUnsettledAttempt(goalId: string): boolean {
  return latestGoalAttempt?.goalId === goalId && latestGoalAttempt.epoch === goalLifecycleEpoch;
}

function clearRecovery() { goalRecovery = undefined; }
function clearRecoveryFor(id: string) { if (goalRecovery?.goalId === id) goalRecovery = undefined; }
async function fenceWorkflowContinuation(): Promise<void> {
  const coordinator = workflowCoordinator;
  const workflowSnapshot = coordinator?.status();
  if (!coordinator || !activeGoal || !hasMatchingWorkflowBinding(activeGoal, workflowSnapshot)) return;
  try { await coordinator.fenceContinuation(); } catch { /* no owned lease means no live marker can be accepted */ }
}
function abortTurn(ctx: GoalContext) { try { ctx.abort?.(); } catch { /* best effort */ } }
function hasPending(ctx: GoalContext) { return ctx.hasPendingMessages?.() ?? false; }

// ---------------------------------------------------------------------------
// Token tracking
// ---------------------------------------------------------------------------

function currentTokenTotal(ctx: GoalContext): number | undefined {
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; message?: { role?: string; usage?: unknown } }>;
  } | undefined;
  let total = 0;
  try {
    for (const entry of sm?.getBranch?.() ?? []) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      const u = entry.message.usage as { input?: number; output?: number } | undefined;
      total += (u?.input ?? 0) + (u?.output ?? 0);
    }
  } catch {
    ctx.ui.notify("Goal token usage could not be refreshed; preserving the last known total.", "warning");
    return undefined;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export function currentGoalPhase(): GoalWidgetPhase {
  const goal = activeGoal;
  if (!goal) return "normal";
  if (goal.status === "active" && verificationInFlight?.goalId === goal.id) return "verifying";
  if (goalRecovery?.goalId === goal.id) {
    return goalRecovery.attempt !== undefined && goalRecovery.maxRetries !== undefined
      ? "retrying"
      : "waiting";
  }
  if (goal.status === "active"
    && (goalLoopOwner?.goalId !== goal.id || goalLoopOwner.epoch !== goalLifecycleEpoch)) return "waiting";
  return "normal";
}

function updateStatusLine(ctx: GoalContext, goal: ActiveGoal, refreshOnly = false) {
  clearCompletionTimer();
  if (goal.status === "active") ensureElapsedTimer(ctx, goal.id);
  else clearElapsedTimer();
  const phase = currentGoalPhase();
  const retry = goalRecovery?.goalId === goal.id ? goalRecovery : undefined;
  ctx.ui.setStatus(
    STATUS_KEY,
    phase === "verifying"
      ? "verifying"
      : retry
        ? retry.attempt !== undefined && retry.maxRetries !== undefined
          ? `retrying ${retry.attempt}/${retry.maxRetries}`
          : "retrying (Pi-owned)"
        : phase === "waiting"
          ? "waiting"
          : fmtStatusLine(goal),
  );
  if (refreshOnly) return;
  updateGoalWidget(ctx, goal, phase);
}

function showCompletionStatus(ctx: GoalContext, goal: ActiveGoal) {
  clearCompletionTimer();
  ctx.ui.setStatus(STATUS_KEY, "done");
  updateGoalWidget(ctx, goal, "verified");
  completionTimer = setTimeout(() => {
    completionTimer = undefined;
    try { clearGoalDisplay(ctx); } catch { /* stale */ }
  }, 8_000);
}

function updateGoalWidget(ctx: GoalContext, goal: ActiveGoal, phase: GoalWidgetPhase): void {
  goalDisplayContext = ctx;
  if (goalPanelOwnedExternally) return;
  const currentGoalId = goal.id;
  ctx.ui.setWidget?.(GOAL_WIDGET_KEY, (_tui, theme) => ({
    render(width: number): string[] {
      // Read the entries per frame, not once at set-widget time. A snapshot taken here
      // freezes the whole panel — the n/N counter and every other goal's status chip —
      // until some goal mutation happens to re-set the widget. The Goal overlay already
      // reads live (index.ts wires getEntries as a thunk); this makes the belowEditor
      // strip agree with it. `phase` stays captured on purpose: it is the caller's
      // explicit intent for this update (e.g. the transient "verified"), not something
      // derivable from current state.
      const entries = getGoalPanelEntries();
      if (!entries.some((entry) => entry.id === currentGoalId)) {
        entries.push(toDetailEntry(goal, undefined));
      }
      return renderGoalPanel(entries, currentGoalId, phase, width, theme, { hideLiveDuration: goalStaticMode });
    },
    invalidate() {},
  }), { placement: "belowEditor" });
}

/**
 * Detached Goal state for compaction metadata and prompts, mirroring
 * getTodoCompactionSnapshot.
 *
 * Goal deliberately does not re-inject its objective into the per-turn prompt (that
 * would invalidate the cached prefix), so the objective and its acceptance criteria
 * reach the model only through the messages sendGoalPrompt/sendContinuation post — the
 * exact messages compaction summarizes away. Without this the summarizer has to
 * re-derive "Current Objective" from prose, and the acceptance list is simply gone.
 */
export function getGoalCompactionSnapshot(): GoalCompactionSnapshot {
  return {
    stateVersion: GOAL_STATE_VERSION,
    ...(activeGoal ? { currentGoalId: activeGoal.id } : {}),
    goals: getGoalList().map((goal) => ({
      id: goal.id,
      objective: goal.text,
      status: goal.status,
      ...(goal.pauseReason ? { pauseReason: goal.pauseReason } : {}),
      iteration: goal.iteration,
      tokensUsed: goal.tokensUsed,
      ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
      ...(goal.verificationFailures ? { verificationFailures: goal.verificationFailures } : {}),
      ...(goal.infraErrorStreak ? { infraErrorStreak: goal.infraErrorStreak } : {}),
      ...(goal.lastVerificationFailure ? { lastVerificationFailure: goal.lastVerificationFailure } : {}),
      ...(goal.acceptance?.length ? { acceptance: [...goal.acceptance] } : {}),
      ...(goal.planHandoffKey ? { planHandoffKey: goal.planHandoffKey } : {}),
      ...(goal.workflowSessionId ? { workflowSessionId: goal.workflowSessionId } : {}),
    })),
  };
}

export function getGoalPanelEntries(): GoalDetailEntry[] {
  const todoByGoal = new Map<string, string>();
  for (const task of getVisibleTasks()) {
    if (task.goalId && !todoByGoal.has(task.goalId)) todoByGoal.set(task.goalId, task.subject);
  }
  return getGoalList().map((entry) => toDetailEntry(entry, todoByGoal.get(entry.id)));
}

function toDetailEntry(goal: ActiveGoal, todoSubject: string | undefined): GoalDetailEntry {
  return {
    id: goal.id,
    objective: goal.text,
    status: goal.status,
    pauseReason: goal.pauseReason,
    iteration: goal.iteration,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    timeUsedSeconds: goal.timeUsedSeconds,
    startedAt: goal.startedAt,
    updatedAt: goal.updatedAt,
    verificationFailures: goal.verificationFailures,
    acceptance: goal.acceptance?.map(redactAcceptanceCommandForDisplay),
    workflowSessionId: goal.workflowSessionId,
    retryAttempt: goalRecovery?.goalId === goal.id
      ? goalRecovery.attempt
      : undefined,
    retryMaxRetries: goalRecovery?.goalId === goal.id
      ? goalRecovery.maxRetries
      : undefined,
    ...(todoSubject ? { todoSubject } : {}),
  };
}

function clearGoalDisplay(ctx: GoalContext): void {
  goalDisplayContext = ctx;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget?.(GOAL_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

function clearCompletionTimer() { if (completionTimer) { clearTimeout(completionTimer); completionTimer = undefined; } }
function clearElapsedTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = undefined; } }

/**
 * One per-second goal tick: advance the live counter and refresh the status
 * line. The below-editor widget is deliberately NOT re-set here — its render
 * closure reads getGoalPanelEntries() live and the status update already
 * triggers a frame render, so rebuilding the widget would only churn the
 * widget container once per second.
 */
export function tickGoalElapsed(ctx: GoalContext, goalId: string, now = Date.now()): boolean {
  const goal = activeGoal;
  if (!goal || goal.id !== goalId || goal.status !== "active") {
    clearElapsedTimer();
    return false;
  }
  if (goalStaticMode) return false;
  const elapsed = Math.max(0, Math.floor((now - goal.startedAt) / 1000));
  if (elapsed === goal.timeUsedSeconds) return false;
  goal.timeUsedSeconds = elapsed;
  updateStatusLine(ctx, goal, true);
  return true;
}

function ensureElapsedTimer(ctx: GoalContext, goalId: string): void {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    tickGoalElapsed(ctx, goalId);
  }, 1_000);
}

export function fmtStatusLine(goal: ActiveGoal | undefined): string | undefined {
  if (!goal) return undefined;
  if (goal.status === "done") return "done";
  if (goal.status === "paused") return goal.pauseReason === "budget" ? `budget ${fmtBudget(goal)}` : goal.pauseReason === "gate" ? "gate blocked" : goal.pauseReason === "stalled" ? "stalled" : "paused";
  if (goal.tokenBudget !== undefined) return `active ${fmtBudget(goal)}`;
  return `active ${fmtDuration(goal.timeUsedSeconds)}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtBudget(goal: ActiveGoal): string { return `${fmtTokens(goal.tokensUsed)}/${fmtTokens(goal.tokenBudget ?? 0)}`; }

function goalSummary(goal: ActiveGoal): string {
  const pauseInfo = goal.pauseReason ? ` (${goal.pauseReason})` : "";
  return [
    `Goal [${goal.id}]: ${goal.text}`,
    `Status: ${goal.status}${pauseInfo}`,
    `Iteration: ${goal.iteration}`,
    `Elapsed: ${fmtDuration(goal.timeUsedSeconds)}`,
    ...(goal.tokenBudget === undefined ? [] : [`Token budget: ${fmtBudget(goal)}`]),
  ].join("\n");
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtTokens(v: number): string {
  if (v < 1_000) return `${v}`;
  if (v < 1_000_000) return `${Number.isInteger(v / 1_000) ? v / 1_000 : (v / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(v / 1_000_000) ? v / 1_000_000 : (v / 1_000_000).toFixed(1)}m`;
}

function parseTokenBudget(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1));
}

function validateObjective(objective: string): string | undefined {
  const t = objective.trim();
  if (!t) return "Objective is required.";
  if (t.length > MAX_OBJECTIVE_LENGTH) return `Objective too long (${t.length}/${MAX_OBJECTIVE_LENGTH}).`;
  return undefined;
}

function escapeXml(v: string): string { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function findFinalAssistant(messages: unknown[]): AssistantMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const entry = m as Record<string, unknown>;
    const c = entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : entry;
    if (c.role !== "assistant") continue;
    return {
      role: "assistant",
      stopReason: isStopReason(c.stopReason) ? c.stopReason : undefined,
      errorMessage: typeof c.errorMessage === "string" ? c.errorMessage : undefined,
      content: c.content,
      usage: c.usage as { input?: number; output?: number } | undefined,
    };
  }
  return undefined;
}

function isStopReason(v: unknown): v is AgentStopReason {
  return ["stop", "length", "toolUse", "error", "aborted"].includes(String(v));
}

/** Validate and narrow raw tool params into typed GoalActionParams. */
export function parseGoalActionParams(params: Record<string, unknown>): GoalParams | undefined {
  const action = params.action;
  if (action === "get") return { action };
  if (action === "complete") {
    return typeof params.summary === "string"
      ? { action, summary: params.summary }
      : undefined;
  }
  if (action !== "create" && action !== "update") return undefined;
  if (typeof params.objective !== "string") return undefined;
  const acceptance = params.acceptance;
  if (acceptanceValidationError(acceptance)) return undefined;
  if (acceptance !== undefined
    && (!Array.isArray(acceptance) || !acceptance.every((command): command is string => typeof command === "string"))) {
    return undefined;
  }
  const validatedAcceptance = acceptance === undefined ? undefined : acceptance.slice();
  if (action === "update") {
    return {
      action,
      objective: params.objective,
      acceptance: validatedAcceptance,
    };
  }
  if (params.tokenBudget !== undefined && typeof params.tokenBudget !== "string") return undefined;
  if (params.planHandoffKey !== undefined && typeof params.planHandoffKey !== "string") return undefined;
  return {
    action,
    objective: params.objective,
    tokenBudget: params.tokenBudget,
    planHandoffKey: params.planHandoffKey,
    acceptance: validatedAcceptance,
  };
}
