/**
 * Durable Plan mode lifecycle.
 *
 * Act mode exposes plan-enter. Plan mode keeps the existing non-editing tool
 * surface plus plan-update/review/confirm/exit/status. Markdown drafts are
 * persisted by workspace and chat session; approval must commit before Act tools are restored.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { altKey } from "../key-labels.ts";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import { openPlanConfirmation, type PlanConfirmationAction } from "./plan-confirm.ts";
import { openPlanEditor } from "./plan-editor.ts";
import { PlanApprovalError, PlanStore, prewarmProcessIdentity, type LoadedPlan, type PlanSessionIdentity } from "./plan-store.ts";
import { getVisibleTasks } from "./todo.ts";
import {
  type CompactionArbiter,
} from "../compaction/compaction-arbiter.ts";

type Mode = "act" | "plan";
type PlanExecutionMode = "current" | "clear" | "compact";
export type PlanHandoffStatus = "none" | "todo-required" | "ready";
export type PlanContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "isIdle" | "sessionManager" | "compact" | "model" | "modelRegistry" | "isProjectTrusted"
> & Partial<Pick<ExtensionContext, "abort" | "getContextUsage">>
  & Partial<Pick<ExtensionCommandContext, "newSession">>;

interface PlanReviewOutcome {
  approved: boolean;
  exited: boolean;
  executionMode?: PlanExecutionMode;
  executionMessage?: string;
}

type PlanHandoffDelivery = "message" | "tool-result";

export interface PlanToolDetails {
  action: "enter" | "update" | "review" | "confirm" | "exit" | "status";
  mode: Mode;
  revision: number;
  path: string;
  sessionId: string;
  status: "empty" | "draft" | "approved";
  handoffStatus: PlanHandoffStatus;
  handoffKey?: string;
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

interface PlanRuntimeOptions {
  storeFactory?: (cwd: string, session: PlanSessionIdentity) => PlanStore;
  hasExecutableTodo?: (handoffKey: string) => boolean;
  compactionArbiter?: CompactionArbiter;
  preferNewSession?: (ctx: PlanContext) => boolean;
}

const STATUS_KEY = "mode";
export const PLAN_TOGGLE_KEY = "alt+shift+p";
export const PLAN_TOGGLE_LABEL = altKey("Shift+P");
const PROPOSED_PLAN_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

const PLAN_ENTER_TOOL = "plan-enter";
const PLAN_MODE_TOOL_NAMES = [
  "plan-update",
  "plan-review",
  "plan-confirm",
  "plan-exit",
  "plan-status",
] as const;
const ALL_PLAN_TOOL_NAMES = new Set([PLAN_ENTER_TOOL, ...PLAN_MODE_TOOL_NAMES]);

const PlanUpdateParams = Type.Object({
  markdown: Type.String({ description: "Complete Markdown text for current.md" }),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
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
let awaitingAction = false;
let pendingPlanExitReminder: string | undefined;
let pendingPlanEnterNote: string | undefined;
let compactionArbiter: CompactionArbiter | undefined;
let preferNewSession = (_ctx: PlanContext): boolean => false;

export const PLAN_CLEAN_CONTEXT_COMPACTION_MARKER = "[maestro-plan-clean-context]";

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

interface PlanContextReplacement {
  lifecycleGeneration: number;
  replacement: AgentMessage;
  baselineMessages?: string[];
}

let planLifecycleGeneration = 0;
let nextPlanHandoffRequestId = 0;
let activePlanHandoffRequest: PlanHandoffRequestIdentity | undefined;
let pendingCleanContextCompaction: PlanCleanContextCompactionRequest | undefined;
let planContextReplacement: PlanContextReplacement | undefined;
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
  preferNewSession = options.preferNewSession ?? (() => false);
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

export function clearPlan(): void {
  latestPlan = undefined;
  latestRevision = 0;
  latestStatus = "empty";
  latestHandoffKey = undefined;
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

async function enterPlanMode(ctx: PlanContext): Promise<void> {
  const store = await ensureStore(ctx);
  applyLoadedPlan(await store.loadQuick());
  pendingPlanExitReminder = undefined;
  pendingPlanEnterNote = buildPlanEnterNote();
  mode = "plan";
  activatePlanToolSurface();
  syncModeStatus(ctx);
  onPlanModeChanged?.(ctx);
  ctx.ui.notify(`Plan mode · ${store.currentPath}`, "info");
}

function exitPlanMode(ctx: PlanContext): void {
  mode = "act";
  pendingPlanEnterNote = undefined;
  restoreActToolSurface();
  syncModeStatus(ctx);
}

/** Leave Plan mode without approving or discarding the current draft. */
export function exitMode(ctx: PlanContext): Mode {
  if (mode === "plan") {
    exitPlanMode(ctx);
    ctx.ui.notify("Act mode · draft preserved", "info");
    pendingPlanExitReminder = buildPlanExitReminder();
    onPlanModeChanged?.(ctx);
  }
  return mode;
}

export async function toggleMode(ctx: PlanContext): Promise<Mode> {
  if (mode === "act") {
    await enterPlanMode(ctx);
    return mode;
  }
  if (hasPlan() && ctx.hasUI !== false) {
    const outcome = await reviewPlan(ctx, true);
    if (!outcome.approved && !outcome.exited) ctx.ui.notify("Staying in Plan mode", "info");
    onPlanModeChanged?.(ctx);
    return mode;
  }
  return exitMode(ctx);
}

/** Bind the root UI/UCL to Plan/Act mode transitions. */
export function setPlanModeChangeListener(listener: ((ctx: PlanContext) => void) | undefined): void {
  onPlanModeChanged = listener;
}

export async function onSessionStartPlan(ctx: PlanContext): Promise<void> {
  restoreActToolSurface();
  resetRuntimeState();
  ensureActToolSurface();
  syncModeStatus(ctx);
  prewarmProcessIdentity();
  try {
    const store = await ensureStore(ctx);
    applyLoadedPlan(await store.load());
  } catch (error) {
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

function resetRuntimeState(): void {
  planLifecycleGeneration++;
  activePlanHandoffRequest = undefined;
  mode = "act";
  currentStore = undefined;
  currentStoreKey = "";
  latestPlan = undefined;
  latestRevision = 0;
  latestStatus = "empty";
  latestHandoffKey = undefined;
  awaitingAction = false;
  pendingPlanExitReminder = undefined;
  pendingPlanEnterNote = undefined;
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

export function onBeforeAgentStartPlan(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
  if (pendingPlanEnterNote) {
    const note = pendingPlanEnterNote;
    pendingPlanEnterNote = undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
  }
  if (!pendingPlanExitReminder) return;
  const reminder = pendingPlanExitReminder;
  pendingPlanExitReminder = undefined;
  return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
}

export function onToolCallPlan(event: {
  toolName: string;
  input: Record<string, unknown>;
}, _bypassHandoff = false): { block: true; reason: string } | undefined {
  return undefined;
}


export async function onAgentEndPlan(event: { messages: unknown[] }, ctx: PlanContext): Promise<void> {
  if (mode !== "plan" || latestStatus === "approved") return;
  const proposedPlan = extractProposedPlan(latestAssistantText(event.messages));
  if (!proposedPlan) return;
  try {
    const store = await ensureStore(ctx);
    const saved = await store.saveDraft(proposedPlan, latestRevision);
    applyLoadedPlan(saved);
    syncModeStatus(ctx);
    ctx.ui.notify("Compatibility plan captured to current.md. Use plan-review or plan-confirm.", "info");
  } catch (error) {
    ctx.ui.notify(`Plan compatibility capture failed: ${errorMessage(error)}`, "warning");
  }
}

async function savePlan(ctx: PlanContext, markdown: string, expectedRevision = latestRevision): Promise<LoadedPlan> {
  const store = await ensureStore(ctx);
  const saved = await store.saveDraft(markdown, expectedRevision);
  applyLoadedPlan(saved);
  syncModeStatus(ctx);
  return saved;
}

async function reviewPlan(
  ctx: PlanContext,
  allowConfirm: boolean,
  handoffDelivery: PlanHandoffDelivery = "message",
): Promise<PlanReviewOutcome> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Plan review requires an interactive UI.", "warning");
    return { approved: false, exited: false };
  }
  const store = await ensureStore(ctx);
  if (mode !== "plan") await enterPlanMode(ctx);
  if (!allowConfirm) {
    await editPlan(ctx, store.currentPath);
    return { approved: false, exited: false };
  }

  while (true) {
    const action = await openPlanConfirmation(ctx, {
      markdown: latestPlan ?? "",
      pathLabel: store.currentPath,
      canClearContext: true,
      clearContextMode: typeof ctx.newSession === "function" ? "new-session" : "compaction",
      canCompactContext: handoffDelivery !== "tool-result",
      // ContextUsage.percent is number | null; the overlay treats "unknown" as
      // absent, so collapse null into undefined rather than widening its type.
      contextPercent: ctx.getContextUsage?.()?.percent ?? undefined,
      preferNewSession: preferNewSession(ctx),
    });
    if (action === "modify") {
      await editPlan(ctx, store.currentPath);
      continue;
    }
    if (action === "continue") {
      const discussion = await ctx.ui.input(
        "Continue discussing the Plan",
        "Enter feedback or a question",
      );
      if (!discussion?.trim()) continue;
      queuePlanDiscussion(ctx, discussion.trim());
      return { approved: false, exited: false };
    }
    if (action === "close") {
      abortPlanTurn(ctx);
      return { approved: false, exited: false };
    }
    if (action === "exit-plan") {
      exitMode(ctx);
      return { approved: false, exited: true };
    }

    const markdown = latestPlan ?? "";
    try {
      const approved = await store.approve(markdown, latestRevision);
      applyLoadedPlan(approved);
    } catch (error) {
      applyLoadedPlan(await store.load());
      // PlanApprovalError carries whether the draft survived the failed commit, and this
      // was the only consumer that threw that away. A bare "approval failed" reads as
      // "your plan is gone" — the user retypes work that is sitting safely on disk.
      const draftNote = error instanceof PlanApprovalError && error.draftPersisted
        ? ` Your draft is intact at revision ${error.revision}; retry the approval.`
        : "";
      ctx.ui.notify(`Plan approval failed: ${errorMessage(error)}${draftNote}`, "warning");
      return { approved: false, exited: false };
    }

    const executionMode = executionModeFor(action);
    const executionMessage = await startImplementation(
      ctx,
      markdown,
      store.currentPath,
      executionMode,
      handoffDelivery,
    );
    return { approved: true, exited: true, executionMode, executionMessage };
  }
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

async function editPlan(ctx: PlanContext, pathLabel: string): Promise<void> {
  await openPlanEditor(ctx, {
    markdown: latestPlan ?? "",
    revision: latestRevision,
    allowConfirm: false,
    pathLabel,
    async onSave(markdown, expectedRevision) {
      const saved = await savePlan(ctx, markdown, expectedRevision);
      return saved.manifest.revision;
    },
    async onConfirm() {},
  });
}

function executionModeFor(action: PlanConfirmationAction): PlanExecutionMode {
  if (action === "execute-clear") return "clear";
  if (action === "execute-compact") return "compact";
  return "current";
}

async function executeNewSessionHandoff(
  newSessionFn: NonNullable<ExtensionCommandContext["newSession"]>,
  ctx: PlanContext,
  markdown: string,
  planPath: string,
  handoffKey: string | undefined,
  portableMessage: string,
): Promise<void> {
  let switchedToReplacement = false;
  try {
    const replacement = await newSessionFn({
      async withSession(newCtx) {
        switchedToReplacement = true;
        const replacementCtx = newCtx as PlanContext;
        try {
          if (!handoffKey) throw new Error("approved Plan is missing its handoff key");
          const replacementStore = await ensureStore(replacementCtx);
          applyLoadedPlan(await replacementStore.approve(markdown, undefined, handoffKey));
        } catch (error) {
          try {
            await enterPlanMode(replacementCtx);
          } catch {
            mode = "plan";
            latestPlan = markdown;
            latestRevision = 0;
            latestStatus = "draft";
            latestHandoffKey = undefined;
            awaitingAction = false;
            activatePlanToolSurface();
            syncModeStatus(replacementCtx);
          }
          replacementCtx.ui.notify(
            `Replacement session Plan handoff failed closed in Plan mode: ${errorMessage(error)}`,
            "error",
          );
          return;
        }
        try {
          await (newCtx as { sendUserMessage(msg: string): Promise<void> }).sendUserMessage(portableMessage);
        } catch (error) {
          replacementCtx.ui.notify(
            `Replacement session holds the approved Plan, but its execution prompt could not be delivered: ${errorMessage(error)}`,
            "error",
          );
        }
      },
    });
    if (!replacement.cancelled || switchedToReplacement) return;
    applyLoadedPlan(await (await ensureStore(ctx)).load());
    ctx.ui.notify("New session was cancelled; executing in the current context.", "warning");
  } catch (error) {
    if (switchedToReplacement) return;
    try {
      applyLoadedPlan(await (await ensureStore(ctx)).load());
    } catch {
      // Preserve the original replacement failure; the still-persisted source approval reloads on restart.
    }
    ctx.ui.notify(`New session failed; executing in the current context: ${errorMessage(error)}`, "warning");
  }
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
  markdown: string,
  planPath: string,
  executionMode: PlanExecutionMode,
  handoffDelivery: PlanHandoffDelivery,
): Promise<string | undefined> {
  exitPlanMode(ctx);
  latestPlan = markdown;
  latestStatus = "approved";
  ctx.ui.notify("Plan approved · Act mode active", "info");
  const executionMessage = [
    "The approved Plan is already in the current context.",
    `Plan source: ${planPath}`,
    "Before modifying the project:",
    "1. Reconcile the Plan with every user requirement; do not shrink or reinterpret the approved scope.",
    "2. Decompose the Plan into an ordered Todo dependency graph before implementation.",
    // The handoff key only ever arrives through the model: nothing injects it into the
    // todo/goal tool inputs. Telling the model the key here is what makes
    // getPlanHandoffStatus report on real work instead of sitting at "todo-required"
    // forever.
    ...(latestHandoffKey
      ? [`   Pass planHandoffKey: "${latestHandoffKey}" on those todo create calls so they are bound to this approval.`]
      : []),
    "3. Attach a Goal as the quality gate only to key Todos that carry verifiable acceptance criteria; do NOT create a Goal for every Todo. Goals are flat and time-ordered — put the overall acceptance Goal on the last Todo when an overall sign-off is needed.",
    "4. Prefer the teammate tool to delegate independent Todo work; use direct execution only when delegation would not help.",
    "5. Execute the Todo sequence; activating a Todo auto-switches to its quality-gate Goal, and a Todo completes only after its Goal verifies.",
  ].join("\n");
  const portableMessage = [
    "Execute this approved Plan in the new session:",
    `Plan source: ${planPath}`,
    "",
    markdown,
    "",
    executionMessage,
  ].join("\n");

  if (executionMode === "clear") {
    if (ctx.newSession) {
      await executeNewSessionHandoff(ctx.newSession, ctx, markdown, planPath, latestHandoffKey, portableMessage);
      return;
    }

    const lease = compactionArbiter?.request("plan-handoff", {
      owner: "plan-handoff",
      reason: "clean-context",
    });
    if (compactionArbiter && !lease) {
      ctx.ui.notify("Compaction is already in progress; executing with the current context.", "warning");
      if (handoffDelivery === "tool-result") return executionMessage;
      sendImplementationMessage(ctx, executionMessage);
      return;
    }

    const cleanContextSummary = [
      "# Approved Plan Execution Context",
      "",
      "The prior conversation was intentionally cleared after explicit user approval.",
      "Only this approved Plan and its execution contract remain authoritative.",
      `Plan source: ${planPath}`,
      "",
      markdown,
      "",
      executionMessage,
    ].join("\n");
    const handoffRequest = beginPlanHandoff();
    pendingCleanContextCompaction = {
      summary: cleanContextSummary,
      firstKeptEntryId: `maestro-plan-clean-${latestHandoffKey ?? "approved"}`,
      ...handoffRequest,
    };

    let settled = false;
    const settleCurrentRequest = (): boolean => {
      if (settled) return false;
      settled = true;
      lease?.release();
      return finishPlanHandoff(handoffRequest);
    };
    const handleResetFailure = (error: unknown) => {
      if (!settleCurrentRequest()) return;
      if (canReplaceContextAfterCompactionFailure(error)) {
        activatePlanContextReplacement(cleanContextSummary);
        ctx.ui.notify("Native compaction was unavailable; using a clean Plan context in this session.", "info");
        sendImplementationMessage(ctx, executionMessage);
        return;
      }
      ctx.ui.notify(`Context reset failed; executing with the current context: ${errorMessage(error)}`, "warning");
      sendImplementationMessage(ctx, executionMessage);
    };
    ctx.ui.notify("Resetting context with the approved Plan preserved…", "info");
    try {
      ctx.compact({
        customInstructions: lease?.tagInstructions(PLAN_CLEAN_CONTEXT_COMPACTION_MARKER)
          ?? PLAN_CLEAN_CONTEXT_COMPACTION_MARKER,
        onComplete() {
          if (!settleCurrentRequest()) return;
          sendImplementationMessage(ctx, executionMessage);
        },
        onError(error) {
          handleResetFailure(error);
        },
      });
    } catch (error) {
      handleResetFailure(error);
    }
    return;
  }

  if (executionMode === "compact") {
    const lease = compactionArbiter?.request("plan-handoff", {
      owner: "plan-handoff",
      reason: "preserve-approved-plan",
    });
    if (compactionArbiter && !lease) {
      ctx.ui.notify("Compaction is already in progress; executing with the current context.", "warning");
      sendImplementationMessage(ctx, executionMessage);
      return;
    }
    const handoffRequest = beginPlanHandoff();
    let delivered = false;
    const deliver = () => {
      if (delivered) return false;
      delivered = true;
      lease?.release();
      if (!finishPlanHandoff(handoffRequest)) return false;
      sendImplementationMessage(ctx, executionMessage);
      return true;
    };
    const compactionInstructions = [
      "Treat the following approved Plan as the authoritative execution contract.",
      `Preserve its source path, locked boundaries, risks, acceptance checks, and current execution position: ${planPath}`,
      "",
      markdown,
    ].join("\n");
    ctx.ui.notify("Compacting context with the approved Plan preserved…", "info");
    try {
      ctx.compact({
        customInstructions: lease?.tagInstructions(compactionInstructions) ?? compactionInstructions,
        onComplete() {
          deliver();
        },
        onError(error) {
          if (isCurrentPlanHandoff(handoffRequest)) {
            ctx.ui.notify(`Compaction failed; executing with the current context: ${error.message}`, "warning");
          }
          deliver();
        },
      });
    } catch (error) {
      if (isCurrentPlanHandoff(handoffRequest)) {
        ctx.ui.notify(`Compaction failed; executing with the current context: ${errorMessage(error)}`, "warning");
      }
      deliver();
    }
    return;
  }

  if (handoffDelivery === "tool-result") return executionMessage;
  sendImplementationMessage(ctx, executionMessage);
}

function sendImplementationMessage(ctx: PlanContext, message: string): void {
  const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
  extensionApi?.sendUserMessage(message, opts);
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
  };
}

/**
 * Detached Plan state for compaction metadata and prompts, mirroring
 * getTodoCompactionSnapshot.
 *
 * Only one-shot notes reach the per-turn prompt (onBeforeAgentStartPlan), so after a
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
): AgentToolResult<PlanToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  } as unknown as AgentToolResult<PlanToolDetails>;
}

function requirePlanMode(action: PlanToolDetails["action"]): AgentToolResult<PlanToolDetails> | undefined {
  if (mode === "plan") return;
  return result(`plan-${action} requires Plan mode. Call plan-enter first.`, {
    ...currentDetails(action),
    error: "E_PLAN_MODE_REQUIRED",
  }, true);
}

export function registerPlanTools(pi: ExtensionAPI): void {
  const enterTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: PLAN_ENTER_TOOL,
    label: "Plan Enter",
    description: "Enter durable Plan mode and load this chat session's current.md draft.",
    promptSnippet: "Use plan-enter before producing or editing an implementation Plan.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (mode !== "plan") await enterPlanMode(ctx);
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
      const blocked = requirePlanMode("update");
      if (blocked) return blocked;
      try {
        const saved = await savePlan(ctx, params.markdown, params.expectedRevision ?? latestRevision);
        return result(`Plan draft saved at revision ${saved.manifest.revision}.`, currentDetails("update"));
      } catch (error) {
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
    label: "Plan Review",
    description: "Open the full-screen editable Markdown draft in an interactive UI. Save or cancel without entering Act mode.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("review");
      if (blocked) return blocked;
      await reviewPlan(ctx, false);
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
    description: "Present the Markdown Plan in an interactive UI with choices to execute, modify, discuss, or exit. The user always decides. Call in the same turn as plan-update when the draft is decision-complete.",
    promptSnippet: "Standard presentation step after plan-update. Renders the plan and gives the user full control over next steps.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("confirm");
      if (blocked) return blocked;
      const outcome = await reviewPlan(ctx, true, "tool-result");
      onPlanModeChanged?.(ctx);
      const summary = outcome.approved
        ? `Plan approved; Act mode restored (${outcome.executionMode ?? "current"} context).`
        : outcome.exited
          ? buildPlanExitMessage()
        : "Plan not approved; Plan mode remains active.";
      const text = outcome.executionMessage
        ? `${summary}\n\n${outcome.executionMessage}`
        : summary;
      return result(text, {
        ...currentDetails("confirm"),
        approved: outcome.approved,
      });
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

  const exitTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-exit",
    label: "Plan Exit",
    description: "Exit Plan mode without deleting the persisted draft and return to Act mode.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("exit");
      if (blocked) return blocked;
      exitMode(ctx);
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
    async execute() {
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

  for (const tool of [enterTool, updateTool, reviewTool, confirmTool, exitTool, statusTool]) {
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
    "Plan mode was activated (via user toggle or plan-enter). The tool surface is UNCHANGED —",
    "mutating it mid-session would invalidate the cached prompt prefix, so plan mode is advisory:",
    "- Do NOT edit files. Edit, Write, and NotebookEdit are still callable but are off-limits until",
    "  the plan is approved — treat a call to any of them as a mistake, not as permission.",
    "- Read, search, and exploration tools are the intended tools for this mode.",
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
    "- Use the teammate tool to dispatch the built-in `planner` role for every final Plan, including",
    "  small Plans. Pass it the resolved requirements, evidence, constraints, and user-owned decisions.",
    "  The planner owns the document and may call `analyst` for technical analysis and pressure review,",
    "  `research` for project knowledge or external research, and `explorer` for codebase discovery and",
    "  call-chain tracing. Require the planner to follow its role-level Plan document contract.",
    "  Do not use implementation-capable agents in Plan mode. The root agent owns user interaction,",
    "  evidence spot-checking, contract validation, plan-update, and plan-confirm; persist the returned",
    "  Markdown only after that check, and return incomplete drafts to the same planner for revision",
    "  instead of silently authoring or filling Plan sections itself.",
    "- Run a Socratic pressure review before confirmation: challenge assumptions, contradictions,",
    "  boundaries, failure cases, and integration effects with concrete code evidence.",
    "- Use ask-user-question for every user question. Ask 2-4 related questions per call, grouped by",
    "  one review branch; do not ask questions as plain assistant text.",
    "- Keep reviewing until scope, boundaries, non-goals, requirements, and acceptance checks are",
    "  explicitly locked; unresolved risks must stay visible.",
    "- Keep the final Markdown decision-complete and directly consumable by an execution agent. Omit",
    "  interview logs, delegate transcripts, and generic boilerplate. Validate the planner's draft",
    "  against the planner role contract before persisting it; return incomplete drafts for revision.",
    "- Approval decomposes the locked Plan into an ordered Todo graph; attach Goals as",
    "  quality gates to key Todos (overall acceptance Goal last) before implementation.",
    "",
    "This is a one-time notification. Subsequent turns will not modify the system prompt for plan mode,",
    "and nothing else will re-announce the mode — this reminder is the only signal you get.",
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
      const trimmed = args.trim();
      const command = trimmed.toLowerCase();
      if (command === "exit" || command === "off") {
        if (isPlanMode()) {
          exitMode(ctx);
        } else {
          ctx.ui.notify("Act mode · draft preserved", "info");
        }
        return;
      }
      if (command === "show") {
        if (!isPlanMode()) await enterPlanMode(ctx);
        await reviewPlan(ctx, false);
        return;
      }
      if (command === "approve") {
        if (!isPlanMode()) await enterPlanMode(ctx);
        if (!hasPlan()) {
          ctx.ui.notify("No Plan draft to approve.", "warning");
          return;
        }
        await reviewPlan(ctx, true);
        onPlanModeChanged?.(ctx);
        return;
      }
      if (command === "clear") {
        if (!isPlanMode()) await enterPlanMode(ctx);
        await savePlan(ctx, "", latestRevision);
        ctx.ui.notify("Plan draft cleared.", "info");
        return;
      }
      if (command === "tools") {
        ctx.ui.notify(isPlanMode() ? PLAN_MODE_TOOL_NAMES.join(", ") : PLAN_ENTER_TOOL, "info");
        return;
      }
      if (trimmed) {
        if (!isPlanMode()) await enterPlanMode(ctx);
        if (ctx.isIdle?.() === false) {
          ctx.ui.notify("Plan mode active. Planning prompt was not queued because the agent is still busy.", "warning");
          return;
        }
        extensionApi?.sendUserMessage(trimmed);
        return;
      }
      await toggleMode(ctx);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
