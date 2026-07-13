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

type Mode = "act" | "plan";
type PlanExecutionMode = "current" | "clear" | "compact";
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
  approved?: boolean;
  error?: string;
}

interface PlanRuntimeOptions {
  storeFactory?: (cwd: string, session: PlanSessionIdentity) => PlanStore;
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
  String.raw`${SHELL_COMMAND_BOUNDARY}git\s+(?:add|apply|clean|commit|push|pull|merge|rebase|reset|restore|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b`,
  "i",
);
const MAESTRO_MUTATING_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}maestro\s+(?:install|uninstall|update)\b`,
  "i",
);
const IN_PLACE_EDIT_COMMAND = new RegExp(
  String.raw`${SHELL_COMMAND_BOUNDARY}(?:sed|perl)\b[^\r\n;|&]*\s-[a-z]*i(?:[a-z]*|\.[^\s]+)?(?:\s|$)`,
  "i",
);
const NESTED_MUTATING_COMMAND = /(?:^|\s)-(?:exec|execdir|x|X)\s+(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd)\b/i;
const MUTATING_BASH_PATTERNS = [
  FILE_MUTATING_COMMAND,
  POWERSHELL_MUTATING_COMMAND,
  PACKAGE_MUTATING_COMMAND,
  GIT_MUTATING_COMMAND,
  MAESTRO_MUTATING_COMMAND,
  IN_PLACE_EDIT_COMMAND,
  NESTED_MUTATING_COMMAND,
  /(^|[^<])>(?!>)/,
  />>/,
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
let awaitingAction = false;
let activeToolsSnapshot: string[] | undefined;

function syncModeStatus(ctx: PlanContext): void {
  ctx.ui.setStatus(STATUS_KEY, mode === "act" ? "ACT" : hasPlan() ? "READY" : "PLAN");
}

export function initPlan(pi: ExtensionAPI, options: PlanRuntimeOptions = {}): void {
  if (extensionApi && activeToolsSnapshot) extensionApi.setActiveTools(activeToolsSnapshot);
  resetRuntimeState();
  extensionApi = pi;
  storeFactory = options.storeFactory ?? ((cwd, session) => new PlanStore(cwd, { session }));
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
  awaitingAction = Boolean(loaded.markdown.trim());
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
  if (mode !== "plan") return;
  const name = event.toolName;
  if (BLOCKED_BUILTIN_TOOLS.has(name)) {
    return { block: true, reason: `Plan mode blocks "${name}". Confirm or exit the plan first.` };
  }
  if (name === "maestro" && event.input?.action === "delegate" && event.input?.mode !== "analysis") {
    return { block: true, reason: "Plan mode requires delegate mode='analysis'; missing or write modes are blocked." };
  }
  if (["bash", "Bash", "powershell", "PowerShell"].includes(name)) {
    const command = readCommand(event.input);
    if (!command || !isSafeCommand(command)) {
      return { block: true, reason: `Plan mode blocks commands that may modify files or repository state.\nCommand: ${command.slice(0, 120)}` };
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
  awaitingAction = false;
  ctx.ui.notify("Plan approved · Act tools restored", "info");
  const executionMessage = [
    "The approved Plan is already in the current context and Act tools are restored.",
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
    try {
      const replacement = await ctx.newSession({
        async withSession(newCtx) {
          await newCtx.sendUserMessage(portableMessage);
        },
      });
      if (!replacement.cancelled) return;
      ctx.ui.notify("New session was cancelled; executing in the current context.", "warning");
    } catch (error) {
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
  };
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

function maskQuotedShellText(command: string): string {
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) => " ".repeat(quoted.length));
}

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const shellSyntax = maskQuotedShellText(trimmed);
  if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(shellSyntax))) return false;
  if (SHELL_SIDE_EFFECT_ARGUMENTS.test(shellSyntax)) return false;
  if (/^\s*find(?:\s|$)/i.test(trimmed)) {
    return !/(?:^|\s)-(?:delete|fprint|fprintf|fls)(?:\s|$)/i.test(trimmed);
  }
  if (/^\s*git\s+/i.test(trimmed)) {
    if (/^\s*git\s+branch(?:\s|$)/i.test(trimmed)) {
      return /^\s*git\s+branch(?:\s+(?:--show-current|--list(?:\s+\S+)?|-a|-r|-v{1,2}))?\s*$/i.test(trimmed);
    }
    if (/^\s*git\s+remote(?:\s|$)/i.test(trimmed)) {
      return /^\s*git\s+remote(?:\s+-v|\s+show\s+\S+|\s+get-url\s+\S+)?\s*$/i.test(trimmed);
    }
    if (/^\s*git\s+config(?:\s|$)/i.test(trimmed)) {
      return /^\s*git\s+config\s+(?:--get|--get-all|--list|--show-origin|--show-scope)(?:\s|$)/i.test(trimmed);
    }
  }
  return true;
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
