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
import { openPlanConfirmation, type PlanConfirmationAction } from "./plan-confirm.ts";
import { openPlanEditor } from "./plan-editor.ts";
import { PlanStore, type LoadedPlan, type PlanSessionIdentity } from "./plan-store.ts";
import { blockIntelligenceToolCallInPlan } from "./intelligence-safety.ts";
import { RUN_CONTROL_READ_ACTIONS } from "./run-control.ts";
import { getActiveGoal } from "./goal.ts";
import { getVisibleTasks } from "./todo.ts";

type Mode = "act" | "plan";
type PlanExecutionMode = "current" | "clear" | "compact";
export type PlanHandoffStatus = "none" | "goal-required" | "todo-required" | "ready";
export type PlanContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui" | "isIdle" | "sessionManager" | "compact"
> & Partial<Pick<ExtensionCommandContext, "newSession">>;

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
  hasExecutableTodo?: (handoffKey: string) => boolean;
}

const STATUS_KEY = "mode";
export const PLAN_TOGGLE_KEY = "alt+p";
export const PLAN_TOGGLE_LABEL = "Alt+P";
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

const BLOCKED_BUILTIN_TOOLS = new Set([
  "Edit", "Write", "NotebookEdit", "edit", "write", "notebook_edit",
]);

const SHELL_COMMAND_BOUNDARY = String.raw`(?:^|[\r\n;|&{(]|\$\(|<\()\s*`;
const FILE_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd)\b`,
  "i",
);
const POWERSHELL_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}(?:Set-Content|Add-Content|Clear-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item)\b`,
  "i",
);
const PACKAGE_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}(?:npm\s+(?:install|uninstall|update|ci|link|publish|version)|yarn\s+(?:add|remove|install|publish|upgrade)|pnpm\s+(?:add|remove|install|publish|update)|bun\s+(?:add|remove|install|update|publish)|pip\s+(?:install|uninstall))\b`,
  "i",
);
const GIT_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}git\s+(?:add|apply|clean|commit|push|pull|merge|rebase|reset|restore|checkout|switch|stash|cherry-pick|revert|init|clone)\b`,
  "i",
);
const MAESTRO_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}maestro\s+(?:install|uninstall|update)\b`,
  "i",
);
const MAESTRO_RUN_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}maestro\s+run\s+(?:next|create|check|complete|decide|seal-session|advance|pause|resume|retry|cancel)\b`,
  "i",
);
const MAESTRO_SESSION_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}maestro\s+session\s+(?:create|chain|migrate|meta)\b`,
  "i",
);
const IN_PLACE_EDIT_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}(?:sed|perl)\b[^\r\n;|&]*\s-[a-z]*i(?:[a-z]*|\.[^\s]+)?(?:\s|$)`,
  "i",
);
const NESTED_MUTATING_COMMAND = /(?:^|\s)-(?:exec|execdir|x|X)\s+(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd)\b/i;
const INTERPRETER_PATH_PREFIX = String.raw`(?:[^\s;|&()]+[\\/])*`;
const INTERPRETER_WRAPPER_PREFIX = String.raw`(?:sudo\s+)?(?:(?:env|command)\s+)?${INTERPRETER_PATH_PREFIX}`;
const SHELL_INTERPRETER = String.raw`(?:ba|z|da|k)?sh(?:\.exe)?`;
const NESTED_INTERPRETER_COMMAND = new RegExp([
  String.raw`${SHELL_COMMAND_BOUNDARY}${INTERPRETER_WRAPPER_PREFIX}${SHELL_INTERPRETER}\b[^\r\n;|&]*\s-(?:c|lc)\b`,
  String.raw`${SHELL_COMMAND_BOUNDARY}${INTERPRETER_WRAPPER_PREFIX}(?:powershell|pwsh)(?:\.exe)?\b[^\r\n;|&]*\s-(?:c|command|encodedcommand)\b`,
  String.raw`${SHELL_COMMAND_BOUNDARY}${INTERPRETER_WRAPPER_PREFIX}cmd(?:\.exe)?\b[^\r\n;|&]*\/(?:c|k)\b`,
  String.raw`${SHELL_COMMAND_BOUNDARY}${INTERPRETER_WRAPPER_PREFIX}(?:node|deno|bun)(?:\.exe)?\b[^\r\n;|&]*\s(?:-e|--eval)\b`,
  String.raw`${SHELL_COMMAND_BOUNDARY}${INTERPRETER_WRAPPER_PREFIX}(?:python\d*(?:\.\d+)?|perl|ruby)(?:\.exe)?\b[^\r\n;|&]*\s-(?:c|e)\b`,
  String.raw`${SHELL_COMMAND_BOUNDARY}xargs\b[^\r\n;|&]*\s+${INTERPRETER_PATH_PREFIX}${SHELL_INTERPRETER}\b[^\r\n;|&]*\s-(?:c|lc)\b`,
  String.raw`(?:^|\s)-(?:exec|execdir)\s+${INTERPRETER_PATH_PREFIX}${SHELL_INTERPRETER}\b[^\r\n;|&]*\s-(?:c|lc)\b`,
].join("|"), "i");
const MUTATING_BASH_PATTERNS = [
  FILE_MUTATING_COMMAND,
  POWERSHELL_MUTATING_COMMAND,
  PACKAGE_MUTATING_COMMAND,
  GIT_MUTATING_COMMAND,
  MAESTRO_MUTATING_COMMAND,
  MAESTRO_RUN_MUTATING_COMMAND,
  MAESTRO_SESSION_MUTATING_COMMAND,
  IN_PLACE_EDIT_COMMAND,
  NESTED_MUTATING_COMMAND,
  NESTED_INTERPRETER_COMMAND,
];

const SHELL_SIDE_EFFECT_ARGUMENTS = /(?:^|\s)(?:--output(?:=|\s)|--outfile(?:=|\s)|-OutFile(?:\s|$)|--in-place(?:=|\s|$)|--exec(?:=|\s|$)|--exec-batch(?:=|\s|$)|--ext-diff(?:\s|$)|--textconv(?:\s|$)|--open-files-in-pager(?:=|\s|$)|--pre(?:=|\s|$)|--fix(?:\s|$))/i;

const PlanEnterParams = Type.Object({
  prompt: Type.Optional(Type.String({ description: "Optional planning request to queue after entering Plan mode" })),
});
const PlanUpdateParams = Type.Object({
  markdown: Type.String({ description: "Complete Markdown text for current.md" }),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
});
const EmptyPlanParams = Type.Object({});

let mode: Mode = "act";
let extensionApi: ExtensionAPI | undefined;
let storeFactory: (cwd: string, session: PlanSessionIdentity) => PlanStore = (cwd, session) => new PlanStore(cwd, { session });
let currentStore: PlanStore | undefined;
let currentStoreKey = "";
let latestPlan: string | undefined;
let latestRevision = 0;
let latestStatus: PlanToolDetails["status"] = "empty";
let latestHandoffKey: string | undefined;
let awaitingAction = false;
let activeToolsSnapshot: string[] | undefined;
let activeGoalHandoffKey = () => {
  const goal = getActiveGoal();
  return goal?.status === "active" ? goal.planHandoffKey : undefined;
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
  if (extensionApi && activeToolsSnapshot) extensionApi.setActiveTools(activeToolsSnapshot);
  resetRuntimeState();
  extensionApi = pi;
  storeFactory = options.storeFactory ?? ((cwd, session) => new PlanStore(cwd, { session }));
  activeGoalHandoffKey = options.activeGoalHandoffKey ?? (() => {
    const goal = getActiveGoal();
    return goal?.status === "active" ? goal.planHandoffKey : undefined;
  });
  hasExecutableTodoForHandoff = options.hasExecutableTodo ?? ((handoffKey) => getVisibleTasks().some((task) =>
    task.planHandoffKey === handoffKey
    && (task.status === "pending" || task.status === "in_progress")
    && task.blockedBy.length === 0
  ));
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
  const next = active.filter((name) => !ALL_PLAN_TOOL_NAMES.has(name));
  if (!next.includes(PLAN_ENTER_TOOL)) next.push(PLAN_ENTER_TOOL);
  extensionApi.setActiveTools(next);
}

function activatePlanToolSurface(): void {
  if (!extensionApi) return;
  if (!activeToolsSnapshot) activeToolsSnapshot = [...extensionApi.getActiveTools()];
  const nonEditing = activeToolsSnapshot.filter((name) => !BLOCKED_BUILTIN_TOOLS.has(name) && name !== PLAN_ENTER_TOOL);
  extensionApi.setActiveTools([...new Set([...nonEditing, ...PLAN_MODE_TOOL_NAMES])]);
}

function restoreActToolSurface(): void {
  if (!extensionApi) return;
  if (activeToolsSnapshot) {
    extensionApi.setActiveTools(activeToolsSnapshot);
    activeToolsSnapshot = undefined;
    return;
  }
  ensureActToolSurface();
}

async function enterPlanMode(ctx: PlanContext): Promise<void> {
  const store = await ensureStore(ctx);
  applyLoadedPlan(await store.load());
  mode = "plan";
  activatePlanToolSurface();
  syncModeStatus(ctx);
  ctx.ui.notify(`Plan mode · ${store.currentPath}`, "info");
}

function exitPlanMode(ctx: PlanContext): void {
  mode = "act";
  restoreActToolSurface();
  syncModeStatus(ctx);
}

export async function toggleMode(ctx: PlanContext): Promise<Mode> {
  if (mode === "act") {
    await enterPlanMode(ctx);
    return mode;
  }
  if (hasPlan() && ctx.hasUI !== false) {
    const outcome = await reviewPlan(ctx, true);
    if (!outcome.approved && !outcome.exited) ctx.ui.notify("Staying in Plan mode", "info");
    return mode;
  }
  exitPlanMode(ctx);
  ctx.ui.notify("Act mode · draft preserved", "info");
  return mode;
}

export async function onSessionStartPlan(ctx: PlanContext): Promise<void> {
  restoreActToolSurface();
  resetRuntimeState();
  ensureActToolSurface();
  syncModeStatus(ctx);
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
  activeToolsSnapshot = undefined;
}

export function onCompactPlan(ctx: PlanContext): void {
  syncModeStatus(ctx);
}

export function onBeforeAgentStartPlan(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
  if (mode !== "plan") return;
  return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}` };
}

export function onToolCallPlan(event: {
  toolName: string;
  input: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
  if (mode !== "plan") return blockApprovedHandoffWrite(event);
  return blockMutatingToolCall(event, "Plan mode");
}

function blockApprovedHandoffWrite(event: {
  toolName: string;
  input: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
  if (!awaitingAction) return;
  const handoffStatus = getPlanHandoffStatus();
  if (handoffStatus === "ready") {
    awaitingAction = false;
    return;
  }
  const action = typeof event.input?.action === "string" ? event.input.action : "";
  if (event.toolName === "goal") {
    if (action === "get") return;
    if (action === "create" && handoffStatus === "goal-required" && latestHandoffKey) {
      event.input.planHandoffKey = latestHandoffKey;
      return;
    }
    return {
      block: true,
      reason: `Approved Plan handoff is ${handoffStatus}. Read the Goal or create the one active Goal before other Goal mutations.`,
    };
  }
  if (event.toolName === "todo") {
    if (action === "list" || action === "get") return;
    if (action === "create" && handoffStatus === "todo-required" && latestHandoffKey) {
      event.input.planHandoffKey = latestHandoffKey;
      return;
    }
    return {
      block: true,
      reason: handoffStatus === "goal-required"
        ? "Approved Plan handoff requires one active Goal before creating its Todo dependency graph."
        : "Approved Plan handoff requires at least one executable Todo before other Todo mutations.",
    };
  }
  return blockMutatingToolCall(event, "Approved Plan handoff");
}

function blockMutatingToolCall(event: {
  toolName: string;
  input: Record<string, unknown>;
}, boundary: "Plan mode" | "Approved Plan handoff"): { block: true; reason: string } | undefined {
  const name = event.toolName;
  if (BLOCKED_BUILTIN_TOOLS.has(name)) {
    return { block: true, reason: `${boundary} blocks "${name}" until its required state is complete.` };
  }
  if (name === "maestro" && event.input?.action === "delegate" && event.input?.mode !== "analysis") {
    return { block: true, reason: `${boundary} requires delegate mode='analysis'; missing or write modes are blocked.` };
  }
  if (name === "run-control" || name === "run_control") {
    const action = typeof event.input?.action === "string" ? event.input.action : "";
    if (!(RUN_CONTROL_READ_ACTIONS as ReadonlySet<string>).has(action)) {
      return { block: true, reason: `${boundary} blocks run-control action "${action || "unknown"}" because it may change canonical Run state.` };
    }
  }
  const intelligenceBlock = blockIntelligenceToolCallInPlan(event);
  if (intelligenceBlock) {
    return boundary === "Plan mode"
      ? intelligenceBlock
      : { block: true, reason: `${boundary} is incomplete. ${intelligenceBlock.reason}` };
  }
  if (["bash", "Bash", "powershell", "PowerShell"].includes(name)) {
    const command = readCommand(event.input);
    const dialect = name.toLowerCase() === "powershell" ? "powershell" : "posix";
    if (!command || !isSafeCommand(command, dialect)) {
      return { block: true, reason: `${boundary} blocks commands that may modify files or repository state.\nCommand: ${command.slice(0, 120)}` };
    }
  }
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
    });
    if (action === "modify") {
      await editPlan(ctx, store.currentPath);
      continue;
    }
    if (action === "cancel") {
      exitPlanMode(ctx);
      ctx.ui.notify("Act mode · Plan draft preserved without approval", "info");
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
  awaitingAction = true;
  ctx.ui.notify("Plan approved · Goal/Todo handoff required before project writes", "info");
  const executionMessage = [
    "The approved Plan is already in the current context. Read tools are available; project writes remain gated until the Goal/Todo handoff is ready.",
    `Plan source: ${planPath}`,
    "Before modifying the project:",
    "1. Reconcile the Plan with every user requirement; do not shrink or reinterpret the approved scope.",
    "2. Convert the approved Plan into one active Goal with a concise objective that preserves its locked boundaries and acceptance checks.",
    "3. Decompose that Goal into an ordered Todo dependency graph before implementation.",
    "4. Execute the Todo sequence under the active Goal, verifying each outcome before proceeding.",
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
              `Replacement session is write-gated, but its execution prompt could not be delivered: ${errorMessage(error)}`,
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
    ctx.ui.notify("Compacting context with the approved Plan preserved…", "info");
    ctx.compact({
      customInstructions: [
        "Treat the following approved Plan as the authoritative execution contract.",
        `Preserve its source path, locked boundaries, risks, acceptance checks, and current execution position: ${planPath}`,
        "",
        markdown,
      ].join("\n"),
      onComplete: deliver,
      onError(error) {
        ctx.ui.notify(`Compaction failed; executing with the current context: ${error.message}`, "warning");
        deliver();
      },
    });
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
  if (!awaitingAction) return latestStatus === "approved" ? "ready" : "none";
  if (!latestHandoffKey || activeGoalHandoffKey() !== latestHandoffKey) return "goal-required";
  if (!hasExecutableTodoForHandoff(latestHandoffKey)) return "todo-required";
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
  const enterTool: ToolDefinition<typeof PlanEnterParams, PlanToolDetails> = {
    name: PLAN_ENTER_TOOL,
    label: "Plan Enter",
    description: "Enter durable Plan mode, load this chat session's current.md draft, and activate Plan-only tools.",
    promptSnippet: "Use plan-enter before producing or editing an implementation Plan.",
    parameters: PlanEnterParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (mode !== "plan") await enterPlanMode(ctx);
      if (params.prompt) {
        const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
        extensionApi?.sendUserMessage(params.prompt, opts);
      }
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
    description: "Render the Markdown Plan and choose how to execute, modify, or exit. Approval commits the archive before Act mode.",
    promptSnippet: "Use plan-confirm only after plan-update has produced a decision-complete draft.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("confirm");
      if (blocked) return blocked;
      const outcome = await reviewPlan(ctx, true, "tool-result");
      const summary = outcome.approved
        ? `Plan approved; Act mode restored (${outcome.executionMode ?? "current"} context).`
        : outcome.exited
          ? "Plan confirmation cancelled; Act mode restored and draft preserved."
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
      exitPlanMode(ctx);
      ctx.ui.notify("Act mode · draft preserved", "info");
      return result("Plan mode exited; draft preserved.", currentDetails("exit"));
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

function readCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.cmd === "string") return record.cmd;
  return "";
}

function executableShellSyntax(
  command: string,
  dialect: "posix" | "powershell",
): { syntax: string; balanced: boolean } {
  const syntax = command.split("");
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      syntax[index] = " ";
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        syntax[index] = " ";
        quote = undefined;
        continue;
      }
      if (dialect === "posix" && char === "\\" && /[$`"\\\r\n]/.test(command[index + 1] ?? "")) {
        syntax[index] = " ";
        if (index + 1 < command.length) syntax[++index] = " ";
        continue;
      }
      if (dialect === "powershell" && char === "`") {
        syntax[index] = " ";
        if (index + 1 < command.length) syntax[++index] = " ";
        continue;
      }
      if (char === "$" && command[index + 1] === "(") {
        syntax[index] = "$";
        syntax[++index] = "(";
        continue;
      }
      syntax[index] = dialect === "posix" && char === "`" ? "`" : " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      syntax[index] = " ";
      continue;
    }
    if (dialect === "posix" && char === "\\") {
      syntax[index] = " ";
      if (index + 1 < command.length) syntax[++index] = " ";
      continue;
    }
    if (dialect === "powershell" && char === "`") {
      syntax[index] = " ";
      if (index + 1 < command.length) syntax[++index] = " ";
    }
  }
  return { syntax: syntax.join(""), balanced: quote === undefined };
}

function tokenizeShellCommands(command: string, dialect: "posix" | "powershell"): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const flushToken = () => {
    if (token) tokens.push(token);
    token = "";
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      const escape = dialect === "posix" ? "\\" : "`";
      if (char === escape && quote === '"' && index + 1 < command.length) {
        token += command[++index];
        continue;
      }
      token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const escape = dialect === "posix" ? "\\" : "`";
    if (char === escape && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    if (";|&(){}".includes(char)) {
      flushSegment();
      if (command[index + 1] === char) index++;
      continue;
    }
    token += char;
  }
  flushSegment();
  return segments;
}

const DIRECT_MUTATING_EXECUTABLES = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "tee", "truncate", "dd",
  "set-content", "add-content", "clear-content", "out-file", "remove-item", "move-item", "copy-item", "new-item", "rename-item",
  "eval", "source", ".", "invoke-expression", "iex",
]);

function executableBasename(token: string): string {
  return token.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function unwrapCommand(tokens: string[]): { executable: string; args: string[] } | undefined {
  let index = 0;
  for (let depth = 0; depth < 6 && index < tokens.length; depth++) {
    const executable = executableBasename(tokens[index]);
    if (executable === "env" || executable === "env.exe") {
      index++;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_]\w*=/.test(tokens[index]))) index++;
      continue;
    }
    if (executable === "command") {
      index++;
      if (["-v", "-V"].includes(tokens[index] ?? "")) return undefined;
      while (["-p", "--"].includes(tokens[index] ?? "")) index++;
      continue;
    }
    if (executable === "sudo" || executable === "sudo.exe") {
      index++;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index++].split("=", 1)[0].toLowerCase();
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-c", "--close-from"].includes(option)
          && index < tokens.length && !tokens[index - 1].includes("=")) index++;
      }
      continue;
    }
    return { executable, args: tokens.slice(index + 1) };
  }
  return undefined;
}

function hasUnsafeCommandLaunch(command: string, dialect: "posix" | "powershell"): boolean {
  for (const segment of tokenizeShellCommands(command, dialect)) {
    const launch = unwrapCommand(segment);
    if (!launch) continue;
    const { executable, args } = launch;
    if (DIRECT_MUTATING_EXECUTABLES.has(executable)) return true;
    if (/^(?:(?:ba|z|da|k)?sh)(?:\.exe)?$/.test(executable)
      && args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return true;
    if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)
      && args.some((arg) => /^-(?:c|command|encodedcommand)$/i.test(arg))) return true;
    if (/^cmd(?:\.exe)?$/.test(executable)
      && args.some((arg) => /^\/(?:c|k)$/i.test(arg))) return true;
    if (/^(?:node|deno|bun)(?:\.exe)?$/.test(executable)
      && args.some((arg) => /^(?:-e|--eval)(?:=|$)/i.test(arg))) return true;
    if (/^(?:python\d*(?:\.\d+)?|perl|ruby)(?:\.exe)?$/.test(executable)
      && args.some((arg) => /^-[A-Za-z]*[ce][A-Za-z]*$/.test(arg))) return true;
    const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (["npm", "yarn", "pnpm", "bun", "pip"].includes(executable)
      && subcommand && ["install", "uninstall", "update", "ci", "link", "publish", "version", "add", "remove", "upgrade"].includes(subcommand)) return true;
    if (executable === "git" && subcommand
      && ["add", "apply", "clean", "commit", "push", "pull", "merge", "rebase", "reset", "restore", "checkout", "switch", "stash", "cherry-pick", "revert", "init", "clone"].includes(subcommand)) return true;
    if (executable === "maestro" && subcommand && ["install", "uninstall", "update"].includes(subcommand)) return true;
  }
  return false;
}

const READ_ONLY_EXECUTABLES = new Set([
  "cat", "cut", "date", "df", "dir", "du", "echo", "fd", "file", "find", "get-childitem",
  "get-content", "get-item", "get-location", "grep", "head", "hostname", "jq", "kill", "ls",
  "measure-object", "printf", "pwd", "readlink", "resolve-path", "rg", "select-string", "sleep",
  "sort", "stat", "tail", "test", "test-path", "tr", "true", "false", "type", "uniq", "wc",
  "where", "which", "whoami", "write-output", "[",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame", "cat-file", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "merge-base",
  "name-rev", "rev-list", "rev-parse", "shortlog", "show", "status",
]);

const READ_ONLY_SCRIPT_PREFIX = /^(?:test|check|lint|typecheck|verify|validate|audit)(?::|$)/i;
const MUTATING_SCRIPT_NAME = /(?:^|:)(?:fix|update|write|generate|prepare|install|publish)(?::|$)/i;
const SAFE_NODE_SCRIPT = /(?:^|[\\/])(?:check|test|lint|verify|validate|audit)[\w.-]*\.(?:[cm]?js|ts)$/i;

function firstSubcommand(args: string[]): { subcommand?: string; rest: string[] } {
  const index = args.findIndex((arg) => !arg.startsWith("-"));
  if (index < 0) return { rest: [] };
  return { subcommand: args[index].toLowerCase(), rest: args.slice(index + 1) };
}

function isReadOnlyGitCommand(args: string[]): boolean {
  const { subcommand, rest } = firstSubcommand(args);
  if (!subcommand) return args.every((arg) => ["--version", "-v", "--help", "-h"].includes(arg));
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "branch") {
    if (rest.length === 0) return true;
    if (rest.length === 1 && ["--show-current", "-a", "-r", "-v", "-vv"].includes(rest[0])) return true;
    return ["--list", "-l"].includes(rest[0])
      && rest.slice(1).every((arg) => !arg.startsWith("-"));
  }
  if (subcommand === "remote") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "-v")) return true;
    if (rest[0] === "show") return rest.length === 2 && !rest[1].startsWith("-");
    if (rest[0] === "get-url") {
      const names = rest.slice(1).filter((arg) => !["--all", "--push"].includes(arg));
      return names.length === 1 && !names[0].startsWith("-");
    }
    return false;
  }
  if (subcommand === "config") {
    return ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope"]
      .includes(rest[0] ?? "");
  }
  if (subcommand === "tag") {
    return rest.length === 0
      || (["--list", "-l"].includes(rest[0]) && rest.slice(1).every((arg) => !arg.startsWith("-")));
  }
  if (subcommand === "worktree") return rest[0] === "list";
  return false;
}

function isReadOnlyMaestroCommand(args: string[]): boolean {
  const { subcommand, rest } = firstSubcommand(args);
  if (!subcommand) return args.every((arg) => ["--version", "-v", "--help", "-h"].includes(arg));
  if (["search", "load", "explore", "help"].includes(subcommand)) return true;
  if (subcommand === "run") return ["prepare", "brief", "status"].includes(rest[0] ?? "");
  if (subcommand === "session") return ["list", "show", "status"].includes(rest[0] ?? "");
  if (subcommand === "spec") return ["health", "history"].includes(rest[0] ?? "");
  if (subcommand === "delegate-config") return rest[0] === "show";
  return rest.includes("--help") || rest.includes("-h");
}

function isReadOnlyPackageCommand(executable: string, args: string[]): boolean {
  const { subcommand, rest } = firstSubcommand(args);
  if (!subcommand) return args.every((arg) => ["--version", "-v", "--help", "-h"].includes(arg));
  if (subcommand === "test") return !args.some((arg) => /^(?:-u|--updateSnapshot|--write)$/i.test(arg));
  if (subcommand === "run") {
    const script = rest[0] ?? "";
    return READ_ONLY_SCRIPT_PREFIX.test(script) && !MUTATING_SCRIPT_NAME.test(script);
  }
  if (subcommand === "audit") return !args.some((arg) => /^(?:--fix|--force)$/i.test(arg));
  if (subcommand === "list" || subcommand === "ls" || subcommand === "why" || subcommand === "outdated") return true;
  return executable === "npm" && ["view", "show", "explain", "query", "prefix", "root"].includes(subcommand);
}

function isReadOnlyNodeCommand(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.every((arg) => ["--version", "-v", "--help", "-h"].includes(arg))) return true;
  if (args[0] === "--test" || args.includes("--test")) {
    return !args.some((arg) => /^(?:-u|--update-snapshots?|--test-update-snapshots?)$/i.test(arg));
  }
  const script = args.find((arg) => !arg.startsWith("-"));
  return Boolean(script && SAFE_NODE_SCRIPT.test(script));
}

function isReadOnlyFindCommand(args: string[]): boolean {
  return !args.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint0?|-fprintf|-fls)$/i.test(arg));
}

function isReadOnlyCommandLaunch(executable: string, args: string[]): boolean {
  if (READ_ONLY_EXECUTABLES.has(executable)) {
    if (executable === "find") return isReadOnlyFindCommand(args);
    if (executable === "sort") return !args.some((arg) => arg === "-o" || arg.startsWith("--output"));
    if (executable === "date") return !args.some((arg) => /^(?:-s|--set)(?:=|$)/i.test(arg));
    if (executable === "hostname") return args.length === 0 || args.every((arg) => arg.startsWith("-"));
    return true;
  }
  if (executable === "git") return isReadOnlyGitCommand(args);
  if (executable === "maestro") return isReadOnlyMaestroCommand(args);
  if (["npm", "yarn", "pnpm", "bun"].includes(executable)) {
    return isReadOnlyPackageCommand(executable, args);
  }
  if (["node", "node.exe"].includes(executable)) return isReadOnlyNodeCommand(args);
  if (/^python\d*(?:\.\d+)?(?:\.exe)?$/.test(executable)) {
    return args.length > 0 && args.every((arg) => ["--version", "-V", "--help", "-h"].includes(arg));
  }
  if (executable === "tsc" || executable === "tsc.exe") return args.includes("--noEmit");
  if (executable === "eslint" || executable === "eslint.exe") return !args.includes("--fix");
  if (executable === "prettier" || executable === "prettier.exe") return args.includes("--check");
  return false;
}

function hasOnlyReadOnlyCommandLaunches(command: string, dialect: "posix" | "powershell"): boolean {
  const segments = tokenizeShellCommands(command, dialect);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const launch = unwrapCommand(segment);
    if (!launch) {
      const executable = executableBasename(segment[0] ?? "");
      return executable === "command" && ["-v", "-V"].includes(segment[1] ?? "");
    }
    return isReadOnlyCommandLaunch(launch.executable, launch.args);
  });
}

function isSafeCommand(command: string, dialect: "posix" | "powershell"): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const parsed = executableShellSyntax(trimmed, dialect);
  if (!parsed.balanced) return false;
  const shellSyntax = parsed.syntax;
  if (/\$\(/.test(shellSyntax) || (dialect === "posix" && /`/.test(shellSyntax))) return false;
  if (/[<>]/.test(shellSyntax)) return false;
  if (hasUnsafeCommandLaunch(trimmed, dialect)) return false;
  if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(shellSyntax))) return false;
  if (SHELL_SIDE_EFFECT_ARGUMENTS.test(shellSyntax)) return false;
  return hasOnlyReadOnlyCommandLaunches(trimmed, dialect);
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

function buildPlanModePrompt(): string {
  return `[PLAN MODE ACTIVE]
# Plan Mode

You are in durable Plan Mode. Read and reason only. Produce concise, decision-complete Markdown.

- Ground decisions in the current codebase and use its terminology.
- Run a Socratic pressure review before confirmation: challenge assumptions, contradictions, boundaries, failure cases, and integration effects with concrete code evidence.
- Use ask-user-question for every user question. Ask 2-4 related questions per call, grouped by one review branch; do not ask questions as plain assistant text.
- Keep reviewing until scope, boundaries, non-goals, requirements, and acceptance checks are explicitly locked; unresolved risks must remain visible.
- Align every user requirement with a planned outcome and a verifiable acceptance check.
- Keep the final Markdown to locked scope, boundaries, decisions, ordered outcomes, risks, and acceptance checks; omit interview logs and boilerplate.
- Confirm only after the pressure review is complete and no material decision remains open.
- Approval converts the locked Plan into one active Goal, then decomposes that Goal into Todo before implementation.
- Use plan-update to persist the complete draft, plan-review to edit, plan-confirm to approve, or plan-exit to leave while preserving current.md.
- Do not use write tools, mutating shell commands, or write-mode delegation.
- The legacy <proposed_plan> block is accepted only as a compatibility path; prefer plan-update.

The public Plan contract is plain Markdown. Do not invent a parallel structured schema.`;
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
        if (isPlanMode()) exitPlanMode(ctx);
        ctx.ui.notify("Act mode · draft preserved", "info");
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
        const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
        extensionApi?.sendUserMessage(trimmed, opts);
        return;
      }
      await toggleMode(ctx);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
