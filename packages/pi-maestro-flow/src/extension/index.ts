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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  MaestroParams,
  GoalToolParams,
  AskUserQuestionParams,
  TodoToolParams,
} from "./schemas.ts";
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
  reconcileWorkflowGoal,
  setWorkflowCoordinator,
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
  onSessionStart as todoSessionStart,
  onSessionShutdown as todoSessionShutdown,
  reconcileMirrorTasks,
  type TodoActorRef,
  type TodoParams,
  type TodoResultDetails,
  type TodoTask,
} from "../tools/todo.ts";
import { WorkflowBridge, buildTodoMirrorSpecs } from "../session/bridge.ts";
import { RunCliAdapter } from "../session/cli-adapter.ts";
import { WorkflowCoordinator } from "../session/coordinator.ts";
import { activeWorkflowRun, type WorkflowSnapshot } from "../session/types.ts";
import { deriveWorkflowViewModel, type WorkflowSnapshotLike } from "../session/view-model.ts";
import { createRunEventComponent, type RunEventDetails } from "../session/run-event.ts";
import {
  executeRunControl,
  isRunControlReadAction,
  RunControlParams,
  type RunControlInput,
} from "../tools/run-control.ts";
import {
  renderMaestroPanel,
  shouldShowMaestroPanel,
  type MaestroPanelMode,
} from "../tui/maestro-panel.ts";
import { SessionOverlay, type SessionOverlayAction } from "../tui/session-overlay.ts";
import { TodoOverlay } from "../tui/todo-overlay.ts";
import {
  initPlan,
  PLAN_TOGGLE_KEY,
  PLAN_TOGGLE_LABEL,
  registerPlanCommand,
  registerPlanTools,
  isPlanMode,
  toggleMode as planToggleMode,
  onSessionStartPlan,
  onSessionShutdownPlan,
  onCompactPlan,
  onBeforeAgentStartPlan,
  onToolCallPlan,
  onAgentEndPlan,
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
import { registerMaestroPackageResources } from "../resources/maestro-package.ts";
import { registerIntelligenceTools, shutdownIntelligenceTools } from "../tools/intelligence.ts";
import {
  proxyTeammateChildTool,
  registerTeammateChildExtension,
  registerTeammateChildToolBroker,
  registerTeammatePermissionBroker,
} from "pi-maestro-teammate/v1/child-extensions";
import { TEAMMATE_STARTED_EVENT } from "pi-maestro-teammate/v1/types";

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
const TODO_TOGGLE_LABEL = "Alt+T";

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

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  if (process.env.PI_TEAMMATE_CHILD === "1") {
    registerMaestroChildSurface(pi);
    return;
  }

  const teammateExtensionPath = fileURLToPath(import.meta.url);
  const teammateAuthorityOwner = `pi-maestro-flow:${teammateExtensionPath}`;
  let todoRootContext: ExtensionContext | undefined;
  let childTodoMutationQueue: Promise<void> = Promise.resolve();
  let teammateRegistrationGeneration = 0;
  let teammateRegistrationDisposers: Array<() => void> = [];
  const childTodoBroker = (request: Parameters<Parameters<typeof registerTeammateChildToolBroker>[1]>[0]) => {
    const execute = async (): Promise<AgentToolResult> => {
      const ctx = todoRootContext;
      if (!ctx) {
        return {
          content: [{ type: "text", text: "Root Todo session is not available." }],
          isError: true,
        };
      }
      if (!request.actor.correlationId || request.actor.correlationId === "unknown") {
        return {
          content: [{ type: "text", text: "Teammate Todo request has no trusted correlation id." }],
          isError: true,
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

  const midTurnAutoCompaction = createMidTurnAutoCompaction(pi);
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

When to use:
- explore: broad read-only code search needing multiple angles fast — each prompt is one independent search agent.
- delegate: route a task to an EXTERNAL CLI model (gemini/codex/etc.) when a specific external provider is required.
- moa: high-stakes decisions or comparisons that benefit from independent multi-model analysis synthesized into one answer.

When NOT to use:
- For normal delegation to a pi agent, use the teammate tool instead — maestro delegate targets external CLIs only.
- For a single known-symbol lookup or exact regex, use maestro search --code or rg directly, not explore.`,

    promptSnippet: "Parallel code search (explore), external-CLI delegation (delegate), and multi-model synthesis (moa)",
    promptGuidelines: [
      "Use maestro explore for broad multi-angle read-only code search; use maestro delegate only to route work to an external CLI model (gemini/codex); use maestro moa for multi-model analysis synthesized into one answer.",
      "Prefer the teammate tool over maestro delegate for ordinary pi-agent delegation; maestro delegate targets external CLIs only.",
    ],

    parameters: MaestroParams,

    async execute(
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate:
        | ((result: AgentToolResult) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
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
- optional budget: Include tokenBudget only when the user explicitly requests one. { action: "create", objective: "...", tokenBudget: "100k" }

When to use:
- create a Goal for multi-turn autonomous work that needs sustained momentum, a token budget, or verified completion.

When NOT to use:
- single-turn tasks; or when an active Workflow Session already projects a Goal — do not create a competing one.

When the agent loop ends naturally, the extension verifies completion automatically. The model cannot stop, resume, clear, or mark a Goal done.`,

    promptSnippet: "Read, create, or update an autonomous Goal; completion is verified automatically",
    promptGuidelines: [
      "When a goal is active, keep working until it is complete; do not stop with only a plan or partial progress.",
      "Use goal get to inspect state. Use goal create only when no Goal exists; use goal update to replace its objective and resume it.",
      "Omit tokenBudget by default. Set it only when the user explicitly requests a Token budget.",
      "Do not attempt to stop, resume, clear, or mark a Goal done; those transitions are user- or verifier-owned.",
    ],

    parameters: GoalToolParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: ((result: AgentToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      const result = await executeGoal(params as GoalActionParams, ctx);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
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
      let label: string;
      if (/^Goal started:/.test(text)) label = "goal created";
      else if (/^A Goal already exists/.test(text)) label = "goal already exists";
      else if (/^No goal set\./.test(text)) label = "no goal";
      else label = "goal status updated";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return singleLine(`${icon} ${label}${text.includes("\n") ? theme.fg("dim", " · Alt+R details") : ""}`);
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

- create: { action: "create", subject: "...", assignee: "self|root|id|unique-id-prefix|label|@label|label#id-prefix", context: "...", skills: [{ name: "maestro-execute", role: "primary", args: "..." }] }
- update: { action: "update", id: "...", assignee: "self|root|id|unique-id-prefix|label|@label|label#id-prefix", status: "completed", summary: "..." }
- clear context/skills: { action: "update", id: "...", context: "", skills: [] }
- list: { action: "list", filter: { status: "pending", memberId: "self|root|correlation-id|unique-id-prefix|label|@label|label#id-prefix" } }
- get: { action: "get", id: "..." }
- delete: { action: "delete", id: "..." }
- clear: { action: "clear" }
- next: { action: "next" } — activate the next pending task and return its resolved context

Rules:
- subject is the title; description is the detail — do not swap. Set summary on completion; the next action consumes prior summaries.
- One in_progress task at a time in the root session.
- Skill binding requires exactly one primary; guard/support are optional. Skill file changes after activation mark the binding stale — re-activate.
- In update: omitted fields are preserved, null clears, empty array replaces.`,

    promptSnippet: "Track multi-step work (≥3 steps) and activate the next Todo task with resolved context and optional skill guidance.",
    promptGuidelines: [
      "Use todo for multi-step work: create a todo list BEFORE executing whenever a request needs ≥3 distinct steps, spans multiple tool-call rounds, names multiple deliverables or files, has step dependencies, or needs resumable cross-turn context. This trigger is mandatory — do not pause to judge whether tracking is needed.",
      "Skip todo only for single-action work (one tool call or edit fully satisfies the request) or when an active Workflow Session already mirrors tasks.",
      "Decision rule: 1–2 steps → skip; ≥3 steps → always create todos. When ambiguous, count the deliverables, not the perceived difficulty.",
      "Drive each step with todo action=next, and close it with todo update status=completed plus a concise summary before starting the next step.",
    ],

    parameters: TodoToolParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: ((result: AgentToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      return executeTodo(params as unknown as TodoParams, ctx);
    },

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      let detail = "";
      if (action === "create") {
        const subj = (args.subject as string) ?? "";
        detail = subj ? ` ${subj.slice(0, 40)}${subj.length > 40 ? "…" : ""}` : "";
      } else if (action === "update" || action === "get" || action === "delete") {
        const id = (args.id as string) ?? "";
        detail = id ? ` #${id}` : "";
      }
      return singleLine(`${theme.fg("toolTitle", theme.bold("todo "))}${action}${detail}`);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as TodoResultDetails | undefined;
      if (!details?.tasks) {
        const text = result.content[0];
        const fallback = text && "text" in text ? text.text : "";
        return singleLine(details?.error ? theme.fg("error", fallback) : theme.fg("dim", fallback));
      }

      if (details.error) {
        return singleLine(theme.fg("error", `Error: ${details.error}`));
      }

      // Brief inline summary — full list shown in footer panel
      const allTasks = details.tasks;
      const done = allTasks.filter((t: TodoTask) => t.status === "completed").length;
      const running = allTasks.filter((t: TodoTask) => t.status === "in_progress").length;
      const open = allTasks.filter((t: TodoTask) => t.status === "pending" || t.status === "blocked").length;

      const counts: string[] = [];
      if (done > 0) counts.push(`${done} done`);
      if (running > 0) counts.push(`${running} in progress`);
      if (open > 0) counts.push(`${open} open`);
      const summary = `${allTasks.length} tasks (${counts.join(", ")})`;

      const actionText = details.action === "create" ? "Created"
        : details.action === "update" ? "Updated"
        : details.action === "delete" ? "Deleted"
        : details.action === "clear" ? "Cleared"
        : details.action === "next" ? "Next"
        : "";

      const prefix = actionText ? `${theme.fg("success", "✓")} ${actionText} — ` : "";
      return singleLine(`${prefix}${theme.fg("muted", summary)}`);
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
  };
  pi.registerTool(runControlTool);

  pi.registerMessageRenderer<RunEventDetails>("run-event", (message, options) => {
    const details = message.details;
    return details ? createRunEventComponent(details, options.expanded) : undefined;
  });

  // === Plan Mode ===
  initPlan(pi);
  registerPlanTools(pi);
  registerPlanCommand(pi);
  registerSwarmDisplay(pi);

  // === Language intelligence, browser control, and tool discovery ===
  registerIntelligenceTools(pi);

  pi.registerShortcut(PLAN_TOGGLE_KEY, {
    description: `Toggle Plan/Act mode (${PLAN_TOGGLE_LABEL})`,
    async handler(ctx: ExtensionContext) {
      await planToggleMode(ctx);
      syncApprovalModeStatus(ctx, approvalMode);
    },
  });

  let approvalMode: PermissionMode = "default";
  const permissionController = createPermissionController({
    async setMode(mode, ctx) {
      if (mode === "plan" && !isPlanMode()) await planToggleMode(ctx);
      if (mode !== "plan" && isPlanMode()) await planToggleMode(ctx);
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
      const current: PermissionMode = isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode;
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
      nextAction: handoffAction ?? snapshot.recovery?.message ?? `maestro run brief ${run.runId}`,
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
    const nextAttachSessionId = activateWorkflowSession
      ? next.session.sessionId
      : undefined;
    if (attachedWorkflowSessionId && attachedWorkflowSessionId !== nextAttachSessionId) {
      try { await workflowCoordinator?.fenceContinuation(); } catch { /* a lost lease is already fail-closed */ }
      await workflowCoordinator?.release();
      attachedWorkflowSessionId = undefined;
    }
    if (emitEvents && activateWorkflowSession
      && attachedWorkflowSessionId !== next.session!.sessionId) {
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
            const planBlock = onToolCallPlan({ toolName: "run-control", input: { action } });
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
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) =>
      new TodoOverlay({
        getTasks: () => getVisibleTasks(),
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
      }), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" },
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
  installStatusline(pi, () => state, () => workflowSnapshotForUi());

  // === Maestro Panel (above editor) ===
  let widgetCtx: ExtensionContext | undefined;
  let panelMode: MaestroPanelMode = "collapsed";

  function updateTodoWidget(): void {
    if (!widgetCtx) return;
    const tasks = getVisibleTasks();
    const view = deriveWorkflowViewModel(workflowSnapshotForUi());
    const showMaestroPanel = view !== undefined && shouldShowMaestroPanel(view, panelMode);
    if (!showMaestroPanel && tasks.length === 0) {
      widgetCtx.ui.setWidget("todo-panel", undefined);
      return;
    }
    widgetCtx.ui.setWidget("todo-panel", () => ({
      render(width: number): string[] {
        return showMaestroPanel
          ? renderMaestroPanel(view, panelMode, width)
          : renderTodoWidget(tasks, panelMode !== "collapsed", width);
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  }

  pi.registerShortcut(TODO_TOGGLE_KEY, {
    description: "Open the shared root and teammate Todo center",
    async handler(ctx: ExtensionContext) {
      await openTodoOverlay(ctx);
    },
  });

  // === Session lifecycle ===
  pi.on("session_start", async (event, ctx) => {
    disposeTeammateSessionRegistrations();
    state.baseCwd = ctx.cwd;
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
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disposeTeammateSessionRegistrations();
    midTurnAutoCompaction.reset(ctx);
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
  });

  pi.on("session_before_compact", async (event, ctx) => {
    goalBeforeCompact(ctx);
    return runWithCompactionStatus(event, ctx, () =>
      createMaestroCompaction(event, ctx, {
        getWorkflowIdentity: () => workflowRecoveryIdentity(),
      }));
  });

  pi.on("session_compact", async (event, ctx) => {
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

  // Plan mode is a hard boundary and must run before hook or configurable permissions.
  pi.on("tool_call", (event) => onToolCallPlan(event));

  pi.on("before_agent_start", async (event) => {
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

  pi.on("agent_end", async (event, ctx) => {
    await onAgentEndPlan(event, ctx);
    await refreshWorkflow(ctx, true);
    await goalAgentEnd(event, ctx);
    onAgentEndTodo();
    midTurnAutoCompaction.onAgentEnd(ctx);
    updateTodoWidget();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "todo") updateTodoWidget();
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

  // Hook denial runs after Plan's hard boundary and before the interactive permission prompt.
  const hookAdapter = registerCodexHookAdapter(pi, {
    getPermissionMode: () => isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode,
  });
  const teammatePermissionBroker = async (call: Parameters<Parameters<typeof registerTeammatePermissionBroker>[0]>[0], ctx: ExtensionContext) => {
    const planBlock = onToolCallPlan(call);
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
          };
        }
        return childTodoBroker(request);
      }, { owner: `${teammateAuthorityOwner}:todo` }));
      nextDisposers.push(registerTeammatePermissionBroker(async (call, requestCtx) => {
        if (generation !== teammateRegistrationGeneration) {
          return { action: "deny", reason: "Root permission authority belongs to a newer session generation." };
        }
        return teammatePermissionBroker(call, requestCtx);
      }, { owner: `${teammateAuthorityOwner}:permission` }));
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
      _onUpdate: ((result: AgentToolResult) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
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
        const value = [...answer.selected, ...(answer.text ? [answer.text] : [])].join(" — ") || "No answer";
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

interface TodoTaskLike {
  id: string;
  subject: string;
  status: string;
  blockedBy: string[];
  skills?: Array<{ name: string; role?: string }>;
  createdBy?: { id: string; label: string };
  assignee?: { id: string; label: string };
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

export function renderTodoWidget(
  tasks: TodoTaskLike[],
  expanded = false,
  width = 120,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines = [renderTodoSummary(tasks, expanded, safeWidth)];
  if (!expanded) return lines;

  const priority: Record<string, number> = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
  const ordered = [...tasks].sort((left, right) =>
    (priority[left.status] ?? 2) - (priority[right.status] ?? 2)
  );
  const visible = ordered.slice(0, 8);
  for (const task of visible) {
    lines.push(truncateToWidth(widgetTaskLine(task, tasks), safeWidth, "…"));
  }
  const hidden = ordered.length - visible.length;
  if (hidden > 0) lines.push(truncateToWidth(dim(`  … ${hidden} more · ${TODO_TOGGLE_LABEL} collapse`), safeWidth, "…"));

  return lines;
}

function renderTodoSummary(tasks: TodoTaskLike[], _expanded: boolean, width: number): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const memberCount = new Set(tasks.flatMap((task) => [task.createdBy?.id, task.assignee?.id]).filter(Boolean)).size;
  const memberMeta = memberCount > 0 ? ` · ${memberCount} member${memberCount === 1 ? "" : "s"}` : "";
  const fullMeta = `${done}/${tasks.length} completed${memberMeta}  (${TODO_TOGGLE_LABEL} center)`;
  const compactMeta = `${done}/${tasks.length}  (${TODO_TOGGLE_LABEL})`;
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

function findNextTodoTask(tasks: TodoTaskLike[]): TodoTaskLike | undefined {
  return tasks.find((t) => t.status === "in_progress")
    ?? tasks.find((t) => t.status === "pending" && t.blockedBy.length === 0)
    ?? tasks.find((t) => t.status === "blocked" || t.status === "pending");
}

function widgetTaskLine(task: TodoTaskLike, allTasks: TodoTaskLike[]): string {
  const colorFn = WCOLOR[task.status] ?? dim;
  const icon = colorFn(WICON[task.status] ?? "?");
  const subject = task.status === "completed" ? dim(task.subject) : task.subject;
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
