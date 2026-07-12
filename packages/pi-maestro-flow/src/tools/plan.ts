/**
 * Durable Plan mode lifecycle.
 *
 * Act mode exposes plan-enter. Plan mode dynamically activates a safe read-only
 * tool surface plus plan-update/review/confirm/exit/status. Markdown drafts are
 * persisted by workspace and chat session; approval must commit before Act tools are restored.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { openPlanEditor } from "./plan-editor.ts";
import { PlanStore, type LoadedPlan, type PlanSessionIdentity } from "./plan-store.ts";

type Mode = "act" | "plan";
export type PlanContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "isIdle" | "sessionManager">;

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

const PLAN_ALLOWED_TOOLS = new Set([
  "maestro", "maestro-wait", "maestro-status", "ask-user-question", "todo",
  "teammate-list", "teammate-watch", "goal", "Read", "Grep", "Glob",
  "read", "grep", "glob", "bash", "Bash", "powershell", "PowerShell",
  "LSP", "WebSearch", "WebFetch", ...PLAN_MODE_TOOL_NAMES,
]);

const MUTATING_BASH_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i,
  /\btouch\b/i, /\bchmod\b/i, /\bchown\b/i, /\bln\b/i, /\btee\b/i,
  /\btruncate\b/i, /\bdd\b/i, /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
  /\byarn\s+(add|remove|install|publish|upgrade)\b/i,
  /\bpnpm\s+(add|remove|install|publish|update)\b/i,
  /\bbun\s+(add|remove|install|update|publish)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsudo\b/i, /\bkill\b/i, /\bpkill\b/i,
];

const SHELL_CHAIN_PATTERN = /(?:\r|\n|;|&&|\|\||\||`|\$\(|<\()/;
const SHELL_SIDE_EFFECT_ARGUMENTS = /(?:^|\s)(?:--output(?:=|\s)|--outfile(?:=|\s)|-OutFile(?:\s|$)|-o(?:\s|$)|--in-place(?:=|\s|$)|-i(?:\s|$)|--exec(?:=|\s|$)|--exec-batch(?:=|\s|$)|-x(?:\s|$)|-X(?:\s|$)|--ext-diff(?:\s|$)|--textconv(?:\s|$)|--open-files-in-pager(?:=|\s|$)|--pager(?:=|\s|$)|--paging(?:=|\s|$)|--pre(?:=|\s|$)|--fix(?:\s|$))/i;
const SIMPLE_READ_COMMAND = /^\s*(?:cat|head|tail|grep|ls|pwd|echo|printf|wc|diff|file|stat|du|df|tree|which|type|uname|whoami|id|ps|jq|rg)(?:\s|$)/i;
const POWERSHELL_READ_COMMAND = /^\s*(?:Get-Content|Get-ChildItem|Get-Item|Get-Location|Resolve-Path|Test-Path|Select-String|Measure-Object)(?:\s|$)/i;

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
  const safe = activeToolsSnapshot.filter((name) => PLAN_ALLOWED_TOOLS.has(name));
  extensionApi.setActiveTools([...new Set([...safe, ...PLAN_MODE_TOOL_NAMES])]);
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
    const approved = await reviewPlan(ctx, true);
    if (!approved) ctx.ui.notify("Staying in Plan mode", "info");
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
  if (!PLAN_ALLOWED_TOOLS.has(name)) {
    return { block: true, reason: `Plan mode tool surface does not allow "${name}".` };
  }
  if (name === "maestro" && event.input?.action === "delegate" && event.input?.mode !== "analysis") {
    return { block: true, reason: "Plan mode requires delegate mode='analysis'; missing or write modes are blocked." };
  }
  if (["bash", "Bash", "powershell", "PowerShell"].includes(name)) {
    const command = readCommand(event.input);
    if (!command || !isSafeCommand(command)) {
      return { block: true, reason: `Plan mode blocks mutating commands.\nCommand: ${command.slice(0, 120)}` };
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

async function reviewPlan(ctx: PlanContext, allowConfirm: boolean): Promise<boolean> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Plan review requires an interactive UI.", "warning");
    return false;
  }
  const store = await ensureStore(ctx);
  if (mode !== "plan") await enterPlanMode(ctx);
  const result = await openPlanEditor(ctx, {
    markdown: latestPlan ?? "",
    revision: latestRevision,
    allowConfirm,
    pathLabel: store.currentPath,
    async onSave(markdown, expectedRevision) {
      const saved = await savePlan(ctx, markdown, expectedRevision);
      return saved.manifest.revision;
    },
    async onConfirm(markdown, expectedRevision) {
      try {
        const approved = await store.approve(markdown, expectedRevision);
        applyLoadedPlan(approved);
      } catch (error) {
        applyLoadedPlan(await store.load());
        throw error;
      }
    },
  });
  if (result.action !== "approved") return false;
  startImplementation(ctx, result.markdown);
  return true;
}

function startImplementation(ctx: PlanContext, markdown: string): void {
  exitPlanMode(ctx);
  latestPlan = markdown;
  latestStatus = "approved";
  awaitingAction = false;
  ctx.ui.notify("Plan approved · Act tools restored", "info");
  const opts = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" as const };
  extensionApi?.sendUserMessage([
    "Plan mode is disabled and the approved Plan is committed. Implement it now:",
    "",
    markdown,
    "",
    "Execute each step and verify it before proceeding.",
  ].join("\n"), opts);
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
    description: "Open the full-screen editor for human confirmation. Approval commits the Markdown archive before restoring Act mode.",
    promptSnippet: "Use plan-confirm only after plan-update has produced a decision-complete draft.",
    parameters: EmptyPlanParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const blocked = requirePlanMode("confirm");
      if (blocked) return blocked;
      const approved = await reviewPlan(ctx, true);
      return result(approved ? "Plan approved; Act mode restored." : "Plan not approved; Plan mode remains active.", {
        ...currentDetails("confirm"),
        approved,
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

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_CHAIN_PATTERN.test(trimmed)) return false;
  if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  if (SHELL_SIDE_EFFECT_ARGUMENTS.test(trimmed)) return false;
  if (/^\s*find(?:\s|$)/i.test(trimmed)) {
    return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:\s|$)/i.test(trimmed);
  }
  if (/^\s*fd(?:\s|$)/i.test(trimmed)) return true;
  if (/^\s*git\s+/i.test(trimmed)) {
    return /^\s*git\s+(?:status|log|diff|show|ls-files|grep)(?:\s|$)/i.test(trimmed)
      || /^\s*git\s+branch(?:\s+(?:--show-current|--list(?:\s+\S+)?|-a|-r|-v{1,2}))?\s*$/i.test(trimmed)
      || /^\s*git\s+remote(?:\s+-v|\s+show\s+\S+|\s+get-url\s+\S+)?\s*$/i.test(trimmed)
      || /^\s*git\s+config\s+--get(?:\s|$)/i.test(trimmed);
  }
  if (/^\s*npm\s+/i.test(trimmed)) {
    return /^\s*npm\s+(?:list|ls|view|info|search|outdated|audit)(?:\s|$)/i.test(trimmed);
  }
  if (/^\s*(?:node|python|python3|npm|tsc|biome)\s+--version\s*$/i.test(trimmed)) return true;
  if (/^\s*date(?:\s+\+\S+)?\s*$/i.test(trimmed)) return true;
  return SIMPLE_READ_COMMAND.test(trimmed) || POWERSHELL_READ_COMMAND.test(trimmed);
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

You are in durable Plan Mode. Explore and reason without modifying the project.

- Use read-only tools and ask-user-question to resolve intent.
- Use plan-update with complete Markdown to persist the current draft.
- Use plan-review when the user needs to edit without approval.
- Use plan-confirm when the draft is decision-complete and ready for human approval.
- Use plan-exit to leave Plan mode while preserving current.md.
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
