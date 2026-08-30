/**
 * Durable Plan mode lifecycle.
 *
 * Act mode exposes plan-enter. Plan mode keeps the existing non-editing tool
 * surface plus plan-update/review/confirm/exit/status. Markdown drafts are
 * persisted by workspace and chat session; approval must commit before Act tools are restored.
 */

import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { altKey } from "../key-labels.ts";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import { buildPlanDecomposeContract, PlanDecomposeParams } from "./plan-decompose.ts";
import { isRunControlReadAction, isRunControlReadArgv } from "./run-control.ts";
import {
  openPlanConfirmation,
  type PlanWorkflowConfirmationOptions,
} from "./plan-confirm.ts";
import { openPlanEditor } from "./plan-editor.ts";
import {
  PlanApprovalError,
  PlanStore,
  prewarmProcessIdentity,
  type LoadedPlan,
  type PlanArtifactEntry,
  type PlanExecutionChoice,
  type PlanExecutionContextMode,
  type PlanSessionIdentity,
  type PlanWorkflowBinding,
} from "./plan-store.ts";
import {
  REFINE_ROLES,
  openRefinePanel,
  type RefineAppliesAs,
  type RefineRole,
  type RefineSession,
} from "./plan-refine.ts";
import { renderRollbackOverlay } from "../tui/plan-rollback-overlay.ts";
import { getVisibleTasks } from "./todo.ts";
import {
  COMPACTION_LEASE_TIMEOUT_MS,
  type CompactionArbiter,
} from "../compaction/compaction-arbiter.ts";

type Mode = "act" | "plan";
type PlanExecutionMode = PlanExecutionContextMode;
export type PlanHandoffStatus = "none" | "todo-required" | "ready";
export type PlanContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "isIdle" | "sessionManager" | "compact" | "model" | "modelRegistry" | "isProjectTrusted"
> & Partial<Pick<ExtensionContext, "abort" | "getContextUsage">>;

interface PlanReviewOutcome {
  approved: boolean;
  exited: boolean;
  executionMode?: PlanExecutionMode;
  executionChoice?: PlanExecutionChoice;
  executionMessage?: string;
  discussionMessage?: string;
  compactDeferred?: boolean;
}

type PlanHandoffDelivery = "message" | "tool-result";

export interface PlanToolDetails {
  action: "enter" | "update" | "review" | "confirm" | "decompose" | "exit" | "status";
  mode: Mode;
  revision: number;
  path: string;
  sessionId: string;
  status: "empty" | "draft" | "approved";
  handoffStatus: PlanHandoffStatus;
  handoffKey?: string;
  execution?: PlanExecutionChoice;
  workflowBinding?: PlanWorkflowBinding;
  approved?: boolean;
  error?: string;
}

export interface PlanCompactionSnapshot {
  mode: Mode;
  status: PlanToolDetails["status"];
  revision: number;
  handoffStatus: PlanHandoffStatus;
  handoffKey?: string;
  path?: string;
}

export interface LoadedPlanArtifactDocument {
  entry: PlanArtifactEntry;
  markdown: string;
}

export interface PlanArtifactSummary {
  available: boolean;
  revision: number;
  status: PlanToolDetails["status"];
}

interface PlanRuntimeOptions {
  storeFactory?: (cwd: string, session: PlanSessionIdentity) => PlanStore;
  hasExecutableTodo?: (handoffKey: string) => boolean;
  compactionArbiter?: CompactionArbiter;
  compactionHandoffTimeoutMs?: number;
  workflowConfirmation?: (
    ctx: PlanContext,
  ) => PlanWorkflowConfirmationOptions | Promise<PlanWorkflowConfirmationOptions>;
  publishWorkflowPlan?: (
    ctx: PlanContext,
    approved: LoadedPlan,
    execution: PlanExecutionChoice,
  ) => Promise<PlanWorkflowPublicationResult>;
}

export interface PlanWorkflowPublicationResult {
  binding: PlanWorkflowBinding;
  executionMessage: string;
}

const STATUS_KEY = "mode";
export const PLAN_TOGGLE_KEY = "alt+shift+p";
export const PLAN_TOGGLE_LABEL = altKey("Shift+P");
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

const PLAN_ENTER_TOOL = "plan-enter";
const PLAN_DECOMPOSE_TOOL = "plan-decompose";
const PLAN_MODE_TOOL_NAMES = [
  "plan-update",
  "plan-review",
  "plan-confirm",
  "plan-exit",
  "plan-status",
] as const;
const ALL_PLAN_TOOL_NAMES = new Set([PLAN_ENTER_TOOL, PLAN_DECOMPOSE_TOOL, ...PLAN_MODE_TOOL_NAMES]);

const PlanUpdateParams = Type.Object({
  markdown: Type.String({ description: "Complete Markdown text for current.md" }),
  expectedRevision: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Expected current revision for optimistic concurrency; the save fails if the draft has moved past it. Defaults to the currently loaded revision.",
    }),
  ),
});
const EmptyPlanParams = Type.Object({});

let mode: Mode = "act";
let extensionApi: ExtensionAPI | undefined;
let onPlanModeChanged: ((ctx: PlanContext) => void) | undefined;
let storeFactory: (cwd: string, session: PlanSessionIdentity) => PlanStore = (cwd, session) => new PlanStore(cwd, { session });
let currentStore: PlanStore | undefined;
let currentStoreKey = "";
let latestPlan: string | undefined;
let latestRevision = 0;
let latestStatus: PlanToolDetails["status"] = "empty";
let latestHandoffKey: string | undefined;
let latestExecution: PlanExecutionChoice | undefined;
let latestWorkflowBinding: PlanWorkflowBinding | undefined;
let latestArtifactAvailable = false;
let awaitingAction = false;
let pendingPlanExitReminder: string | undefined;
let pendingPlanEnterNote: string | undefined;
let compactionArbiter: CompactionArbiter | undefined;
let planCompactionHandoffTimeoutMs = COMPACTION_LEASE_TIMEOUT_MS;
let workflowConfirmation = async (_ctx: PlanContext): Promise<PlanWorkflowConfirmationOptions> => ({ allowNew: false });
let publishWorkflowPlan: (
  ctx: PlanContext,
  approved: LoadedPlan,
  execution: PlanExecutionChoice,
) => Promise<PlanWorkflowPublicationResult> = async () => {
  throw new Error("Workflow-backed Plan execution is unavailable");
};

export const PLAN_CLEAN_CONTEXT_COMPACTION_MARKER = "[maestro-plan-clean-context]";

/** True only when the clean-context marker is the leading instruction token. */
export function isPlanCleanContextCompactionInstructions(
  customInstructions: string | undefined,
): boolean {
  return customInstructions?.trimStart().startsWith(PLAN_CLEAN_CONTEXT_COMPACTION_MARKER) === true;
}

export interface PlanCleanContextCompactionRequest {
  summary: string;
  firstKeptEntryId: string;
  lifecycleGeneration: number;
  requestId: number;
}

interface PlanHandoffRequestIdentity {
  lifecycleGeneration: number;
  requestId: number;
}

interface PlanOperationIdentity {
  lifecycleGeneration: number;
  operationId: number;
  sessionId: string;
  storeKey: string;
  store?: PlanStore;
}

interface PlanCompactHandoff {
  request: PlanHandoffRequestIdentity;
  operation: PlanOperationIdentity;
  planPath: string;
  markdown: string;
  executionMessage: string;
  onDelivered?: () => Promise<void>;
}

interface PlanContextReplacement {
  lifecycleGeneration: number;
  replacement: AgentMessage;
  baselineMessages?: string[];
}

let planLifecycleGeneration = 0;
let nextPlanHandoffRequestId = 0;
let nextPlanOperationId = 0;
let activePlanOperation: PlanOperationIdentity | undefined;
let activePlanHandoffRequest: PlanHandoffRequestIdentity | undefined;
let pendingPlanCompactHandoff: PlanCompactHandoff | undefined;
let pendingCleanContextCompaction: PlanCleanContextCompactionRequest | undefined;
let planContextReplacement: PlanContextReplacement | undefined;
// Review & Refine state is scoped to the current draft revision and reset when
// the revision changes or the Plan is cleared.
let refineSession: RefineSession | undefined;
let refineSessionRevision = -1;
let refineLatestOutput: string | undefined;
let refineLatestRole: RefineRole | undefined;
let refineLatestAppliesAs: RefineAppliesAs | undefined;
let refineLatestRoleLabel: string | undefined;
// The handoff gate reads todos only. Goal state was decoupled from it in 39a5f2dc;
// the getters that used to feed it are gone so they cannot be wired back by accident.
let hasExecutableTodoForHandoff = (handoffKey: string) => getVisibleTasks().some((task) =>
  task.planHandoffKey === handoffKey
  && (task.status === "pending" || task.status === "in_progress")
  && task.blockedBy.length === 0
);

function syncModeStatus(ctx: PlanContext): void {
  ctx.ui.setStatus(STATUS_KEY, mode === "act" ? "ACT" : hasPlan() ? "READY" : "PLAN");
}

export function initPlan(pi: ExtensionAPI, options: PlanRuntimeOptions = {}): void {
  resetRuntimeState();
  extensionApi = pi;
  storeFactory = options.storeFactory ?? ((cwd, session) => new PlanStore(cwd, { session }));
  hasExecutableTodoForHandoff = options.hasExecutableTodo ?? ((handoffKey) => getVisibleTasks().some((task) =>
    task.planHandoffKey === handoffKey
    && (task.status === "pending" || task.status === "in_progress")
    && task.blockedBy.length === 0
  ));
  compactionArbiter = options.compactionArbiter;
  planCompactionHandoffTimeoutMs = Math.max(1, options.compactionHandoffTimeoutMs ?? COMPACTION_LEASE_TIMEOUT_MS);
  workflowConfirmation = async (ctx) => options.workflowConfirmation?.(ctx) ?? { allowNew: false };
  publishWorkflowPlan = options.publishWorkflowPlan ?? (async () => {
    throw new Error("Workflow-backed Plan execution is unavailable");
  });
}

export function isPlanMode(): boolean {
  return mode === "plan";
}

export function getMode(): Mode {
  return mode;
}

export function hasPlan(): boolean {
  return Boolean(latestPlan?.trim());
}

export function getPlanText(): string {
  return latestPlan ?? "";
}

export function getPlanArtifactSummary(): PlanArtifactSummary {
  return {
    available: latestArtifactAvailable,
    revision: latestRevision,
    status: latestStatus,
  };
}

export async function loadCurrentPlanArtifacts(ctx: PlanContext): Promise<LoadedPlanArtifactDocument[]> {
  const store = await ensureStore(ctx);
  const entries = await store.listArtifacts();
  latestArtifactAvailable = entries.length > 0;
  onPlanModeChanged?.(ctx);
  return Promise.all(entries.map(async (entry) => ({
    entry,
    markdown: await store.readArtifact(entry),
  })));
}

export function clearPlan(): void {
  latestPlan = undefined;
  latestRevision = 0;
  latestStatus = "empty";
  latestHandoffKey = undefined;
  latestExecution = undefined;
  latestWorkflowBinding = undefined;
  latestArtifactAvailable = false;
  refineSession = undefined;
  refineSessionRevision = -1;
  refineLatestOutput = undefined;
  refineLatestRole = undefined;
  refineLatestAppliesAs = undefined;
  refineLatestRoleLabel = undefined;
  awaitingAction = false;
}

async function ensureStore(ctx: PlanContext): Promise<PlanStore> {
  const session = currentPlanSession(ctx);
  const storeKey = `${ctx.cwd}\0${session.id}`;
  if (!currentStore || currentStoreKey !== storeKey) {
    currentStore = storeFactory(ctx.cwd, session);
    currentStoreKey = storeKey;
  }
  return currentStore;
}

function currentPlanSession(ctx: PlanContext): PlanSessionIdentity {
  const file = ctx.sessionManager.getSessionFile();
  const name = ctx.sessionManager.getSessionName();
  return {
    id: ctx.sessionManager.getSessionId(),
    ...(file ? { file } : {}),
    ...(name ? { name } : {}),
  };
}

function applyLoadedPlan(loaded: LoadedPlan): void {
  latestPlan = loaded.markdown || undefined;
  latestRevision = loaded.manifest.revision;
  latestStatus = loaded.markdown
    ? loaded.manifest.status
    : "empty";
  latestHandoffKey = loaded.manifest.handoffKey;
  latestExecution = loaded.manifest.execution;
  latestWorkflowBinding = loaded.manifest.workflowBinding;
  latestArtifactAvailable = latestArtifactAvailable
    || Boolean(loaded.markdown.trim())
    || loaded.manifest.approvals.length > 0;
  awaitingAction = loaded.manifest.status === "approved" && Boolean(loaded.markdown.trim());
}

function ensureActToolSurface(): void {
  if (!extensionApi) return;
  const active = extensionApi.getActiveTools();
  const missing = [...ALL_PLAN_TOOL_NAMES].filter((name) => !active.includes(name));
  if (missing.length > 0) extensionApi.setActiveTools([...active, ...missing]);
}

function activatePlanToolSurface(): void {}

function restoreActToolSurface(): void {}

async function enterPlanMode(ctx: PlanContext, operation: PlanOperationIdentity): Promise<boolean> {
  const store = await ensureStore(ctx);
  if (!bindPlanOperation(ctx, operation, store)) return false;
  const loaded = await store.loadQuick();
  if (!isCurrentPlanOperation(ctx, operation)) return false;
  applyLoadedPlan(loaded);
  pendingPlanExitReminder = undefined;
  pendingPlanEnterNote = buildPlanEnterNote();
  mode = "plan";
  activatePlanToolSurface();
  syncModeStatus(ctx);
  onPlanModeChanged?.(ctx);
  ctx.ui.notify(`Plan mode · ${store.currentPath}`, "info");
  return true;
}

function exitPlanMode(ctx: PlanContext): void {
  mode = "act";
  pendingPlanEnterNote = undefined;
  restoreActToolSurface();
  syncModeStatus(ctx);
}

/** Leave Plan mode without approving or discarding the current draft. */
export function exitMode(ctx: PlanContext, operation = beginPlanOperation(ctx)): Mode {
  if (!isCurrentPlanOperation(ctx, operation, false)) return mode;
  if (mode === "plan") {
    exitPlanMode(ctx);
    ctx.ui.notify("Act mode · draft preserved", "info");
    pendingPlanExitReminder = buildPlanExitReminder();
    onPlanModeChanged?.(ctx);
  }
  return mode;
}

export async function toggleMode(ctx: PlanContext, operation = beginPlanOperation(ctx)): Promise<Mode> {
  if (mode === "act") {
    await enterPlanMode(ctx, operation);
    if (!isCurrentPlanOperation(ctx, operation)) return mode;
    return mode;
  }
  if (hasPlan() && ctx.hasUI !== false) {
    const outcome = await reviewPlan(ctx, true, "message", operation);
    if (!isCurrentPlanOperation(ctx, operation)) return mode;
    if (!outcome.approved && !outcome.exited) ctx.ui.notify("Staying in Plan mode", "info");
    onPlanModeChanged?.(ctx);
    return mode;
  }
  return exitMode(ctx, operation);
}

/** Bind the root UI/UCL to Plan/Act mode transitions. */
export function setPlanModeChangeListener(listener: ((ctx: PlanContext) => void) | undefined): void {
  onPlanModeChanged = listener;
}

export async function onSessionStartPlan(ctx: PlanContext): Promise<void> {
  restoreActToolSurface();
  resetRuntimeState();
  const operation = beginPlanOperation(ctx);
  ensureActToolSurface();
  syncModeStatus(ctx);
  prewarmProcessIdentity();
  try {
    const store = await ensureStore(ctx);
    if (!bindPlanOperation(ctx, operation, store)) return;
    const loaded = await store.load();
    if (!isCurrentPlanOperation(ctx, operation)) return;
    applyLoadedPlan(loaded);
    latestArtifactAvailable = await store.hasArtifacts();
    if (!isCurrentPlanOperation(ctx, operation)) return;
    if (loaded.manifest.status === "approved"
      && loaded.manifest.execution?.backend === "workflow"
      && (loaded.manifest.workflowBinding?.status !== "bound"
        || loaded.manifest.workflowBinding.deliveryStatus === "pending")) {
      await recoverWorkflowBinding(ctx, store, loaded, operation);
      if (!isCurrentPlanOperation(ctx, operation)) return;
    }
  } catch (error) {
    if (!isCurrentPlanOperation(ctx, operation)) return;
    currentStore = undefined;
    currentStoreKey = "";
    clearPlan();
    ctx.ui.notify(`Plan draft unavailable: ${errorMessage(error)}`, "warning");
  }
}

export function onSessionShutdownPlan(ctx: PlanContext): void {
  restoreActToolSurface();
  resetRuntimeState();
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function beginPlanOperation(ctx: PlanContext): PlanOperationIdentity {
  const session = currentPlanSession(ctx);
  const storeKey = `${ctx.cwd}\0${session.id}`;
  const operation: PlanOperationIdentity = {
    lifecycleGeneration: planLifecycleGeneration,
    operationId: ++nextPlanOperationId,
    sessionId: session.id,
    storeKey,
    ...(currentStore && currentStoreKey === storeKey ? { store: currentStore } : {}),
  };
  activePlanOperation = operation;
  return operation;
}

function bindPlanOperation(
  ctx: PlanContext,
  operation: PlanOperationIdentity,
  store: PlanStore,
): boolean {
  if (!isCurrentPlanOperation(ctx, operation, false)) return false;
  operation.store = store;
  return isCurrentPlanOperation(ctx, operation);
}

function planOperationMatchesContext(ctx: PlanContext, operation: PlanOperationIdentity): boolean {
  const session = currentPlanSession(ctx);
  return session.id === operation.sessionId
    && `${ctx.cwd}\0${session.id}` === operation.storeKey;
}

function isCurrentPlanOperation(
  ctx: PlanContext,
  operation: PlanOperationIdentity,
  requireStore = true,
): boolean {
  return activePlanOperation === operation
    && planLifecycleGeneration === operation.lifecycleGeneration
    && planOperationMatchesContext(ctx, operation)
    && (!requireStore || (
      operation.store !== undefined
      && currentStore === operation.store
      && currentStoreKey === operation.storeKey
    ));
}

async function recoverWorkflowBinding(
  ctx: PlanContext,
  store: PlanStore,
  approved: LoadedPlan,
  operation: PlanOperationIdentity,
): Promise<void> {
  const execution = approved.manifest.execution;
  const handoffKey = approved.manifest.handoffKey;
  const sourceChecksum = approved.manifest.approvedChecksum;
  const approvedPath = approved.manifest.approvedPath;
  if (!execution || execution.backend !== "workflow" || !handoffKey || !sourceChecksum || !approvedPath) return;
  if (!isCurrentPlanOperation(ctx, operation)) return;
  const priorBinding = approved.manifest.workflowBinding;
  let publicationInput = approved;
  try {
    if (priorBinding?.status !== "bound") {
      publicationInput = await store.updateWorkflowBinding(handoffKey, {
        status: "pending",
        handoffKey,
        sourceChecksum,
        updatedAt: new Date().toISOString(),
      });
      if (!isCurrentPlanOperation(ctx, operation)) return;
      applyLoadedPlan(publicationInput);
    }
    if (!isCurrentPlanOperation(ctx, operation)) return;
    const published = await publishWorkflowPlan(ctx, publicationInput, execution);
    if (!isCurrentPlanOperation(ctx, operation)) return;
    if (published.binding.status !== "bound") {
      throw new Error("Workflow publisher did not return a bound result");
    }
    const pendingDelivery = withPendingWorkflowDelivery(published.binding);
    const bound = await store.updateWorkflowBinding(handoffKey, pendingDelivery);
    if (!isCurrentPlanOperation(ctx, operation)) return;
    applyLoadedPlan(bound);
    ctx.ui.notify(`Recovered approved Plan binding to Workflow Session ${published.binding.workflowSessionId}.`, "info");
    const planPath = join(bound.plansDir, approvedPath);
    const executionMessage = `${published.executionMessage}\n\n${buildPlanExecutionContract(planPath, handoffKey)}`;
    if (!isCurrentPlanOperation(ctx, operation)) return;
    await deliverImplementation(
      ctx,
      planPath,
      bound.markdown,
      execution.context,
      executionMessage,
      "message",
      operation,
      () => acknowledgeWorkflowDelivery(ctx, store, handoffKey, pendingDelivery, operation),
    );
    if (!isCurrentPlanOperation(ctx, operation)) return;
  } catch (error) {
    if (!isCurrentPlanOperation(ctx, operation)) return;
    if (priorBinding?.status !== "bound") {
      try {
        const failed = await store.updateWorkflowBinding(handoffKey, {
          status: "failed",
          handoffKey,
          sourceChecksum,
          error: errorMessage(error),
          updatedAt: new Date().toISOString(),
        });
        if (!isCurrentPlanOperation(ctx, operation)) return;
        applyLoadedPlan(failed);
      } catch (persistError) {
        if (!isCurrentPlanOperation(ctx, operation)) return;
        ctx.ui.notify(
          `Approved Plan Workflow binding retry failed and its failure state could not be persisted: ${errorMessage(persistError)}.`,
          "warning",
        );
        return;
      }
    }
    if (!isCurrentPlanOperation(ctx, operation)) return;
    ctx.ui.notify(
      priorBinding?.status === "bound"
        ? `Approved Plan Workflow delivery retry failed: ${errorMessage(error)}. The canonical binding is preserved.`
        : `Approved Plan Workflow binding retry failed: ${errorMessage(error)}. Approval is preserved; execution was not started.`,
      "warning",
    );
  }
}

function withPendingWorkflowDelivery(binding: PlanWorkflowBinding): PlanWorkflowBinding {
  if (binding.status !== "bound" || !binding.requestId) return binding;
  return {
    ...binding,
    deliveryId: binding.deliveryId ?? `${binding.requestId}:implementation`,
    deliveryStatus: "pending",
    updatedAt: new Date().toISOString(),
  };
}

async function acknowledgeWorkflowDelivery(
  ctx: PlanContext,
  store: PlanStore,
  handoffKey: string,
  binding: PlanWorkflowBinding,
  operation: PlanOperationIdentity,
): Promise<void> {
  if (binding.status !== "bound" || binding.deliveryStatus !== "pending") return;
  if (!isCurrentPlanOperation(ctx, operation)) return;
  const deliveredAt = new Date().toISOString();
  try {
    const delivered = await store.updateWorkflowBinding(handoffKey, {
      ...binding,
      deliveryStatus: "delivered",
      deliveredAt,
      updatedAt: deliveredAt,
    });
    if (!isCurrentPlanOperation(ctx, operation)) return;
    applyLoadedPlan(delivered);
  } catch (error) {
    if (!isCurrentPlanOperation(ctx, operation)) return;
    ctx.ui.notify(`Workflow execution handoff was delivered but could not be acknowledged: ${errorMessage(error)}`, "warning");
  }
}

function resetRuntimeState(): void {
  planLifecycleGeneration++;
  activePlanOperation = undefined;
  activePlanHandoffRequest = undefined;
  mode = "act";
  currentStore = undefined;
  currentStoreKey = "";
  latestPlan = undefined;
  latestRevision = 0;
  latestStatus = "empty";
  latestHandoffKey = undefined;
  latestExecution = undefined;
  latestWorkflowBinding = undefined;
  latestArtifactAvailable = false;
  refineSession = undefined;
  refineSessionRevision = -1;
  refineLatestOutput = undefined;
  refineLatestRole = undefined;
  refineLatestAppliesAs = undefined;
  refineLatestRoleLabel = undefined;
  awaitingAction = false;
  pendingPlanExitReminder = undefined;
  pendingPlanEnterNote = undefined;
  pendingPlanCompactHandoff = undefined;
  pendingCleanContextCompaction = undefined;
  planContextReplacement = undefined;
}

export function onCompactPlan(ctx: PlanContext): void {
  planContextReplacement = undefined;
  syncModeStatus(ctx);
}

export function onContextPlan(messages: AgentMessage[]): { messages: AgentMessage[] } | undefined {
  const manifest = planContextReplacement;
  if (!manifest) return undefined;
  if (manifest.lifecycleGeneration !== planLifecycleGeneration) {
    planContextReplacement = undefined;
    return undefined;
  }

  const serialized = messages.map((message) => JSON.stringify(message));
  if (!manifest.baselineMessages) {
    manifest.baselineMessages = serialized;
    return { messages: [manifest.replacement] };
  }

  const baselineMatches = manifest.baselineMessages.length <= serialized.length
    && manifest.baselineMessages.every((message, index) => message === serialized[index]);
  if (!baselineMatches) {
    // Preserve the newest unmatched user turn while rebasing the dropped prefix.
    // This avoids resurrecting rewritten history without hiding the request that
    // caused a branch or host-prefix change.
    let suffixStart = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role !== "user") continue;
      if (index >= manifest.baselineMessages.length || serialized[index] !== manifest.baselineMessages[index]) {
        suffixStart = index;
        break;
      }
    }
    if (suffixStart < 0) suffixStart = messages.length;
    manifest.baselineMessages = serialized.slice(0, suffixStart);
    return { messages: [manifest.replacement, ...messages.slice(suffixStart)] };
  }
  return {
    messages: [manifest.replacement, ...messages.slice(manifest.baselineMessages.length)],
  };
}

export function projectPlanContextForCompaction(messages: AgentMessage[]): {
  messages: AgentMessage[];
  firstKeptEntryId: string;
} | undefined {
  const manifest = planContextReplacement;
  const projected = onContextPlan(messages);
  if (!manifest || !projected || manifest.lifecycleGeneration !== planLifecycleGeneration) return undefined;
  return {
    messages: projected.messages,
    firstKeptEntryId: `maestro-plan-replacement-${manifest.lifecycleGeneration}`,
  };
}

export const PLAN_MODE_REMINDER_TYPE = "plan-mode-reminder";

export function onBeforeAgentStartPlan(_event: { systemPrompt: string }): {
  message: { customType: string; content: string; display: boolean };
} | undefined {
  if (pendingPlanEnterNote) {
    const note = pendingPlanEnterNote;
    pendingPlanEnterNote = undefined;
    return {
      message: {
        customType: PLAN_MODE_REMINDER_TYPE,
        content: note,
        display: false,
      },
    };
  }
  if (!pendingPlanExitReminder) return;
  const reminder = pendingPlanExitReminder;
  pendingPlanExitReminder = undefined;
  return {
    message: {
      customType: PLAN_MODE_REMINDER_TYPE,
      content: reminder,
      display: false,
    },
  };
}

export function onToolCallPlan(event: {
  toolName: string;
  input: Record<string, unknown>;
}, _bypassHandoff = false): { block: true; reason: string } | undefined {
  if (mode !== "plan") return undefined;
  const toolName = event.toolName.toLowerCase();
  const action = typeof event.input.action === "string" ? event.input.action : "";
  if (toolName === "run-control") {
    const argv = Array.isArray(event.input.argv) ? event.input.argv.map(String) : [];
    if (argv.length > 0) {
      return isRunControlReadArgv(argv)
        ? undefined
        : planMutationBlock(`run-control ${argv.join(" ")}`);
    }
    return isRunControlReadAction(action)
      ? undefined
      : planMutationBlock(`run-control ${action || "mutation"}`);
  }
  if (toolName === "todo") {
    return ["get", "list"].includes(action) ? undefined : planMutationBlock(`todo ${action || "mutation"}`);
  }
  if (toolName === "conflict") {
    return action === "list" || action === "diff" ? undefined : planMutationBlock(`conflict ${action || "resolve"}`);
  }
  if (toolName === "goal") {
    return action === "get" ? undefined : planMutationBlock(`goal ${action || "mutation"}`);
  }
  if (["edit", "write", "notebookedit", "notebook_edit"].includes(toolName)) {
    return planMutationBlock(event.toolName);
  }
  if (toolName === "bash" || toolName === "bash_bg") {
    if (toolName === "bash_bg" && ["status", "wait", "list"].includes(action)) return undefined;
    const command = typeof event.input.command === "string"
      ? event.input.command
      : typeof event.input.task === "string" ? event.input.task : "";
    return isMutatingPlanShell(command)
      ? planMutationBlock(event.toolName, "the command modifies files or system state")
      : undefined;
  }
  if (toolName === "computer_use") {
    return planMutationBlock(`computer_use ${action || "unknown"}`);
  }
  if (toolName === "browser") {
    return action === "open" || action === "close" ? undefined : planMutationBlock(`browser ${action || "run"}`);
  }
  if (toolName === "lsp") {
    const readActions = [
      "diagnostics", "definition", "references", "hover", "symbols", "type_definition",
      "implementation", "status", "capabilities", "request",
    ];
    if (readActions.includes(action)) return undefined;
    if (["rename", "rename_file", "code_actions"].includes(action) && event.input.apply !== true) return undefined;
    return planMutationBlock(`lsp ${action || "mutation"}`);
  }
  if (toolName === "teammate") {
    // Plan mode delegates discovery to `explorer` and authoring to `planner` only;
    // analysis/research belong inside the planner's single nested-agent budget.
    const readOnlyAgents = new Set(["explorer", "planner"]);
    const topLevelAgent = typeof event.input.agent === "string" ? event.input.agent : "general";
    const tasks = Array.isArray(event.input.tasks) ? event.input.tasks : [];
    const agents = tasks.length > 0
      ? tasks.map((task) => task && typeof task === "object"
        && typeof (task as Record<string, unknown>).agent === "string"
        ? (task as Record<string, unknown>).agent as string
        : topLevelAgent)
      : [topLevelAgent];
    return agents.every((agent) => readOnlyAgents.has(agent))
      ? undefined
      : planMutationBlock(`teammate ${agents.join(", ")}`);
  }
  if (toolName === "teammate-send") {
    // Plan mode allows targeted revision of the same read-only planner/explorer
    // (steer/follow_up are message injections, not project mutations), but still
    // blocks abort, which terminates the agent and its subtree.
    const mode = typeof event.input.mode === "string" ? event.input.mode : "steer";
    return mode === "abort"
      ? planMutationBlock("teammate-send abort")
      : undefined;
  }
  if (new Set([
    "read", "grep", "glob", "ls", "find", "ffgrep", "fffind", "ask-user-question",
    "teammate-list", "teammate-watch", "observe", "search_tool_bm25", "smart_search", "source_check",
    "resource",
    "plan-enter", "plan-update", "plan-review", "plan-confirm", "plan-exit", "plan-status",
  ]).has(toolName)) return undefined;
  return planMutationBlock(event.toolName);
}

function planMutationBlock(operation: string, detail?: string): { block: true; reason: string } {
  return {
    block: true,
    reason: `Plan mode is read-only before approval; ${operation} is blocked${detail ? ` (${detail})` : ""}. Approve or exit the Plan first.`,
  };
}

/**
 * Default-allow bash in Plan mode: only clearly mutating commands are blocked.
 * The scan is lexical over the whole command; quoted strings are excluded from
 * verb matching (so `rg -rn "rm" .` is not a false positive) while `bash -c
 * "rm -rf src"` is still caught by the shell -c rule. Deliberate evasion via
 * interpreters (`node -e`, `python -c`) is out of scope: this is an
 * accidental-mutation guard, not a sandbox.
 */
// Lookbehind instead of \b: a hyphen before the verb is a flag fragment
// (e.g. `rg -ln`), not a command verb — \b would match inside it because `-`
// is a word boundary.
const MUTATING_SHELL_VERBS = /(?<![\w-])(?:rm|rmdir|unlink|mv|mkdir|touch|truncate|ln|cp|dd|shred|tee|install|chmod|chown|chgrp|mkfs\w*|mount|umount|kill|pkill|killall|systemctl|service|reboot|halt|poweroff|shutdown|scp|rsync|sftp|vim|vi|nano|make|ninja|mvn|gradle|docker|kubectl|terraform|eval|tar|gzip|gunzip|bzip2|bunzip2|xz|unxz|zstd|unzstd|zip|unzip|7z|7za|rar|unrar)\b/;
const IN_PLACE_EDIT = /(?:^|\s)-[a-z]*i(?:[a-z]|\.|\s|$)/i;
const SHELL_EXEC_FLAG = /(?:^|\s)-(?:[a-zA-Z]*c|Command)(?:\s|$)|(?:^|\s)\/c(?:\s|$)/;
const SHELL_FAMILY = /\b(?:bash|sh|zsh|ksh|dash|fish|pwsh|powershell|cmd|command)\b/;
const GIT_READ_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "grep", "ls-files", "ls-tree", "ls-remote",
  "rev-parse", "rev-list", "blame", "describe", "shortlog", "branch", "tag",
  "help", "version", "range-diff", "cherry", "whatchanged", "merge-base",
  "cat-file", "check-ignore", "diff-tree", "name-rev",
]);
const NPM_WRITE_VERBS = /(?:^|\s)(?:install|add|remove|uninstall|update|upgrade|run|exec|publish|init|create|set|pack|link|unlink|dedupe|prune|rebuild|ci)(?=\s|$)/;
const PIP_WRITE_VERBS = /(?:^|\s)(?:install|uninstall|download|wheel|build)(?=\s|$)/;
const APT_WRITE_VERBS = /(?:^|\s)(?:install|uninstall|remove|update|upgrade|purge|autoremove|clean|dist-upgrade|full-upgrade|tap|untap|link|unlink|build|rebuild|reinstall)(?=\s|$)/;
const CURL_WRITE_FLAGS = /(?:^|\s)-(?:[A-Za-z]*[oOD]|-d|-F|-T)(?:\s|$|=)|(?:^|\s)--(?:output(?:-document)?|data(?:-raw|-url)?|form|upload-file|cookie-jar)(?:\s|=)|(?:^|\s)-(?:X|--request)(?:\s|=)(?:POST|PUT|PATCH|DELETE)\b/i;
// Maestro CLI read commands; everything else mutates the workflow ledger.
const MAESTRO_READ_TOP = new Set(["search", "load", "wiki", "explore", "arch-kb", "help", "version"]);
const MAESTRO_READ_SUB = new Map<string, Set<string>>([
  ["run", new Set(["status", "brief", "check", "prepare"])],
  ["session", new Set(["status"])],
  ["spec", new Set(["history"])],
  ["knowledge", new Set(["review", "search"])],
]);

function isMutatingPlanShell(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  // Command substitution and backticks run arbitrary code: scan their payload.
  for (const segment of normalized.match(/\$\([^()]*\)|`[^`]*`/g) ?? []) {
    const payload = segment.startsWith("$(") ? segment.slice(2, -1) : segment.slice(1, -1);
    if (isMutatingPlanShell(payload)) return true;
  }
  // Quoted strings are data, not commands: drop them before the lexical scan.
  const unquoted = normalized.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "");
  // File-write redirection (`>`, `>>`, `&>`, `2>`); `>&` is fd duplication, not a write.
  if (/>(?![&<])(?!\s*\/dev\/null\b)/.test(unquoted)) return true;
  if (MUTATING_SHELL_VERBS.test(unquoted)) return true;
  // In-place editing rewrites files; sed/perl/awk without -i is a read filter.
  if (/\b(?:sed|perl|awk)\b/.test(unquoted) && IN_PLACE_EDIT.test(unquoted)) return true;
  // Exec hooks can run arbitrary programs.
  if (/(?:^|\s)--pre(?:=|\s|$)/.test(unquoted)) return true;
  if (/(?:^|\s)-delete(?:\s|$)/.test(unquoted)) return true;
  // Shell -c / cmd /c executes a script string; block rather than trust its content.
  if (SHELL_FAMILY.test(unquoted) && SHELL_EXEC_FLAG.test(unquoted)) return true;
  if (hasMutatingGitCall(unquoted)) return true;
  if (hasMutatingMaestroCall(unquoted)) return true;
  if (/\b(?:npm|npx|yarn|pnpm|bun)\b/.test(unquoted) && NPM_WRITE_VERBS.test(unquoted)) return true;
  if (/\b(?:pip|pip3)\b/.test(unquoted) && PIP_WRITE_VERBS.test(unquoted)) return true;
  if (/\b(?:apt|apt-get|dnf|yum|brew|scoop|choco|winget|port)\b/.test(unquoted) && APT_WRITE_VERBS.test(unquoted)) return true;
  if (/\bcurl\b/.test(unquoted) && CURL_WRITE_FLAGS.test(unquoted)) return true;
  // wget writes a file unless output goes to stdout (-O- / -O -).
  if (/\bwget\b/.test(unquoted) && !/(?:-O-|-O\s+-)/.test(unquoted)) return true;
  return false;
}

function hasMutatingGitCall(command: string): boolean {
  const sub = gitSubcommand(command);
  if (sub?.verb === undefined) return false;
  if (/(?:^|\s)--(?:output(?:=|\s)|ext-diff(?:\s|$)|textconv(?:\s|$))/.test(sub.rest)) return true;
  if (!GIT_READ_SUBCOMMANDS.has(sub.verb)) return true;
  // branch/tag are read as bare listing but write with delete/rename/annotate flags.
  if (sub.verb === "branch" || sub.verb === "tag") {
    const writeFlags = sub.verb === "branch" ? "dDmMcC" : "aftdm";
    if (new RegExp(`\\b${sub.verb}\\s+-[${writeFlags}](?:\\s|$)`).test(sub.rest)) return true;
  }
  return false;
}

function hasMutatingMaestroCall(command: string): boolean {
  const sub = maestroSubcommand(command);
  if (sub?.verb === undefined) return false;
  if (MAESTRO_READ_TOP.has(sub.verb)) return false;
  const readVerbs = MAESTRO_READ_SUB.get(sub.verb);
  return !readVerbs || !readVerbs.has(sub.rest.trim().split(/\s+/)[0] ?? "");
}

function gitSubcommand(command: string): { verb: string | undefined; rest: string } | undefined {
  const tokens = command.split(/\s+/);
  const index = tokens.findIndex((token) => token === "git");
  if (index < 0) return undefined;
  let cursor = index + 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (["-C", "--git-dir", "--work-tree", "--namespace", "-c", "--config-env"].includes(token)) {
      cursor += 2;
      continue;
    }
    if (token.startsWith("-")) {
      cursor += 1;
      continue;
    }
    return { verb: token, rest: tokens.slice(cursor).join(" ") };
  }
  return { verb: undefined, rest: "" };
}

function maestroSubcommand(command: string): { verb: string | undefined; rest: string } | undefined {
  const tokens = command.split(/\s+/);
  const index = tokens.findIndex((token) => token === "maestro");
  if (index < 0) return undefined;
  let cursor = index + 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;
    if (token.startsWith("-")) {
      cursor += 1;
      continue;
    }
    return { verb: token, rest: tokens.slice(cursor + 1).join(" ") };
  }
  return { verb: undefined, rest: "" };
}


export async function onAgentEndPlan(event: { messages: unknown[] }, ctx: PlanContext): Promise<void> {
  if (mode !== "plan" || latestStatus === "approved") return;
  const proposedPlan = extractProposedPlan(latestAssistantText(event.messages));
  if (!proposedPlan) return;
  const operation = beginPlanOperation(ctx);
  try {
    const store = await ensureStore(ctx);
    if (!bindPlanOperation(ctx, operation, store)) return;
    const saved = await store.saveDraft(proposedPlan, latestRevision);
    if (!isCurrentPlanOperation(ctx, operation)) return;
    applyLoadedPlan(saved);
    latestArtifactAvailable = Boolean(saved.markdown.trim()) || latestArtifactAvailable;
    syncModeStatus(ctx);
    onPlanModeChanged?.(ctx);
    ctx.ui.notify("Compatibility plan captured to current.md. Use plan-review or plan-confirm.", "info");
  } catch (error) {
    if (!isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) return;
    ctx.ui.notify(`Plan compatibility capture failed: ${errorMessage(error)}`, "warning");
  }
}

async function savePlan(
  ctx: PlanContext,
  markdown: string,
  expectedRevision: number,
  operation: PlanOperationIdentity,
): Promise<LoadedPlan | undefined> {
  const store = await ensureStore(ctx);
  if (!bindPlanOperation(ctx, operation, store)) return undefined;
  const saved = await store.saveDraft(markdown, expectedRevision);
  if (!isCurrentPlanOperation(ctx, operation)) return undefined;
  applyLoadedPlan(saved);
  latestArtifactAvailable = Boolean(saved.markdown.trim()) || latestArtifactAvailable;
  syncModeStatus(ctx);
  onPlanModeChanged?.(ctx);
  return saved;
}

async function reviewPlan(
  ctx: PlanContext,
  allowConfirm: boolean,
  handoffDelivery: PlanHandoffDelivery,
  operation: PlanOperationIdentity,
  signal?: AbortSignal,
  onUserAttention?: UserAttentionHandler,
): Promise<PlanReviewOutcome> {
  if (!ctx.hasUI) {
    if (isCurrentPlanOperation(ctx, operation, false)) {
      ctx.ui.notify("Plan review requires an interactive UI.", "warning");
    }
    return { approved: false, exited: false };
  }
  const store = await ensureStore(ctx);
  if (!bindPlanOperation(ctx, operation, store)) return { approved: false, exited: false };
  if (mode !== "plan") {
    await enterPlanMode(ctx, operation);
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
  }
  if (!allowConfirm) {
    onUserAttention?.({
      id: `plan-review:${operation.sessionId}:${operation.operationId}`,
      kind: "plan-review",
    }, ctx);
    await editPlan(ctx, store.currentPath, operation);
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
    return { approved: false, exited: false };
  }

  let attentionIndex = 0;
  while (isCurrentPlanOperation(ctx, operation)) {
    const workflow = await workflowConfirmation(ctx);
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
    let drafts: { revision: number; archivedAt: string; checksum: string }[];
    try {
      drafts = (await store.listDrafts()).map((entry) => ({
        revision: entry.revision,
        archivedAt: entry.archivedAt,
        checksum: entry.checksum,
      }));
    } catch {
      drafts = [];
    }
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
    onUserAttention?.({
      id: `plan-confirm:${operation.sessionId}:${operation.operationId}:${++attentionIndex}`,
      kind: "plan-confirm",
    }, ctx);
    const decision = await openPlanConfirmation(ctx, {
      markdown: latestPlan ?? "",
      pathLabel: store.currentPath,
      canCompactContext: true,
      contextPercent: ctx.getContextUsage?.()?.percent ?? undefined,
      defaultExecution: latestExecution,
      workflow,
      drafts,
    });
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
    const action = decision.action;
    if (action === "modify") {
      refineSession = undefined;
      refineSessionRevision = -1;
      refineLatestOutput = undefined;
      refineLatestRole = undefined;
      refineLatestAppliesAs = undefined;
      refineLatestRoleLabel = undefined;
      await editPlan(ctx, store.currentPath, operation);
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      continue;
    }
    if (action === "refine") {
      if (!extensionApi) {
        ctx.ui.notify("Review & Refine is unavailable: extension API is not initialized.", "warning");
        continue;
      }
      if (refineSessionRevision !== latestRevision) {
        refineSession = undefined;
        refineSessionRevision = latestRevision;
        refineLatestOutput = undefined;
        refineLatestRole = undefined;
        refineLatestAppliesAs = undefined;
        refineLatestRoleLabel = undefined;
      }
      const initialRole: RefineRole = refineSession?.currentRole ?? "reviewer";
      const reviewedRevision = latestRevision;
      const outcome = await openRefinePanel(extensionApi, ctx, {
        markdown: latestPlan ?? "",
        initialRole,
        session: refineSession,
        signal,
        async onOutput(turn) {
          await store.saveReviewArtifact({
            revision: reviewedRevision,
            role: turn.role,
            markdown: turn.output,
            createdAt: turn.createdAt,
          });
          if (!isCurrentPlanOperation(ctx, operation)) return;
          latestArtifactAvailable = true;
          onPlanModeChanged?.(ctx);
        },
      });
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      refineSession = outcome.session;
      refineSessionRevision = latestRevision;
      refineLatestOutput = outcome.latestOutput;
      refineLatestRole = outcome.latestRole;
      refineLatestAppliesAs = outcome.latestAppliesAs;
      refineLatestRoleLabel = outcome.latestRole ? REFINE_ROLES[outcome.latestRole].label : undefined;
      if (outcome.action === "apply") {
        const output = refineSessionRevision === latestRevision ? refineLatestOutput : undefined;
        if (!output) {
          ctx.ui.notify("No refine result is available to apply; run review/refine first.", "warning");
          continue;
        }
        if (refineLatestAppliesAs === "draft") {
          // Optimizer-style roles return a full draft: write it directly as the new current.md.
          const saved = await savePlan(ctx, output, latestRevision, operation);
          if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
          if (saved) {
            refineLatestOutput = undefined;
            refineLatestRole = undefined;
            refineLatestAppliesAs = undefined;
            refineLatestRoleLabel = undefined;
            refineSession = undefined;
            refineSessionRevision = -1;
            ctx.ui.notify("Refine result applied to the Plan draft.", "info");
          }
          continue;
        }
        // Reviewer/decomposer/brainstormer output continues the Plan discussion.
        const feedback = buildRefineFeedbackMessage(output, refineLatestRoleLabel);
        refineLatestOutput = undefined;
        refineLatestRole = undefined;
        refineLatestAppliesAs = undefined;
        refineLatestRoleLabel = undefined;
        return deliverPlanDiscussion(ctx, handoffDelivery, feedback);
      }
      if (outcome.action === "discard" || outcome.action === "cancel") {
        refineLatestOutput = undefined;
        refineLatestRole = undefined;
        refineLatestAppliesAs = undefined;
        refineLatestRoleLabel = undefined;
        if (outcome.action === "discard") {
          ctx.ui.notify("Refine result discarded; returning to the Plan preview.", "info");
        }
      }
      continue;
    }
    if (action === "rollback") {
      const entries = await store.listDrafts();
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      if (entries.length === 0) {
        ctx.ui.notify("No archived drafts are available to roll back to.", "warning");
        continue;
      }
      const rollback = await renderRollbackOverlay(ctx, {
        drafts: entries,
        readDraft: (path) => store.readDraft(path),
      });
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      if (rollback.action === "restore" && rollback.selected) {
        try {
          const restored = await store.restoreDraft(rollback.selected.revision, latestRevision);
          if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
          applyLoadedPlan(restored);
          refineSession = undefined;
          refineSessionRevision = -1;
          refineLatestOutput = undefined;
          refineLatestRole = undefined;
          refineLatestAppliesAs = undefined;
          refineLatestRoleLabel = undefined;
          syncModeStatus(ctx);
          ctx.ui.notify(`Restored Plan draft revision ${rollback.selected.revision} as r${restored.manifest.revision}.`, "info");
        } catch (error) {
          ctx.ui.notify(`Rollback failed: ${errorMessage(error)}`, "warning");
        }
      }
      continue;
    }
    if (action === "continue") {
      const discussion = await ctx.ui.input(
        "Continue discussing the Plan",
        "Enter feedback or a question",
      );
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      if (!discussion?.trim()) continue;
      return deliverPlanDiscussion(ctx, handoffDelivery, discussion.trim());
    }
    if (action === "close") {
      abortPlanTurn(ctx);
      return { approved: false, exited: false };
    }
    if (action === "exit-plan") {
      exitMode(ctx, operation);
      return { approved: false, exited: true };
    }

    const markdown = latestPlan ?? "";
    const executionChoice = decision.execution ?? { backend: "standalone", context: "current" };
    let approved: LoadedPlan;
    try {
      approved = await store.approve(markdown, latestRevision, { execution: executionChoice });
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      applyLoadedPlan(approved);
    } catch (error) {
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      const loaded = await store.load();
      if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
      applyLoadedPlan(loaded);
      const draftNote = error instanceof PlanApprovalError && error.draftPersisted
        ? ` Your draft is intact at revision ${error.revision}; retry the approval.`
        : "";
      ctx.ui.notify(`Plan approval failed: ${errorMessage(error)}${draftNote}`, "warning");
      return { approved: false, exited: false };
    }

    const executionMode = executionChoice.context;
    const executionMessage = await startImplementation(
      ctx,
      store,
      approved,
      executionChoice,
      handoffDelivery,
      operation,
    );
    if (!isCurrentPlanOperation(ctx, operation)) return { approved: false, exited: false };
    const compactDeferred = pendingPlanCompactHandoff?.operation === operation;
    return { approved: true, exited: true, executionMode, executionChoice, executionMessage, compactDeferred };
  }
  return { approved: false, exited: false };
}

function buildRefineFeedbackMessage(output: string, roleLabel?: string): string {
  return [
    "## Refine Feedback (Plan)",
    `The following is the Review & Refine output${roleLabel ? ` from ${roleLabel}` : ""} for the current Plan draft. Revise the Plan with plan-update to incorporate the valid findings, then present it again with plan-confirm. If you disagree with a point, explain why in the discussion.`,
    "",
    output,
  ].join("\n");
}

function deliverPlanDiscussion(
  ctx: PlanContext,
  handoffDelivery: PlanHandoffDelivery,
  discussion: string,
): PlanReviewOutcome {
  if (handoffDelivery === "tool-result") {
    return { approved: false, exited: false, discussionMessage: discussion };
  }
  queuePlanDiscussion(ctx, discussion);
  return { approved: false, exited: false };
}

function queuePlanDiscussion(ctx: PlanContext, discussion: string): void {
  const busy = ctx.isIdle?.() === false;
  extensionApi?.sendUserMessage(
    discussion,
    busy ? { deliverAs: "followUp" } : undefined,
  );
  if (busy) abortPlanTurn(ctx);
}

function buildPlanExitMessage(): string {
  const path = currentStore?.currentPath ?? "the persisted Plan draft";
  return [
    "## Exited Plan Mode",
    "The user intentionally exited Plan mode without approving the draft.",
    `Act mode is now active, and the draft remains preserved at ${path}.`,
    "This is not an approval failure. Do not call Plan-only tools unless the user explicitly re-enters Plan mode.",
  ].join("\n");
}

function buildPlanExitReminder(): string {
  return `<system-reminder>\n${buildPlanExitMessage()}\n</system-reminder>`;
}

function abortPlanTurn(ctx: PlanContext): void {
  try {
    ctx.abort?.();
  } catch {
    // 关闭确认页不应因宿主中断失败而阻塞。
  }
}

async function editPlan(
  ctx: PlanContext,
  pathLabel: string,
  operation: PlanOperationIdentity,
): Promise<void> {
  await openPlanEditor(ctx, {
    markdown: latestPlan ?? "",
    revision: latestRevision,
    allowConfirm: false,
    pathLabel,
    async onSave(markdown, expectedRevision) {
      if (!isCurrentPlanOperation(ctx, operation)) throw new Error("Plan operation was superseded");
      const saved = await savePlan(ctx, markdown, expectedRevision, operation);
      if (!isCurrentPlanOperation(ctx, operation) || !saved) throw new Error("Plan operation was superseded");
      return saved.manifest.revision;
    },
    async onConfirm() {},
  });
  if (!isCurrentPlanOperation(ctx, operation)) return;
}

export function consumePlanCleanContextCompaction(): PlanCleanContextCompactionRequest | undefined {
  const request = pendingCleanContextCompaction;
  if (!request || !isCurrentPlanHandoff(request)) {
    pendingCleanContextCompaction = undefined;
    return undefined;
  }
  pendingCleanContextCompaction = undefined;
  return request;
}

function beginPlanHandoff(): PlanHandoffRequestIdentity {
  const request = {
    lifecycleGeneration: planLifecycleGeneration,
    requestId: ++nextPlanHandoffRequestId,
  };
  activePlanHandoffRequest = request;
  return request;
}

function isCurrentPlanHandoff(request: PlanHandoffRequestIdentity): boolean {
  return request.lifecycleGeneration === planLifecycleGeneration
    && request.requestId === activePlanHandoffRequest?.requestId
    && request.lifecycleGeneration === activePlanHandoffRequest.lifecycleGeneration;
}

function finishPlanHandoff(request: PlanHandoffRequestIdentity): boolean {
  if (!isCurrentPlanHandoff(request)) return false;
  activePlanHandoffRequest = undefined;
  if (pendingCleanContextCompaction?.requestId === request.requestId
    && pendingCleanContextCompaction.lifecycleGeneration === request.lifecycleGeneration) {
    pendingCleanContextCompaction = undefined;
  }
  return true;
}

export function applyPlanContextToCompaction(
  preparation: {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    firstKeptEntryId: string;
    previousSummary?: string;
  },
  branchMessages: AgentMessage[],
): boolean {
  const projected = projectPlanContextForCompaction(branchMessages);
  if (!projected) return false;
  preparation.messagesToSummarize = projected.messages;
  preparation.turnPrefixMessages = [];
  preparation.firstKeptEntryId = projected.firstKeptEntryId;
  preparation.previousSummary = undefined;
  return true;
}

function activatePlanContextReplacement(summary: string): void {
  const text = [
    "The conversation history before this point was intentionally reset after explicit user approval.",
    "",
    "<summary>",
    summary,
    "</summary>",
  ].join("\n");
  planContextReplacement = {
    lifecycleGeneration: planLifecycleGeneration,
    replacement: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as AgentMessage,
  };
}

function canReplaceContextAfterCompactionFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("Nothing to compact") || message.includes("Already compacted");
}

async function startImplementation(
  ctx: PlanContext,
  store: PlanStore,
  approved: LoadedPlan,
  executionChoice: PlanExecutionChoice,
  handoffDelivery: PlanHandoffDelivery,
  operation: PlanOperationIdentity,
): Promise<string | undefined> {
  if (!isCurrentPlanOperation(ctx, operation)) return undefined;
  const markdown = approved.markdown;
  const planPath = approved.manifest.approvedPath
    ? join(approved.plansDir, approved.manifest.approvedPath)
    : approved.currentPath;
  const executionMode = executionChoice.context;
  exitPlanMode(ctx);
  latestPlan = markdown;
  latestStatus = "approved";
  ctx.ui.notify("Plan approved · Act mode active", "info");
  const refineFeedback = refineSessionRevision === approved.manifest.revision
    && refineLatestAppliesAs === "feedback"
    ? refineLatestOutput
    : undefined;
  const executionContract = buildPlanExecutionContract(
    planPath,
    latestHandoffKey,
    refineFeedback,
    refineLatestRoleLabel,
  );
  let executionMessage = executionContract;
  let workflowDelivery: { handoffKey: string; binding: PlanWorkflowBinding } | undefined;

  if (executionChoice.backend === "workflow") {
    try {
      const publication = await publishWorkflowPlan(ctx, approved, executionChoice);
      if (!isCurrentPlanOperation(ctx, operation)) return undefined;
      if (publication.binding.status !== "bound") {
        throw new Error("Workflow publisher returned a non-bound result");
      }
      const pendingDelivery = withPendingWorkflowDelivery(publication.binding);
      const bound = await store.updateWorkflowBinding(publication.binding.handoffKey, pendingDelivery);
      if (!isCurrentPlanOperation(ctx, operation)) return undefined;
      applyLoadedPlan(bound);
      workflowDelivery = {
        handoffKey: publication.binding.handoffKey,
        binding: bound.manifest.workflowBinding!,
      };
      executionMessage = `${publication.executionMessage}\n\n${executionContract}`;
      ctx.ui.notify(
        `Approved Plan bound to Workflow Session ${publication.binding.workflowSessionId}`,
        "info",
      );
    } catch (error) {
      if (!isCurrentPlanOperation(ctx, operation)) return undefined;
      const message = errorMessage(error);
      const handoffKey = approved.manifest.handoffKey;
      const checksum = approved.manifest.approvedChecksum;
      if (handoffKey && checksum) {
        const failed: PlanWorkflowBinding = {
          status: "failed",
          handoffKey,
          sourceChecksum: checksum,
          error: message.slice(0, 2000),
          updatedAt: new Date().toISOString(),
        };
        try {
          const failedPlan = await store.updateWorkflowBinding(handoffKey, failed);
          if (!isCurrentPlanOperation(ctx, operation)) return undefined;
          applyLoadedPlan(failedPlan);
        } catch (bindingError) {
          if (!isCurrentPlanOperation(ctx, operation)) return undefined;
          ctx.ui.notify(`Workflow binding state could not be persisted: ${errorMessage(bindingError)}`, "error");
        }
      }
      if (!isCurrentPlanOperation(ctx, operation)) return undefined;
      const failureMessage = `Plan approved, but Workflow binding failed; execution was not started: ${message}`;
      ctx.ui.notify(failureMessage, "error");
      return failureMessage;
    }
  }

  const delivered = await deliverImplementation(
    ctx,
    planPath,
    markdown,
    executionMode,
    executionMessage,
    handoffDelivery,
    operation,
    workflowDelivery
      ? () => acknowledgeWorkflowDelivery(
          ctx,
          store,
          workflowDelivery!.handoffKey,
          workflowDelivery!.binding,
          operation,
        )
      : undefined,
  );
  return isCurrentPlanOperation(ctx, operation) ? delivered : undefined;
}

function buildPlanExecutionContract(
  planPath: string,
  handoffKey?: string,
  refineFeedback?: string,
  refineRoleLabel?: string,
): string {
  const base = [
    "The user selected Execute and explicitly authorized immediate implementation of the approved Plan.",
    "Begin execution now. Do not ask the user to trigger implementation again.",
    "The approved Plan is already in the current context.",
    `Plan source: ${planPath}`,
    "Before modifying the project:",
    "1. Load the knowledge/spec system (Knowledge Gate) before any project-related work:",
    "   - Make `maestro search \"<1-3 task keywords from this Plan>\" [--type spec|knowhow] --json` the first project-related call.",
    "   - Load every relevant governing hit with `maestro load --type <type> --id <id>`; search is exposure only, loading records consumption.",
    "   - Follow the injected knowledge_context; re-search when entering a new subsystem or before an architecture decision.",
    "2. Reconcile the Plan with every user requirement; do not shrink or reinterpret the approved scope.",
    "3. Decompose the Plan into an ordered Todo dependency graph before implementation.",
    ...(handoffKey
      ? [
          `   - For complex approved work, call plan-decompose with planHandoffKey: "${handoffKey}"; follow the returned decomposition prompt in the current main flow, then create the Todo batch it specifies.`,
          `   - For simple work, create the Todo directly with planHandoffKey: "${handoffKey}".`,
        ]
      : ["   - For complex approved work, use plan-decompose before creating Todos."]),
    "4. Attach a Goal as the quality gate only to key Todos that carry verifiable acceptance criteria; do NOT create a Goal for every Todo. Goals are flat and time-ordered — put the overall acceptance Goal on the last Todo when an overall sign-off is needed.",
    "5. Prefer the teammate tool to delegate independent Todo work; use direct execution only when delegation would not help.",
    "6. Execute the Todo sequence; activating a Todo auto-switches to its quality-gate Goal, and a Todo completes only after its Goal verifies.",
  ];
  if (refineFeedback) {
    base.push(
      `7. Review & Refine feedback${refineRoleLabel ? ` from ${refineRoleLabel}` : ""}: incorporate valid findings during execution.`,
      "<refine-feedback>",
      refineFeedback,
      "</refine-feedback>",
    );
  }
  return base.join("\n");
}

async function deliverImplementation(
  ctx: PlanContext,
  planPath: string,
  markdown: string,
  executionMode: PlanExecutionChoice["context"],
  executionMessage: string,
  handoffDelivery: PlanHandoffDelivery,
  operation: PlanOperationIdentity,
  onDelivered?: () => Promise<void>,
): Promise<string | undefined> {
  if (!isCurrentPlanOperation(ctx, operation)) return undefined;
  if (executionMode === "compact") {
    const handoff: PlanCompactHandoff = {
      request: beginPlanHandoff(),
      operation,
      planPath,
      markdown,
      executionMessage,
      ...(onDelivered ? { onDelivered } : {}),
    };
    if (handoffDelivery === "tool-result") {
      pendingPlanCompactHandoff = handoff;
      ctx.ui.notify("Plan compaction queued for the end of the current turn…", "info");
      return undefined;
    }
    startPlanCompaction(ctx, handoff);
    return undefined;
  }

  if (handoffDelivery === "tool-result") {
    await onDelivered?.();
    return isCurrentPlanOperation(ctx, operation) ? executionMessage : undefined;
  }
  sendImplementationMessage(ctx, executionMessage);
  await onDelivered?.();
  if (!isCurrentPlanOperation(ctx, operation)) return undefined;
}

export function hasPendingPlanCompactHandoff(ctx: PlanContext): boolean {
  const handoff = pendingPlanCompactHandoff;
  return Boolean(handoff
    && planOperationMatchesContext(ctx, handoff.operation)
    && isCurrentPlanOperation(ctx, handoff.operation));
}

export function onAgentSettledPlan(ctx: PlanContext): void {
  const handoff = pendingPlanCompactHandoff;
  if (!handoff || !planOperationMatchesContext(ctx, handoff.operation)) return;
  pendingPlanCompactHandoff = undefined;
  if (!isCurrentPlanOperation(ctx, handoff.operation)) {
    finishPlanHandoff(handoff.request);
    return;
  }
  startPlanCompaction(ctx, handoff);
}

function startPlanCompaction(ctx: PlanContext, handoff: PlanCompactHandoff): void {
  const { request, operation, planPath, markdown, executionMessage, onDelivered } = handoff;
  const lease = compactionArbiter?.request("plan-handoff", {
    owner: "plan-handoff",
    reason: "preserve-approved-plan",
  });
  let delivered = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const deliver = (releaseLease = true) => {
    if (delivered) return false;
    delivered = true;
    if (watchdog) clearTimeout(watchdog);
    if (releaseLease) lease?.release();
    if (!isCurrentPlanOperation(ctx, operation) || !isCurrentPlanHandoff(request)) return false;
    try {
      sendImplementationMessage(ctx, executionMessage);
    } catch (error) {
      finishPlanHandoff(request);
      ctx.ui.notify(`Plan execution handoff could not be queued: ${errorMessage(error)}`, "error");
      return false;
    }
    if (!finishPlanHandoff(request)) return false;
    void onDelivered?.();
    return true;
  };

  if (compactionArbiter && !lease) {
    ctx.ui.notify("Compaction is already in progress; executing with the current context.", "warning");
    deliver();
    return;
  }

  const compactionInstructions = [
    "Treat the following approved Plan as the authoritative execution contract.",
    `Preserve its source path, locked boundaries, risks, acceptance checks, and current execution position: ${planPath}`,
    "",
    markdown,
  ].join("\n");
  ctx.ui.notify("Compacting context with the approved Plan preserved…", "info");
  watchdog = setTimeout(() => {
    if (isCurrentPlanOperation(ctx, operation) && isCurrentPlanHandoff(request)) {
      ctx.ui.notify("Plan compaction did not finish in time; executing with the current context.", "warning");
    }
    deliver(false);
  }, planCompactionHandoffTimeoutMs);
  watchdog.unref?.();
  try {
    ctx.compact({
      customInstructions: lease?.tagInstructions(compactionInstructions) ?? compactionInstructions,
      onComplete() {
        deliver();
      },
      onError(error) {
        if (isCurrentPlanOperation(ctx, operation) && isCurrentPlanHandoff(request)) {
          ctx.ui.notify(`Compaction failed; executing with the current context: ${error.message}`, "warning");
        }
        deliver();
      },
    });
  } catch (error) {
    if (isCurrentPlanOperation(ctx, operation) && isCurrentPlanHandoff(request)) {
      ctx.ui.notify(`Compaction failed; executing with the current context: ${errorMessage(error)}`, "warning");
    }
    deliver();
  }
}

function sendImplementationMessage(ctx: PlanContext, message: string): void {
  if (!extensionApi) throw new Error("Plan extension API is not initialized");
  const opts = ctx.isIdle?.() === false
    ? { deliverAs: "followUp" as const }
    : undefined;
  extensionApi.sendUserMessage(message, opts);
}

function currentDetails(action: PlanToolDetails["action"]): PlanToolDetails {
  return {
    action,
    mode,
    revision: latestRevision,
    path: currentStore?.currentPath ?? "",
    sessionId: currentStore?.sessionId ?? "",
    status: latestStatus,
    handoffStatus: getPlanHandoffStatus(),
    ...(latestHandoffKey ? { handoffKey: latestHandoffKey } : {}),
    ...(latestExecution ? { execution: latestExecution } : {}),
    ...(latestWorkflowBinding ? { workflowBinding: latestWorkflowBinding } : {}),
  };
}

/**
 * Detached Plan state for compaction metadata and prompts, mirroring
 * getTodoCompactionSnapshot.
 *
 * Only one-shot notes reach the model via before_agent_start.message, so after a
 * compaction the model's only trace of an approved Plan is whatever prose survived the
 * summary — including the handoff key, which nothing injects and which the todo tool
 * needs verbatim. The plan body is deliberately left out: it lives at `path` and is
 * reloaded from the store, so this carries identity and reload metadata, the same way
 * the checkpoint treats skills.
 */
export function getPlanCompactionSnapshot(): PlanCompactionSnapshot {
  return {
    mode,
    status: latestStatus,
    revision: latestRevision,
    handoffStatus: getPlanHandoffStatus(),
    ...(latestHandoffKey ? { handoffKey: latestHandoffKey } : {}),
    ...(currentStore?.currentPath ? { path: currentStore.currentPath } : {}),
  };
}

export function getPlanHandoffStatus(): PlanHandoffStatus {
  if (latestStatus !== "approved") return "none";
  if (!latestHandoffKey || !hasExecutableTodoForHandoff(latestHandoffKey)) return "todo-required";
  return "ready";
}

function result(
  text: string,
  details: PlanToolDetails,
  isError = false,
  terminate = false,
): AgentToolResult<PlanToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
    ...(terminate ? { terminate: true } : {}),
  } as unknown as AgentToolResult<PlanToolDetails>;
}

function requirePlanMode(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> | undefined {
  if (mode === "plan") return;
  return result(`plan-${action} requires Plan mode. Call plan-enter first.`, {
    ...currentDetails(action),
    error: "E_PLAN_MODE_REQUIRED",
  }, true);
}

function supersededResult(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> {
  return result("Plan operation was superseded by a newer Plan operation.", {
    ...currentDetails(action),
    error: "E_PLAN_OPERATION_SUPERSEDED",
  }, true);
}

export function registerPlanTools(
  pi: ExtensionAPI,
  options: { onUserAttention?: UserAttentionHandler } = {},
): void {
  const enterTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: PLAN_ENTER_TOOL,
    label: "Plan Enter",
    description: "Enter durable Plan mode and load this chat session's current.md draft.",
    promptSnippet: "Use plan-enter before producing or editing an implementation Plan.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      if (mode !== "plan") await enterPlanMode(ctx, operation);
      if (!isCurrentPlanOperation(ctx, operation)) return supersededResult("enter");
      return result(`Plan mode active. Draft: ${currentStore?.currentPath ?? ""}`, currentDetails("enter"));
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "enter");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      return toolResultLine(theme, { name: "plan", ok: true, arg: "enter", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const updateTool: ToolDefinition<typeof PlanUpdateParams, PlanToolDetails> = {
    name: "plan-update",
    label: "Plan Update",
    description: "Replace this chat session's current.md draft with complete Markdown. expectedRevision defaults to the currently loaded revision.",
    promptSnippet: "Use plan-update to persist the decision-complete, execution-ready Markdown Plan before review.",
    parameters: PlanUpdateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      const blocked = requirePlanMode("update");
      if (blocked) return blocked;
      const expectedRevision = params.expectedRevision ?? latestRevision;
      try {
        const saved = await savePlan(ctx, params.markdown, expectedRevision, operation);
        if (!isCurrentPlanOperation(ctx, operation) || !saved) return supersededResult("update");
        return result(`Plan draft saved at revision ${saved.manifest.revision}.`, currentDetails("update"));
      } catch (error) {
        if (!isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) return supersededResult("update");
        return result(errorMessage(error), { ...currentDetails("update"), error: errorMessage(error) }, true);
      }
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "update");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "update", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const reviewTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-review",
    label: "Plan Draft Editor",
    description: "Open the full-screen editable Markdown draft in an interactive UI. Save or cancel without entering Act mode. Use plan-confirm for Review & Refine (role-based AI review and refinement).",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      const blocked = requirePlanMode("review");
      if (blocked) return blocked;
      await reviewPlan(ctx, false, "message", operation, undefined, options.onUserAttention);
      if (!isCurrentPlanOperation(ctx, operation)) return supersededResult("review");
      return result("Plan review closed; Plan mode remains active.", currentDetails("review"));
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "review");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "review", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const confirmTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-confirm",
    label: "Plan Confirm",
    description: "Present the Markdown Plan in an interactive UI with choices to execute, modify, discuss, run role-based Review & Refine, or exit. Current-context execution returns through the tool result; compact execution settles the turn, compacts, then resumes automatically.",
    promptSnippet: "Standard presentation step after plan-update. The user controls approval and may run role-based Review & Refine; choosing Execute authorizes immediate implementation, with compact execution resuming automatically after turn settlement.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      const blocked = requirePlanMode("confirm");
      if (blocked) return blocked;
      const outcome = await reviewPlan(ctx, true, "tool-result", operation, signal, options.onUserAttention);
      if (!isCurrentPlanOperation(ctx, operation)) return supersededResult("confirm");
      onPlanModeChanged?.(ctx);
      if (outcome.compactDeferred) {
        try {
          ctx.abort?.();
        } catch (error) {
          ctx.ui.notify(`Plan could not stop the current tool batch before compaction: ${errorMessage(error)}`, "warning");
        }
      }
      const summary = outcome.approved
        ? outcome.executionChoice?.backend === "workflow" && latestWorkflowBinding?.status === "failed"
          ? "Plan approved; Workflow binding failed and execution was not started."
          : outcome.compactDeferred
            ? `Plan approved; Act mode restored (${outcome.executionMode ?? "compact"} context, ${outcome.executionChoice?.backend ?? "standalone"}). Compaction will start after this turn settles, then execution resumes automatically.`
            : `Plan approved; Act mode restored (${outcome.executionMode ?? "current"} context, ${outcome.executionChoice?.backend ?? "standalone"}).`
        : outcome.exited
          ? buildPlanExitMessage()
          : outcome.discussionMessage
            ? "Plan feedback returned; Plan mode remains active."
            : "Plan not approved; Plan mode remains active.";
      const toolMessage = outcome.executionMessage ?? outcome.discussionMessage;
      const text = toolMessage
        ? `${summary}\n\n${toolMessage}`
        : summary;
      return result(text, {
        ...currentDetails("confirm"),
        approved: outcome.approved,
      }, false, outcome.compactDeferred === true);
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "confirm");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "confirm", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const decomposeTool: ToolDefinition<typeof PlanDecomposeParams, PlanToolDetails> = {
    name: PLAN_DECOMPOSE_TOOL,
    label: "Plan Decompose",
    description: "Inject the main-flow decomposition prompt for the currently approved Plan. Requires Act mode and the exact approved handoff key; creates no files, Todos, messages, or agents.",
    promptSnippet: "For complex approved work, call plan-decompose with the exact planHandoffKey, then let the current main flow build the complete Todo graph from its returned prompt.",
    parameters: PlanDecomposeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      if (mode !== "act") {
        return result("plan-decompose requires Act mode after Plan approval.", {
          ...currentDetails("decompose"),
          error: "E_PLAN_ACT_MODE_REQUIRED",
        }, true);
      }
      try {
        const store = await ensureStore(ctx);
        if (!bindPlanOperation(ctx, operation, store)) return supersededResult("decompose");
        const loaded = await store.loadApprovedSnapshotReadOnly();
        if (!isCurrentPlanOperation(ctx, operation)) return supersededResult("decompose");
        const manifest = loaded.manifest;
        if (
          manifest.status !== "approved"
          || !manifest.handoffKey
          || !manifest.approvedPath
          || !manifest.approvedChecksum
        ) {
          return result("plan-decompose requires a currently approved Plan with complete approval identity.", {
            ...currentDetails("decompose"),
            error: "E_PLAN_APPROVAL_REQUIRED",
          }, true);
        }
        if (params.planHandoffKey !== manifest.handoffKey) {
          return result("plan-decompose requires the exact handoff key of the currently approved Plan.", {
            ...currentDetails("decompose"),
            error: "E_PLAN_HANDOFF_KEY_MISMATCH",
          }, true);
        }
        const contract = buildPlanDecomposeContract({
          planHandoffKey: params.planHandoffKey,
          approvedPlanPath: loaded.approvedPath,
          approvedChecksum: manifest.approvedChecksum,
        });
        if (!isCurrentPlanOperation(ctx, operation)) return supersededResult("decompose");
        return result(contract, currentDetails("decompose"));
      } catch (error) {
        if (!isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) return supersededResult("decompose");
        if (errorMessage(error) === "Plan has no complete approved snapshot") {
          return result("plan-decompose requires a currently approved Plan with complete approval identity.", {
            ...currentDetails("decompose"),
            error: "E_PLAN_APPROVAL_REQUIRED",
          }, true);
        }
        return result(errorMessage(error), {
          ...currentDetails("decompose"),
          error: "E_PLAN_DECOMPOSE_INVALID",
        }, true);
      }
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "decompose");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "decompose", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const exitTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-exit",
    label: "Plan Exit",
    description: "Exit Plan mode without deleting the persisted draft and return to Act mode.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const operation = beginPlanOperation(ctx);
      const blocked = requirePlanMode("exit");
      if (blocked) return blocked;
      exitMode(ctx, operation);
      return result(buildPlanExitMessage(), currentDetails("exit"));
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "exit");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "exit", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  const statusTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-status",
    label: "Plan Status",
    description: "Return the draft path, revision, approval status, and handoff state while Plan mode is active.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      beginPlanOperation(ctx);
      const blocked = requirePlanMode("status");
      if (blocked) return blocked;
      const details = currentDetails("status");
      return result(`${details.mode} · ${details.status} · r${details.revision} · ${details.sessionId} · ${details.path}`, details);
    },
    renderShell: "self",
    renderCall(_args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "plan", "status");
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const block = result.content.find((c) => c.type === "text");
      const text = block && "text" in block ? block.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      return toolResultLine(theme, { name: "plan", ok: !isError, arg: "status", summary: resultSummary(result), expanded: opts.expanded, detail: text });
    },
  };

  for (const tool of [enterTool, updateTool, reviewTool, confirmTool, decomposeTool, exitTool, statusTool]) {
    pi.registerTool(tool as ToolDefinition);
  }
}

function extractProposedPlan(text: string): string | undefined {
  return PROPOSED_PLAN_PATTERN.exec(text)?.[1]?.trim() || undefined;
}

function latestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index] as Record<string, unknown>;
    const message = (entry?.message as Record<string, unknown>) ?? entry;
    if (message?.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const value = block as { type?: string; text?: string };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
}

function buildPlanEnterNote(): string {
  return [
    "<system-reminder>",
    "## Plan Mode Just Activated",
    "Plan mode was activated (via user toggle or plan-enter). The tool surface is UNCHANGED for prompt-cache stability,",
    "but the tool-call hook enforces a read-only boundary until approval:",
    "- Project edits, Workflow/Todo/Goal mutations, write teammates, and mutating shell/browser calls are blocked.",
    "- Read, search, exploration, and canonical Workflow read actions remain available.",
    "- Plan tools: plan-update, plan-review, plan-confirm, plan-exit, plan-status.",
    "",
    "Workflow: research → plan-update (persist draft) → plan-confirm (present to user) in the same turn.",
    "plan-confirm gives the user a choice (execute, modify, discuss, or exit) — it does NOT force execution.",
    "If the user wants changes: plan-update again, then plan-confirm again.",
    "plan-exit leaves Plan mode without approving; the draft is preserved.",
    "",
    // Restored in full rather than condensed: 896d036f thinned this guidance on the
    // premise that the tool panel was "the authoritative signal" for Plan mode, and
    // 2e7c19b2 then removed the panel change altogether. This note is now the only
    // channel, and being one-time it extends the cached prefix once instead of
    // invalidating it per turn — so there is no cache argument for keeping it terse.
    "Planning quality:",
    "- Ground every decision in codebase evidence, not assumption.",
    "- Align every user requirement with a planned outcome and a verifiable acceptance check.",
    "",
    "Agent boundary (the hook only lets you dispatch `explorer` and `planner`):",
    "- Standard flow (broad or uncertain scope): dispatch `explorer` ONCE with batched parallel",
    "  prompts; unless the cross-module escalation below applies, dispatch one `planner`, passing",
    "  each explorer result's exact `agent://` publication ID as an immutable briefing reference",
    "  (use a correlation ID only when latest-turn semantics are intentional), plus your distilled",
    "  evidence, resolved requirements, constraints, and every known red line (architecture invariants,",
    "  compatibility rules) as a mandatory first-round checklist so the plan passes review in one",
    "  round. Never re-dispatch planning from scratch; send targeted revision instructions to the same",
    "  planner instead.",
    "- Lightweight flow (small, well-understood task): skip agent exploration entirely — inspect the",
    "  code yourself with read/search tools, then either author the draft via plan-update directly or",
    "  make one `planner` call with that content injected. After spot-checking the result, go straight",
    "  to ask-user-question / plan-confirm.",
    "- Planner budget: the planner may call at most ONE nested read-only agent (prefer a pressure",
    "  review of its near-final draft on architecturally risky changes) and must apply the findings by",
    "  revising its own draft — no repeated review rounds, no delegate chains.",
    "- Multi-planner escalation (cross-module scope only): when explorer evidence shows real module",
    "  boundaries (>= 2 modules, interface contracts are the core risk), you may dispatch up to 3",
    "  planners in parallel — one per module, each with maxNestingDepth: 0 (sub-planners get no nested",
    "  agents) and a briefing carrying only that module's exact immutable explorer publication IDs",
    "  and distilled evidence; never use a task-name URI as durable briefing. Root owns cross-module",
    "  integration and synthesizes the final unified Plan (or designates one lead planner",
    "  for integration). Single-module scope stays one planner.",
    "- Do not use implementation-capable agents in Plan mode. The root agent owns user interaction,",
    "  evidence spot-checking, contract validation, plan-update, and plan-confirm; persist the returned",
    "  Markdown only after checking it against the planner role contract, and return incomplete drafts",
    "  to the same planner for targeted revision (except in the lightweight flow, where you may author",
    "  the small draft yourself).",
    "- Use ask-user-question for every user question. Ask 2-4 related questions per call, grouped by",
    "  one review branch; do not ask questions as plain assistant text.",
    "- Root performs one contract spot-check covering scope, boundaries, non-goals, requirements, and",
    "  acceptance checks. Send concrete gaps to the same planner as targeted revisions without starting",
    "  another review chain; unresolved risks must stay visible.",
    "- Keep the final Markdown decision-complete and directly consumable by an execution agent. Omit",
    "  interview logs, delegate transcripts, and generic boilerplate. Validate the planner's draft",
    "  against the planner role contract before persisting it; return incomplete drafts for revision.",
    "- Approval decomposes the locked Plan into an ordered Todo graph; attach Goals as",
    "  quality gates to key Todos (overall acceptance Goal last) before implementation.",
    "",
    // Injected as a one-time custom message (before_agent_start.message) so the
    // system prompt prefix stays stable for prompt-cache reuse.
    "This is a one-time notification injected at the next turn boundary. Subsequent turns will not re-announce Plan mode — this reminder is the only signal you get.",
    "</system-reminder>",
  ].join("\n");
}

export function registerPlanCommand(pi: ExtensionAPI): void {
  pi.registerCommand("plan", {
    description: "Plan mode: /plan [<prompt>|exit|show|approve|clear|tools]",
    getArgumentCompletions(prefix: string) {
      const options = [
        { value: "exit", label: "exit", description: "Leave Plan mode and preserve draft" },
        { value: "show", label: "show", description: "Open editable Plan review" },
        { value: "approve", label: "approve", description: "Review, approve and implement" },
        { value: "clear", label: "clear", description: "Clear current Markdown draft" },
        { value: "tools", label: "tools", description: "Show active Plan tools" },
      ];
      const lower = prefix.trim().toLowerCase();
      return lower ? options.filter((option) => option.value.startsWith(lower)) : options;
    },
    async handler(args: string, ctx: PlanContext) {
      const operation = beginPlanOperation(ctx);
      const trimmed = args.trim();
      const command = trimmed.toLowerCase();
      if (command === "exit" || command === "off") {
        if (isPlanMode()) {
          exitMode(ctx, operation);
        } else if (isCurrentPlanOperation(ctx, operation, false)) {
          ctx.ui.notify("Act mode · draft preserved", "info");
        }
        return;
      }
      if (command === "show") {
        if (!isPlanMode()) {
          await enterPlanMode(ctx, operation);
          if (!isCurrentPlanOperation(ctx, operation)) return;
        }
        await reviewPlan(ctx, false, "message", operation);
        if (!isCurrentPlanOperation(ctx, operation)) return;
        return;
      }
      if (command === "approve") {
        if (!isPlanMode()) {
          await enterPlanMode(ctx, operation);
          if (!isCurrentPlanOperation(ctx, operation)) return;
        }
        if (!hasPlan()) {
          ctx.ui.notify("No Plan draft to approve.", "warning");
          return;
        }
        await reviewPlan(ctx, true, "message", operation);
        if (!isCurrentPlanOperation(ctx, operation)) return;
        onPlanModeChanged?.(ctx);
        return;
      }
      if (command === "clear") {
        if (!isPlanMode()) {
          await enterPlanMode(ctx, operation);
          if (!isCurrentPlanOperation(ctx, operation)) return;
        }
        const saved = await savePlan(ctx, "", latestRevision, operation);
        if (!isCurrentPlanOperation(ctx, operation) || !saved) return;
        ctx.ui.notify("Plan draft cleared.", "info");
        return;
      }
      if (command === "tools") {
        if (isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) {
          ctx.ui.notify(isPlanMode() ? PLAN_MODE_TOOL_NAMES.join(", ") : PLAN_ENTER_TOOL, "info");
        }
        return;
      }
      if (trimmed) {
        if (!isPlanMode()) {
          await enterPlanMode(ctx, operation);
          if (!isCurrentPlanOperation(ctx, operation)) return;
        }
        if (ctx.isIdle?.() === false) {
          ctx.ui.notify("Plan mode active. Planning prompt was not queued because the agent is still busy.", "warning");
          return;
        }
        extensionApi?.sendUserMessage(trimmed);
        return;
      }
      await toggleMode(ctx, operation);
      if (!isCurrentPlanOperation(ctx, operation, operation.store !== undefined)) return;
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
