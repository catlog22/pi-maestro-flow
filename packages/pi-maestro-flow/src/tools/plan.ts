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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { altKey } from "../key-labels.ts";
import { openPlanConfirmation, type PlanConfirmationAction } from "./plan-confirm.ts";
import { openPlanEditor } from "./plan-editor.ts";
import { PlanStore, prewarmProcessIdentity, type LoadedPlan, type PlanSessionIdentity } from "./plan-store.ts";
import { getActiveGoal, getGoalList } from "./goal.ts";
import { getVisibleTasks } from "./todo.ts";
import {
  type CompactionArbiter,
} from "../compaction/compaction-arbiter.ts";

type Mode = "act" | "plan";
type PlanExecutionMode = "current" | "clear" | "compact";
export type PlanHandoffStatus = "none" | "todo-required" | "ready";
export type PlanContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "isIdle" | "sessionManager" | "compact"
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

interface PlanRuntimeOptions {
  storeFactory?: (cwd: string, session: PlanSessionIdentity) => PlanStore;
  activeGoalHandoffKey?: () => string | undefined;
  pausedGoalHandoffKey?: () => string | undefined;
  hasExecutableTodo?: (handoffKey: string) => boolean;
  compactionArbiter?: CompactionArbiter;
}

const STATUS_KEY = "mode";
export const PLAN_TOGGLE_KEY = "alt+p";
export const PLAN_TOGGLE_LABEL = altKey("P");
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
let activeGoalHandoffKey = () => {
  const current = getActiveGoal();
  if (current?.status === "active" && current.planHandoffKey) return current.planHandoffKey;
  const bound = getGoalList().find((goal) => goal.planHandoffKey && goal.status !== "paused");
  return bound?.planHandoffKey;
};
let pausedGoalHandoffKey = () => {
  const goal = getActiveGoal();
  return goal?.status === "paused" ? goal.planHandoffKey : undefined;
};
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
  activeGoalHandoffKey = options.activeGoalHandoffKey ?? (() => {
    const current = getActiveGoal();
    if (current?.status === "active" && current.planHandoffKey) return current.planHandoffKey;
    const bound = getGoalList().find((goal) => goal.planHandoffKey && goal.status !== "paused");
    return bound?.planHandoffKey;
  });
  pausedGoalHandoffKey = options.pausedGoalHandoffKey ?? (() => {
    const goal = getActiveGoal();
    return goal?.status === "paused" ? goal.planHandoffKey : undefined;
  });
  hasExecutableTodoForHandoff = options.hasExecutableTodo ?? ((handoffKey) => getVisibleTasks().some((task) =>
    task.planHandoffKey === handoffKey
    && (task.status === "pending" || task.status === "in_progress")
    && task.blockedBy.length === 0
  ));
  compactionArbiter = options.compactionArbiter;
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
    onPlanModeChanged?.(ctx);
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
}

export function onCompactPlan(ctx: PlanContext): void {
  syncModeStatus(ctx);
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
  if (mode !== "plan") return;
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
      canClearContext: typeof ctx.newSession === "function",
      canCompactContext: handoffDelivery !== "tool-result",
      // ContextUsage.percent is number | null; the overlay treats "unknown" as
      // absent, so collapse null into undefined rather than widening its type.
      contextPercent: ctx.getContextUsage?.()?.percent ?? undefined,
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
      ctx.ui.notify(`Plan approval failed: ${errorMessage(error)}`, "warning");
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

  if (executionMode === "clear" && ctx.newSession) {
    const sourceHandoffKey = latestHandoffKey;
    let switchedToReplacement = false;
    try {
      const replacement = await ctx.newSession({
        async withSession(newCtx) {
          switchedToReplacement = true;
          const replacementCtx = newCtx as PlanContext;
          try {
            if (!sourceHandoffKey) throw new Error("approved Plan is missing its handoff key");
            const replacementStore = await ensureStore(replacementCtx);
            applyLoadedPlan(await replacementStore.approve(markdown, undefined, sourceHandoffKey));
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
            await newCtx.sendUserMessage(portableMessage);
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

  if (executionMode === "compact") {
    let delivered = false;
    const deliver = () => {
      if (delivered) return;
      delivered = true;
      sendImplementationMessage(ctx, executionMessage);
    };
    const lease = compactionArbiter?.request("plan-handoff");
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
    try {
      ctx.compact({
        customInstructions: lease?.tagInstructions(compactionInstructions) ?? compactionInstructions,
        onComplete() {
          lease?.release();
          deliver();
        },
        onError(error) {
          lease?.release();
          ctx.ui.notify(`Compaction failed; executing with the current context: ${error.message}`, "warning");
          deliver();
        },
      });
    } catch (error) {
      lease?.release();
      ctx.ui.notify(`Compaction failed; executing with the current context: ${errorMessage(error)}`, "warning");
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
    description: "Enter durable Plan mode, load this chat session's current.md draft, and activate Plan-only tools.",
    promptSnippet: "Use plan-enter before producing or editing an implementation Plan.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (mode !== "plan") await enterPlanMode(ctx);
      return result(`Plan mode active. Draft: ${currentStore?.currentPath ?? ""}`, currentDetails("enter"));
    },
    renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("plan enter")), 0, 0); },
  };

  const updateTool: ToolDefinition<typeof PlanUpdateParams, PlanToolDetails> = {
    name: "plan-update",
    label: "Plan Update",
    description: "Replace this chat session's current.md draft with complete Markdown using optional revision checking.",
    promptSnippet: "Use plan-update to persist the decision-complete Markdown Plan before review.",
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
  };

  const reviewTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-review",
    label: "Plan Review",
    description: "Open the full-screen editable Markdown draft. Save or cancel without entering Act mode.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("review");
      if (blocked) return blocked;
      await reviewPlan(ctx, false);
      return result("Plan review closed; Plan mode remains active.", currentDetails("review"));
    },
  };

  const confirmTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-confirm",
    label: "Plan Confirm",
    description: "Present the Markdown Plan to the user with choices: execute, modify, discuss, or exit. Does not force execution — the user always decides. Call in the same turn as plan-update when the draft is decision-complete.",
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
  };

  const exitTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-exit",
    label: "Plan Exit",
    description: "Exit Plan mode without deleting the persisted draft and restore the exact prior active tool set.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("exit");
      if (blocked) return blocked;
      exitMode(ctx);
      return result(buildPlanExitMessage(), currentDetails("exit"));
    },
  };

  const statusTool: ToolDefinition<typeof EmptyPlanParams, PlanToolDetails> = {
    name: "plan-status",
    label: "Plan Status",
    description: "Return current Plan mode, draft path, revision and approval status.",
    parameters: EmptyPlanParams,
    async execute() {
      const blocked = requirePlanMode("status");
      if (blocked) return blocked;
      const details = currentDetails("status");
      return result(`${details.mode} · ${details.status} · r${details.revision} · ${details.sessionId} · ${details.path}`, details);
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
    "- Run a Socratic pressure review before confirmation: challenge assumptions, contradictions,",
    "  boundaries, failure cases, and integration effects with concrete code evidence.",
    "- Use ask-user-question for every user question. Ask 2-4 related questions per call, grouped by",
    "  one review branch; do not ask questions as plain assistant text.",
    "- Keep reviewing until scope, boundaries, non-goals, requirements, and acceptance checks are",
    "  explicitly locked; unresolved risks must stay visible.",
    "- Keep the final Markdown to locked scope, boundaries, decisions, ordered outcomes, risks, and",
    "  acceptance checks; omit interview logs and boilerplate.",
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
