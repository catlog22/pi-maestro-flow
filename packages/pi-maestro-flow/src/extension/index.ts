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
 *   - /plan command + Alt+P shortcut (Plan/Act mode toggle)
 *   - Shift+Tab approval-mode cycle (after remapping Pi effort cycling to Shift+E)
 *   - Dynamic LLM providers
 */

import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FlowToolResult } from "../tools/tool-result.ts";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  MaestroParams,
  GoalToolParams,
  AskUserQuestionParams,
  TodoToolParams,
} from "./schemas.ts";
import { altKey } from "../key-labels.ts";
import { executeExplore, type ExploreParams } from "../tools/explore.ts";
import { executeDelegate, type DelegateParams } from "../tools/delegate.ts";
import { executeMoa, type MoaParams } from "../tools/moa.ts";
import { registerSwarmDisplay } from "../tools/swarm.ts";
import { registerMaestroProviders } from "../providers/provider-registry.ts";
import { registerApiProviderConfigs } from "../providers/api-provider-config.ts";
import registerMcpAdapter from "../mcp/index.ts";
import {
  initGoal,
  registerGoalCommand,
  executeGoal,
  executeGoalCommand,
  onSessionStart as goalSessionStart,
  onSessionShutdown as goalSessionShutdown,
  onBeforeCompact as goalBeforeCompact,
  onCompact as goalCompact,
  onInput as goalInput,
  onBeforeAgentStart as goalBeforeAgentStart,
  onAgentEnd as goalAgentEnd,
  getActiveGoal,
  getGoalPanelEntries,
  currentGoalPhase,
  switchCurrentGoal,
  reconcileWorkflowGoal,
  setWorkflowCoordinator,
  setGoalStateChangeListener,
  type GoalParams as GoalActionParams,
} from "../tools/goal.ts";
import {
  executeAsk,
  type AskParams,
  type AskResultDetails,
} from "../tools/ask.ts";
import {
  initTodo,
  executeTodo,
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
import { guiEnabled, startGuiSubsystem, registerGuiTool, isGuiToolAllowed, getGuiTool, createGuiEventForwarder, GUI_EVENTS, type GuiServerHandle, type GuiPermissionGateway } from "../gui/index.ts";
import { loadLatestTeamSwarmProjection } from "../swarm/projection.ts";
import { RunCliAdapter } from "../session/cli-adapter.ts";
import { WorkflowCoordinator } from "../session/coordinator.ts";
import { activeWorkflowRun, type WorkflowSnapshot } from "../session/types.ts";
import { deriveWorkflowViewModel, workflowStatusLabel, type WorkflowSnapshotLike } from "../session/view-model.ts";
import { createRunEventComponent, type RunEventDetails } from "../session/run-event.ts";
import {
  executeRunControl,
  isRunControlReadAction,
  RunControlParams,
  type RunControlInput,
} from "../tools/run-control.ts";
import { SessionOverlay, type SessionOverlayAction } from "../tui/session-overlay.ts";
import { TodoOverlay } from "../tui/todo-overlay.ts";
import { GoalOverlay, type GoalOverlayAction } from "../tui/goal-overlay.ts";
import {
  onSessionStart as inputHistorySessionStart,
  onSessionShutdown as inputHistorySessionShutdown,
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
  onBeforeAgentStartPlan,
  onToolCallPlan,
  onAgentEndPlan,
  getMode as getPlanMode,
  hasPlan,
  getPlanText,
  getPlanHandoffStatus,
  setPlanModeChangeListener,
} from "../tools/plan.ts";
import { installStatusline } from "../statusline/statusline.ts";
import { registerCodexHookAdapter } from "../hooks/pi-adapter.ts";
import { createPermissionController } from "../permissions/controller.ts";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/types.ts";
import {
  createMaestroCompaction,
  persistMaestroCompactionKnowhow,
  runWithCompactionStatus,
  type WorkflowRecoveryIdentity,
} from "../compaction/maestro-compaction.ts";
import { createMidTurnAutoCompaction } from "../compaction/auto-compaction.ts";
import {
  CompactionArbiter,
  compactionRequestFromInstructions,
} from "../compaction/compaction-arbiter.ts";
import { registerCompactionSettingsCommand } from "../tui/compaction-settings.ts";
import { registerMaestroPackageResources } from "../resources/maestro-package.ts";
import { registerSkillManager } from "../skills/skill-manager.ts";
import { registerIntelligenceTools, shutdownIntelligenceTools } from "../tools/intelligence.ts";
import { registerFff } from "../tools/fff.ts";
import { registerBashBg } from "../tools/bash-bg.ts";
import { registerModelAvailability } from "../tools/model-availability.ts";
import {
  proxyTeammateChildTool,
  registerTeammateChildExtension,
  registerTeammateChildToolBroker,
  registerTeammatePermissionBroker,
  type TeammatePermissionBroker,
} from "pi-maestro-teammate/v1/child-extensions";
import { TEAMMATE_STARTED_EVENT, TEAMMATE_MESSAGE_EVENT, TEAMMATE_COMPLETE_EVENT } from "pi-maestro-teammate/v1/types";

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
// Keep Plan in the same manual mode carousel as the other permission modes.
// permissionController.setMode() owns the transition side effects so every
// entry path (Shift+Tab, settings reload, and explicit mode changes) activates
// or exits the durable Plan lifecycle consistently.
export const APPROVAL_MODES: readonly PermissionMode[] = PERMISSION_MODES;

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

const TODO_TOGGLE_KEY = "alt+t";
const TODO_TOGGLE_LABEL = altKey("T");
const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
const COCKPIT_TODO_TOGGLE_EVENT = "cockpit:toggle-todo";
const GOAL_OVERLAY_KEY = "alt+g";
const GOAL_OVERLAY_LABEL = altKey("G");

function singleLine(text: string): Component {
  return {
    render: (width: number) => [truncateToWidth(text, Math.max(1, width), "…")],
    invalidate() {},
  };
}

function textBlock(text: string): Component {
  return {
    render: (width: number) => text
      .split("\n")
      .map((line) => truncateToWidth(line, Math.max(1, width), "…")),
    invalidate() {},
  };
}

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

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  if (process.env.PI_TEAMMATE_CHILD === "1") {
    registerMaestroChildSurface(pi);
    return;
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
  let todoRootContext: ExtensionContext | undefined;
  let guiServer: GuiServerHandle | null = null;
  const guiEvents = createGuiEventForwarder();
  // Forward teammate lifecycle events (shared EventBus) to the GUI SSE stream.
  pi.events.on(TEAMMATE_STARTED_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateStarted, event));
  pi.events.on(TEAMMATE_MESSAGE_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateProgress, event));
  pi.events.on(TEAMMATE_COMPLETE_EVENT, (event) => guiEvents.emit(GUI_EVENTS.teammateComplete, event));
  const emitGoalChanged = (): void => {
    if (!guiEvents.isActive()) return;
    const goal = getActiveGoal();
    guiEvents.emitDeduped(GUI_EVENTS.goalChanged, JSON.stringify(goal ?? null), goal);
  };
  setTodoStateChangeListener(updateTodoWidget);
  setGoalStateChangeListener(emitGoalChanged);
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
  let lastRunStates = new Map<string, string>();
  let workflowSessionOptedIn = true;

  // Register dynamic providers from cli-tools.json
  try {
    registerApiProviderConfigs(pi);
    registerMaestroProviders(pi);
  } catch (error) {
    // Provider registration failures should not block extension load
    console.error(
      `[maestro] Provider registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    registerMcpAdapter(pi);
  } catch (error) {
    // MCP 注册失败不得阻断 Maestro 现有工具与 Provider。
    console.error(
      `[maestro] MCP adapter registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  registerMaestroPackageResources(pi);
  registerSkillManager(pi);
  registerCompactionSettingsCommand(pi);

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

When to use: in the pi-agent, prefer the **teammate** tool for ALL delegation, code exploration, and multi-model synthesis — teammate supports prompt templates (the prompt field) and model selection (the model field). The maestro actions below route to external CLI endpoints (gemini/codex CLI processes) and are rarely needed directly:
- explore: external-CLI-backed parallel search.
- delegate: route a task to an external CLI process (gemini/codex).
- moa: multi-model synthesis across external CLI endpoints.

Progressive fallback (delegate as teammate degradation): when a user explicitly requests a specific external model (codex, gemini, claude, opencode) that is NOT listed in <available_teammate_models>, it may still be reachable through the Maestro delegate CLI. Call the **model-availability** tool to confirm what is enabled, then route via the bash CLI:
  maestro delegate "<PROMPT>" --to <tool> --mode analysis
The --to flag is MANDATORY to target a tool. A bare \`maestro delegate codex\` treats "codex" as the prompt and silently falls back to the first enabled tool — this is the cause of "no output" reports. Full delegate contract (options, --rule templates, resume, message delivery): D:\\maestro2\\workflows\\delegate-usage.md.

When NOT to use:
- For pi-agent code discovery, delegation, analysis, or synthesis — use teammate (agent: "explorer" for discovery; the prompt field for templates; the model field for external models).
- For a single known-symbol lookup or exact regex — use maestro search --code or rg directly.`,

    promptSnippet: "External-CLI-endpoint routing (explore/delegate/moa) with a delegate-as-teammate-fallback path. Prefer teammate; fall back to maestro delegate --to <tool> for explicit external models missing from the teammate catalog.",
    promptGuidelines: [
      "In the pi-agent, use the teammate tool for all delegation, code exploration, and multi-model synthesis — teammate supports prompt templates (prompt field) and model selection (model field). Do not call the maestro tool's explore/delegate/moa for ordinary pi-agent work.",
      "Reserve the maestro tool (explore/delegate/moa) for the rare case of routing work directly to an external CLI endpoint (gemini/codex CLI process); for knowledge search use the maestro search/load bash CLI.",
      "Progressive fallback: when a user explicitly requests an external model (codex/gemini/claude/opencode) that is NOT in <available_teammate_models>, call the model-availability tool, then route via bash `maestro delegate \"<PROMPT>\" --to <tool> --mode analysis`. The --to flag is mandatory — a bare `maestro delegate codex` sends \"codex\" as the prompt to the first enabled tool. Contract: D:\\maestro2\\workflows\\delegate-usage.md.",
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

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      let detail = "";
      if (action === "explore") {
        const prompts = args.prompts as string[] | undefined;
        detail = prompts
          ? ` (${prompts.length} prompt${prompts.length !== 1 ? "s" : ""})`
          : "";
      } else if (action === "delegate") {
        const tool = (args.tool as string) ?? "";
        detail = tool ? ` ${theme.fg("accent", tool)}` : "";
      } else if (action === "moa") {
        detail = "";
      }

      return singleLine(
        `${theme.fg("toolTitle", theme.bold("maestro "))}${action}${detail}`,
      );
    },
    renderResult(result, _opts, theme) {
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      const isError = (result as { isError?: boolean }).isError === true;
      if (isError) {
        const firstLine = message.split("\n")[0] ?? message;
        return singleLine(theme.fg("error", `✗ ${firstLine}`));
      }
      const lines = message.split("\n").filter(Boolean);
      const header = lines[0] ?? "";
      const extra = lines.length > 1 ? theme.fg("dim", ` · ${lines.length - 1} more lines`) : "";
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", header.slice(0, 120))}${extra}`);
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
- complete: Request independent completion verification after all work is done. Run the acceptance commands first and include their fresh output in the summary. { action: "complete", summary: "..." }
- optional budget: Include tokenBudget only when the user explicitly requests one. { action: "create", objective: "...", tokenBudget: "100k" }
- optional acceptance: Declare up to 5 acceptance commands the harness runs during verification as functional evidence of completion (results are supplied to the verifier). { action: "create", objective: "...", acceptance: ["npm test -- foo.test.ts"] }

When to use:
- create a Goal for multi-turn autonomous work that needs sustained momentum, a token budget, or verified completion.

When NOT to use:
- single-turn tasks; or when an active Workflow Session already projects a Goal — do not create a competing one.

Only request completion after all work is done; the extension verifies it independently. The model cannot stop, resume, or clear a Goal.`,

    promptSnippet: "Read, create, update, or request independent verification for an autonomous Goal",
    promptGuidelines: [
      "When a goal is active, keep working until it is complete; do not stop with only a plan or partial progress.",
      "Use goal get to inspect state. Use goal create only when no Goal exists; use goal update to replace its objective and resume it.",
      "Omit tokenBudget by default. Set it only when the user explicitly requests a Token budget.",
      "Use goal complete only after all requirements are met and provide concise verification evidence; the verifier owns the done transition.",
      "Prefer declaring acceptance commands at goal create; before goal complete, run them yourself and put their fresh output in the summary so the verifier can confirm functionally.",
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

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      let detail = "";
      if (action === "create" || action === "update") {
        const obj = (args.objective as string) ?? "";
        detail = obj ? ` ${obj.slice(0, 40)}${obj.length > 40 ? "…" : ""}` : "";
      }
      return singleLine(`${theme.fg("toolTitle", theme.bold("goal "))}${action}${detail}`);
    },

    renderResult(result, options, theme) {
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "Goal action completed.";
      if (options.expanded) return textBlock(text);

      const isError = (result as { isError?: boolean }).isError === true;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const firstLine = text.split("\n")[0] ?? text;
      return singleLine(`${icon} ${theme.fg("muted", firstLine)}`);
    },
  };

  pi.registerTool(goalTool);

  // === Ask User Question Tool ===
  registerAskUserQuestionTool(pi);

  // === Todo Tool ===
  initTodo(pi);
  pi.events.on(TEAMMATE_STARTED_EVENT, (event) => {
    if (!todoRootContext) return;
    const actor = todoActorFromTeammateStarted(event);
    if (actor) registerTodoActor(actor);
  });

  const todoTool: ToolDefinition<typeof TodoToolParams> = {
    name: "todo",
    label: "Todo",
    description: `Task management with plain-text context and optional Pi skill execution — 7 actions.

- create (single): { action: "create", subject: "...", assignee: "self|root|id|unique-id-prefix|label|@label|label#id-prefix", context: "...", skills: [{ name: "maestro-execute", role: "primary", args: "..." }] }
- create (batch — lay out a whole plan in ONE call): { action: "create", tasks: [{ subject: "Step 1", context: "..." }, { subject: "Step 2", blockedBy: ["#0"] }, { subject: "Step 3", blockedBy: ["#1"] }] }
- update: { action: "update", id: "...", assignee: "self|root|id|unique-id-prefix|label|@label|label#id-prefix", status: "completed", summary: "..." }
- clear context/skills: { action: "update", id: "...", context: "", skills: [] }
- list: { action: "list", filter: { status: "pending", memberId: "self|root|correlation-id|unique-id-prefix|label|@label|label#id-prefix" } }
- get: { action: "get", id: "..." }
- delete: { action: "delete", id: "..." }
- clear: { action: "clear" }
- next: { action: "next" } — activate the next pending task and return its resolved context

Rules:
- For multi-step work, create the ENTIRE plan up front in ONE batch create (the tasks array) — never create tasks one at a time as you go. Array order is the execution order; use blockedBy "#N" to depend on the Nth task in the same batch.
- subject is the title; description is the detail — do not swap. Set summary on completion; the next action consumes prior summaries.
- One in_progress task at a time in the root session.
- Skill binding requires exactly one primary; guard/support are optional. Skill file changes after activation mark the binding stale — re-activate.
- In update: omitted fields are preserved, null clears, empty array replaces.`,

    promptSnippet: "Lay out a whole multi-step plan in one batch create (≥3 steps), then drive it step by step with resolved context and optional skill guidance.",
    promptGuidelines: [
      "Use todo for multi-step work: create the COMPLETE plan in a single batch create (action=create with a tasks array) BEFORE executing, whenever a request needs ≥3 distinct logical phases, spans multiple tool-call rounds, has step dependencies, or needs resumable cross-turn context. This trigger is mandatory — do not pause to judge whether tracking is needed.",
      "A todo task is a meaningful unit of work — a feature, a logical phase, a component, or an independently verifiable outcome — not a single edit or command. Multiple related edits that serve one logical change belong in ONE task (e.g. \"Implement JWT middleware\" touching 3 files = 1 task, not 3). Use description and context to make each task rich: affected files, expected changes, verification criteria.",
      "Always lay out the full plan up front with one batch create. Do NOT create a single task, finish it, then create the next — a one-at-a-time list hides the overall plan and provides no tracking value. Discover new sub-steps mid-work? Add them with another batch create so the whole remaining plan stays visible.",
      "Skip todo only for single-action work (one tool call or edit fully satisfies the request) or when an active Workflow Session already mirrors tasks.",
      "Decision rule: 1–2 logical phases → skip; ≥3 → always batch-create todos. Count logical phases and independently verifiable outcomes, not individual file edits or commands.",
      "Drive each step with todo action=next, and close it with todo update status=completed plus a concise summary before starting the next step.",
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

    renderCall(args, theme) {
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
      return singleLine(`${theme.fg("toolTitle", theme.bold("todo "))}${action}${detail}`);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as TodoResultDetails | undefined;
      const rawText = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";

      if (!details?.tasks) {
        return singleLine(details?.error ? theme.fg("error", rawText) : theme.fg("dim", rawText));
      }
      if (details.error) {
        return singleLine(theme.fg("error", `Error: ${details.error}`));
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

      const action = details.action;
      if (action === "get") {
        const firstLine = rawText.split("\n")[0]?.replace(/^# /, "") ?? "";
        return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", firstLine)}`);
      }
      if (action === "list") {
        const lines = rawText.split("\n").filter(Boolean);
        const body = lines.length <= 6
          ? lines
          : [...lines.slice(0, 5), `… and ${lines.length - 5} more`];
        return textBlock(body.map((line) => theme.fg("muted", line)).join("\n"));
      }
      if (action === "create" && rawText.includes("\n")) {
        const [header, ...taskLines] = rawText.split("\n");
        const compact = taskLines.map((l) => l.replace(/^\s*/, "")).join(" · ");
        return singleLine(`${theme.fg("success", "✓")} ${header}: ${theme.fg("muted", compact)}`);
      }

      const firstLine = rawText.split("\n")[0] ?? "";
      const prefix = theme.fg("success", "✓");
      return singleLine(`${prefix} ${theme.fg("muted", firstLine)} ${theme.fg("dim", `— ${progress}`)}`);
    },
  };

  pi.registerTool(todoTool);

  // === Canonical Workflow Run Control ===
  const runControlTool: ToolDefinition<typeof RunControlParams> = {
    name: "run-control",
    label: "Run Control",
    description: `Read or control canonical Maestro Workflow Runs through one typed shell.
Actions:
- status: read the current projected Session snapshot; no CLI mutation.
- brief: load a Run resume packet; runId is optional and defaults to the active Run.
- prepare: preview a workflow step without creating a Run; requires step.
- check: evaluate Run gates and finish guidance; runId is optional and defaults to the active Run.
- next: allocate the next chain Run with optional pick; if a Run is already active, return its brief instead.
- done: seal a Run with a verdict; requires runId, defaults verdict to done, and delegates to the stable complete protocol.
- edit: modify future chain steps with commands/after/replace/remove and optional metadata.
Mutating actions next/done/edit require an attached canonical Session and the Flow host mutation lease.

When to use:
- Inside an active Maestro Workflow Session: status/brief/check to inspect (read-only), next/done/edit to drive the chain (mutating).

When NOT to use:
- No active workflow or coordinator not attached — the call errors; do not invoke it.`,
    promptSnippet: "Read (status/brief/check) or drive (next/done/edit) canonical Maestro Workflow Runs",
    parameters: RunControlParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!workflowCoordinator) {
        return {
          content: [{ type: "text", text: "Workflow Coordinator is not attached." }],
          isError: true,
          details: { ok: false, action: params.action, message: "Workflow Coordinator is not attached." },
        };
      }
      const actionOptsIn = !isRunControlReadAction(params.action);
      if (actionOptsIn && !workflowSessionOptedIn) {
        const snapshot = workflowBridge?.getSnapshot() ?? await refreshWorkflow(ctx);
        if (snapshot && shouldAttachWorkflowSession(snapshot) && await attachWorkflowSession(ctx, snapshot)) {
          workflowSessionOptedIn = true;
        }
      }
      const result = await executeRunControl(params as RunControlInput, workflowCoordinator);
      if (result.ok) {
        await refreshWorkflow(ctx, true, actionOptsIn);
      }
      return {
        content: [{ type: "text", text: result.message }],
        isError: !result.ok,
        details: result,
      };
    },
    renderCall(args, theme) {
      return singleLine(`${theme.fg("toolTitle", theme.bold("run-control "))}${String(args.action ?? "?")}`);
    },
    renderResult(result, _opts, theme) {
      const details = result.details as { ok?: boolean; action?: string; message?: string } | undefined;
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      const firstLine = message.split("\n")[0] ?? message;
      if (!details?.ok) {
        return singleLine(theme.fg("error", `✗ ${firstLine}`));
      }
      return singleLine(`${theme.fg("success", "✓")} ${theme.fg("muted", `${details.action}: ${firstLine}`)}`);
    },
  };
  pi.registerTool(runControlTool);

  pi.registerMessageRenderer<RunEventDetails>("run-event", (message, options) => {
    const details = message.details;
    return details ? createRunEventComponent(details, options.expanded) : undefined;
  });

  // === Plan Mode ===
  initPlan(pi, { compactionArbiter });
  registerPlanTools(pi);
  registerPlanCommand(pi);
  registerSwarmDisplay(pi);

  // === Language intelligence, browser control, and tool discovery ===
  registerIntelligenceTools(pi);
  registerFff(pi);
  registerBashBg(pi);
  registerModelAvailability(pi);

  pi.registerShortcut(PLAN_TOGGLE_KEY, {
    description: `Toggle Plan/Act mode (${PLAN_TOGGLE_LABEL})`,
    async handler(ctx: ExtensionContext) {
      await planToggleMode(ctx);
      syncApprovalModeStatus(ctx, approvalMode);
    },
  });

  let approvalMode: PermissionMode = "default";
  setPlanModeChangeListener((ctx) => {
    updateTodoWidget();
    syncApprovalModeStatus(ctx, approvalMode);
  });
  const permissionController = createPermissionController({
    async setMode(mode, ctx) {
      if (mode === "plan" && !isPlanMode()) await planToggleMode(ctx);
      if (mode !== "plan" && isPlanMode()) planExitMode(ctx);
      approvalMode = mode;
      syncApprovalModeStatus(ctx, approvalMode);
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
        ctx.ui.notify("权限配置已重新加载。", "info");
        return;
      }
      ctx.ui.notify(permissionController.summary(isPlanMode() ? "plan" : approvalMode), "info");
    },
  });
  pi.registerShortcut(APPROVAL_MODE_CYCLE_KEY, {
    description: "Cycle approval mode",
    async handler(ctx: ExtensionContext) {
      const current: PermissionMode = isPlanMode()
        ? "plan"
        : approvalMode === "plan"
          ? "default"
          : approvalMode;
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
  ): Promise<WorkflowSnapshot | undefined> {
    if (!workflowBridge) return undefined;
    const next = await workflowBridge.refresh();
    if (!workflowSessionOptedIn && allowOptIn && next.session?.status === "running") {
      workflowSessionOptedIn = true;
    }

    const activateWorkflowSession = shouldActivateWorkflowSession(next, workflowSessionOptedIn);
    const nextSession = activateWorkflowSession ? next.session : undefined;
    const nextAttachSessionId = nextSession?.sessionId;
    if (attachedWorkflowSessionId && attachedWorkflowSessionId !== nextAttachSessionId) {
      try { await workflowCoordinator?.fenceContinuation(); } catch { /* a lost lease is already fail-closed */ }
      await workflowCoordinator?.release();
      attachedWorkflowSessionId = undefined;
    }
    if (emitEvents && nextSession
      && attachedWorkflowSessionId !== nextSession.sessionId) {
      await attachWorkflowSession(ctx, next);
    }
    reconcileMirrorTasks(
      activateWorkflowSession ? buildTodoMirrorSpecs(next) : [],
      ctx,
      next.sessionGeneration,
    );
    if (workflowSessionOptedIn) reconcileWorkflowGoal(next, ctx);
    if (emitEvents && activateWorkflowSession) emitRunTransitions(next);
    else lastRunStates = new Map(next.session?.runs.map((run) => [run.runId, run.status]) ?? []);
    updateTodoWidget();
    return next;
  }

  async function attachWorkflowSession(ctx: ExtensionContext, snapshot: WorkflowSnapshot): Promise<boolean> {
    if (!workflowCoordinator || !shouldAttachWorkflowSession(snapshot)) return false;
    const sessionId = snapshot.session!.sessionId;
    if (attachedWorkflowSessionId === sessionId) return true;
    const hostSessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.()
      ?? `pi-${process.pid}`;
    try {
      await workflowCoordinator.attach(hostSessionId, sessionId);
      attachedWorkflowSessionId = sessionId;
      return true;
    } catch (error) {
      attachedWorkflowSessionId = undefined;
      ctx.ui.notify(`Workflow Session attach is read-only because continuation ownership was unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    }
  }

  function emitRunTransitions(snapshot: WorkflowSnapshot): void {
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
    }
    lastRunStates = nextStates;
  }

  async function openSessionOverlay(ctx: ExtensionContext): Promise<void> {
    const view = deriveWorkflowViewModel(workflowSnapshotForUi());
    if (!view || !workflowCoordinator) {
      ctx.ui.notify("No active canonical Workflow Session.", "info");
      return;
    }
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let overlay: SessionOverlay;
      overlay = new SessionOverlay({
        view,
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        onAction: async (action: SessionOverlayAction, runId?: string) => {
          if (action !== "decision") {
            const planBlock = onToolCallPlan({ toolName: "run-control", input: { action } }, approvalMode === "bypassPermissions");
            if (planBlock) throw new Error(planBlock.reason);
          }
          if (action === "pause" || action === "resume") {
            if (action === "resume" && !workflowSessionOptedIn) {
              workflowSessionOptedIn = true;
              const snapshot = workflowBridge?.getSnapshot();
              if (snapshot && await attachWorkflowSession(ctx, snapshot)) {
                reconcileWorkflowGoal(snapshot, ctx);
              }
            }
            const goal = getActiveGoal();
            if ((action === "pause" && goal?.status === "active")
              || (action === "resume" && (goal?.status === "paused" || goal?.status === "active"))) {
              if (action === "pause") await workflowCoordinator!.fenceContinuation();
              const result = await executeGoalCommand({ action: action === "pause" ? "stop" : "resume" }, ctx);
              if (result.isError) throw new Error(result.text);
            }
          } else if (action === "brief") {
            await workflowCoordinator!.brief(runId);
          } else if (action === "check") {
            await workflowCoordinator!.check(runId);
          } else if (action === "next") {
            await workflowCoordinator!.next();
          } else if (action === "done") {
            if (!runId) throw new Error("No Run selected");
            await workflowCoordinator!.done(runId, { verdict: "done" });
          } else {
            ctx.ui.notify("Resolve the decision through AskUserQuestion; the overlay is a recovery fallback only.", "info");
          }
          await refreshWorkflow(ctx, true);
          const updated = deriveWorkflowViewModel(workflowSnapshotForUi());
          if (updated) overlay.update(updated);
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

  pi.registerCommand("maestro-session", {
    description: "Open the canonical Workflow Session control center",
    async handler(_args, ctx) { await openSessionOverlay(ctx); },
  });
  pi.registerCommand("maestro-todo", {
    description: "Open the shared root and teammate Todo center",
    async handler(_args, ctx) { await openTodoOverlay(ctx); },
  });
  pi.registerCommand("maestro-goal", {
    description: "Open the Goal control center — every goal with full details, switch/stop/resume/clear",
    async handler(_args, ctx) { await openGoalOverlay(ctx); },
  });
  pi.registerCommand("sysprompt", {
    description: "Inspect the active system prompt — mode, size, and key markers. Use 'full' to dump the whole prompt.",
    async handler(args, ctx) {
      const prompt = ctx.getSystemPrompt();
      const opts = ctx.getSystemPromptOptions();
      if (args.trim().toLowerCase() === "full") {
        ctx.ui.notify(prompt, "info");
        return;
      }
      const lines = prompt.split("\n");
      const has = (marker: string) => (prompt.includes(marker) ? "yes" : "NO");
      const contextFiles = (opts.contextFiles ?? []).map((f) => f.path);
      const summary = [
        `System prompt: ${prompt.length} chars / ${lines.length} lines`,
        `Mode: ${opts.customPrompt ? "customPrompt (SYSTEM.md or --system-prompt)" : "default base prompt"}`,
        `First line: ${lines[0]?.slice(0, 90) ?? "(empty)"}`,
        `Markers:`,
        `  # Engineering Principles       : ${has("# Engineering Principles")}`,
        `  # Task Tracking (todo)         : ${has("# Task Tracking (todo)")}`,
        `  # Knowledge System             : ${has("# Knowledge System")}`,
        `  Available tools: (default only): ${has("Available tools:")}`,
        `  <project_instructions>         : ${has("<project_instructions>")}`,
        `  <available_skills>             : ${has("<available_skills>")}`,
        `Context files (${contextFiles.length}): ${contextFiles.join(", ") || "(none)"}`,
      ].join("\n");
      ctx.ui.notify(summary, "info");
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
    const ownership = payload as { todo?: unknown; todoExpanded?: unknown };
    cockpitOwnsTodo = ownership.todo === true;
    if (typeof ownership.todoExpanded === "boolean") {
      panelMode = ownership.todoExpanded ? "expanded" : "collapsed";
    }
    updateTodoWidget();
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
    disposeTeammateSessionRegistrations();
    state.baseCwd = ctx.cwd;
    await inputHistorySessionStart(ctx);
    compactionArbiter.reset();
    midTurnAutoCompaction.onSessionStart(ctx);
    todoRootContext = ctx;
    widgetCtx = ctx;
    panelMode = "collapsed";
    await goalSessionStart(ctx, event);
    const restoredGoal = getActiveGoal();
    workflowSessionOptedIn = false;
    todoSessionStart(ctx);
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
        await refreshWorkflow(ctx, true);
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
    activateTeammateSessionRegistrations(ctx);
    if (guiEnabled()) {
      guiServer?.close("session-restart");
      const guiSessionId =
        (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? "unknown";
      guiServer = await startGuiSubsystem({
        sessionId: guiSessionId,
        cwd: ctx.cwd,
        getHealth: () => ({ approvalMode }),
        listAllTools: () => pi.getAllTools(),
        gateway: buildGuiPermissionGateway(ctx),
        getCtx: () => ctx,
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
          approvalMode: () => (approvalMode === "plan" ? "default" : approvalMode),
          sessionId: () => guiSessionId,
        },
      });
      guiEvents.bind(guiServer);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disposeTeammateSessionRegistrations();
    await inputHistorySessionShutdown();
    midTurnAutoCompaction.reset(ctx);
    compactionArbiter.reset();
    state.activeToolCalls.clear();
    widgetCtx?.ui.setWidget("todo-panel", undefined);
    widgetCtx = undefined;
    todoRootContext = undefined;
    panelMode = "collapsed";
    goalSessionShutdown(ctx);
    todoSessionShutdown(ctx);
    await workflowCoordinator?.release();
    attachedWorkflowSessionId = undefined;
    workflowCoordinator = undefined;
    workflowBridge = undefined;
    workflowSessionOptedIn = true;
    lastRunStates.clear();
    setWorkflowCoordinator(undefined);
    onSessionShutdownPlan(ctx);
    ctx.ui.setStatus("approval-mode", undefined);
    await shutdownIntelligenceTools();
    guiServer?.close("session-shutdown");
    guiServer = null;
    guiEvents.bind(null);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const observed = compactionArbiter.observeStart(
      compactionRequestFromInstructions(event.customInstructions),
      event.signal,
    );
    if (!observed.allowed) return { cancel: true };
    goalBeforeCompact(ctx);
    try {
      return await runWithCompactionStatus(event, ctx, () =>
        createMaestroCompaction(event, ctx, {
          getWorkflowIdentity: () => workflowRecoveryIdentity(),
        }));
    } catch (error) {
      observed.releaseIfNative();
      throw error;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    compactionArbiter.complete();
    midTurnAutoCompaction.onCompact();
    try {
      await persistMaestroCompactionKnowhow(event, ctx);
    } catch (error) {
      ctx.ui.notify(
        `Compaction checkpoint was saved in the session but the knowhow copy failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    await goalCompact(event, ctx);
    onCompactPlan(ctx);
  });

  pi.on("input", (event) => {
    return goalInput(event);
  });

  // Plan mode is advisory (a5b0d8b7): onToolCallPlan blocks nothing, the editing constraint
  // is carried by the plan-enter prompt, and the permission chain below still applies in full.
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
    return todoResult ?? planResult;
  });

  pi.on("context", async (event, ctx) => {
    const todoResult = await onContextTodo(event.messages);
    const messages = todoResult?.messages ?? event.messages;
    const pressureMessages = await midTurnAutoCompaction.evaluate(messages, ctx);
    return pressureMessages ? { messages: pressureMessages } : todoResult;
  });

  // Eight independent end-of-turn side effects across five subsystems. Chained bare, the
  // first throw skips every step after it — so a Goal failure would silently leave the
  // Todo widget stale and mid-turn compaction bookkeeping unrun, with no clue which
  // subsystem broke. Isolate each step and name it in the warning instead.
  pi.on("agent_end", async (event, ctx) => {
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
    await step("Goal", () => goalAgentEnd(event, ctx));
    await step("Goal change event", () => emitGoalChanged());
    await step("Todo", () => onAgentEndTodo());
    await step("Output-limit compaction", () =>
      midTurnAutoCompaction.onOutputLimit(event.messages as AgentMessage[], ctx));
    await step("Mid-turn compaction", () => midTurnAutoCompaction.onAgentEnd(ctx));
    await step("Todo widget", () => updateTodoWidget());
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "todo") updateTodoWidget();
    if (event.toolName === "goal") emitGoalChanged();
    const command = event.toolName === "bash"
      ? String((event as { input?: { command?: unknown } }).input?.command ?? "")
      : "";
    if (event.toolName === "run-control" || /\bmaestro\s+(?:run|ralph)\b/.test(command)) {
      const runControlAction = event.toolName === "run-control"
        ? String((event as { input?: { action?: unknown } }).input?.action ?? "")
        : "";
      const allowOptIn = event.toolName === "run-control"
        ? Boolean(runControlAction && !isRunControlReadAction(runControlAction))
        : isWorkflowOptInCommand(command);
      await refreshWorkflow(ctx, true, allowOptIn);
    }
  });

  // Hook denial runs after Plan's advisory tool_call pass and before the interactive prompt.
  const hookAdapter = registerCodexHookAdapter(pi, {
    getPermissionMode: () => isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode,
  });
  const teammatePermissionBroker: TeammatePermissionBroker = async (call, ctx) => {
    const planBlock = onToolCallPlan(call, approvalMode === "bypassPermissions");
    if (planBlock) return { action: "deny", reason: planBlock.reason };
    const hookBlock = await hookAdapter.beforeToolCall(call, ctx);
    if (hookBlock) return { action: "deny", reason: hookBlock.reason };
    const block = await permissionController.authorize(
      call,
      ctx,
      isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode,
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
    const mode = (): PermissionMode => (isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode);
    return {
      mode,
      authorize: async (toolName, input) => {
        const call = { toolName, input };
        const planBlock = onToolCallPlan(call, approvalMode === "bypassPermissions");
        if (planBlock) return { block: true, reason: planBlock.reason };
        const hookBlock = await hookAdapter.beforeToolCall(call, ctx);
        if (hookBlock) return { block: true, reason: hookBlock.reason };
        const block = await permissionController.authorize(call, ctx, mode(), hookAdapter);
        if (block) return { block: true, reason: block.reason };
        return undefined;
      },
    };
  }

  function activateTeammateSessionRegistrations(ctx: ExtensionContext): void {
    disposeTeammateSessionRegistrations();
    const generation = ++teammateRegistrationGeneration;
    const nextDisposers: Array<() => void> = [];
    try {
      // Teammates run in separate Pi processes. This registration is scoped to
      // the live root session so a reload cannot retain a stale child surface.
      nextDisposers.push(registerTeammateChildExtension(teammateExtensionPath, {
        tools: ["ask-user-question", "todo"],
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

  function disposeTeammateSessionRegistrations(): void {
    teammateRegistrationGeneration++;
    const disposers = teammateRegistrationDisposers;
    teammateRegistrationDisposers = [];
    for (const dispose of disposers.reverse()) dispose();
  }

  pi.on("tool_call", async (event, ctx) => permissionController.authorize(
    event,
    ctx,
    isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode,
    hookAdapter,
  ));
}

/**
 * Teammate children inherit this extension for interaction and permission RPC.
 * They must not register the root Workflow/Goal/Todo lifecycle because only the
 * parent Pi session may own the canonical continuation lease.
 */
function registerMaestroChildSurface(pi: ExtensionAPI): void {
  registerAskUserQuestionTool(pi);
  const todoProxyTool: ToolDefinition<typeof TodoToolParams> = {
    name: "todo",
    label: "Todo",
    description: `Manage the shared root Todo list from this teammate.

Tasks created here are attributed to this teammate and assigned to self by default.
Use assignee="root" to hand work back to root. Teammates can update tasks they created or were assigned; only root can clear the shared list.`,
    promptSnippet: "Create and update teammate-owned tasks in the shared root Todo list.",
    promptGuidelines: [
      "Use todo for newly discovered follow-up work, explicit blockers, and resumable steps.",
      "Complete or pause your active Todo before activating another task assigned to you.",
    ],
    parameters: TodoToolParams,
    async execute(_id, params, signal) {
      return proxyTeammateChildTool("todo", params as unknown as Record<string, unknown>, signal);
    },
    renderCall(args, theme) {
      const action = String(args.action ?? "?");
      const subject = action === "create" && args.subject ? ` ${String(args.subject).slice(0, 40)}` : "";
      return singleLine(`${theme.fg("toolTitle", theme.bold("todo "))}${action}${subject}`);
    },
    renderResult(result, _options, theme) {
      const block = result.content.find((item) => item.type === "text");
      const text = block && "text" in block ? block.text : "Todo request completed.";
      return singleLine((result as { isError?: boolean }).isError
        ? theme.fg("error", text)
        : theme.fg("muted", text));
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

    renderCall(args, theme) {
      const qs = args.questions as unknown[] | undefined;
      const count = qs?.length ?? 0;
      return singleLine(
        `${theme.fg("toolTitle", theme.bold("ask "))}${count} question${count !== 1 ? "s" : ""}`,
      );
    },

    renderResult(result, opts, theme) {
      const details = result.details as AskResultDetails | undefined;
      if (details?.cancelled) {
        return singleLine(theme.fg("warning", "! Questionnaire cancelled"));
      }
      if ((result as { isError?: boolean }).isError || !details) {
        const text = result.content[0];
        const fallback = text && "text" in text ? text.text : "Questionnaire failed.";
        return singleLine(theme.fg("error", `✗ ${fallback}`));
      }
      const count = details.answers.length;
      const header = `${theme.fg("success", "✓")} Collected ${count} answer${count === 1 ? "" : "s"}`;
      const answerLines = details.answers.map((answer, index) => {
        const chosen = answer.selected.map((label) => {
          const detail = answer.details?.[label];
          return detail ? `${label} (${detail})` : label;
        });
        const value = [...chosen, ...(answer.text ? [answer.text] : [])].join(" — ") || "No answer";
        return `${index + 1}. ${answer.question} → ${value}`;
      });
      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          const lines = opts.expanded
            ? [header, ...answerLines]
            : [answerLines[0] ? `${header} · ${answerLines[0]}` : header];
          return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
        },
        invalidate() {},
      };
    },
  };

  pi.registerTool(askTool);
}

/**
 * Plan owns the mode indicator while it is active. Keeping a second
 * `APPROVAL plan` indicator wastes narrow terminal space and can become stale
 * when Plan is toggled through a different shortcut.
 */
export function approvalModeStatusValue(
  planMode: boolean,
  approvalMode: PermissionMode,
): string | undefined {
  return planMode ? undefined : `APPROVAL ${approvalMode === "bypassPermissions" ? "YOLO" : approvalMode}`;
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

  const now = Date.now();
  const ordered = [...tasks].sort((left, right) =>
    todoDisplayRank(left, now) - todoDisplayRank(right, now)
  );
  const visible = ordered.slice(0, 8);
  for (const task of visible) {
    lines.push(truncateToWidth(widgetTaskLine(task, tasks), safeWidth, "…"));
  }
  const hidden = ordered.length - visible.length;
  if (hidden > 0) lines.push(truncateToWidth(dim(`  … ${hidden} more · ${TODO_TOGGLE_LABEL} collapse`), safeWidth, "…"));

  return lines;
}

const RECENT_COMPLETED_WINDOW_MS = 30_000;

/** Recently completed first (a la Claude Code), then running, blocked, pending, older completed. */
function todoDisplayRank(task: TodoTaskLike, now: number): number {
  if (task.status === "completed") {
    const recent = task.updatedAt !== undefined && now - task.updatedAt < RECENT_COMPLETED_WINDOW_MS;
    return recent ? 0 : 4;
  }
  if (task.status === "in_progress") return 1;
  if (task.status === "blocked") return 2;
  return 3;
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
  const next = findNextTodoTask(tasks);

  const nextText = next
    ? next.status === "blocked"
      ? `${red("»")} ${red(`Blocked: ${next.subject}`)}`
      : `${green("»")} ${green(next.subject)}`
    : green("✓ All tasks completed");

  if (width < 20) return truncateToWidth(nextText, width, "…");

  const candidates = [fullMeta, compactMeta, minimalMeta];
  let meta = minimalMeta;
  for (const candidate of candidates) {
    const prefix = `${bold("Todo")}  ${dim(candidate)}  `;
    if (visibleWidth(prefix) + Math.min(18, visibleWidth(nextText)) <= width) {
      meta = candidate;
      break;
    }
  }

  return truncateToWidth(`${bold("Todo")}  ${dim(meta)}  ${nextText}`, width, "…");
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

function findNextTodoTask(tasks: TodoTaskLike[]): TodoTaskLike | undefined {
  return tasks.find((t) => t.status === "in_progress")
    ?? tasks.find((t) => t.status === "pending" && t.blockedBy.length === 0)
    ?? tasks.find((t) => t.status === "blocked" || t.status === "pending");
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
