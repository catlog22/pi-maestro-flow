/**
 * Maestro Agent Extension Entry Point
 *
 * Registers tools:
 *   - maestro: Main tool with action-based dispatch (explore, delegate, moa)
 *   - goal: Autonomous Goal read/create surface with automatic loop-end verification
 *   - ask-user-question: Structured questionnaire for user input
 *   - todo: Task management with plain context, optional skills, and step tracking
 *   - lsp: Language-server diagnostics, navigation, refactors, and raw requests
 *   - browser: Named-tab Chromium control and screenshots
 *   - search_tool_bm25: Natural-language discovery across registered tools
 *
 * Also registers:
 *   - /goal command
 *   - /swarm bundled Skill activation + native teammate/MMAS dashboard
 *   - /plan command + Alt+Shift+P shortcut (Plan/Act mode toggle)
 *   - Shift+Tab approval-mode cycle (after remapping Pi effort cycling to Ctrl+Shift+E)
 *   - Dynamic LLM providers
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerCompanionPackages } from "../../scripts/register-companion-packages.mjs";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { COCKPIT_INPUT_TARGET_EVENT, COCKPIT_TODO_TOGGLE_EVENT, type CockpitInputTargetV1, type CockpitUiOwnershipV1 } from "pi-cockpit/v1/events";
import type { FlowToolResult } from "../tools/tool-result.ts";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  MaestroParams,
  GoalToolParams,
  AskUserQuestionParams,
  TodoToolParams,
} from "./schemas.ts";
import { altKey } from "../key-labels.ts";
import { setQuietMode } from "../quiet-state.ts";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import { registerKeybindingsCommand } from "../keybindings-command.ts";
import { executeExplore, type ExploreParams } from "../tools/explore.ts";
import { executeDelegate, type DelegateParams } from "../tools/delegate.ts";
import { executeMoa, type MoaParams } from "../tools/moa.ts";
import { registerSwarmDisplay } from "../tools/swarm.ts";
import { MaestroUiPublisher, registerMaestroUiQuery } from "../ui-projection.ts";
import { registerMaestroProviders } from "../providers/provider-registry.ts";
import { registerApiProviderConfigs } from "../providers/api-provider-config.ts";
import { registerExploreConfigManager } from "../providers/explore-config-manager.ts";
import { registerModelFailover } from "../providers/model-failover.ts";
import { showModelFailoverOverlay } from "../tui/model-failover-settings.ts";
import registerMcpAdapter from "../mcp/index.ts";
import {
  initGoal,
  registerGoalCommand,
  executeGoal,
  executeGoalCommand,
  onSessionStart as goalSessionStart,
  onSessionShutdown as goalSessionShutdown,
  onBeforeCompact as goalBeforeCompact,
  onCompactionCancelled as goalCompactionCancelled,
  onCompact as goalCompact,
  onInput as goalInput,
  onBeforeAgentStart as goalBeforeAgentStart,
  onAgentEnd as goalAgentEnd,
  onAgentSettled as goalAgentSettled,
  onProviderPressureSettled as goalProviderPressureSettled,
  getActiveGoal,
  getGoalPanelEntries,
  currentGoalPhase,
  switchCurrentGoal,
  reconcileWorkflowGoal,
  recoverPendingGoalTodoDetachesAfterTodoStart,
  setWorkflowCoordinator,
  setGoalStateChangeListener,
  setGoalPanelOwnership,
  setGoalStaticMode,
  type GoalParams as GoalActionParams,
} from "../tools/goal.ts";
import {
  executeAsk,
  type AskParams,
  type AskResultDetails,
} from "../tools/ask.ts";
import {
  initTodo,
  isolateTodoForTeammateAttach,
  executeTodo,
  delegateTodoTaskToAgent,
  delegateTodoTasksToAgent,
  sealTodoTasksOnAgentComplete,
  formatTodoActorSelector,
  getVisibleTasks,
  onAgentEndTodo,
  onBeforeAgentStartTodo,
  onContextTodo,
  registerTodoActor,
  setTodoStateChangeListener,
  onSessionStart as todoSessionStart,
  onSessionShutdown as todoSessionShutdown,
  reconcileMirrorTasks,
  type TodoActorRef,
  type TodoParams,
  type TodoResultDetails,
  type TodoTask,
} from "../tools/todo.ts";
import { WorkflowBridge, buildTodoMirrorSpecs } from "../session/bridge.ts";
import { guiEnabled, startGuiSubsystem, registerGuiTool, isGuiToolAllowed, getGuiTool, createGuiEventForwarder, GUI_EVENTS, bindGuiStartupIfCurrent, guiContextForGeneration, type GuiServerHandle, type GuiPermissionGateway } from "../gui/index.ts";
import { loadLatestTeamSwarmProjection, type TeamSwarmProjection } from "../swarm/projection.ts";
import { RunCliAdapter } from "../session/cli-adapter.ts";
import { publicWorkflowErrorMessage, WorkflowCoordinator } from "../session/coordinator.ts";
import { activeWorkflowRun, type WorkflowSnapshot } from "../session/types.ts";
import { deriveWorkflowViewModel, workflowStatusLabel, type WorkflowSnapshotLike, type WorkflowViewModel } from "../session/view-model.ts";
import { createRunEventComponent, type RunEventDetails } from "../session/run-event.ts";
import {
  exportSessionHistory,
  formatBytes,
  formatSessionLocation,
  probeSessionFile,
  resolveExportTarget,
  tryCopyToClipboard,
  type SessionLocationInfo,
} from "../session/session-export.ts";
import {
  classifyRunControlArgv,
  executeRunControl,
  isRunControlReadAction,
  isRunControlReadArgv,
  RunControlParams,
  type RunControlInput,
} from "../tools/run-control.ts";
import {
  assertPublishedPlanSnapshot,
  requirePublishedExecutionRun,
} from "../tools/plan-workflow.ts";
import { SessionOverlay, type SessionOverlayAction } from "../tui/session-overlay.ts";
import { TodoOverlay } from "../tui/todo-overlay.ts";
import { GoalOverlay, type GoalOverlayAction } from "../tui/goal-overlay.ts";
import { KnowledgeOverlay, type KnowledgeOverlayAction } from "../tui/knowledge-overlay.ts";
import { KnowledgeCliAdapter, resolveLatestSessionId } from "../knowledge/cli-adapter.ts";
import { stageWindowKnowledgeCandidate } from "../knowledge/extractor.ts";
import { SkillCliAdapter, type SkillCliListOptions } from "../skills/skill-cli-adapter.ts";
import { buildKnowledgeCenterView, type KnowledgeCenterView } from "../knowledge/view-model.ts";
import {
  onSessionStart as inputHistorySessionStart,
  onSessionShutdown as inputHistorySessionShutdown,
  setInputRouteTarget,
} from "../tui/input-history.ts";
import {
  initPlan,
  PLAN_TOGGLE_KEY,
  PLAN_TOGGLE_LABEL,
  registerPlanCommand,
  registerPlanTools,
  isPlanMode,
  toggleMode as planToggleMode,
  exitMode as planExitMode,
  onSessionStartPlan,
  onSessionShutdownPlan,
  onCompactPlan,
  onContextPlan,
  onBeforeAgentStartPlan,
  onToolCallPlan,
  onAgentEndPlan,
  consumePlanCleanContextCompaction,
  applyPlanContextToCompaction,
  isPlanCleanContextCompactionInstructions,
  getMode as getPlanMode,
  hasPlan,
  getPlanText,
  getPlanHandoffStatus,
  setPlanModeChangeListener,
  type PlanContext,
  type PlanWorkflowPublicationResult,
} from "../tools/plan.ts";
import type { PlanWorkflowConfirmationOptions } from "../tools/plan-confirm.ts";
import type { LoadedPlan, PlanExecutionChoice, PlanWorkflowBinding } from "../tools/plan-store.ts";
import { registerPlanModelSelection } from "../tools/plan-model.ts";
import { registerPlanReviewModelCommand } from "../tools/plan-review.ts";
import { installStatusline } from "../statusline/statusline.ts";
import { registerCodexHookAdapter } from "../hooks/pi-adapter.ts";
import { createPermissionController } from "../permissions/controller.ts";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
} from "../permissions/types.ts";
import {
  COMPACTION_STATUS_KEY,
  createMaestroCompaction,
  persistMaestroCompactionKnowhow,
  runWithCompactionStatus,
  type WorkflowRecoveryIdentity,
} from "../compaction/maestro-compaction.ts";
import {
  commitProjectedCompactionInput,
  createMidTurnAutoCompaction,
  shouldCancelCompletedTurnThreshold,
  shouldPreserveCompletedTurn,
} from "../compaction/auto-compaction.ts";
import {
  CompactionArbiter,
  compactionRequestFromInstructions,
  isNativeFallbackCompactionInstructions,
  isProviderPressureCompactionTrigger,
  runObservedCompaction,
} from "../compaction/compaction-arbiter.ts";
import { registerCompactionSettingsCommand, showCompactionSettingsOverlay } from "../tui/compaction-settings.ts";
import { flowTuiText, registerTuiLocaleEvents } from "../tui/locale.ts";
import { registerMaestroPackageResources } from "../resources/maestro-package.ts";
import { registerSkillManager, runSkillManager } from "../skills/skill-manager.ts";
import { SkillManagerStore } from "../skills/skill-manager-store.ts";
import { registerIntelligenceTools, shutdownIntelligenceTools } from "../tools/intelligence.ts";
import { createLspTool } from "../tools/lsp-tool.ts";
import { lspManager } from "../tools/lsp/manager.ts";
import { registerSmartSearchTool } from "../tools/smart-search.ts";
import { createSourceCheckTool } from "../tools/web-access/source-check-tool.ts";
import { registerFff } from "../tools/fff.ts";
import { registerBashBg } from "../tools/bash-bg.ts";
import { registerLoop } from "../tools/loop.ts";
import { registerModelAvailability } from "../tools/model-availability.ts";
import { registerResourceTool } from "../tools/resource.ts";
import { registerConflictTool } from "../tools/conflict.ts";
import {
  capturePublishedAgentResult,
  filterUnacknowledgedResults,
  persistStructuredResults,
} from "../teammate/agent-output-capture.ts";
import {
  createTeammateChildBrowserTool,
  TeammateBrowserBroker,
} from "../teammate/browser-broker.ts";
import { registerMarkdownReviewCommand } from "../tools/markdown-review-command.ts";
import {
  proxyTeammateChildTool,
  registerTeammateChildExtension,
  registerTeammateChildToolBroker,
  registerTeammatePermissionBroker,
  type TeammatePermissionBroker,
} from "pi-maestro-teammate/v1/child-extensions";
import {
  TEAMMATE_STARTED_EVENT,
  TEAMMATE_MESSAGE_EVENT,
  TEAMMATE_RESULT_PUBLISHED_EVENT,
  TEAMMATE_COMPLETE_EVENT,
} from "pi-maestro-teammate/v1/types";
import type { MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";
import { sharedModelCircuitBreaker } from "pi-maestro-teammate/v1/retry";
import { createFlowSettingsProvider, registerFlowSettingsProvider } from "../settings/flow-settings-provider.ts";
import {
  createApiManagerSettingsProvider,
  registerApiManagerSettingsProvider,
} from "../settings/api-manager-settings-provider.ts";
import {
  createMcpSettingsProvider,
  registerMcpSettingsProvider,
} from "../settings/mcp-settings-provider.ts";
import {
  createSkillsSettingsProvider,
  registerSkillsSettingsProvider,
} from "../settings/skills-settings-provider.ts";
import {
  createSmartSearchSettingsProvider,
  registerSmartSearchSettingsProvider,
} from "../settings/smart-search-settings-provider.ts";
import {
  createVisionDelegationSettingsProvider,
  registerVisionDelegationSettingsProvider,
} from "../settings/vision-delegation-provider.ts";
import {
  createExploreSettingsProvider,
  registerExploreSettingsProvider,
} from "../settings/explore-settings-provider.ts";
import {
  createHooksSettingsProvider,
  registerHooksSettingsProvider,
} from "../settings/hooks-settings-provider.ts";

export const MAESTRO_CHILD_TOOL_NAMES = [
  "ask-user-question",
  "bash_bg",
  "smart_search",
  "source_check",
  "resource",
  "lsp",
  "browser",
  "todo",
] as const;

interface MaestroState {
  baseCwd: string;
  activeToolCalls: Map<
    string,
    {
      action: string;
      startedAt: number;
      correlationId: string;
    }
  >;
}

export const APPROVAL_MODE_CYCLE_KEY = "shift+tab";
// Plan is a separate durable workflow entered through /plan, Alt+Shift+P, or an LLM
// plan tool. Shift+Tab only cycles permission-engine approval modes.
export const APPROVAL_MODES: readonly PermissionMode[] = PERMISSION_MODES.filter(
  (mode) => mode !== "plan",
);

export function nextApprovalMode(
  current: PermissionMode,
  disabled: ReadonlySet<PermissionMode> = new Set(),
): PermissionMode {
  let index = APPROVAL_MODES.indexOf(current);
  for (let offset = 0; offset < APPROVAL_MODES.length; offset++) {
    index = (index + 1) % APPROVAL_MODES.length;
    const candidate = APPROVAL_MODES[index] ?? "default";
    if (!disabled.has(candidate)) return candidate;
  }
  return "default";
}

/**
 * Permission mode used to authorize tool calls. Plan mode is advisory and
 * display-only: it no longer overrides the approval mode, so entering Plan
 * mode keeps whatever approval mode was active before (including YOLO). The
 * legacy "plan" approval-mode carousel entry evaluates as "default".
 */
export function effectivePermissionMode(approvalMode: PermissionMode): PermissionMode {
  return approvalMode === "plan" ? "default" : approvalMode;
}

const TODO_TOGGLE_KEY = "alt+t";
const TODO_TOGGLE_LABEL = altKey("T");
const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
const INPUT_TARGET_COLORS = new Set<ThemeColor>([
  "accent", "warning", "success", "mdLink", "thinkingLow", "thinkingMedium", "thinkingHigh", "muted", "error",
]);
const TEAMMATE_ATTACH_ENTRY = "maestro-teammate-attach";
const GOAL_OVERLAY_KEY = "alt+g";
const GOAL_OVERLAY_LABEL = altKey("G");

export function shouldRestoreWorkflowGoal(
  reason: "startup" | "reload" | "new" | "resume" | "fork" | undefined,
  goal: { workflowSessionId?: string } | undefined,
  snapshot: WorkflowSnapshot | undefined,
): boolean {
  const canonicalSessionId = snapshot?.canonicalClaim?.status === "valid"
    ? snapshot.session?.sessionId
    : undefined;
  return reason !== "new"
    && reason !== "fork"
    && Boolean(goal?.workflowSessionId && goal.workflowSessionId === canonicalSessionId);
}

export function shouldAttachWorkflowSession(
  snapshot: WorkflowSnapshot | undefined,
): boolean {
  return snapshot?.source === "canonical"
    && snapshot.canonicalClaim?.status !== "invalid"
    && snapshot.session?.status === "running";
}

/**
 * A canonical Workflow Session is workspace-wide, while Todo is owned by the
 * current Pi session. Never project or attach it into a fresh/forked Pi
 * session until that session explicitly resumes its workflow-owned Goal or
 * performs a Workflow write.
 */
export function shouldActivateWorkflowSession(
  snapshot: WorkflowSnapshot | undefined,
  workflowSessionOptedIn: boolean,
): boolean {
  return workflowSessionOptedIn && shouldAttachWorkflowSession(snapshot);
}

/**
 * A canonical Session is workspace-wide, so every Pi session can read it. The
 * statusline must only surface the Session the current Pi session actually
 * leases; otherwise an unattached session would display a Session owned by
 * another Pi session.
 */
export function workflowSnapshotForAttachedSession(
  snapshot: WorkflowSnapshotLike | undefined,
  attachedSessionId: string | undefined,
): WorkflowSnapshotLike | undefined {
  const sessionId = snapshot?.session?.sessionId;
  return sessionId && attachedSessionId === sessionId ? snapshot : undefined;
}

export function isWorkflowOptInCommand(command: string): boolean {
  if (/\bmaestro\s+ralph\b/.test(command)) return true;
  const runAction = /\bmaestro\s+run\s+([\w-]+)/.exec(command)?.[1];
  return Boolean(runAction && !isRunControlReadAction(runAction));
}

export function todoActorFromTeammateStarted(event: unknown): TodoActorRef | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const correlationId = typeof record.correlationId === "string" ? record.correlationId.trim() : "";
  if (!correlationId || correlationId === "unknown") return undefined;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
  const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
  return {
    kind: "teammate",
    id: correlationId,
    label: name ?? agent ?? correlationId.slice(0, 8),
    ...(agent ? { agentType: agent } : {}),
  };
}

/**
 * Access the teammate extension's published v1 mailbox registry (durable task
 * notification + pending-count + capability negotiation for teammate agents).
 * Available only while the teammate extension runs an active mailbox in this
 * process (root host, mailbox not disabled); undefined otherwise.
 */
export function mailboxRegistry(): MailboxHostRegistry | undefined {
  const bridge = globalThis as typeof globalThis & Record<symbol, unknown>;
  return bridge[Symbol.for("pi-maestro-teammate.mailbox-registry")] as MailboxHostRegistry | undefined;
}

function parseGoalActionParams(params: Record<string, unknown>): GoalActionParams | undefined {
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
  if (acceptance !== undefined && (
    !Array.isArray(acceptance)
    || acceptance.some((command) => typeof command !== "string")
  )) {
    return undefined;
  }
  const validatedAcceptance = acceptance === undefined ? undefined : acceptance.filter(
    (command): command is string => typeof command === "string",
  );
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

const CHINESE_RESPONSE_STATE_ENTRY = "maestro-chinese-response-mode";
const CHINESE_GLOBAL_STATE_FILE = "maestro-chinese-response-mode.json";
const CHINESE_RESPONSE_PROMPT_MARKER = "<chinese_response_mode>";

// Disambiguate the resource tool contract: the built-in read tool handles only
// local files; protocol resources (pr:// issue:// skill:// rule://) go through resource.
const RESOURCE_TOOL_GUIDANCE = [
  "Protocol resources are read via the resource tool, not read:",
  "  - pr://owner/repo/N[/diff|/files] or pr://N — GitHub pull requests (requires gh CLI)",
  "  - issue://owner/repo/N or issue://N — GitHub issues (requires gh CLI)",
  "  - skill://name — installed skill's SKILL.md",
  "  - rule://name — project rule files (agents/rules/cursor/cline)",
  "  - agent://<id>[/key[/index[/field]]] — structured output of a completed teammate subagent (bare agent://<id> returns the full JSON; path segments are object keys / array indices, no /json prefix)",
  "The built-in read tool handles only local files and ordinary URLs.",
].join("\n");

export function chineseGlobalStatePath(homeDir: string): string {
  return join(homeDir, ".pi", CHINESE_GLOBAL_STATE_FILE);
}

/** Load the global chinese mode state, or undefined when absent/invalid. */
export function loadChineseGlobalState(homeDir: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(chineseGlobalStatePath(homeDir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const enabled = (parsed as { enabled?: unknown }).enabled;
      if (typeof enabled === "boolean") return enabled;
    }
  } catch {
    // Missing or malformed state falls back to the session branch.
  }
  return undefined;
}

/** Persist the global chinese mode state (atomic write, last toggle wins). */
export function saveChineseGlobalState(enabled: boolean, homeDir: string): void {
  const filePath = chineseGlobalStatePath(homeDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, "utf8");
    renameSync(temporary, filePath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export const CHINESE_RESPONSE_PROMPT = `<chinese_response_mode>
# 中文回复准则

## 核心原则

- 所有回复使用简体中文
- 技术术语保留英文，首次出现可添加中文解释
- 代码变量名保持英文，注释使用中文

## 格式规范

- 中英文/数字间加空格：\`使用 TypeScript 开发\`、\`共 3 个文件\`
- 使用中文标点：，。！？：；
- 代码/命令用反引号：\`npm install\`

## Git Commit

- 使用中文提交信息
- 格式：\`类型: 简短描述\`
- 类型：feat/fix/refactor/docs/test/chore

## 保持英文

- 代码文件内容
- 错误信息和日志
- 文件路径和命令
</chinese_response_mode>`;

export function appendChineseResponsePrompt(systemPrompt: string): string {
  if (systemPrompt.includes(CHINESE_RESPONSE_PROMPT_MARKER)) return systemPrompt;
  return `${systemPrompt}\n\n${CHINESE_RESPONSE_PROMPT}`;
}

export interface ChineseResponseModeHandle {
  isEnabled(): boolean;
  setEnabled(value: boolean, ctx: ExtensionContext): void;
  toggle(ctx: ExtensionContext): void;
}

export function registerChineseResponseMode(
  pi: ExtensionAPI,
  options: { homeDir?: string } = {},
): ChineseResponseModeHandle {
  let enabled = false;
  const stateHomeDir = options.homeDir ?? homedir();
  const setEnabled = (value: boolean, ctx: ExtensionContext): void => {
    enabled = value;
    pi.appendEntry(CHINESE_RESPONSE_STATE_ENTRY, { enabled });
    try {
      saveChineseGlobalState(enabled, stateHomeDir);
      ctx.ui.notify(`中文回复模式已${enabled ? "开启" : "关闭"}（全局持久化）。`, "info");
    } catch {
      ctx.ui.notify(`中文回复模式已${enabled ? "开启" : "关闭"}，但全局配置保存失败。`, "warning");
    }
  };

  pi.registerCommand("chinese", {
    description: "切换中文回复模式，支持 on、off、status",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(`中文回复模式：${enabled ? "已开启" : "已关闭"}。`, "info");
        return;
      }
      if (action && !["on", "off", "enable", "disable"].includes(action)) {
        ctx.ui.notify("用法：/chinese [on|off|status]", "warning");
        return;
      }

      setEnabled(
        action === "on" || action === "enable"
          ? true
          : action === "off" || action === "disable"
            ? false
            : !enabled,
        ctx,
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const globalState = loadChineseGlobalState(stateHomeDir);
    if (globalState !== undefined) {
      enabled = globalState;
      return;
    }
    const entries = ctx.sessionManager.getBranch() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
    const state = entries
      .filter((entry) => entry.type === "custom" && entry.customType === CHINESE_RESPONSE_STATE_ENTRY)
      .at(-1)?.data as { enabled?: unknown } | undefined;
    enabled = state?.enabled === true;
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return undefined;
    return { systemPrompt: appendChineseResponsePrompt(event.systemPrompt) };
  });

  return {
    isEnabled: () => enabled,
    setEnabled,
    toggle: (ctx) => setEnabled(!enabled, ctx),
  };
}

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  if (process.env.PI_TEAMMATE_CHILD === "1") {
    registerMaestroChildSurface(pi);
    return;
  }

  const disposeTuiLocaleEvents = registerTuiLocaleEvents(pi.events);

  // pi install's SettingsManager overwrites postinstall's settings.json writes
  // with its stale in-memory cache. Re-register companion packages at load time
  // so the next pi startup picks them up.
  try {
    const companionRegistration = registerCompanionPackages();
    for (const entry of companionRegistration.preservedUnowned) {
      console.warn(`[pi-maestro-flow] Preserved local companion override for ${entry.name}: ${entry.source}`);
    }
    for (const entry of companionRegistration.versionMismatch) {
      console.warn(`[pi-maestro-flow] ${entry.name} resolved ${entry.actual ?? "unknown"}, but Flow requires ${entry.expected}; reinstall the versioned Flow package.`);
    }
  } catch (error) {
    console.warn(`[pi-maestro-flow] Companion package registration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  // UCL: capture only the locked extension-tool surface. pi.getAllTools() exposes
  // schemas but not execute(), so the registry is the invocation source for the
  // GUI sidecar. Do not capture built-ins or unrelated extension registrations.
  const originalRegisterTool = pi.registerTool.bind(pi);
  (pi as unknown as { registerTool: (tool: unknown) => unknown }).registerTool = (tool: unknown) => {
    const candidate = tool as { name?: unknown; execute?: unknown; label?: unknown };
    if (candidate && typeof candidate.name === "string" && typeof candidate.execute === "function") {
      const owner = typeof candidate.label === "string" && candidate.label.startsWith("MCP:") ? "mcp" : "pi-maestro-flow";
      if (!isGuiToolAllowed(candidate.name, owner)) return originalRegisterTool(tool as ToolDefinition);
      try {
        registerGuiTool(tool as ToolDefinition, owner);
      } catch {
        // GUI capture must never break tool registration.
      }
    }
    return originalRegisterTool(tool as ToolDefinition);
  };

  const teammateExtensionPath = fileURLToPath(import.meta.url);
  const teammateAuthorityOwner = `pi-maestro-flow:${teammateExtensionPath}`;
  const childBrowserBroker = new TeammateBrowserBroker();
  const childBrowserCleanups = new Set<Promise<unknown>>();
  const trackChildBrowserCleanup = (operation: Promise<unknown>): Promise<unknown> => {
    const contained = operation.catch((error) => {
      console.warn(`[pi-maestro-flow] teammate browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    childBrowserCleanups.add(contained);
    void contained.then(() => childBrowserCleanups.delete(contained));
    return contained;
  };
  let todoRootContext: ExtensionContext | undefined;
  let guiServer: GuiServerHandle | null = null;
  let guiLifecycleGeneration = 0;
  const guiEvents = createGuiEventForwarder();
  const acknowledgedPublications = new Map<string, number>();
  const rememberPublishedResult = (publicationId: string): void => {
    acknowledgedPublications.delete(publicationId);
    acknowledgedPublications.set(publicationId, Date.now());
    while (acknowledgedPublications.size > 2_000) {
      const oldest = acknowledgedPublications.keys().next().value as string | undefined;
      if (!oldest) break;
      acknowledgedPublications.delete(oldest);
    }
  };
  const compatibilityResults = (results: unknown): unknown =>
    filterUnacknowledgedResults(results, acknowledgedPublications);
  // Forward teammate lifecycle events (shared EventBus) to the GUI SSE stream.
  pi.events.on(TEAMMATE_STARTED_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateStarted, event));
  pi.events.on(TEAMMATE_MESSAGE_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateProgress, event));
  pi.events.on(TEAMMATE_COMPLETE_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateComplete, event));
  // Persist each published node before runGraph releases its dependents. The
  // completion/tool-result hooks below remain compatibility fallbacks.
  pi.events.on(TEAMMATE_RESULT_PUBLISHED_EVENT, (event) => {
    capturePublishedAgentResult(event, rememberPublishedResult);
  });
  // agent:// data source for background/detached runs: the root tool_result of
  // a background dispatch carries empty results, so the authoritative completion
  // event is the persistence channel for its structured outputs.
  pi.events.on(TEAMMATE_COMPLETE_EVENT, (event) => {
    try {
      const payload = event as { structuredResults?: unknown };
      const remaining = compatibilityResults(payload.structuredResults);
      if (!Array.isArray(remaining) || remaining.length === 0) return;
      void persistStructuredResults(remaining, undefined).catch((err) => {
        console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // Auto-seal delegated Todo work and reclaim browser tabs owned by the agent.
  pi.events.on(TEAMMATE_COMPLETE_EVENT, (event) => {
    const record = event as { correlationId?: unknown; agent?: unknown; exitCode?: unknown; cancelled?: unknown };
    const cid = typeof record.correlationId === "string" ? record.correlationId.trim() : "";
    if (!cid || cid === "unknown") return;
    trackChildBrowserCleanup(childBrowserBroker.closeActor(cid));

    if (!todoRootContext) return;
    const rootCtx = todoRootContext;
    const agent = typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : undefined;
    const actor: TodoActorRef = {
      kind: "teammate",
      id: cid,
      label: agent ?? cid.slice(0, 8),
      ...(agent ? { agentType: agent } : {}),
    };
    void sealTodoTasksOnAgentComplete(actor, Number(record.exitCode ?? 1), record.cancelled === true, rootCtx)
      .then((result) => {
        if (result.sealed.length === 0) return;
        updateTodoWidget();
        rootCtx.ui?.notify?.(`Todo: sealed ${result.sealed.length} task(s) for @${actor.label} on completion`, "info");
      });
  });
  const emitGoalChanged = (): void => {
    if (!guiEvents.isActive()) return;
    const goal = getActiveGoal();
    guiEvents.emitDeduped(GUI_EVENTS.goalChanged, JSON.stringify(goal ?? null), goal);
  };
  setTodoStateChangeListener(updateTodoWidget);
  setGoalStateChangeListener(() => {
    emitGoalChanged();
    publishMaestroUi();
  });
  let childTodoMutationQueue: Promise<void> = Promise.resolve();
  let teammateRegistrationGeneration = 0;
  let teammateRegistrationDisposers: Array<() => void> = [];
  const childTodoBroker = (request: Parameters<Parameters<typeof registerTeammateChildToolBroker>[1]>[0]) => {
    const execute = async (): Promise<FlowToolResult> => {
      const ctx = todoRootContext;
      if (!ctx) {
        return {
          content: [{ type: "text", text: "Root Todo session is not available." }],
          isError: true,
          details: {},
        };
      }
      if (!request.actor.correlationId || request.actor.correlationId === "unknown") {
        return {
          content: [{ type: "text", text: "Teammate Todo request has no trusted correlation id." }],
          isError: true,
          details: {},
        };
      }
      const actor: TodoActorRef = {
        kind: "teammate",
        id: request.actor.correlationId,
        label: request.actor.name ?? request.actor.agent ?? request.actor.correlationId.slice(0, 8),
        ...(request.actor.agent ? { agentType: request.actor.agent } : {}),
      };
      const result = await executeTodo(request.input as unknown as TodoParams, ctx, actor);
      updateTodoWidget();
      return result;
    };
    const result = childTodoMutationQueue.then(execute, execute);
    childTodoMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const compactionArbiter = new CompactionArbiter();
  const midTurnAutoCompaction = createMidTurnAutoCompaction(pi, { arbiter: compactionArbiter });
  const state: MaestroState = {
    baseCwd: "",
    activeToolCalls: new Map(),
  };
  let workflowBridge: WorkflowBridge | undefined;
  let workflowCoordinator: WorkflowCoordinator | undefined;
  let attachedWorkflowSessionId: string | undefined;
  let attachedWorkflowHostSessionId: string | undefined;
  let lastRunStates = new Map<string, string>();

  // Knowledge-pending UI indicator: persistent status-bar segment + 0→N
  // notify so manual resolve (review_required) is surfaced without opening
  // the knowledge center.
  const KNOWLEDGE_PENDING_STATUS_KEY = "maestro-knowledge-pending";
  let lastKnowledgePendingNotify = "";

  function updateKnowledgePendingStatus(
    ctx: ExtensionContext,
    counts: { pending: number; reviewRequired: number },
  ): void {
    try {
      const total = counts.pending + counts.reviewRequired;
      if (total === 0) {
        ctx.ui.setStatus(KNOWLEDGE_PENDING_STATUS_KEY, undefined);
        return;
      }
      const value = counts.reviewRequired > 0
        ? `${counts.reviewRequired} review · ${counts.pending} pending`
        : `${counts.pending} pending`;
      ctx.ui.setStatus(KNOWLEDGE_PENDING_STATUS_KEY, value);
      // One-shot notify on 0→N transition (dedup by key).
      const key = `${counts.reviewRequired}:${counts.pending}`;
      if (lastKnowledgePendingNotify !== key) {
        lastKnowledgePendingNotify = key;
        ctx.ui.notify(
          `Knowledge center: ${counts.reviewRequired} candidate(s) need manual resolve`
            + ` (${counts.pending} pending total) — /maestro-knowledge`,
          "info",
        );
      }
    } catch {
      // Status bar is cosmetic — never break the refresh flow.
    }
  }

  async function refreshKnowledgePendingStatus(ctx: ExtensionContext, sessionId: string): Promise<void> {
    try {
      const summary = await new KnowledgeCliAdapter(ctx.cwd).review(sessionId).catch(() => null);
      if (!summary) return;
      updateKnowledgePendingStatus(ctx, {
        pending: summary.candidates.filter((candidate) => candidate.status === "pending").length,
        reviewRequired: summary.candidates.filter(
          (candidate) => candidate.reconciliation?.promotion_eligibility === "review_required",
        ).length,
      });
    } catch {
      // Ignore — next seal/refresh will retry.
    }
  }
  let lastSessionStatus: string | undefined;
  let workflowSessionOptedIn = true;
  let approvalMode: PermissionMode = DEFAULT_PERMISSION_MODE;
  let currentSwarmProjection: TeamSwarmProjection | undefined;
  let maestroUiSessionActive = false;
  let preserveCompletedTurnFromNativeThreshold = false;
  let lastCompactionCancel: { reason: string; at: number; operationId?: number } | undefined;
  let teammateAttachTodoIsolated = false;
  let flowSettingsContext: ExtensionContext | undefined;
  const maestroUiPublisher = new MaestroUiPublisher({
    read: () => ({
      workflow: deriveWorkflowViewModel(workflowSnapshotForUi()),
      goals: getGoalPanelEntries(),
      currentGoalId: getActiveGoal()?.id,
      swarm: currentSwarmProjection,
      planMode: getPlanMode(),
      approvalMode: effectivePermissionMode(approvalMode),
    }),
    emit: (event, snapshot) => pi.events.emit(event, snapshot),
  });
  registerMaestroUiQuery(pi.events, maestroUiPublisher, () => maestroUiSessionActive);

  function publishMaestroUi(): void {
    if (maestroUiSessionActive) maestroUiPublisher.publish();
  }

  // Register dynamic providers from cli-tools.json
  let apiProviderHandle: ReturnType<typeof registerApiProviderConfigs> | undefined;
  try {
    apiProviderHandle = registerApiProviderConfigs(pi);
    registerExploreConfigManager(pi);
    registerMaestroProviders(pi);
  } catch (error) {
    // Provider registration failures should not block extension load
    console.error(
      `[maestro] Provider registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  registerPlanModelSelection(pi);
  registerPlanReviewModelCommand(pi);
  try {
    registerModelFailover(pi);
  } catch (error) {
    console.error(
      `[maestro] Model failover registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let mcpAdapterHandle: ReturnType<typeof registerMcpAdapter> | undefined;
  try {
    mcpAdapterHandle = registerMcpAdapter(pi);
  } catch (error) {
    // MCP 注册失败不得阻断 Maestro 现有工具与 Provider。
    console.error(
      `[maestro] MCP adapter registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  registerMaestroPackageResources(pi);
  const chineseResponseMode = registerChineseResponseMode(pi);
  registerSkillManager(pi);
  registerCompactionSettingsCommand(pi);
  pi.registerCommand("compaction-status", {
    description: "Show maestro auto-compaction state: arbiter owner, pending intents, breaker, and the last cancel reason.",
    async handler(_args, ctx) {
      const state = midTurnAutoCompaction.describeState();
      const arbiterOwner = compactionArbiter.currentOwner();
      const operationId = compactionArbiter.currentOperationId();
      const tombstone = compactionArbiter.timeoutTombstone();
      const lines: string[] = [
        `turn: ${state.turnCount}`,
        `running: ${state.running ? `yes${state.activeRequestOwner ? ` (${state.activeRequestOwner})` : ""}` : "no"}`,
        state.zombieOwner !== undefined
          ? `zombie: owner#${state.zombieOwner} may still be settling (new submissions held)`
          : "zombie: (none)",
        `arbiter owner: ${arbiterOwner ?? "(idle)"}${operationId !== undefined ? ` op#${operationId}` : ""}`,
        tombstone
          ? `arbiter tombstone: holding extension submissions for ~${Math.ceil(tombstone.remainingMs / 1000)}s after a lease timeout`
          : "arbiter tombstone: (none)",
        state.pendingIntent
          ? `pending intent: ${state.pendingIntent.tokens.toLocaleString("en-US")}/${state.pendingIntent.thresholdTokens.toLocaleString("en-US")} tokens${state.pendingIntent.contextExhausted ? " (context exhausted)" : ""}${state.pendingIntent.requestBlocked ? " (request blocked)" : ""}`
          : "pending intent: (none)",
        `output-limit intent: ${state.outputLimitIntentPending ? "pending" : "(none)"}`,
        state.breaker.trippedAtTurn !== undefined && state.breaker.cooldownRemainingTurns !== undefined
          ? `breaker: TRIPPED after ${state.breaker.consecutiveFailures} consecutive failures; cooldown has ${state.breaker.cooldownRemainingTurns} completed turn(s) left`
          : `breaker: ok (${state.breaker.consecutiveFailures} consecutive failures)`,
        lastCompactionCancel
          ? `last cancel: ${lastCompactionCancel.reason} (at ${new Date(lastCompactionCancel.at).toLocaleTimeString()})`
          : "last cancel: (none)",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // === Main Tool: maestro ===
  const maestroTool: ToolDefinition<typeof MaestroParams> = {
    name: "maestro",
    label: "Maestro",
    description: `Maestro flow command tool with three actions:

- **explore**: Parallel code search via teammate agents. Each prompt spawns an independent search agent.
  { action: "explore", prompts: ["FIND: auth middleware\\nSCOPE: src/"], model: "..." }

- **delegate**: Delegate a task to a specific model/provider for analysis or implementation.
  { action: "delegate", prompt: "Analyze the auth flow", tool: "gemini", mode: "analysis" }

- **moa**: Mixture-of-Agents — parallel reference analysis across models, then aggregator synthesis.
  { action: "moa", prompts: ["Compare auth strategies"], preset: "deep" }

These actions route to external CLI endpoints (gemini/codex CLI processes). Results are returned inline in the tool response as text. Prefer the **teammate** tool for ordinary delegation and exploration.

This tool is NOT the Maestro Session/Run lifecycle CLI: use the **run-control** tool for session/run commands (or the bash \`maestro\` CLI for knowledge search/load), never this tool.

Progressive fallback: when a user explicitly requests an external model (codex, gemini, claude, opencode) NOT in <available_teammate_models>, call **model-availability** first, then route via bash:
  maestro delegate "<PROMPT>" --to <tool> --mode analysis
The --to flag is MANDATORY. A bare \`maestro delegate codex\` treats "codex" as the prompt and falls back to the first enabled tool. Contract: D:\\maestro2\\workflows\\delegate-usage.md.`,

    promptSnippet: "External-CLI-endpoint routing (explore/delegate/moa) with a delegate-as-teammate-fallback path. Prefer teammate; fall back to maestro delegate --to <tool> for explicit external models missing from the teammate catalog.",
    promptGuidelines: [
      "In the pi-agent, use the teammate tool for all delegation, code exploration, and multi-model synthesis — teammate supports prompt templates (prompt field) and model selection (model field). Do not call the maestro tool's explore/delegate/moa for ordinary pi-agent work.",
      "Reserve the maestro tool (explore/delegate/moa) for the rare case of routing work directly to an external CLI endpoint (gemini/codex CLI process); for knowledge search use the maestro search/load bash CLI.",
      "Session/Run lifecycle commands belong to the run-control tool (argv passthrough shell), not this tool and not hand-written bash `maestro run/session` calls.",
    ],

    parameters: MaestroParams,

    async execute(
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate:
        | ((result: FlowToolResult) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<FlowToolResult> {
      const action = params.action as string;

      // Track run
      state.activeToolCalls.set(id, {
        action,
        startedAt: Date.now(),
        correlationId: id,
      });

      try {
        switch (action) {
          case "explore":
            return await executeExplore(
              params as unknown as ExploreParams,
              signal,
              ctx,
              pi,
            );

          case "delegate":
            return await executeDelegate(
              params as unknown as DelegateParams,
              signal,
              ctx,
              pi,
            );

          case "moa":
            return await executeMoa(
              params as unknown as MoaParams,
              signal,
              ctx,
              pi,
            );

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown action "${action}". Valid actions: explore, delegate, moa`,
                },
              ],
              isError: true,
              details: {},
            };
        }
      } finally {
        state.activeToolCalls.delete(id);
      }
    },

    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = (args.action as string) ?? "?";
      let arg = action;
      if (action === "explore") {
        const prompts = args.prompts as string[] | undefined;
        if (prompts) arg += ` (${prompts.length})`;
      } else if (action === "delegate") {
        const tool = (args.tool as string) ?? "";
        if (tool) arg += ` ${tool}`;
      }
      return toolCallLine(theme, "maestro", arg);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      let arg = action;
      if (action === "explore") {
        const prompts = ctx.args.prompts as string[] | undefined;
        if (prompts) arg += ` (${prompts.length})`;
      } else if (action === "delegate") {
        const tool = String(ctx.args.tool ?? "");
        if (tool) arg += ` ${tool}`;
      }
      return toolResultLine(theme, { name: "maestro", ok: !isError, arg, summary: resultSummary(result), expanded: opts.expanded, detail: message });
    },
  };

  pi.registerTool(maestroTool);

  // === Goal Tool ===
  initGoal(pi);
  registerGoalCommand(pi);

  const goalTool: ToolDefinition<typeof GoalToolParams> = {
    name: "goal",
    label: "Goal",
    description: `Read, create, or update an autonomous Goal. Lifecycle control belongs to the user through /goal commands.

- get: Read the current Goal state. { action: "get" }
- create: Create a new Goal without a budget by default. { action: "create", objective: "..." }
- update: Replace the active Goal objective and resume it automatically. { action: "update", objective: "..." }
- complete: Request completion verification after all work is done. Declared acceptance commands are rerun and decide the result directly; without them, an independent agent verifier is used. { action: "complete", summary: "..." }
- optional budget: Include tokenBudget only when the user explicitly requests one. { action: "create", objective: "...", tokenBudget: "100k" }
- optional acceptance: Declare or replace up to 5 acceptance commands on create or update. { action: "create", objective: "...", acceptance: ["npm test -- foo.test.ts"] }

When to use:
- create a Goal for multi-turn autonomous work that needs sustained momentum, a token budget, or verified completion.

When NOT to use:
- single-turn tasks; or when an active Workflow Session already tracks its Runs — do not create a competing one.

Only request completion after all work is done; the extension verifies it independently. The model cannot stop, resume, or clear a Goal.`,

    promptSnippet: "Read, create, update, or request independent verification for an autonomous Goal",
    promptGuidelines: [
      "When a goal is active, keep working until it is complete; do not stop with only a plan or partial progress.",
      "Use goal get to inspect state. Use goal create only when no Goal exists; use goal update to replace its objective and resume it.",
      "Omit tokenBudget by default. Set it only when the user explicitly requests a Token budget.",
      "Use goal complete only after all requirements are met and provide concise verification evidence; the extension owns the done transition.",
      "Prefer declaring acceptance commands at goal create or update. Run focused checks before goal complete for fresh evidence; the extension reruns declared commands during verification.",
    ],

    parameters: GoalToolParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: ((result: FlowToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<FlowToolResult> {
      const goalParams = parseGoalActionParams(params);
      if (!goalParams) {
        return {
          content: [{ type: "text", text: "Invalid Goal parameters for the requested action." }],
          isError: true,
          details: {},
        };
      }
      const result = await executeGoal(goalParams, ctx);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
        details: {},
      };
    },

    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = (args.action as string) ?? "?";
      const obj = action === "create" || action === "update" ? ((args.objective as string) ?? "") : "";
      return toolCallLine(theme, "goal", obj ? `${action} ${obj.slice(0, 40)}` : action);
    },

    renderResult(result, options, theme, ctx) {
      if (options.isPartial) return new Text("", 0, 0);
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "Goal action completed.";
      const isError = (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      const objective = action === "create" || action === "update" ? String(ctx.args.objective ?? "") : "";
      const arg = objective ? `${action} ${objective.slice(0, 40)}` : action;
      return toolResultLine(theme, { name: "goal", ok: !isError, arg, summary: resultSummary(result), expanded: options.expanded, detail: text });
    },
  };

  pi.registerTool(goalTool);

  // === Ask User Question Tool ===
  registerAskUserQuestionTool(pi);

  // === Todo Tool ===
  initTodo(pi);
  pi.events.on(TEAMMATE_STARTED_EVENT, (event) => {
    if (!todoRootContext) return;
    const rootCtx = todoRootContext;
    const actor = todoActorFromTeammateStarted(event);
    if (actor) registerTodoActor(actor);
    const record = event as { todos?: unknown; todo?: unknown };
    const todos = Array.isArray(record.todos)
      ? record.todos.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : typeof record.todo === "string" && record.todo.trim()
        ? [record.todo]
        : [];
    if (actor && todos.length > 0) {
      // tasks[].todo binding: hand the tasks to the agent that just started —
      // each assignee becomes the agent (root → agent) and the first runnable
      // one is auto-activated. Runs synchronously in this tick via the
      // serialized todo mutation queue — well before the child's first tool call.
      void delegateTodoTasksToAgent(todos, actor, rootCtx)
        .then((result) => {
          updateTodoWidget();
          if (result.errors.length > 0) {
            rootCtx.ui?.notify?.(`Todo delegation to @${actor.label} partial: ${result.errors.join("; ")}`, "warning");
          } else if (result.delegated.length > 0) {
            rootCtx.ui?.notify?.(`Todo: @${actor.label} now owns ${result.delegated.length} task(s)${result.activated.length > 0 ? `, activated #${result.activated[0]}` : ""}`, "info");
          }
        });
    }
  });

  const todoTool: ToolDefinition<typeof TodoToolParams> = {
    name: "todo",
    label: "Todo",
    description: `Task management with plain-text context and optional Pi skill execution — 7 actions.

- create (single): { action: "create", subject: "...", assignee: "self|root|id|unique-id-prefix|label|@label|label#id-prefix", context: "...", skills: [{ name: "maestro-execute", role: "primary", args: "..." }] }
- create (batch — lay out a whole plan in ONE call): { action: "create", tasks: [{ subject: "Step 1", context: "..." }, { subject: "Step 2", blockedBy: [0] }, { subject: "Step 3", blockedBy: [1] }] }
- update: { action: "update", id: "...", updateFields: ["status", "summary"], status: "completed", summary: "..." }
- clear context/skills: { action: "update", id: "...", updateFields: ["context", "skills"], context: "", skills: [] }
- list: { action: "list", filter: { status: "pending", memberId: "self|root|correlation-id|unique-id-prefix|label|@label|label#id-prefix" } }
- get: { action: "get", id: "..." }
- delete: { action: "delete", id: "..." }
- clear: { action: "clear" }
- next: { action: "next" } — activate the oldest runnable pending task assigned to the caller and return its resolved context; ERRORS if you already hold an in_progress task — close it first with update status=completed (+ summary), then call next

Parallel delegation: pass todo task id(s) to a teammate dispatch via the teammate tool's tasks[].todo field — the agent takes ownership on start (assignee root → agent, first runnable task auto-activates unless the agent is already busy), manages the injected ordered queue itself, and clean exits auto-seal leftovers. Self-drive your own tasks with todo next; delegated agents advance theirs with todo update.

Rules:
- Use todo when the work has ≥3 steps/phases, has step dependencies, or spans turns; otherwise (same-turn, <3 steps, no dependencies) skip it. Count verifiable outcomes, not file edits or commands.
- For multi-step work, create the ENTIRE plan up front in ONE batch create (the tasks array) — never create tasks one at a time as you go.
- In a batch, each blockedBy integer N means the earlier array item tasks[N]. For tasks[i], every dependency must satisfy 0 <= N < i. Example: tasks[1] depends on tasks[0] with blockedBy: [0].
- subject is the title; description is the detail — do not swap. Set summary on completion; the next action consumes prior summaries.
- Each actor may have at most one in_progress task.
- Skill binding requires exactly one primary; guard/support are optional. Skill file changes after activation mark the binding stale — re-activate.
- status is update-only: create derives it from dependencies and rejects an explicit status. create takes either subject (single) or tasks (batch) — never both.
- In update: list changed fields in updateFields. Unlisted fields are preserved; empty strings or arrays clear fields that support clearing. Always use updateFields; legacy presence-based updates (top-level fields without updateFields) are deprecated.`,

    promptSnippet: "Lay out a whole multi-step plan in one batch create (≥3 steps), then drive it step by step with resolved context and optional skill guidance.",
    promptGuidelines: [
      "Use todo whenever the request has ≥3 steps/phases, step dependencies, or cross-turn context — create the COMPLETE plan in a single batch create (action=create with a tasks array) BEFORE executing. This trigger is mandatory — do not pause to judge whether tracking is needed.",
      "A todo task is a meaningful unit of work — a feature, a logical phase, a component, or an independently verifiable outcome — not a single edit or command. Multiple related edits that serve one logical change belong in ONE task (e.g. \"Implement JWT middleware\" touching 3 files = 1 task, not 3). Use description and context to make each task rich: affected files, expected changes, verification criteria.",
      "Always lay out the full plan up front with one batch create. Do NOT create a single task, finish it, then create the next — a one-at-a-time list hides the overall plan and provides no tracking value. Discover new sub-steps mid-work? Add them with another batch create so the whole remaining plan stays visible.",
      "For batch dependencies, use earlier zero-based integer indexes: tasks[i].blockedBy = [N] means tasks[i] depends on tasks[N], where 0 <= N < i.",
      "Drive each step with todo action=next — next errors while a task is in_progress, so close each step first with todo update status=completed plus a concise summary before calling it.",
    ],

    parameters: TodoToolParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: ((result: FlowToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<FlowToolResult> {
      return executeTodo(params as unknown as TodoParams, ctx);
    },

    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = (args.action as string) ?? "?";
      let detail = "";
      if (action === "create") {
        const batch = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : undefined;
        if (batch && batch.length > 0) {
          detail = ` ${batch.length} tasks`;
        } else {
          const subj = (args.subject as string) ?? "";
          detail = subj ? ` ${subj.slice(0, 40)}${subj.length > 40 ? "…" : ""}` : "";
        }
      } else if (action === "update" || action === "get" || action === "delete") {
        const id = (args.id as string) ?? "";
        detail = id ? ` #${id}` : "";
      }
      return toolCallLine(theme, "todo", `${action}${detail}`.trim());
    },

    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as TodoResultDetails | undefined;
      const rawText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const isError = !!(details?.error);
      const action = String(ctx.args.action ?? "?");
      let callDetail = "";
      if (action === "create") {
        const batch = Array.isArray(ctx.args.tasks) ? ctx.args.tasks as unknown[] : undefined;
        if (batch?.length) callDetail = ` ${batch.length} tasks`;
        else {
          const subject = String(ctx.args.subject ?? "");
          if (subject) callDetail = ` ${subject.slice(0, 40)}${subject.length > 40 ? "…" : ""}`;
        }
      } else if (action === "update" || action === "get" || action === "delete") {
        const id = String(ctx.args.id ?? "");
        if (id) callDetail = ` #${id}`;
      }
      const arg = `${action}${callDetail}`.trim();

      if (!details?.tasks) {
        return toolResultLine(theme, { name: "todo", ok: !isError, arg, summary: rawText.split("\n")[0]?.slice(0, 80) ?? "", expanded: opts.expanded, detail: rawText });
      }

      const allTasks = details.tasks;
      const done = allTasks.filter((t: TodoTask) => t.status === "completed").length;
      const running = allTasks.filter((t: TodoTask) => t.status === "in_progress").length;
      const open = allTasks.filter((t: TodoTask) => t.status === "pending" || t.status === "blocked").length;
      const counts: string[] = [];
      if (done > 0) counts.push(`${done} done`);
      if (running > 0) counts.push(`${running} in progress`);
      if (open > 0) counts.push(`${open} open`);
      const progress = `${allTasks.length} tasks (${counts.join(", ")})`;

      return toolResultLine(theme, { name: "todo", ok: !isError, arg, summary: progress, expanded: opts.expanded, detail: rawText });
    },
  };

  pi.registerTool(todoTool);

  // === Canonical Workflow Run Control ===
  const runControlTool: ToolDefinition<typeof RunControlParams> = {
    name: "run-control",
    label: "Run Control",
    description: `Transparent shell over the canonical Maestro CLI for the Session/Run lifecycle. Pass argv exactly as the CLI takes it (without the leading \`maestro\` executable), e.g. { argv: ["session","next","--json"] } or { argv: ["run","check","run-abc","--json"] }.
Read commands (status/brief/prepare/check/recall/evidence/list/show/graph/skills/search/load/review) need no mutation lease; write commands (next/done/decide/seal/edit/...) require the current Pi session to own the Workflow mutation lease and are blocked in Plan mode. Entry commands (session/run create|start) may mint a Session without a held lease.
This is the single LLM surface for the lifecycle: do not hand-write \`maestro\` run/session calls in bash. Read results report mutation-lease ownership so a Pi session can distinguish its Run from another session's workspace-wide Run.

When to use:
- Inside an active Maestro Workflow Session: any session/run lifecycle operation.

When NOT to use:
- No active workflow or coordinator not attached — the call errors; do not invoke it.
- Knowledge writes (knowledge stage/record/promote) and explore/delegate/moa belong to the bash \`maestro\` CLI and the \`maestro\` tool respectively; read-only knowledge lookups (search/load/review) may pass through this shell (they are classified as read commands above).

Examples: { argv: ["session","status"] }, { argv: ["run","done","run-abc","--verdict","done"] }, { argv: ["run","edit","verify","--after","latest"] }.`,
    promptSnippet: "Maestro CLI passthrough shell for Session/Run lifecycle",
    parameters: RunControlParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!workflowCoordinator) {
        return {
          content: [{ type: "text", text: "Workflow Coordinator is not attached." }],
          isError: true,
          details: { ok: false, action: "exec", message: "Workflow Coordinator is not attached." },
        };
      }
      const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
      const actionOptsIn = classifyRunControlArgv(argv).write;
      const hostSessionId = workflowHostSessionId(ctx);
      if (actionOptsIn && hostSessionId) {
        await ensureWorkflowHostIdentity(ctx, hostSessionId);
        const snapshot = workflowBridge?.getSnapshot() ?? await refreshWorkflow(ctx);
        if (snapshot && shouldAttachWorkflowSession(snapshot)
          && (attachedWorkflowSessionId !== snapshot.session?.sessionId
            || attachedWorkflowHostSessionId !== hostSessionId)) {
          if (await attachWorkflowSession(ctx, snapshot, hostSessionId)) workflowSessionOptedIn = true;
        }
      }
      const result = await executeRunControl(
        params as RunControlInput,
        workflowCoordinator,
        hostSessionId ? { hostSessionId } : undefined,
      );
      if (result.ok) {
        await refreshWorkflow(ctx, actionOptsIn, actionOptsIn, actionOptsIn);
      }
      return {
        content: [{ type: "text", text: result.message }],
        isError: !result.ok,
        details: result,
      };
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const argv = Array.isArray(args.argv) ? args.argv.join(" ") : "?";
      return toolCallLine(theme, "run-control", argv);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as { ok?: boolean; message?: string } | undefined;
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      const arg = Array.isArray(ctx.args.argv) ? ctx.args.argv.join(" ") : "?";
      return toolResultLine(theme, { name: "run-control", ok: details?.ok !== false, arg, summary: resultSummary(result), expanded: opts.expanded, detail: message });
    },
  };
  pi.registerTool(runControlTool);

  pi.registerMessageRenderer<RunEventDetails>("run-event", (message, options) => {
    const details = message.details;
    return details ? createRunEventComponent(details, options.expanded) : undefined;
  });

  // === Plan Mode ===
  initPlan(pi, {
    compactionArbiter,
    workflowConfirmation: planWorkflowConfirmation,
    publishWorkflowPlan: publishApprovedPlanToWorkflow,
  });
  registerPlanTools(pi);
  registerPlanCommand(pi);
  registerSwarmDisplay(pi, {
    onProjectionChange(projection) {
      currentSwarmProjection = projection;
      publishMaestroUi();
    },
  });

  // === Language intelligence, browser control, and tool discovery ===
  registerIntelligenceTools(pi);
  registerFff(pi);
  registerBashBg(pi);
  registerLoop(pi);
  registerModelAvailability(pi);
  registerResourceTool(pi);
  registerConflictTool(pi);
  registerKeybindingsCommand(pi);
  registerMarkdownReviewCommand(pi);

  pi.registerShortcut(PLAN_TOGGLE_KEY, {
    description: `Toggle Plan/Act mode (${PLAN_TOGGLE_LABEL})`,
    async handler(ctx: ExtensionContext) {
      await planToggleMode(ctx);
      syncApprovalModeStatus(ctx, approvalMode);
    },
  });

  setPlanModeChangeListener((ctx) => {
    updateTodoWidget();
    syncApprovalModeStatus(ctx, approvalMode);
    publishMaestroUi();
  });
  const permissionController = createPermissionController({
    async setMode(mode, ctx) {
      if (mode === "plan" && !isPlanMode()) await planToggleMode(ctx);
      if (mode !== "plan" && isPlanMode()) planExitMode(ctx);
      approvalMode = mode;
      syncApprovalModeStatus(ctx, approvalMode);
      publishMaestroUi();
    },
  });
  pi.registerCommand("permissions", {
    description: "查看、重新加载权限规则，或用 /permissions yolo 启用全权限模式",
    async handler(args, ctx) {
      const action = args.trim().toLowerCase();
      if (action === "yolo" || action === "bypasspermissions") {
        if (permissionController.bypassDisabled()) {
          ctx.ui.notify("YOLO mode is disabled by permissions.disableBypassPermissionsMode.", "warning");
          return;
        }
        await permissionController.setDefaultMode(ctx, "bypassPermissions");
        ctx.ui.notify("Approval mode: YOLO (saved as the project default)", "warning");
        return;
      }
      if (action === "reload") {
        const configuredMode = await permissionController.reload(ctx);
        if (configuredMode === "plan" && !isPlanMode()) await planToggleMode(ctx);
        if (configuredMode && configuredMode !== "plan" && isPlanMode()) planExitMode(ctx);
        if (configuredMode) approvalMode = configuredMode;
        syncApprovalModeStatus(ctx, approvalMode);
        publishMaestroUi();
        ctx.ui.notify("权限配置已重新加载。", "info");
        return;
      }
      ctx.ui.notify(permissionController.summary(effectivePermissionMode(approvalMode)), "info");
    },
  });
  pi.registerShortcut(APPROVAL_MODE_CYCLE_KEY, {
    description: "Cycle approval mode",
    async handler(ctx: ExtensionContext) {
      const current: PermissionMode = effectivePermissionMode(approvalMode);
      const disabled = permissionController.bypassDisabled()
        ? new Set<PermissionMode>(["bypassPermissions"])
        : new Set<PermissionMode>();
      const next = nextApprovalMode(current, disabled);

      await permissionController.setDefaultMode(ctx, next);
      ctx.ui.notify(`Approval mode: ${next} (saved as the project default)`, "info");
    },
  });

  function workflowSnapshotForUi(): WorkflowSnapshotLike | undefined {
    const snapshot = workflowBridge?.getSnapshot();
    if (!snapshot) return undefined;
    const goal = getActiveGoal();
    return {
      ...snapshot,
      goal: goal ? {
        objective: goal.text,
        status: goal.status,
        tokensUsed: goal.tokensUsed,
        tokenBudget: goal.tokenBudget,
      } : null,
      todos: getVisibleTasks().map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        origin: task.origin ? "mirror" : "local",
        blockedBy: task.blockedBy,
        createdBy: { id: task.createdBy.id, label: task.createdBy.label },
        assignee: { id: task.assignee.id, label: task.assignee.label },
      })),
    };
  }

  function workflowRecoveryIdentity(): WorkflowRecoveryIdentity | undefined {
    const snapshot = workflowBridge?.getSnapshot();
    const session = snapshot?.session;
    if (!snapshot || !session) return undefined;
    const run = activeWorkflowRun(snapshot);
    if (!run) return undefined;
    const task = getVisibleTasks().find((candidate) => candidate.origin?.runId === run.runId)
      ?? getVisibleTasks().find((candidate) => candidate.status === "in_progress" && candidate.origin);
    const gates = [...session.gates, ...(run?.gates ?? [])];
    const next = Array.isArray(run?.handoff?.next) ? run?.handoff?.next[0] : undefined;
    const handoffAction = next && typeof next === "object" && typeof (next as { command?: unknown }).command === "string"
      ? (next as { command: string }).command
      : undefined;
    return {
      sessionId: session.sessionId,
      runId: run.runId,
      todoId: task?.id,
      stackRevision: task?.skillActivation?.stackRevision,
      gates: {
        passed: gates.filter((gate) => ["passed", "waived", "skipped"].includes(gate.status)).length,
        total: gates.length,
        failed: gates.filter((gate) => ["failed", "blocked"].includes(gate.status)).length,
      },
      artifactRefs: session.artifacts.map((artifact) => artifact.artifactId),
      nextAction: handoffAction ?? `maestro run brief ${run.runId}`,
    };
  }

  async function refreshWorkflow(
    ctx: ExtensionContext,
    emitEvents = false,
    allowOptIn = false,
    allowLeaseMutation = false,
  ): Promise<WorkflowSnapshot | undefined> {
    if (!workflowBridge) return undefined;
    const next = await workflowBridge.refresh();
    if (!workflowSessionOptedIn && allowOptIn && next.session?.status === "running") {
      workflowSessionOptedIn = true;
    }

    const activateWorkflowSession = shouldActivateWorkflowSession(next, workflowSessionOptedIn);
    const nextSession = activateWorkflowSession ? next.session : undefined;
    const nextAttachSessionId = nextSession?.sessionId;
    if (allowLeaseMutation
      && attachedWorkflowSessionId
      && attachedWorkflowSessionId !== nextAttachSessionId) {
      try { await workflowCoordinator?.fenceContinuation(); } catch { /* a lost lease is already fail-closed */ }
      await workflowCoordinator?.release();
      attachedWorkflowSessionId = undefined;
      attachedWorkflowHostSessionId = undefined;
    }
    if (allowLeaseMutation && emitEvents && nextSession
      && attachedWorkflowSessionId !== nextSession.sessionId) {
      await attachWorkflowSession(ctx, next);
    }
    reconcileMirrorTasks(
      activateWorkflowSession ? buildTodoMirrorSpecs(next) : [],
      ctx,
      next.sessionGeneration,
    );
    if (workflowSessionOptedIn) reconcileWorkflowGoal(next, ctx);
    if (nextSession?.status && nextSession.status !== lastSessionStatus) {
      if (nextSession.status === "sealed" && lastSessionStatus !== undefined) {
        const sealedSessionId = nextSession.sessionId;
        const summary = await new KnowledgeCliAdapter(ctx.cwd).review(sealedSessionId).catch(() => null);
        const pending = summary?.candidates.filter(candidate => candidate.status === "pending").length ?? 0;
        const reviewRequired = summary?.candidates.filter(
          candidate => candidate.reconciliation?.promotion_eligibility === "review_required",
        ).length ?? 0;
        updateKnowledgePendingStatus(ctx, { pending, reviewRequired });
        if (pending > 0 || reviewRequired > 0) {
          const message = `Workflow Session ${sealedSessionId} sealed — ${pending} candidate(s) pending, `
            + `${reviewRequired} review required. Run \"maestro knowledge review ${sealedSessionId}\" before promotion.`;
          ctx.ui.notify(message, "info");
          pi.sendMessage({ customType: "session-knowledge", content: message, display: true });
        }
      }
      lastSessionStatus = nextSession.status;
    }
    if (emitEvents && activateWorkflowSession) emitRunTransitions(next, ctx);
    else lastRunStates = new Map(next.session?.runs.map((run) => [run.runId, run.status]) ?? []);
    updateTodoWidget();
    publishMaestroUi();
    return next;
  }

  async function planWorkflowConfirmation(ctx: PlanContext): Promise<PlanWorkflowConfirmationOptions> {
    const hostSessionId = workflowHostSessionId(ctx as ExtensionContext);
    if (!workflowCoordinator || !workflowBridge || !hostSessionId) {
      return { allowNew: false };
    }
    try {
      if (!await workflowCoordinator.supportsPlanPublish()) {
        return { allowNew: false };
      }
      const snapshot = await workflowBridge.refresh();
      const session = snapshot.session;
      if (!session) return { allowNew: true };
      const active = activeWorkflowRun(snapshot);
      const ownership = await workflowCoordinator.ownership(hostSessionId);
      // stale leases are reclaimable (WorkflowLeaseStore.acquire treats a
      // heartbeat past staleAfterMs as unowned), so they never block binding
      // the current Session or creating a new one.
      const ownedHere = ownership?.state === "unowned"
        || ownership?.state === "stale"
        || (ownership?.isOwner === true && ownership.isAttached === true);
      const firstPendingStep = session.chain.find((step) => step.status === "pending");
      let reason: string | undefined;
      if (session.status !== "running") reason = `Workflow Session is ${session.status}`;
      else if (active) reason = `Workflow Session has active Run ${active.runId}`;
      else if (!firstPendingStep) reason = "Workflow Session has no pending execution step";
      else if (firstPendingStep.command !== "execute") {
        reason = `Next Workflow step is ${firstPendingStep.command}, not execute`;
      }
      else if (!ownedHere) {
        reason = ownership?.ownerHostSessionId
          ? `Workflow Session is owned by Pi session ${ownership.ownerHostSessionId}`
          : "Workflow Session mutation lease is unavailable";
      }
      return {
        current: {
          sessionId: session.sessionId,
          intent: session.intent,
          available: reason === undefined,
          ...(reason ? { reason } : {}),
        },
        allowNew: !active && (ownership?.state === "unowned" || ownedHere),
      };
    } catch (error) {
      return {
        current: {
          sessionId: "unavailable",
          intent: "Workflow capability check failed",
          available: false,
          reason: publicWorkflowErrorMessage(error),
        },
        allowNew: false,
      };
    }
  }

  async function publishApprovedPlanToWorkflow(
    ctx: PlanContext,
    approved: LoadedPlan,
    execution: PlanExecutionChoice,
  ): Promise<PlanWorkflowPublicationResult> {
    if (execution.backend !== "workflow" || !execution.workflowTarget) {
      throw new Error("Workflow publication requires an explicit Workflow target");
    }
    if (!workflowCoordinator || !workflowBridge) throw new Error("Workflow Coordinator is not attached");
    const hostSessionId = workflowHostSessionId(ctx as ExtensionContext);
    if (!hostSessionId) {
      throw new Error("Current Pi host does not expose a stable session id; Workflow publication is refused");
    }
    if (!await workflowCoordinator.supportsPlanPublish()) {
      throw new Error("Installed Maestro CLI does not support `maestro plan publish`");
    }
    const handoffKey = approved.manifest.handoffKey;
    const approvedChecksum = approved.manifest.approvedChecksum;
    const approvedAt = approved.manifest.approvedAt;
    const approvedPath = approved.manifest.approvedPath;
    if (!handoffKey || !approvedChecksum || !approvedAt || !approvedPath) {
      throw new Error("Approved Plan is missing canonical approval identity");
    }

    let targetSessionId: string | undefined;
    if (execution.workflowTarget === "current") {
      const snapshot = await workflowBridge.refresh();
      const session = snapshot.session;
      if (!session || session.status !== "running") throw new Error("No running canonical Workflow Session to bind");
      const active = activeWorkflowRun(snapshot);
      const firstPendingStep = session.chain.find((step) => step.status === "pending");
      if (!active && firstPendingStep?.command !== "execute") {
        throw new Error(firstPendingStep
          ? `Next Workflow step is ${firstPendingStep.command}, not execute`
          : "Current Workflow Session has no pending execute step");
      }
      workflowSessionOptedIn = true;
      if (!await attachWorkflowSession(ctx as ExtensionContext, snapshot, hostSessionId)) {
        throw new Error(`Could not acquire Workflow Session ${session.sessionId}`);
      }
      targetSessionId = session.sessionId;
    } else {
      await workflowCoordinator.release();
      attachedWorkflowSessionId = undefined;
      attachedWorkflowHostSessionId = undefined;
    }

    const sourcePath = join(approved.plansDir, approvedPath);
    const publication = await workflowCoordinator.publishPlan({
      sourcePath,
      sourceRoot: approved.plansDir,
      ...(targetSessionId ? { sessionId: targetSessionId } : {}),
      intent: planIntent(approved.markdown, handoffKey),
      topic: planIntent(approved.markdown, handoffKey),
      handoffKey,
      sourcePiSession: hostSessionId,
      planRevision: approved.manifest.revision,
      approvedAt,
    }, { hostSessionId });
    const published = parsePlanPublishResult(publication.command.stdout);
    if (published.source_checksum !== `sha256:${approvedChecksum}`) {
      throw new Error("Published Plan source checksum does not match the approved revision");
    }
    assertPublishedPlanSnapshot(publication.snapshot, published, targetSessionId);

    workflowSessionOptedIn = true;
    if (!await attachWorkflowSession(ctx as ExtensionContext, publication.snapshot, hostSessionId)) {
      throw new Error(`Published Workflow Session ${published.session_id} could not be attached`);
    }
    const existingExecution = activeWorkflowRun(publication.snapshot);
    if (existingExecution) {
      requirePublishedExecutionRun(publication.snapshot, published);
    }
    const executionRun = existingExecution
      ? {
          command: await workflowCoordinator.brief(existingExecution.runId),
          snapshot: await workflowBridge.refresh(),
        }
      : await workflowCoordinator.next(undefined, { hostSessionId });
    assertPublishedPlanSnapshot(executionRun.snapshot, published, published.session_id);
    const active = requirePublishedExecutionRun(executionRun.snapshot, published);
    await refreshWorkflow(ctx as ExtensionContext, true, true, true);

    const binding: PlanWorkflowBinding = {
      status: "bound",
      handoffKey,
      sourceChecksum: approvedChecksum,
      workflowSessionId: published.session_id,
      ...(executionRun.snapshot.sessionGeneration
        ? { workflowSessionGeneration: executionRun.snapshot.sessionGeneration }
        : {}),
      artifactId: published.artifact_id,
      producerRunId: published.run_id,
      executionRunId: active.runId,
      requestId: published.request_id,
      updatedAt: new Date().toISOString(),
    };
    const executionMessage = executionRun.command.stdout.trim()
      || `Continue Workflow Run ${active.runId} in Session ${published.session_id}.`;
    return { binding, executionMessage };
  }

  function planIntent(markdown: string, handoffKey: string): string {
    const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const firstLine = markdown.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return (heading || firstLine || `Approved Plan ${handoffKey.slice(0, 12)}`).slice(0, 240);
  }

  function parsePlanPublishResult(stdout: string): {
    session_id: string;
    run_id: string;
    artifact_id: string;
    source_checksum: string;
    request_id: string;
  } {
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout.trim());
    } catch {
      throw new Error("Maestro plan publisher returned invalid JSON");
    }
    if (!envelope || typeof envelope !== "object") throw new Error("Maestro plan publisher returned an invalid envelope");
    const record = envelope as Record<string, unknown>;
    const payload = record.result;
    if (record.ok !== true || !payload || typeof payload !== "object") {
      throw new Error("Maestro plan publisher did not return a successful result");
    }
    const result = payload as Record<string, unknown>;
    for (const field of ["session_id", "run_id", "artifact_id", "source_checksum", "request_id"] as const) {
      if (typeof result[field] !== "string" || !(result[field] as string).trim()) {
        throw new Error(`Maestro plan publisher result is missing ${field}`);
      }
    }
    return result as {
      session_id: string;
      run_id: string;
      artifact_id: string;
      source_checksum: string;
      request_id: string;
    };
  }

  async function withPublicWorkflowErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new Error(publicWorkflowErrorMessage(error));
    }
  }

  function workflowHostSessionId(ctx: ExtensionContext): string | undefined {
    const value = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.();
    const normalized = value?.trim();
    return normalized || undefined;
  }

  async function ensureWorkflowHostIdentity(
    ctx: ExtensionContext,
    hostSessionId: string,
  ): Promise<void> {
    if (!attachedWorkflowSessionId || attachedWorkflowHostSessionId === hostSessionId) return;
    await workflowCoordinator?.release();
    attachedWorkflowSessionId = undefined;
    attachedWorkflowHostSessionId = undefined;
    const snapshot = workflowBridge?.getSnapshot() ?? await workflowBridge?.refresh();
    if (snapshot && workflowSessionOptedIn && shouldAttachWorkflowSession(snapshot)) {
      await attachWorkflowSession(ctx, snapshot, hostSessionId);
    }
  }

  async function attachWorkflowSession(
    ctx: ExtensionContext,
    snapshot: WorkflowSnapshot,
    hostSessionId = workflowHostSessionId(ctx),
  ): Promise<boolean> {
    if (!workflowCoordinator || !shouldAttachWorkflowSession(snapshot)) return false;
    if (!hostSessionId) {
      ctx.ui.notify(
        "Workflow Session remains read-only because this Pi host does not expose a stable session id.",
        "warning",
      );
      return false;
    }
    const sessionId = snapshot.session!.sessionId;
    if (attachedWorkflowSessionId === sessionId && attachedWorkflowHostSessionId === hostSessionId) return true;
    try {
      await workflowCoordinator.attach(hostSessionId, sessionId);
      attachedWorkflowSessionId = sessionId;
      attachedWorkflowHostSessionId = hostSessionId;
      return true;
    } catch (error) {
      attachedWorkflowSessionId = undefined;
      attachedWorkflowHostSessionId = undefined;
      ctx.ui.notify(
        `Workflow Session attach is read-only because continuation ownership was unavailable: ${publicWorkflowErrorMessage(error)}`,
        "warning",
      );
      return false;
    }
  }

  function emitRunTransitions(snapshot: WorkflowSnapshot, ctx: ExtensionContext): void {
    const nextStates = new Map(snapshot.session?.runs.map((run) => [run.runId, run.status]) ?? []);
    for (const run of snapshot.session?.runs ?? []) {
      const previous = lastRunStates.get(run.runId);
      if (!previous || previous === run.status) continue;
      const handoff = run.handoff ?? {};
      const next = Array.isArray(handoff.next) ? handoff.next[0] : undefined;
      pi.sendMessage({
        customType: "run-event",
        content: `Run ${run.runId} changed from ${previous} to ${run.status}`,
        display: true,
        details: {
          runId: run.runId,
          command: run.command,
          status: run.status,
          verdict: typeof handoff.verdict === "string" ? handoff.verdict : undefined,
          artifactsCount: snapshot.session?.artifacts.filter((artifact) => artifact.runId === run.runId).length ?? 0,
          nextAction: next && typeof next === "object" && typeof (next as { command?: unknown }).command === "string"
            ? (next as { command: string }).command
            : undefined,
        } satisfies RunEventDetails,
      });
      guiEvents.emit(GUI_EVENTS.runTransition, {
        runId: run.runId,
        from: previous,
        to: run.status,
        command: run.command,
      });
      guiEvents.emit(GUI_EVENTS.stateChanged, { subsystem: GUI_EVENTS.runTransition, runId: run.runId });
      // Run seal completes the knowledge pipeline for this step: surface the
      // attribution and staged-candidate summary without blocking the refresh.
      if (previous !== "sealed" && run.status === "sealed") {
        const sealedSessionId = snapshot.session?.sessionId;
        if (sealedSessionId) {
          void (async () => {
            const adapter = new KnowledgeCliAdapter(flowSettingsContext?.cwd ?? process.cwd());
            const summary = await adapter.review(sealedSessionId).catch(() => null);
            if (!summary) return;
            const signals: Record<string, number> = { consumed: 0, cited: 0, validated: 0, contradicted: 0 };
            for (const input of summary.inputs ?? []) {
              if (input.run_id !== run.runId) continue;
              signals[input.signal] += input.count;
            }
            const staged = summary.candidates
              .filter(candidate => candidate.run_ids.includes(run.runId)).length;
            const reviewRequired = summary.candidates
              .filter(candidate => candidate.reconciliation?.promotion_eligibility === "review_required").length;
            updateKnowledgePendingStatus(ctx, {
              pending: summary.candidates.filter(candidate => candidate.status === "pending").length,
              reviewRequired,
            });
            const reviewHint = reviewRequired > 0
              ? ` · ${reviewRequired} review required — \"maestro knowledge review ${sealedSessionId}\"`
              : ` — \"maestro knowledge review ${sealedSessionId}\"`;
            pi.sendMessage({
              customType: "run-knowledge",
              content: `Run ${run.runId}/${run.command} sealed — knowledge: consumed ${signals.consumed} · `
                + `cited ${signals.cited} · validated ${signals.validated} · contradicted ${signals.contradicted}`
                + ` · staged ${staged} candidate(s)${reviewHint}`,
              display: true,
              details: { runId: run.runId, signals, staged, reviewRequired },
            });
          })();
        }
      }
    }
    lastRunStates = nextStates;
  }

  async function openSessionOverlay(ctx: ExtensionContext): Promise<void> {
    const view = deriveWorkflowViewModel(workflowSnapshotForUi());
    if (!view || !workflowCoordinator) {
      ctx.ui.notify("No active canonical Workflow Session.", "info");
      return;
    }
    const knowledgeAdapter = new KnowledgeCliAdapter(ctx.cwd);
    const withKnowledge = async (vm: WorkflowViewModel): Promise<WorkflowViewModel> => {
      try {
        const summary = await knowledgeAdapter.review(vm.sessionId);
        return {
          ...vm,
          knowledge: {
            consumed: summary.input_totals.consumed,
            cited: summary.input_totals.cited,
            validated: summary.input_totals.validated,
            contradicted: summary.input_totals.contradicted,
            pendingCandidates: summary.candidates.filter((c) => c.status === "pending").length,
            corroboratedCandidates: summary.candidates.filter(
              (c) => c.status === "pending" && c.stage === "corroborated",
            ).length,
            reviewRequired: summary.candidates.filter((c) => c.reconciliation?.promotion_eligibility === "review_required").length,
            promotedCandidates: summary.candidates.filter((c) => c.status === "promoted").length,
            bySource: summary.input_totals_by_source ?? {},
            inputs: [...(summary.inputs ?? [])]
              .reverse()
              .slice(0, 20)
              .map((input) => ({
                runId: input.run_id,
                knowledgeId: input.knowledge_id,
                signal: input.signal,
                source: input.source,
                count: input.count,
              })),
          },
        };
      } catch {
        return vm;
      }
    };
    const enrichedView = await withKnowledge(view);
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let overlay: SessionOverlay;
      overlay = new SessionOverlay({
        view: enrichedView,
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        onAction: async (action: SessionOverlayAction, runId?: string) => {
          if (action !== "decision") {
            const planBlock = onToolCallPlan({ toolName: "run-control", input: { action } }, approvalMode === "bypassPermissions");
            if (planBlock) throw new Error(planBlock.reason);
          }
          const hostSessionId = workflowHostSessionId(ctx);
          const mutatesOwnership = ["pause", "resume", "next", "done"].includes(action);
          if (mutatesOwnership) {
            if (!hostSessionId) {
              throw new Error("Current Pi host does not expose a stable session id; Workflow mutation is refused");
            }
            await ensureWorkflowHostIdentity(ctx, hostSessionId);
          }
          if (action === "pause" || action === "resume") {
            if (action === "resume" && !workflowSessionOptedIn) {
              workflowSessionOptedIn = true;
              const snapshot = workflowBridge?.getSnapshot();
              if (snapshot && await attachWorkflowSession(ctx, snapshot, hostSessionId)) {
                reconcileWorkflowGoal(snapshot, ctx);
              }
            }
            const goal = getActiveGoal();
            if ((action === "pause" && goal?.status === "active")
              || (action === "resume" && (goal?.status === "paused" || goal?.status === "active"))) {
              if (action === "pause") {
                await withPublicWorkflowErrors(() => workflowCoordinator!.fenceContinuation());
              }
              const result = await executeGoalCommand({ action: action === "pause" ? "stop" : "resume" }, ctx);
              if (result.isError) throw new Error(result.text);
            }
          } else if (action === "brief") {
            await workflowCoordinator!.brief(runId);
          } else if (action === "check") {
            await workflowCoordinator!.check(runId);
          } else if (action === "next") {
            await withPublicWorkflowErrors(() =>
              workflowCoordinator!.next(undefined, { hostSessionId: hostSessionId! }));
          } else if (action === "done") {
            if (!runId) throw new Error("No Run selected");
            await withPublicWorkflowErrors(() =>
              workflowCoordinator!.done(runId, { verdict: "done" }, { hostSessionId: hostSessionId! }));
          } else {
            ctx.ui.notify("Resolve the decision through AskUserQuestion; the overlay is a recovery fallback only.", "info");
          }
          await refreshWorkflow(ctx, mutatesOwnership, mutatesOwnership, mutatesOwnership);
          const updated = deriveWorkflowViewModel(workflowSnapshotForUi());
          if (updated) overlay.update(await withKnowledge(updated));
        },
      });
      return overlay;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    });
  }

  async function openTodoOverlay(ctx: ExtensionContext): Promise<void> {
    const tasks = getVisibleTasks().filter((task) => !task.origin);
    if (tasks.length === 0) {
      ctx.ui.notify("No local or teammate Todo tasks to display.", "info");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
      new TodoOverlay({
        getTasks: () => getVisibleTasks(),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        theme,
      }), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" },
    });
  }

  async function openGoalOverlay(ctx: ExtensionContext): Promise<void> {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
      new GoalOverlay({
        getEntries: () => getGoalPanelEntries(),
        getCurrentGoalId: () => getActiveGoal()?.id,
        getPhase: () => currentGoalPhase(),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        theme,
        onAction: async (action: GoalOverlayAction, goalId: string) => {
          // Lifecycle commands act on the current goal, so surface the selected one first.
          if (getActiveGoal()?.id !== goalId && !switchCurrentGoal(goalId, ctx)) {
            throw new Error(`Unknown goal: ${goalId}`);
          }
          if (action === "switch") return;
          const result = await executeGoalCommand(
            { action: action === "stop" ? "stop" : action === "resume" ? "resume" : "clear" },
            ctx,
          );
          if (result.isError) throw new Error(result.text);
        },
      }), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    });
  }

  async function openKnowledgeOverlay(ctx: ExtensionContext, sessionIdArg?: string): Promise<void> {
    const adapter = new KnowledgeCliAdapter(ctx.cwd);
    const sessionId = sessionIdArg?.trim()
      || workflowSnapshotForUi()?.session?.sessionId
      || resolveLatestSessionId(ctx.cwd);
    if (!sessionId) {
      ctx.ui.notify("No Workflow Session found to review.", "info");
      return;
    }

    const loadView = async (refresh: boolean): Promise<KnowledgeCenterView> => {
      const [reviewResult, auditResult] = await Promise.allSettled([
        adapter.review(sessionId, { refresh }),
        adapter.audit("all"),
      ]);
      const review = reviewResult.status === "fulfilled" ? reviewResult.value : null;
      const audit = auditResult.status === "fulfilled" ? auditResult.value : null;
      const error = reviewResult.status === "rejected"
        ? (reviewResult.reason instanceof Error ? reviewResult.reason.message : String(reviewResult.reason))
        : null;
      return buildKnowledgeCenterView(review, audit, error);
    };

    const view = await loadView(false);
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let overlay: KnowledgeOverlay;
      overlay = new KnowledgeOverlay({
        view,
        requestRender: () => tui.requestRender(),
        close: () => {
          void refreshKnowledgePendingStatus(ctx, sessionId);
          done(undefined);
        },
        onAction: async (action: KnowledgeOverlayAction) => {
          if (action.kind === "refresh") {
            overlay.update(await loadView(true));
            return;
          }
          if (action.kind === "resolve-batch") {
            const current = await loadView(false);
            const byId = new Map(current.candidates.map((c) => [c.candidate.candidate_id, c]));
            const items = action.candidateIds.map((candidateId) => {
              const summary = byId.get(candidateId);
              const target = action.as !== "unique"
                ? (summary?.canonicalId ?? summary?.candidate.reconciliation?.matches[0]?.knowledge_id)
                : undefined;
              return { candidateId, as: action.as, target, reason: action.reason };
            });
            const result = await adapter.resolveMany(sessionId, items);
            overlay.update(await loadView(false));
            if (result.failed.length > 0) {
              throw new Error(
                `resolved ${result.resolved}, failed ${result.failed.length}: `
                + result.failed.map((f) => f.candidateId).join(", "),
              );
            }
            return;
          }
          if (action.kind === "resolve") {
            await adapter.resolve(sessionId, action.candidateId, {
              as: action.as,
              target: action.target,
              reason: action.reason,
            });
          } else if (action.kind === "promote") {
            await adapter.promote(sessionId, { candidates: [action.candidateId] });
          } else if (action.kind === "promote-all") {
            await adapter.promote(sessionId, { all: true });
          }
          overlay.update(await loadView(false));
        },
      });
      return overlay;
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
    });
  }

  pi.registerCommand("maestro-session", {
    description: "Open the canonical Workflow Session control center",
    async handler(_args, ctx) { await openSessionOverlay(ctx); },
  });
  pi.registerCommand("maestro-knowledge", {
    description: "Open the Knowledge center — review session candidates, reconciliation matches, and corpus health",
    async handler(args, ctx) { await openKnowledgeOverlay(ctx, args); },
  });
  pi.registerCommand("maestro-knowledge-stage", {
    description: "Stage a knowledge candidate (spec|knowhow) on the active Run, optionally with an attribution signal. Usage: maestro-knowledge-stage <spec|knowhow> <title> <content> [--category <c>] [--action <propose|reaffirm|supersede|contest>] [--signal <consumed|cited|validated|contradicted> --signal-ids <id1,id2>] [--evidence <ref1,ref2>]",
    async handler(args, ctx) {
      const parsed = parseKnowledgeStageArgs(args);
      if (parsed instanceof Error) {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const snapshot = workflowBridge?.getSnapshot();
      const session = snapshot?.session;
      const run = session ? activeWorkflowRun(snapshot) : undefined;
      const adapter = new KnowledgeCliAdapter(ctx.cwd);
      try {
        const result = await adapter.stage({
          target: parsed.target,
          title: parsed.title,
          content: parsed.content,
          runId: run?.runId,
          sessionId: run ? session?.sessionId : undefined,
          action: parsed.action,
          category: parsed.category,
          signal: parsed.signal,
          signalIds: parsed.signalIds,
          evidence: parsed.evidence,
        });
        const signal = parsed.signal ? `; recorded ${result.signal_recorded} signal(s) as ${parsed.signal}` : "";
        const location = result.run_id
          ? `${result.session_id}/${result.run_id}`
          : `${result.session_id} (session source)`;
        ctx.ui.notify(
          `Staged ${result.candidate_id} on ${location}${signal} `
          + `— review with \"maestro knowledge review ${result.session_id}\"`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
  pi.registerCommand("maestro-knowledge-from-window", {
    description: "Stage a spec/knowhow candidate with explicit distilled content plus evidence from the latest readable entry in this Pi window. Usage: maestro-knowledge-from-window <spec|knowhow> <title> <content> [--category <c>] [--action <propose|reaffirm|supersede|contest>] [--signal <consumed|cited|validated|contradicted> --signal-ids <id1,id2>] [--evidence <ref1,ref2>]",
    async handler(args, ctx) {
      const parsed = parseKnowledgeStageArgs(args);
      if (parsed instanceof Error) {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const snapshot = workflowBridge?.getSnapshot();
      const session = snapshot?.session;
      const run = session ? activeWorkflowRun(snapshot) : undefined;
      const adapter = new KnowledgeCliAdapter(ctx.cwd);
      try {
        const outcome = await stageWindowKnowledgeCandidate(
          ctx,
          workflowHostSessionId(ctx),
          {
            target: parsed.target,
            title: parsed.title,
            content: parsed.content,
            runId: run?.runId,
            sessionId: run ? session?.sessionId : undefined,
            action: parsed.action,
            category: parsed.category,
            signal: parsed.signal,
            signalIds: parsed.signalIds,
            evidence: parsed.evidence,
          },
          options => adapter.stage(options),
        );
        if (!outcome.result) {
          ctx.ui.notify(outcome.reason ?? "No readable transcript entry is available", "error");
          return;
        }
        const result = outcome.result;
        const signal = parsed.signal ? `; recorded ${result.signal_recorded} signal(s) as ${parsed.signal}` : "";
        const location = result.run_id
          ? `${result.session_id}/${result.run_id}`
          : `${result.session_id} (session source)`;
        ctx.ui.notify(
          `Staged ${result.candidate_id} from this Pi window on ${location}${signal} `
          + `— review with "maestro knowledge review ${result.session_id}"`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.registerCommand("maestro-skills", {
    description: "List Maestro CLI skills/steps for the pi platform. Usage: maestro-skills [--steps] [--platform <claude|codex|agent|agy|pi>]",
    async handler(args, ctx) {
      const steps = /--steps\b/.test(args);
      const platform = /--platform\s+(\S+)/.exec(args)?.[1] ?? "pi";
      const adapter = new SkillCliAdapter(ctx.cwd);
      try {
        const entries = await adapter.list({ platform: platform as SkillCliListOptions["platform"], steps });
        const skills = entries.filter((entry) => entry.type === "skill");
        const commands = entries.filter((entry) => entry.type === "command");
        const stepCount = steps ? entries.filter((entry) => entry.type === "step").length : 0;
        const names = [...new Set(skills.map((entry) => entry.name))].slice(0, 12).join(", ");
        ctx.ui.notify(
          `maestro skills (${platform}): ${skills.length} skills · ${commands.length} commands`
          + (stepCount > 0 ? ` · ${stepCount} run-resolvable steps` : "")
          + `${names ? ` — ${names}${skills.length > 12 ? " …" : ""}` : ""}`
          + (entries.length === 0 ? " — CLI found no entries for this platform" : ""),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
  pi.registerCommand("maestro-knowledge-record", {
    description: "Record pure knowledge attribution on the active Run without staging a candidate. Usage: maestro-knowledge-record <knowledge-id...> [--signal <consumed|cited|validated|contradicted>] [--source <search|load|manual>]",
    async handler(args, ctx) {
      const parsed = parseKnowledgeRecordArgs(args);
      if (parsed instanceof Error) {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const snapshot = workflowBridge?.getSnapshot();
      const session = snapshot?.session;
      const run = session ? activeWorkflowRun(snapshot) : undefined;
      const adapter = new KnowledgeCliAdapter(ctx.cwd);
      try {
        const result = await adapter.recordInputs({
          knowledgeIds: parsed.knowledgeIds,
          signal: parsed.signal,
          source: parsed.source,
          runId: run?.runId,
          sessionId: run ? session?.sessionId : undefined,
        });
        ctx.ui.notify(
          `Recorded ${result.recorded} input(s) as ${parsed.signal ?? "consumed"} `
          + `(source ${parsed.source ?? "search"}) on ${result.session_id}/${result.run_id}; `
          + `review with "maestro knowledge review ${result.session_id}"`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
  pi.registerCommand("maestro-todo", {
    description: "Open the shared root and teammate Todo center",
    async handler(_args, ctx) { await openTodoOverlay(ctx); },
  });
  pi.registerCommand("maestro-goal", {
    description: "Open the Goal control center — every goal with full details, switch/stop/resume/clear",
    async handler(_args, ctx) { await openGoalOverlay(ctx); },
  });
  const systemPromptCommand: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  } = {
    description: "Inspect the active system prompt — mode, size, key markers, and Chinese response mode. Use 'full' to dump the whole prompt, 'reload' to re-read SYSTEM.md and resources.",
    async handler(args, ctx) {
      const sub = args.trim().toLowerCase();
      if (sub === "reload") {
        await ctx.reload();
        ctx.ui.notify("Reloaded extensions, skills, prompts, themes, and context files.", "info");
        return;
      }
      const prompt = ctx.getSystemPrompt();
      const opts = ctx.getSystemPromptOptions();
      if (sub === "full") {
        ctx.ui.notify(prompt, "info");
        return;
      }
      const lines = prompt.split("\n");
      const has = (marker: string) => (prompt.includes(marker) ? "yes" : "NO");
      const contextFiles = (opts.contextFiles ?? []).map((f) => f.path);
      const summary = [
        `System prompt: ${prompt.length} chars / ${lines.length} lines`,
        `Mode: ${opts.customPrompt ? "customPrompt (SYSTEM.md or --system-prompt)" : "default base prompt"}`,
        `Chinese response mode: ${chineseResponseMode.isEnabled() ? "enabled" : "disabled"}`,
        `First line: ${lines[0]?.slice(0, 90) ?? "(empty)"}`,
        `Markers:`,
        `  # Project Knowledge Gate       : ${has("# Project Knowledge Gate")}`,
        `  # Engineering                  : ${has("# Engineering")}`,
        `  # Task Tracking                : ${has("# Task Tracking")}`,
        `  # Plan Mode                    : ${has("# Plan Mode")}`,
        `  # Tool Routing                 : ${has("# Tool Routing")}`,
        `  # Teammates                    : ${has("# Teammates")}`,
        `  # Knowledge Operations         : ${has("# Knowledge Operations")}`,
        `  Available tools: (default only): ${has("Available tools:")}`,
        `  <project_instructions>         : ${has("<project_instructions>")}`,
        `  <available_skills>             : ${has("<available_skills>")}`,
        `Context files (${contextFiles.length}): ${contextFiles.join(", ") || "(none)"}`,
      ].join("\n");
      ctx.ui.notify(summary, "info");
    },
  };
  pi.registerCommand("sysprompt", systemPromptCommand);

  pi.registerCommand("export-session-info", {
    description:
      "Show the current session id and where its history (transcript) is stored, and copy it to the clipboard. Pass a destination path to also export a copy of the history file there.",
    async handler(args, ctx) {
      const manager = ctx.sessionManager;
      const info: SessionLocationInfo = {
        sessionId: manager.getSessionId(),
        sessionName: manager.getSessionName(),
        sessionFile: manager.getSessionFile(),
        sessionDir: manager.getSessionDir(),
      };
      const destination = args.trim();
      if (!destination) {
        const status = info.sessionFile ? await probeSessionFile(info.sessionFile) : undefined;
        const report = formatSessionLocation(info, status);
        const copied = await tryCopyToClipboard(report, copyToClipboard);
        const suffix = copied ? "\nCopied to clipboard." : "\n(Clipboard unavailable.)";
        ctx.ui.notify(`${report}${suffix}`, "info");
        return;
      }
      if (!info.sessionFile) {
        ctx.ui.notify("No active session history file to export.", "warning");
        return;
      }
      const status = await probeSessionFile(info.sessionFile);
      if (!status.exists) {
        ctx.ui.notify(`Session history file not found on disk:\n${info.sessionFile}`, "warning");
        return;
      }
      try {
        const target = await resolveExportTarget(destination, info.sessionFile, ctx.cwd);
        const { written, bytes } = await exportSessionHistory(info.sessionFile, target);
        ctx.ui.notify(
          `${formatSessionLocation(info, status)}\nExported to : ${written} (${formatBytes(bytes)})`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // === Statusline ===
  installStatusline(pi, () => state, () =>
    workflowSnapshotForAttachedSession(workflowSnapshotForUi(), attachedWorkflowSessionId),
  );

  // === Maestro Panel (above editor) ===
  let widgetCtx: ExtensionContext | undefined;
  let panelMode: "collapsed" | "expanded" = "collapsed";
  let cockpitOwnsTodo = false;

  function updateTodoWidget(): void {
    const tasks = getVisibleTasks();
    if (guiEvents.isActive()) {
      const todoFp = JSON.stringify(tasks.map((task) => [task.id, task.status, task.subject, task.summary]));
      guiEvents.emitDeduped(GUI_EVENTS.todoUpdated, todoFp, { count: tasks.length, tasks });
      const effectiveMode = isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode;
      guiEvents.emitDeduped(GUI_EVENTS.planMode, effectiveMode, { mode: effectiveMode, isPlanMode: isPlanMode() });
    }
    if (!widgetCtx) return;
    if (cockpitOwnsTodo) {
      widgetCtx.ui.setWidget("todo-panel", undefined);
      return;
    }
    const view = deriveWorkflowViewModel(workflowSnapshotForUi());
    const runs = view?.runs;
    if (tasks.length === 0 && !(runs && runs.length > 0)) {
      widgetCtx.ui.setWidget("todo-panel", undefined);
      return;
    }
    widgetCtx.ui.setWidget("todo-panel", () => ({
      render(width: number): string[] {
        return renderTodoWidget(tasks, panelMode !== "collapsed", width, runs);
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  }

  pi.events.on(COCKPIT_UI_OWNERSHIP_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const ownership = payload as Partial<CockpitUiOwnershipV1>;
    cockpitOwnsTodo = ownership.todo === true;
    setGoalPanelOwnership(ownership.goal === true, widgetCtx);
    setGoalStaticMode(ownership.static === true);
    setQuietMode(ownership.quiet === true, ownership.quietSymbols);
    if (typeof ownership.todoExpanded === "boolean") {
      panelMode = ownership.todoExpanded ? "expanded" : "collapsed";
    }
    updateTodoWidget();
  });

  pi.events.on(COCKPIT_INPUT_TARGET_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") {
      setInputRouteTarget(undefined);
      return;
    }
    const target = payload as Partial<CockpitInputTargetV1>;
    const sigil = target.sigil ?? "@";
    if (target.version !== 1 || typeof target.label !== "string" || !target.label.trim()
      || typeof target.color !== "string" || !INPUT_TARGET_COLORS.has(target.color as ThemeColor)
      || (sigil !== "@" && sigil !== "#")) {
      setInputRouteTarget(undefined);
      return;
    }
    setInputRouteTarget({ label: target.label.trim(), color: target.color as ThemeColor, sigil });
  });

  pi.registerShortcut(TODO_TOGGLE_KEY, {
    description: "Toggle the inline Todo panel (collapsed ↔ expanded); use /maestro-todo for the full center",
    async handler(_ctx: ExtensionContext) {
      panelMode = panelMode === "collapsed" ? "expanded" : "collapsed";
      if (cockpitOwnsTodo) {
        pi.events.emit(COCKPIT_TODO_TOGGLE_EVENT, { expanded: panelMode === "expanded" });
      }
      updateTodoWidget();
    },
  });

  pi.registerShortcut(GOAL_OVERLAY_KEY, {
    description: `Open the Goal overlay (${GOAL_OVERLAY_LABEL}) — full details for every goal, switch/stop/resume/clear`,
    async handler(ctx: ExtensionContext) {
      await openGoalOverlay(ctx);
    },
  });

  // === Session lifecycle ===
  pi.on("session_start", async (event, ctx) => {
    const guiGeneration = ++guiLifecycleGeneration;
    const previousGuiServer = guiServer;
    guiServer = null;
    guiEvents.bind(null);
    previousGuiServer?.close("session-restart");
    maestroUiPublisher.beginSession();
    maestroUiSessionActive = true;
    await disposeTeammateSessionRegistrations();
    state.baseCwd = ctx.cwd;
    // K9: inject the host session identity into the process environment so all
    // maestro CLI subprocesses can resolve knowledge write authority via the
    // lease/channel tiers. Env-only by design (no capability probe, no new CLI
    // flag): older CLIs simply ignore it and degrade to prior behavior.
    try {
      const hostSessionId = workflowHostSessionId(ctx);
      if (hostSessionId) process.env.PI_HOST_SESSION_ID = hostSessionId;
      else delete process.env.PI_HOST_SESSION_ID;
    } catch {
      // Identity injection is best-effort; resolution falls back to other tiers.
    }
    await inputHistorySessionStart(ctx);
    compactionArbiter.reset();
    preserveCompletedTurnFromNativeThreshold = false;
    teammateAttachTodoIsolated = false;
    midTurnAutoCompaction.onSessionStart(ctx, event);
    todoRootContext = ctx;
    widgetCtx = ctx;
    panelMode = "collapsed";
    await goalSessionStart(ctx, event);
    const restoredGoal = getActiveGoal();
    workflowSessionOptedIn = false;
    todoSessionStart(ctx);
    try {
      recoverPendingGoalTodoDetachesAfterTodoStart(ctx);
    } catch (error) {
      ctx.ui.notify(`Goal cleanup recovery remains pending: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    workflowBridge = new WorkflowBridge(ctx.cwd);
    workflowCoordinator = WorkflowCoordinator.create(
      workflowBridge,
      new RunCliAdapter(ctx.cwd),
      ctx.cwd,
    );
    setWorkflowCoordinator(workflowCoordinator);
    const snapshot = await workflowBridge.refresh();
    workflowSessionOptedIn = shouldRestoreWorkflowGoal(event.reason, restoredGoal, snapshot);
    if (workflowSessionOptedIn && snapshot) reconcileWorkflowGoal(snapshot, ctx);
    if (snapshot && shouldActivateWorkflowSession(snapshot, workflowSessionOptedIn)) {
      if (await attachWorkflowSession(ctx, snapshot)) {
        await refreshWorkflow(ctx, true, false, true);
        const recovery = workflowRecoveryIdentity();
        if (recovery) {
          pi.sendMessage({
            customType: "workflow-attach",
            content: `Attached canonical Workflow Session ${recovery.sessionId} at Run ${recovery.runId}.`,
            display: false,
            details: recovery,
          });
        }
      } else {
        await refreshWorkflow(ctx);
      }
    } else {
      await refreshWorkflow(ctx);
    }
    await onSessionStartPlan(ctx);
    const configuredMode = await permissionController.reload(ctx);
    if (configuredMode === "plan" && !isPlanMode()) await planToggleMode(ctx);
    if (configuredMode) approvalMode = configuredMode;
    syncApprovalModeStatus(ctx, approvalMode);
    updateTodoWidget();
    publishMaestroUi();
    await activateTeammateSessionRegistrations(ctx);
    if (guiEnabled()) {
      const guiSessionId =
        (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? "unknown";
      const getGuiCtx = () => guiContextForGeneration(
        ctx,
        guiGeneration,
        guiLifecycleGeneration,
        todoRootContext,
      );
      const startedGuiServer = await startGuiSubsystem({
        sessionId: guiSessionId,
        cwd: ctx.cwd,
        getHealth: () => ({ approvalMode }),
        listAllTools: () => pi.getAllTools(),
        gateway: buildGuiPermissionGateway(ctx),
        getCtx: getGuiCtx,
        isCurrent: () => getGuiCtx() !== undefined,
        stateProviders: {
          workflow: () => deriveWorkflowViewModel(workflowSnapshotForUi()),
          todos: () => getVisibleTasks(),
          goal: () => getActiveGoal(),
          plan: () => ({
            mode: getPlanMode(),
            isPlanMode: isPlanMode(),
            hasPlan: hasPlan(),
            text: getPlanText(),
            handoffStatus: getPlanHandoffStatus(),
          }),
          teammates: async () => {
            const entry = getGuiTool("teammate-list");
            if (!entry) return null;
            const result = await entry.execute(
              "gui-state-teammates",
              { view: "active" } as never,
              undefined,
              undefined,
              ctx,
            );
            return (result.details as { agents?: unknown } | undefined)?.agents ?? null;
          },
          swarm: () => loadLatestTeamSwarmProjection(ctx.cwd) ?? null,
          approvalMode: () => effectivePermissionMode(approvalMode),
          sessionId: () => guiSessionId,
        },
      });
      bindGuiStartupIfCurrent(
        startedGuiServer,
        guiGeneration,
        guiLifecycleGeneration,
        (server) => {
          guiServer = server;
          guiEvents.bind(server);
        },
      );
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "quit" || event.reason === "reload") disposeTuiLocaleEvents();
    guiLifecycleGeneration += 1;
    const closingGuiServer = guiServer;
    guiServer = null;
    guiEvents.bind(null);
    closingGuiServer?.close("session-shutdown");
    maestroUiSessionActive = false;
    maestroUiPublisher.clear();
    await disposeTeammateSessionRegistrations();
    // Fence callbacks and leases before the first await so teardown cannot
    // enqueue continuation work into the departing session.
    midTurnAutoCompaction.onSessionShutdown(ctx);
    preserveCompletedTurnFromNativeThreshold = false;
    lastCompactionCancel = undefined;
    compactionArbiter.reset();
    await inputHistorySessionShutdown();
    // Non-destructive: preserve the prune manifest and spill resources so a
    // resumed session replays the identical transformed prefix. Destructive
    // teardown stays with reset()/onCompact().
    state.activeToolCalls.clear();
    widgetCtx?.ui.setWidget("todo-panel", undefined);
    widgetCtx = undefined;
    todoRootContext = undefined;
    // Keep the cwd captured by the initial teammate tool_result: detached work
    // may publish its completion after the session context has shut down.
    panelMode = "collapsed";
    goalSessionShutdown(ctx);
    todoSessionShutdown(ctx);
    await workflowCoordinator?.release();
    attachedWorkflowSessionId = undefined;
    attachedWorkflowHostSessionId = undefined;
    workflowCoordinator = undefined;
    workflowBridge = undefined;
    workflowSessionOptedIn = true;
    lastRunStates.clear();
    setWorkflowCoordinator(undefined);
    onSessionShutdownPlan(ctx);
    ctx.ui.setStatus("approval-mode", undefined);
    await shutdownIntelligenceTools();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const request = compactionRequestFromInstructions(event.customInstructions);
    const isRecoveryFallback = isNativeFallbackCompactionInstructions(event.customInstructions);
    const cancelCompletedTurnThreshold = shouldCancelCompletedTurnThreshold(
      event.reason,
      preserveCompletedTurnFromNativeThreshold,
      request !== undefined,
      Boolean(ctx.hasPendingMessages?.()),
      isRecoveryFallback,
      midTurnAutoCompaction.hasPendingTakeover(),
    );
    if (cancelCompletedTurnThreshold) {
      const retainNative = midTurnAutoCompaction.shouldRetainNativeThreshold(ctx);
      preserveCompletedTurnFromNativeThreshold = false;
      if (retainNative) {
        lastCompactionCancel = undefined;
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, "CTX CRITICAL → NATIVE");
          ctx.ui.notify(
            "Native threshold compaction retained because provider output headroom is exhausted.",
            "info",
          );
        } catch { /* native ownership remains authoritative */ }
      } else {
        const breakerPause = midTurnAutoCompaction.describeBreakerPause();
        lastCompactionCancel = {
          reason: breakerPause
            ? `completed-turn preservation (deferred; ${breakerPause})`
            : "completed-turn preservation (deferred to maestro settle)",
          at: Date.now(),
        };
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, breakerPause ? "CTX DEFERRED (BREAKER)" : "CTX DEFERRED → SETTLE");
          ctx.ui.notify(
            breakerPause
              ? `Native threshold compaction deferred: ${breakerPause}.`
              : "Native threshold compaction deferred: the turn completed cleanly; maestro compaction will run at agent settle.",
            "info",
          );
        } catch { /* status/notification are best-effort; cancellation stays authoritative */ }
        return { cancel: true };
      }
    }
    const observed = compactionArbiter.observeStart(
      request,
      event.signal,
    );
    if (!observed.allowed) {
      const activeOwner = compactionArbiter.currentOwner();
      const tombstone = compactionArbiter.timeoutTombstone();
      const reason = activeOwner
        ? `arbiter denied: a ${activeOwner} compaction is already active`
        : tombstone
          ? "arbiter denied: a timed-out compaction may still be settling"
          : "arbiter denied: stale or mismatched compaction request";
      lastCompactionCancel = {
        reason,
        at: Date.now(),
        operationId: observed.operationId,
      };
      try {
        ctx.ui.notify(
          activeOwner
            ? `Auto-compaction skipped: a ${activeOwner} compaction is already active.`
            : tombstone
              ? `Auto-compaction skipped: a timed-out compaction may still be settling (~${Math.ceil(tombstone.remainingMs / 1000)}s hold left).`
              : "Auto-compaction skipped: the compaction request no longer matches the active lease.",
          "info",
        );
      } catch { /* best-effort */ }
      return { cancel: true };
    }
    const providerPressureRecovery = isProviderPressureCompactionTrigger(observed.trigger);
    try {
      const result = await runObservedCompaction(observed, async () => {
        goalBeforeCompact(ctx);
        const cleanContextRequest = observed.trigger?.owner === "plan-handoff"
          && observed.trigger.reason === "clean-context"
          && isPlanCleanContextCompactionInstructions(event.customInstructions)
          ? consumePlanCleanContextCompaction()
          : undefined;
        if (observed.trigger?.owner === "plan-handoff" && observed.trigger.reason === "clean-context") {
          if (!cleanContextRequest) {
            ctx.ui.notify("Approved Plan context reset was cancelled because its payload was unavailable.", "warning");
            lastCompactionCancel = {
              reason: "plan clean-context payload unavailable",
              at: Date.now(),
              operationId: observed.operationId,
            };
            return { cancel: true };
          }
          const compaction = await runWithCompactionStatus(event, ctx, () =>
            createMaestroCompaction(event, ctx, {
              getWorkflowIdentity: () => workflowRecoveryIdentity(),
              trigger: observed.trigger,
              summaryOverride: cleanContextRequest.summary,
              firstKeptEntryIdOverride: cleanContextRequest.firstKeptEntryId,
            }), observed);
          return compaction?.compaction ? compaction : { cancel: true };
        }

        applyPlanContextToCompaction(
          event.preparation,
          buildSessionContext(event.branchEntries).messages,
        );

        const projected = await midTurnAutoCompaction.projectCompactionInput(event, ctx);
        commitProjectedCompactionInput(event, projected);
        return await runWithCompactionStatus(event, ctx, () =>
          createMaestroCompaction(event, ctx, {
            getWorkflowIdentity: () => workflowRecoveryIdentity(),
            trigger: observed.trigger,
            summaryInputTokens: projected.estimatedInputTokens,
            failClosed: providerPressureRecovery,
          }), observed);
      });
      if (result?.cancel) {
        observed.finalize("cancel");
        if (lastCompactionCancel?.operationId !== observed.operationId) {
          lastCompactionCancel = {
            reason: providerPressureRecovery
              ? "provider-pressure recovery failed (fail-closed; native fallback blocked)"
              : "maestro compaction declined (see notification)",
            at: Date.now(),
            operationId: observed.operationId,
          };
        }
        if (providerPressureRecovery) {
          try { goalCompactionCancelled(ctx); } catch { /* cancellation remains authoritative */ }
        } else {
          goalCompactionCancelled(ctx);
        }
      }
      return result;
    } catch (error) {
      observed.finalize("error");
      if (providerPressureRecovery) {
        try { goalCompactionCancelled(ctx); } catch { /* cancellation remains authoritative */ }
        try {
          ctx.ui.notify(
            `Provider-pressure compaction failed; native fallback was blocked: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } catch { /* cancellation remains authoritative */ }
        lastCompactionCancel = {
          reason: "provider-pressure recovery failed (fail-closed; native fallback blocked)",
          at: Date.now(),
          operationId: observed.operationId,
        };
        return { cancel: true };
      }
      goalCompactionCancelled(ctx);
      ctx.ui.notify(
        `Compaction failed; falling back to Pi native compaction: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  });

  // agent:// data source: capture teammate structured outputs when the tool
  // result arrives (foreground) or the authoritative completion event fires
  // (background/detached, whose root tool_result carries empty results).
  pi.on("tool_result", (event, ctx) => {
    if ((event as { toolName?: unknown }).toolName !== "teammate") return;
    try {
      const details = (event as { details?: unknown }).details as
        | { results?: unknown; progress?: unknown }
        | undefined;
      void persistStructuredResults(
        compatibilityResults(details?.results),
        details?.progress,
        ctx.cwd,
      ).catch((err) => {
        console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      console.warn(`[pi-maestro-flow] agent output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const completedOwner = compactionArbiter.currentOwner();
    compactionArbiter.complete("success");
    midTurnAutoCompaction.onCompact(completedOwner, ctx);
    // Clear the non-persistent Plan replacement before any async subsystem can
    // enqueue a continuation or fail. The persisted compaction is now canonical.
    onCompactPlan(ctx);
    try {
      await persistMaestroCompactionKnowhow(event, ctx);
    } catch (error) {
      ctx.ui.notify(
        `Compaction checkpoint was saved in the session but the knowhow copy failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    await goalCompact(event, ctx, { deferContinuation: true });
  });

  pi.on("input", (event) => {
    return goalInput(event);
  });

  // A hard-threshold intent must settle before the next tool executes. The
  // guard blocks (+ terminates) the tool batch here without abort(); agent_settled
  // owns the actual compact() and CONTINUE resume. Returning block/terminate
  // avoids the host "This operation was aborted" error that stranded recovery.
  pi.on("tool_call", (_event, ctx) => midTurnAutoCompaction.onToolCall(ctx));

  // Keep the tool panel stable for prompt-cache reuse; this hook enforces the hard
  // read-only boundary until Plan approval, before the interactive permission chain.
  pi.on("tool_call", (event) => onToolCallPlan(event, approvalMode === "bypassPermissions"));

  pi.on("before_agent_start", async (event) => {
    // Pick up compaction settings edited while idle; cached again within the turn.
    midTurnAutoCompaction.refreshSettings();
    // Plan owns the stable mode prompt; Goal only acknowledges continuation markers.
    const planResult = onBeforeAgentStartPlan(event);
    goalBeforeAgentStart(event);
    const todoResult = await onBeforeAgentStartTodo({
      systemPrompt: planResult?.systemPrompt ?? event.systemPrompt,
    });
    const base = todoResult?.systemPrompt ?? planResult?.systemPrompt ?? event.systemPrompt;
    return { systemPrompt: `${base}\n\n${RESOURCE_TOOL_GUIDANCE}` };
  });

  pi.on("context", async (event, ctx) => {
    if (!teammateAttachTodoIsolated) {
      const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string }>;
      if (branch.some((entry) => entry.type === "custom" && entry.customType === TEAMMATE_ATTACH_ENTRY)) {
        isolateTodoForTeammateAttach();
        teammateAttachTodoIsolated = true;
      }
    }
    const planResult = onContextPlan(event.messages);
    const todoResult = await onContextTodo(planResult?.messages ?? event.messages);
    const messages = todoResult?.messages ?? planResult?.messages ?? event.messages;
    let pressureMessages: AgentMessage[] | undefined;
    try {
      pressureMessages = await midTurnAutoCompaction.evaluate(messages, ctx);
    } catch (error) {
      // The context transform must never take down the request: fall back to
      // the plain messages and surface the failure instead of throwing.
      ctx.ui.notify(
        `Mid-turn pressure evaluation failed; continuing without pruning: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    if (pressureMessages) return { messages: pressureMessages };
    return todoResult ?? planResult;
  });

  pi.on("before_provider_request", (event, ctx) =>
    midTurnAutoCompaction.beforeProviderRequest(event.payload, ctx));

  // Eight independent end-of-turn side effects across five subsystems. Chained bare, the
  // first throw skips every step after it — so a Goal failure would silently leave the
  // Todo widget stale and mid-turn compaction bookkeeping unrun, with no clue which
  // subsystem broke. Isolate each step and name it in the warning instead.
  pi.on("agent_end", async (event, ctx) => {
    const syntheticInterruption = midTurnAutoCompaction.isSyntheticCompactionInterruptionActive();
    const step = async (label: string, run: () => unknown) => {
      try {
        await run();
      } catch (error) {
        ctx.ui.notify(
          `${label} failed at the end of the turn: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    };
    await step("Plan", () => onAgentEndPlan(event, ctx));
    await step("Workflow refresh", () => refreshWorkflow(ctx, true));
    if (!syntheticInterruption) {
      await step("Goal attempt", () => goalAgentEnd(event, ctx));
    }
    await step("Output-limit compaction", () =>
      midTurnAutoCompaction.onOutputLimit(event.messages as AgentMessage[], ctx));
    await step("Goal change event", () => emitGoalChanged());
    await step("Todo", () => onAgentEndTodo());
    preserveCompletedTurnFromNativeThreshold = shouldPreserveCompletedTurn(
      event.messages as AgentMessage[],
      Boolean(ctx.hasPendingMessages?.()),
    );
    await step("Todo widget", () => updateTodoWidget());
  });

  // Model failover registered its agent_settled arbiter before this consolidated
  // root handler. Goal therefore consumes the authoritative settlement first,
  // then compaction can safely act on the resulting continuation state.
  pi.on("agent_settled", async (_event, ctx) => {
    const syntheticInterruption = midTurnAutoCompaction.isSyntheticCompactionInterruptionActive();
    try {
      if (syntheticInterruption) goalProviderPressureSettled(ctx);
      else await goalAgentSettled(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Goal settlement failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    try {
      emitGoalChanged();
    } catch (error) {
      ctx.ui.notify(
        `Goal change event failed after settlement: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    try {
      await midTurnAutoCompaction.onAgentEnd(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Settled context compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    } finally {
      preserveCompletedTurnFromNativeThreshold = false;
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "todo") updateTodoWidget();
    if (event.toolName === "goal") emitGoalChanged();
    const command = event.toolName === "bash"
      ? String((event as { input?: { command?: unknown } }).input?.command ?? "")
      : "";
    // Knowledge evolution operations (record/stage/promote/review/load/search)
    // change attribution or candidates; refresh the UI snapshot and GUI state so
    // the current Session's knowledge view stays live.
    if (event.toolName === "bash" && /\bmaestro\s+(?:knowledge\s+(?:record|stage|promote|review|reconcile)|load|search)\b/.test(command)) {
      guiEvents.emit(GUI_EVENTS.stateChanged, { subsystem: "knowledge", at: Date.now() });
      publishMaestroUi();
    }
    if (event.toolName === "run-control" || /\bmaestro\s+(?:run|ralph)\b/.test(command)) {
      const runControlArgv = event.toolName === "run-control"
        ? Array.isArray((event as { input?: { argv?: unknown } }).input?.argv)
          ? ((event as { input?: { argv?: unknown } }).input!.argv as unknown[]).map(String)
          : []
        : [];
      const allowOptIn = event.toolName === "run-control"
        ? Boolean(runControlArgv.length && !isRunControlReadArgv(runControlArgv))
        : isWorkflowOptInCommand(command);
      await refreshWorkflow(ctx, true, allowOptIn, allowOptIn);
    }
  });

  // Hook denial runs after Plan's advisory tool_call pass and before the interactive prompt.
  const hookAdapter = registerCodexHookAdapter(pi, {
    getPermissionMode: () => effectivePermissionMode(approvalMode),
    shouldSkipStopHook: () => midTurnAutoCompaction.shouldSkipStopHook(),
    onCompactionCancelled: () => {
      compactionArbiter.complete("cancel");
      goalCompactionCancelled();
      lastCompactionCancel = {
        reason: "PreCompact hook rejected the compaction",
        at: Date.now(),
      };
    },
  });
  const requireFlowSettingsContext = (surface: string): ExtensionContext | undefined => {
    const ctx = flowSettingsContext;
    if (!ctx) console.error(`[maestro] Cannot open ${surface}: no active Flow session context`);
    else if (!ctx.hasUI) ctx.ui.notify(flowTuiText("surface.needTui", { surface }), "warning");
    return ctx?.hasUI ? ctx : undefined;
  };
  /** Run an action with a unified status-line lifecycle (set before, clear after). */
  const withActionStatus = async (status: string, run: (ctx: ExtensionContext) => Promise<string | void> | string | void): Promise<string | void> => {
    const ctx = requireFlowSettingsContext(status);
    if (!ctx) return undefined;
    ctx.ui.setStatus("maestro-settings", status);
    try {
      return await run(ctx);
    } finally {
      ctx.ui.setStatus("maestro-settings", undefined);
    }
  };
  const flowSettingsProvider = createFlowSettingsProvider({
    getAgentResponseLanguage: () => chineseResponseMode.isEnabled() ? "zh-CN" : "default",
    getPermissionOverview: () => permissionController.overview(effectivePermissionMode(approvalMode)),
    actions: {
      "compaction.manage": () => withActionStatus(flowTuiText("compaction.opening"), async (ctx) => {
        await showCompactionSettingsOverlay(ctx as ExtensionCommandContext);
      }),
      "failover.manage": () => withActionStatus(flowTuiText("failover.opening"), async (ctx) => {
        await showModelFailoverOverlay(ctx, sharedModelCircuitBreaker);
      }),
      "responseLanguage.manage": () => withActionStatus(flowTuiText("response.opening"), async (ctx) => {
        chineseResponseMode.toggle(ctx);
        return chineseResponseMode.isEnabled() ? flowTuiText("response.zh") : flowTuiText("response.default");
      }),
      "skills.manage": () => withActionStatus(flowTuiText("skills.opening"), async (ctx) => {
        const result = await runSkillManager(ctx, new SkillManagerStore(ctx.cwd));
        if (result.configChanged) ctx.ui.notify(flowTuiText("skills.reload"), "info");
      }),
      "mcp.manage": () => withActionStatus(flowTuiText("mcp.opening"), async (ctx) => {
        if (mcpAdapterHandle) await mcpAdapterHandle.openManager(ctx);
        else ctx.ui.notify(flowTuiText("mcp.unavailable"), "warning");
      }),
      "hooks.manage": () => withActionStatus(flowTuiText("hooks.opening"), async (ctx) => {
        await hookAdapter.openSettings(ctx);
      }),
    },
  });
  // Settings providers re-register at each session boundary so a host reload
  // cannot accumulate stale shared-bus listeners from previous instances
  // (see issue ISS-20260803-005; cockpit follows the same pattern).
  let flowSettingsDisposer: (() => void) | undefined;
  const registerFlowSettings = (): void => {
    if (flowSettingsDisposer) return;
    flowSettingsDisposer = registerFlowSettingsProvider(pi.events, flowSettingsProvider);
  };
  const disposeFlowSettings = (): void => {
    flowSettingsDisposer?.();
    flowSettingsDisposer = undefined;
  };
  const openApiManager = async (args: string, surface: string): Promise<void> => {
    const ctx = requireFlowSettingsContext(surface);
    if (!ctx) return;
    if (!apiProviderHandle) {
      ctx.ui.notify("API provider manager is unavailable.", "warning");
      return;
    }
    ctx.ui.setStatus("maestro-settings", `正在打开 ${surface}…`);
    try {
      await apiProviderHandle.openManager(ctx as ExtensionCommandContext, args);
    } finally {
      ctx.ui.setStatus("maestro-settings", undefined);
    }
  };
  const apiManagerSettingsProvider = createApiManagerSettingsProvider({
    actions: {
      "api.manage": () => openApiManager("", "API provider manager"),
      "api.configure": () => openApiManager("configure", "API provider editor"),
      "api.retry": () => openApiManager("retry", "API retry settings"),
      "api.cache": () => openApiManager("cache", "Prompt cache policy"),
      "api.list": () => openApiManager("list", "API provider overview"),
    },
  });
  let apiManagerSettingsDisposer: (() => void) | undefined;
  const registerApiManagerSettings = (): void => {
    if (apiManagerSettingsDisposer) return;
    apiManagerSettingsDisposer = registerApiManagerSettingsProvider(pi.events, apiManagerSettingsProvider);
  };
  const disposeApiManagerSettings = (): void => {
    apiManagerSettingsDisposer?.();
    apiManagerSettingsDisposer = undefined;
  };
  // Provider-only registrations: mcp/skills/smart-search expose their managed
  // state through the settings shell without a legacy action surface.
  const mcpSettingsProvider = createMcpSettingsProvider({});
  let mcpSettingsDisposer: (() => void) | undefined;
  const registerMcpSettings = (): void => {
    if (mcpSettingsDisposer) return;
    mcpSettingsDisposer = registerMcpSettingsProvider(pi.events, mcpSettingsProvider);
  };
  const disposeMcpSettings = (): void => {
    mcpSettingsDisposer?.();
    mcpSettingsDisposer = undefined;
  };
  const skillsSettingsProvider = createSkillsSettingsProvider({});
  let skillsSettingsDisposer: (() => void) | undefined;
  const registerSkillsSettings = (): void => {
    if (skillsSettingsDisposer) return;
    skillsSettingsDisposer = registerSkillsSettingsProvider(pi.events, skillsSettingsProvider);
  };
  const disposeSkillsSettings = (): void => {
    skillsSettingsDisposer?.();
    skillsSettingsDisposer = undefined;
  };
  const smartSearchSettingsProvider = createSmartSearchSettingsProvider({});
  let smartSearchSettingsDisposer: (() => void) | undefined;
  const registerSmartSearchSettings = (): void => {
    if (smartSearchSettingsDisposer) return;
    smartSearchSettingsDisposer = registerSmartSearchSettingsProvider(pi.events, smartSearchSettingsProvider);
  };
  const disposeSmartSearchSettings = (): void => {
    smartSearchSettingsDisposer?.();
    smartSearchSettingsDisposer = undefined;
  };

  const visionDelegationSettingsProvider = createVisionDelegationSettingsProvider({});
  let visionDelegationSettingsDisposer: (() => void) | undefined;
  const registerVisionDelegationSettings = (): void => {
    if (visionDelegationSettingsDisposer) return;
    visionDelegationSettingsDisposer = registerVisionDelegationSettingsProvider(pi.events, visionDelegationSettingsProvider);
  };
  const disposeVisionDelegationSettings = (): void => {
    visionDelegationSettingsDisposer?.();
    visionDelegationSettingsDisposer = undefined;
  };

  const exploreSettingsProvider = createExploreSettingsProvider({});
  let exploreSettingsDisposer: (() => void) | undefined;
  const registerExploreSettings = (): void => {
    if (exploreSettingsDisposer) return;
    exploreSettingsDisposer = registerExploreSettingsProvider(pi.events, exploreSettingsProvider);
  };
  const disposeExploreSettings = (): void => {
    exploreSettingsDisposer?.();
    exploreSettingsDisposer = undefined;
  };

  const hooksSettingsProvider = createHooksSettingsProvider({});
  let hooksSettingsDisposer: (() => void) | undefined;
  const registerHooksSettings = (): void => {
    if (hooksSettingsDisposer) return;
    hooksSettingsDisposer = registerHooksSettingsProvider(pi.events, hooksSettingsProvider);
  };
  const disposeHooksSettings = (): void => {
    hooksSettingsDisposer?.();
    hooksSettingsDisposer = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    flowSettingsContext = ctx;
    registerFlowSettings();
    registerApiManagerSettings();
    registerMcpSettings();
    registerSkillsSettings();
    registerSmartSearchSettings();
    registerVisionDelegationSettings();
    registerExploreSettings();
    registerHooksSettings();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (flowSettingsContext === ctx) flowSettingsContext = undefined;
    disposeFlowSettings();
    disposeApiManagerSettings();
    disposeMcpSettings();
    disposeSkillsSettings();
    disposeSmartSearchSettings();
    disposeVisionDelegationSettings();
    disposeExploreSettings();
    disposeHooksSettings();
  });

  const teammatePermissionBroker: TeammatePermissionBroker = async (call, ctx) => {
    const planBlock = onToolCallPlan(call, approvalMode === "bypassPermissions");
    if (planBlock) return { action: "deny", reason: planBlock.reason };
    // CV-01: child tools must not hit Lead hard-gate — mark expertsCaller=expert.
    const hookBlock = await hookAdapter.beforeToolCall(
      { ...call, expertsCaller: "expert" as const },
      ctx,
    );
    if (hookBlock) return { action: "deny", reason: hookBlock.reason };
    const block = await permissionController.authorize(
      call,
      ctx,
      effectivePermissionMode(approvalMode),
      hookAdapter,
    );
    if (block) return { action: "deny", reason: block.reason };
    return { action: "allow_once" as const, updatedInput: call.input };
  };

  // UCL permission gateway: GUI tool invocation runs the exact same chain as the
  // LLM tool-call path (advisory plan pass -> codex hooks -> authorize). The
  // interactive approval prompt (ctx.ui.select) surfaces over RPC as
  // extension_ui_request for the GUI to answer.
  function buildGuiPermissionGateway(ctx: ExtensionContext): GuiPermissionGateway {
    const mode = (): PermissionMode => effectivePermissionMode(approvalMode);
    return {
      mode,
      authorize: async (toolName, input, signal) => {
        signal.throwIfAborted();
        const call = { toolName, input };
        const planBlock = onToolCallPlan(call, approvalMode === "bypassPermissions");
        if (planBlock) return { block: true, reason: planBlock.reason };
        // GUI path is Leader-originated; keep default expertsCaller=leader.
        const hookBlock = await hookAdapter.beforeToolCall(call, ctx);
        signal.throwIfAborted();
        if (hookBlock) return { block: true, reason: hookBlock.reason };
        const block = await permissionController.authorize(call, ctx, mode(), hookAdapter);
        signal.throwIfAborted();
        if (block) return { block: true, reason: block.reason };
        return undefined;
      },
    };
  }

  async function activateTeammateSessionRegistrations(ctx: ExtensionContext): Promise<void> {
    await disposeTeammateSessionRegistrations();
    const generation = ++teammateRegistrationGeneration;
    const nextDisposers: Array<() => void> = [];
    try {
      // Teammates run in separate Pi processes. This registration is scoped to
      // the live root session so a reload cannot retain a stale child surface.
      nextDisposers.push(registerTeammateChildExtension(teammateExtensionPath, {
        tools: MAESTRO_CHILD_TOOL_NAMES,
      }));
      nextDisposers.push(registerTeammateChildToolBroker("todo", async (request) => {
        if (generation !== teammateRegistrationGeneration || todoRootContext !== ctx) {
          return {
            content: [{ type: "text", text: "Root Todo authority belongs to a newer session generation." }],
            isError: true,
            details: {},
          };
        }
        return childTodoBroker(request);
      }, { owner: `${teammateAuthorityOwner}:todo` }));
      nextDisposers.push(registerTeammateChildToolBroker("browser", async (request) => {
        if (generation !== teammateRegistrationGeneration || todoRootContext !== ctx) {
          return {
            content: [{ type: "text", text: "Root browser authority belongs to a newer session generation." }],
            isError: true,
            details: {},
          };
        }
        return childBrowserBroker.execute(request, ctx);
      }, { owner: `${teammateAuthorityOwner}:browser` }));
      const sessionPermissionBroker: TeammatePermissionBroker = async (call, requestCtx) => {
        if (generation !== teammateRegistrationGeneration) {
          return { action: "deny", reason: "Root permission authority belongs to a newer session generation." };
        }
        return teammatePermissionBroker(call, requestCtx);
      };
      nextDisposers.push(registerTeammatePermissionBroker(
        sessionPermissionBroker,
        { owner: `${teammateAuthorityOwner}:permission` },
      ));
      teammateRegistrationDisposers = nextDisposers;
    } catch (error) {
      for (const dispose of nextDisposers.reverse()) dispose();
      teammateRegistrationGeneration++;
      throw error;
    }
  }

  async function disposeTeammateSessionRegistrations(): Promise<void> {
    teammateRegistrationGeneration++;
    const disposers = teammateRegistrationDisposers;
    teammateRegistrationDisposers = [];
    for (const dispose of disposers.reverse()) dispose();
    trackChildBrowserCleanup(childBrowserBroker.closeAll());
    await Promise.all([...childBrowserCleanups]);
  }

  pi.on("tool_call", async (event, ctx) => permissionController.authorize(
    event,
    ctx,
    effectivePermissionMode(approvalMode),
    hookAdapter,
  ));
}

/**
 * Teammate children inherit this extension for interaction and permission RPC.
 * They must not register the root Workflow/Goal/Todo lifecycle because only the
 * parent Pi session may own the canonical continuation lease.
 */
function registerMaestroChildSurface(pi: ExtensionAPI): void {
  const compactionArbiter = new CompactionArbiter();
  const autoCompaction = createMidTurnAutoCompaction(pi, { arbiter: compactionArbiter });
  let preserveCompletedTurnFromNativeThreshold = false;

  pi.on("session_start", (event, ctx) => {
    preserveCompletedTurnFromNativeThreshold = false;
    compactionArbiter.reset();
    autoCompaction.onSessionStart(ctx, event);
  });
  // Child sessions share the same hard-threshold gate: block+terminate, never abort.
  pi.on("tool_call", (_event, ctx) => autoCompaction.onToolCall(ctx));
  pi.on("context", async (event, ctx) => {
    try {
      const messages = await autoCompaction.evaluate(event.messages, ctx);
      return messages ? { messages } : undefined;
    } catch (error) {
      ctx.ui.notify(
        `Mid-turn pressure evaluation failed; continuing without pruning: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  });
  pi.on("before_provider_request", (event, ctx) =>
    autoCompaction.beforeProviderRequest(event.payload, ctx));
  pi.on("agent_end", async (event, ctx) => {
    try {
      await autoCompaction.onOutputLimit(event.messages as AgentMessage[], ctx);
    } catch (error) {
      ctx.ui.notify(
        `Child output-limit compaction failed at the end of the turn: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    preserveCompletedTurnFromNativeThreshold = shouldPreserveCompletedTurn(
      event.messages as AgentMessage[],
      Boolean(ctx.hasPendingMessages?.()),
    );
  });
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      await autoCompaction.onAgentEnd(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Child settled context compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    } finally {
      preserveCompletedTurnFromNativeThreshold = false;
    }
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const request = compactionRequestFromInstructions(event.customInstructions);
    const isRecoveryFallback = isNativeFallbackCompactionInstructions(event.customInstructions);
    const cancelCompletedTurnThreshold = shouldCancelCompletedTurnThreshold(
      event.reason,
      preserveCompletedTurnFromNativeThreshold,
      request !== undefined,
      Boolean(ctx.hasPendingMessages?.()),
      isRecoveryFallback,
      autoCompaction.hasPendingTakeover(),
    );
    if (cancelCompletedTurnThreshold) {
      const retainNative = autoCompaction.shouldRetainNativeThreshold(ctx);
      preserveCompletedTurnFromNativeThreshold = false;
      if (retainNative) {
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, "CTX CRITICAL → NATIVE");
          ctx.ui.notify(
            "Native threshold compaction retained because provider output headroom is exhausted.",
            "info",
          );
        } catch { /* native ownership remains authoritative */ }
      } else {
        const breakerPause = autoCompaction.describeBreakerPause();
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, breakerPause ? "CTX DEFERRED (BREAKER)" : "CTX DEFERRED → SETTLE");
          ctx.ui.notify(
            breakerPause
              ? `Native threshold compaction deferred: ${breakerPause}.`
              : "Native threshold compaction deferred: the turn completed cleanly; maestro compaction will run at agent settle.",
            "info",
          );
        } catch { /* status/notification are best-effort; cancellation stays authoritative */ }
        return { cancel: true };
      }
    }
    const observed = compactionArbiter.observeStart(request, event.signal);
    if (!observed.allowed) {
      const activeOwner = compactionArbiter.currentOwner();
      const tombstone = compactionArbiter.timeoutTombstone();
      try {
        ctx.ui.notify(
          activeOwner
            ? `Auto-compaction skipped: a ${activeOwner} compaction is already active.`
            : tombstone
              ? `Auto-compaction skipped: a timed-out compaction may still be settling (~${Math.ceil(tombstone.remainingMs / 1000)}s hold left).`
              : "Auto-compaction skipped: the compaction request no longer matches the active lease.",
          "info",
        );
      } catch { /* best-effort */ }
      return { cancel: true };
    }
    const providerPressureRecovery = isProviderPressureCompactionTrigger(observed.trigger);
    try {
      const projected = await autoCompaction.projectCompactionInput(event, ctx);
      commitProjectedCompactionInput(event, projected);
      const result = await runObservedCompaction(observed, () =>
        createMaestroCompaction(event, ctx, {
          trigger: observed.trigger,
          summaryInputTokens: projected.estimatedInputTokens,
          failClosed: providerPressureRecovery,
        }));
      if (result?.cancel) observed.finalize("cancel");
      return result;
    } catch (error) {
      observed.finalize("error");
      if (providerPressureRecovery) {
        try {
          ctx.ui.notify(
            `Child provider-pressure compaction failed; native fallback was blocked: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } catch { /* cancellation remains authoritative */ }
        return { cancel: true };
      }
      ctx.ui.notify(
        `Child compaction failed; falling back to Pi native compaction: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    const completedOwner = compactionArbiter.currentOwner();
    compactionArbiter.complete("success");
    autoCompaction.onCompact(completedOwner, ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    autoCompaction.onSessionShutdown(ctx);
    preserveCompletedTurnFromNativeThreshold = false;
    compactionArbiter.reset();
    await lspManager.shutdown();
  });

  registerAskUserQuestionTool(pi);
  registerBashBg(pi);
  registerSmartSearchTool(pi);
  pi.registerTool(createSourceCheckTool() as never);
  registerResourceTool(pi);
  pi.registerTool(createLspTool() as never);
  pi.registerTool(createTeammateChildBrowserTool());
  const todoProxyTool: ToolDefinition<typeof TodoToolParams> = {
    name: "todo",
    label: "Todo",
    description: `Manage the shared root Todo list from this teammate.

Tasks created here are attributed to this teammate and assigned to self by default.
Use assignee="root" to hand work back to root. Teammates can update tasks they created or were assigned; only root can clear the shared list.

If root delegated a task to you (spawned with todo: "<id>"), it is usually already active (in_progress) — check with \`todo list\`, work on the in_progress one, and finish it with \`todo update <id> status=completed summary=<one-line result>\`. Only call \`todo next\` when you have no active task. Leave a task pending only if you could not complete it.`,
    promptSnippet: "Create and update teammate-owned tasks in the shared root Todo list.",
    promptGuidelines: [
      "Use todo for newly discovered follow-up work, explicit blockers, and resumable steps.",
      "Complete or pause your active Todo before activating another task assigned to you.",
      "If root delegated a task to you (spawned with todo: \"<id>\"), it is usually already active — work on the in_progress one and finish it with todo update <id> status=completed summary=... before your final answer; keep it pending only if you could not complete it.",
    ],
    parameters: TodoToolParams,
    async execute(_id, params, signal) {
      return proxyTeammateChildTool("todo", params as unknown as Record<string, unknown>, signal);
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "?");
      const subject = action === "create" && args.subject ? ` ${String(args.subject).slice(0, 40)}` : "";
      return toolCallLine(theme, "todo", `${action}${subject}`);
    },
    renderResult(result, options, theme, ctx) {
      if (options.isPartial) return new Text("", 0, 0);
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "Todo request completed.";
      const isError = (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      const subject = action === "create" && ctx.args.subject ? ` ${String(ctx.args.subject).slice(0, 40)}` : "";
      return toolResultLine(theme, { name: "todo", ok: !isError, arg: `${action}${subject}`, summary: resultSummary(result), expanded: options.expanded, detail: text });
    },
  };
  pi.registerTool(todoProxyTool);
  const permissionController = createPermissionController();
  pi.on("tool_call", (event, ctx) => {
    // structured_output is a schema-validated, child-local termination tool.
    // Relaying it deadlocks direct runners, which have no interaction handler.
    if (event.toolName === "structured_output") return;
    return permissionController.authorize(event, ctx, "default");
  });
}

function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  const askTool: ToolDefinition<typeof AskUserQuestionParams> = {
    name: "ask-user-question",
    label: "Ask User",
    description: `Collect structured user answers through a keyboard-first TUI wizard.

- Single question: { questions: [{ question: "Which approach?", options: [{label: "A"}, {label: "B"}] }] }
- Multiple questions: up to 4 questions in one call
- Multi-select: { questions: [{ question: "Which features?", multiSelect: true, options: [...] }] }
- Open-ended: { questions: [{ question: "What should the name be?" }] }

Users may add supplementary details to any option (including a free-form answer for "None of the above"); these come back in each answer's details map and text field.

The tool returns structured answers only. Plan mode owns proposed-plan Markdown; /plan approve is the explicit confirmation command.

When to use:
- A genuine decision fork the user must own (approach A vs B, which features, naming) that you cannot resolve by reading code or docs.

When NOT to use:
- Questions you could answer yourself with a grep or a doc read — investigate first, then ask only a specific question.
- Confirming a proposed plan — that is owned by /plan approve, not this tool.`,

    promptSnippet: "Collect a structured user decision via a keyboard-first TUI wizard (up to 4 questions)",
    promptGuidelines: [
      "Use ask-user-question only for genuine decisions the user must own; before asking, do up to a minute of read-only investigation (grep/docs/knowledge) so the question is specific rather than open-ended.",
    ],

    parameters: AskUserQuestionParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: ((result: FlowToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<FlowToolResult> {
      return executeAsk(params as unknown as AskParams, ctx);
    },

    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const qs = args.questions as unknown[] | undefined;
      const count = qs?.length ?? 0;
      return toolCallLine(theme, "ask", `${count} question${count !== 1 ? "s" : ""}`);
    },

    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as AskResultDetails | undefined;
      const isError = (result as { isError?: boolean }).isError === true;
      const questions = ctx.args.questions as unknown[] | undefined;
      const arg = `${questions?.length ?? 0} question${questions?.length === 1 ? "" : "s"}`;
      if (details?.cancelled) {
        return toolResultLine(theme, { name: "ask", ok: false, arg, summary: "cancelled" });
      }
      if (isError || !details) {
        const text = result.content[0];
        const fallback = text && "text" in text ? text.text : "Questionnaire failed.";
        return toolResultLine(theme, { name: "ask", ok: false, arg, summary: fallback });
      }
      const count = details.answers.length;
      const answerLines = details.answers.map((answer, index) => {
        const chosen = answer.selected.map((label) => {
          const detail = answer.details?.[label];
          return detail ? `${label} (${detail})` : label;
        });
        const value = [...chosen, ...(answer.text ? [answer.text] : [])].join(" — ") || "No answer";
        return `${index + 1}. ${answer.question} → ${value}`;
      });
      return toolResultLine(theme, {
        name: "ask",
        ok: true,
        arg,
        summary: `${count} answer${count !== 1 ? "s" : ""}`,
        expanded: opts.expanded,
        detail: answerLines.join("\n"),
      });
    },
  };

  pi.registerTool(askTool);
}

/**
 * Plan owns the mode indicator while it is active, so non-YOLO approval modes
 * are hidden to avoid a stale second indicator. YOLO is the exception: it is
 * safety-relevant and must stay visible, inherited unchanged into Plan mode.
 */
export function approvalModeStatusValue(
  planMode: boolean,
  approvalMode: PermissionMode,
): string | undefined {
  if (approvalMode === "bypassPermissions") return "YOLO";
  if (planMode) return undefined;
  return `APPROVAL ${approvalMode}`;
}

function syncApprovalModeStatus(
  ctx: Pick<ExtensionContext, "ui">,
  approvalMode: PermissionMode,
): void {
  ctx.ui.setStatus("approval-mode", approvalModeStatusValue(isPlanMode(), approvalMode));
}

// ---------------------------------------------------------------------------
// Todo widget renderer — width-aware string[] for setWidget (above editor)
// ---------------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const strikethrough = (s: string) => `\x1b[9m${s}\x1b[29m`;

interface TodoTaskLike {
  id: string;
  subject: string;
  status: string;
  blockedBy: string[];
  skills?: Array<{ name: string; role?: string }>;
  createdBy?: { id: string; label: string };
  assignee?: { id: string; label: string };
  updatedAt?: number;
}

const WICON: Record<string, string> = {
  completed: "✓",
  in_progress: "■",
  blocked: "!",
  pending: "□",
};

const WCOLOR: Record<string, (s: string) => string> = {
  completed: green,
  in_progress: yellow,
  blocked: red,
  pending: dim,
};

interface WidgetRunLike {
  id: string;
  sequence?: number;
  command: string;
  status: string;
  attempt?: number;
  gate?: string;
  verdict?: string;
  artifactsCount?: number;
}

export function renderTodoWidget(
  tasks: TodoTaskLike[],
  expanded = false,
  width = 120,
  runs?: readonly WidgetRunLike[] | null,
): string[] {
  const safeWidth = Math.max(1, width);
  const hasTasks = tasks.length > 0;
  const lines: string[] = [];
  if (hasTasks) lines.push(renderTodoSummary(tasks, expanded, safeWidth));
  if (runs && runs.length > 0) lines.push(truncateToWidth(widgetRunsCountLine(runs, lines.length === 0), safeWidth, "…"));
  if (!expanded) return lines;
  if (runs && runs.length > 0) {
    for (const line of widgetRunsFocusLines(runs, safeWidth)) lines.push(line);
  }
  if (!hasTasks) return lines;

  const ordered = [...tasks].sort((left, right) =>
    todoStatusRank(left.status) - todoStatusRank(right.status)
    || todoIdOrder(left.id) - todoIdOrder(right.id)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  const visible = ordered.slice(0, 8);
  for (const task of visible) {
    lines.push(truncateToWidth(widgetTaskLine(task, tasks), safeWidth, "…"));
  }
  const hidden = ordered.length - visible.length;
  if (hidden > 0) lines.push(truncateToWidth(dim(`  … ${hidden} more · ${TODO_TOGGLE_LABEL} collapse`), safeWidth, "…"));

  return lines;
}

const TODO_STATUS_RANK: Record<string, number> = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };

function todoStatusRank(status: string): number {
  return TODO_STATUS_RANK[status] ?? 4;
}

// Tasks keep their creation order (the numeric id assigned at allocation).
// Non-numeric ids (workflow mirrors) sort after numeric ones, then lexicographically.
function todoIdOrder(id: string): number {
  const n = Number(id);
  return Number.isInteger(n) ? n : Number.POSITIVE_INFINITY;
}

function renderTodoSummary(tasks: TodoTaskLike[], expanded: boolean, width: number): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const running = tasks.filter((t) => t.status === "in_progress").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const memberCount = new Set(tasks.flatMap((task) => [task.createdBy?.id, task.assignee?.id]).filter(Boolean)).size;
  const memberMeta = memberCount > 0 ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : "";
  const toggleHint = expanded ? "collapse" : "expand";
  const fullMeta = `${bold(String(tasks.length))} tasks · ${bold(String(done))} done · ${bold(String(running))} running${blocked ? ` · ${bold(String(blocked))} blocked` : ""}${memberMeta}  (${TODO_TOGGLE_LABEL} ${toggleHint})`;
  const compactMeta = `${bold(String(done))}/${bold(String(tasks.length))} · ${bold(String(running))} running  (${TODO_TOGGLE_LABEL} ${toggleHint})`;
  const minimalMeta = `${done}/${tasks.length}`;

  const candidates = [fullMeta, compactMeta, minimalMeta];
  let meta = minimalMeta;
  for (const candidate of candidates) {
    const prefix = `${bold("Todo")}  ${dim(candidate)}`;
    if (visibleWidth(prefix) <= width) {
      meta = candidate;
      break;
    }
  }

  return truncateToWidth(`${bold("Todo")}  ${dim(meta)}`, width, "…");
}

function workflowStatusColor(status: string): (s: string) => string {
  if (status === "running" || status === "retrying") return yellow;
  if (status === "failed") return red;
  if (status === "sealed" || status === "completed" || status === "ready") return green;
  return dim;
}

function widgetRunsCountLine(runs: readonly WidgetRunLike[], topLevel: boolean): string {
  const total = runs.length;
  const done = runs.filter((run) => run.status === "sealed" || run.status === "completed").length;
  const running = runs.filter((run) => run.status === "running" || run.status === "retrying").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const failedPart = failed > 0 ? ` · ${red(bold(String(failed)))} failed` : "";
  const prefix = topLevel ? "" : "  ";
  return `${prefix}${dim("Runs")}  ${bold(String(total))} · ${bold(String(done))} done · ${bold(String(running))} running${failedPart}`;
}

function widgetRunsFocusLines(runs: readonly WidgetRunLike[], width: number): string[] {
  const focus = [...runs]
    .sort((left, right) => widgetRunRank(left.status) - widgetRunRank(right.status))
    .filter((run) => widgetRunRank(run.status) < 5)
    .slice(0, 3);
  return focus.map((run) => truncateToWidth(widgetRunLine(run), width, "…"));
}

function widgetRunLine(run: WidgetRunLike): string {
  const seq = run.sequence != null ? String(run.sequence).padStart(3, "0") : run.id.slice(0, 6);
  const details = [run.gate, run.verdict, run.artifactsCount ? `${run.artifactsCount} art` : ""]
    .filter(Boolean)
    .join(" · ");
  const tail = details ? dim(` · ${details}`) : "";
  return `    ${workflowStatusColor(run.status)(workflowStatusLabel(run.status as never, run.attempt))} ${dim(`${seq}/`)}${run.command}${tail}`;
}

function widgetRunRank(status: string): number {
  return ({ failed: 0, blocked: 1, waiting_user: 2, retrying: 3, running: 4 } as Record<string, number>)[status] ?? 5;
}

function formatWidgetTokens(value: number): string {
  return value < 1_000 ? String(value) : `${Math.round(value / 1_000)}k`;
}

function widgetTaskLine(task: TodoTaskLike, allTasks: TodoTaskLike[]): string {
  const colorFn = WCOLOR[task.status] ?? dim;
  const icon = colorFn(WICON[task.status] ?? "?");
  const subject = task.status === "completed"
    ? strikethrough(colorFn(task.subject))
    : task.status === "in_progress"
      ? bold(colorFn(task.subject))
      : colorFn(task.subject);
  const actor = task.assignee
    ? task.createdBy && task.createdBy.id !== task.assignee.id
      ? `@${widgetActorLabel(task.createdBy, allTasks)}→@${widgetActorLabel(task.assignee, allTasks)}`
      : `@${widgetActorLabel(task.assignee, allTasks)}`
    : "";
  let line = `  ${icon}${actor ? ` ${actor}` : ""} ${subject}`;
  if (task.skills && task.skills.length > 0) {
    const primary = task.skills.find((skill) => skill.role === "primary") ?? task.skills[0];
    line += dim(`  /${primary.name}${task.skills.length > 1 ? ` +${task.skills.length - 1}` : ""}`);
  }

  // blocked: always show dependency arrows
  if (task.status === "blocked" && task.blockedBy.length > 0) {
    const arrows = task.blockedBy.map((depId) => {
      const dep = allTasks.find((t) => t.id === depId);
      if (!dep) return dim("← ?");
      const depColorFn = WCOLOR[dep.status] ?? dim;
      return `${dim("←")} ${depColorFn(WICON[dep.status] ?? "?")} ${dim(dep.subject)}`;
    });
    line += `  ${arrows.join("  ")}`;
  }

  return line;
}

function widgetActorLabel(
  actor: { id: string; label: string },
  tasks: readonly TodoTaskLike[],
): string {
  const actors = tasks.flatMap((task) => [task.createdBy, task.assignee])
    .filter((candidate): candidate is { id: string; label: string } => Boolean(candidate));
  return formatTodoActorSelector(actor, actors);
}

interface ParsedKnowledgeStageArgs {
  target: "spec" | "knowhow";
  title: string;
  content: string;
  action?: "propose" | "reaffirm" | "supersede" | "contest";
  category?: string;
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  signalIds?: string[];
  evidence?: string[];
}

const KNOWLEDGE_STAGE_SIGNALS = new Set(["consumed", "cited", "validated", "contradicted"]);
const KNOWLEDGE_STAGE_ACTIONS = new Set(["propose", "reaffirm", "supersede", "contest"]);

function parseKnowledgeStageArgs(args: string): ParsedKnowledgeStageArgs | Error {
  const tokens = tokenizeQuoted(args);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const values: string[] = [];
      while (index + 1 < tokens.length && !tokens[index + 1]!.startsWith("--")) {
        values.push(tokens[++index]!);
      }
      if (values.length === 0) return new Error(`--${name} requires a value`);
      flags.set(name, values);
    } else {
      positionals.push(token);
    }
  }
  const [target, ...rest] = positionals;
  if (!target || !["spec", "knowhow"].includes(target)) {
    return new Error('target must be "spec" or "knowhow"');
  }
  const title = rest.shift();
  if (!title) return new Error("title is required");
  const content = rest.length > 0 ? rest.join(" ") : "";
  if (!content.trim()) return new Error("content is required");

  const category = firstFlag(flags, "category");
  const action = firstFlag(flags, "action");
  if (action !== undefined && !KNOWLEDGE_STAGE_ACTIONS.has(action)) {
    return new Error(`--action must be one of ${[...KNOWLEDGE_STAGE_ACTIONS].join("|")}`);
  }
  const signal = firstFlag(flags, "signal");
  if (signal !== undefined && !KNOWLEDGE_STAGE_SIGNALS.has(signal)) {
    return new Error(`--signal must be one of ${[...KNOWLEDGE_STAGE_SIGNALS].join("|")}`);
  }
  const signalIds = splitFlag(flags, "signal-ids");
  const evidence = splitFlag(flags, "evidence");
  if (signal && !signalIds) return new Error("--signal requires --signal-ids");
  if (signalIds && !signal) return new Error("--signal-ids requires --signal");

  return {
    target: target as "spec" | "knowhow",
    title,
    content,
    action: action as ParsedKnowledgeStageArgs["action"],
    category,
    signal: signal as ParsedKnowledgeStageArgs["signal"],
    signalIds,
    evidence,
  };
}

interface ParsedKnowledgeRecordArgs {
  knowledgeIds: string[];
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  source?: "search" | "load" | "manual";
}

const KNOWLEDGE_RECORD_SOURCES = new Set(["search", "load", "manual"]);

function parseKnowledgeRecordArgs(args: string): ParsedKnowledgeRecordArgs | Error {
  const tokens = tokenizeQuoted(args);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const values: string[] = [];
      while (index + 1 < tokens.length && !tokens[index + 1]!.startsWith("--")) {
        values.push(tokens[++index]!);
      }
      if (values.length === 0) return new Error(`--${name} requires a value`);
      flags.set(name, values);
    } else {
      positionals.push(token);
    }
  }
  const knowledgeIds = positionals.flatMap((id) => id.split(",")).map((id) => id.trim()).filter(Boolean);
  if (knowledgeIds.length === 0) return new Error("at least one knowledge id is required");
  const signal = firstFlag(flags, "signal");
  if (signal !== undefined && !KNOWLEDGE_STAGE_SIGNALS.has(signal)) {
    return new Error(`--signal must be one of ${[...KNOWLEDGE_STAGE_SIGNALS].join("|")}`);
  }
  const source = firstFlag(flags, "source");
  if (source !== undefined && !KNOWLEDGE_RECORD_SOURCES.has(source)) {
    return new Error(`--source must be one of ${[...KNOWLEDGE_RECORD_SOURCES].join("|")}`);
  }
  return {
    knowledgeIds,
    signal: signal as ParsedKnowledgeRecordArgs["signal"],
    source: source as ParsedKnowledgeRecordArgs["source"],
  };
}

function tokenizeQuoted(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of input.trim()) {
    if (character === '"') {
      quoted = !quoted;
    } else if (character === " " && !quoted) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function firstFlag(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

function splitFlag(flags: Map<string, string[]>, name: string): string[] | undefined {
  const values = flags.get(name);
  if (!values) return undefined;
  return values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean);
}
