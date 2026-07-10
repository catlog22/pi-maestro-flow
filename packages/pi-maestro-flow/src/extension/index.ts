/**
 * Maestro Agent Extension Entry Point
 *
 * Registers tools:
 *   - maestro: Main tool with action-based dispatch (explore, delegate, moa)
 *   - maestro-wait: Block until background maestro runs finish
 *   - maestro-status: Inspect active/completed runs
 *   - goal: Autonomous goal management (set/done/pause/clear) with independent verifier
 *   - ask-user-question: Structured questionnaire for user input
 *   - todo: Task management with plain context, optional skills, and step tracking
 *
 * Also registers:
 *   - /goal command
 *   - /plan command + Shift+Tab shortcut (Plan/Act mode toggle)
 *   - Dynamic LLM providers
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  MaestroParams,
  MaestroWaitParams,
  MaestroStatusParams,
  GoalToolParams,
  AskUserQuestionParams,
  TodoToolParams,
} from "./schemas.ts";
import { executeExplore, type ExploreParams } from "../tools/explore.ts";
import { executeDelegate, type DelegateParams } from "../tools/delegate.ts";
import { executeMoa, type MoaParams } from "../tools/moa.ts";
import { executeMaestroWait } from "../tools/wait.ts";
import { executeMaestroStatus } from "../tools/status.ts";
import { registerMaestroProviders } from "../providers/provider-registry.ts";
import {
  initGoal,
  registerGoalCommand,
  executeGoal,
  onSessionStart as goalSessionStart,
  onSessionShutdown as goalSessionShutdown,
  onBeforeCompact as goalBeforeCompact,
  onCompact as goalCompact,
  onInput as goalInput,
  onToolCall as goalToolCall,
  onBeforeAgentStart as goalBeforeAgentStart,
  onAgentEnd as goalAgentEnd,
  type GoalParams as GoalActionParams,
} from "../tools/goal.ts";
import { executeAsk, type AskParams } from "../tools/ask.ts";  // stateless formatter
import {
  initTodo,
  executeTodo,
  getVisibleTasks,
  onSessionStart as todoSessionStart,
  onSessionShutdown as todoSessionShutdown,
  type TodoParams,
  type TodoResultDetails,
  type TodoTask,
} from "../tools/todo.ts";
import {
  initPlan,
  registerPlanCommand,
  toggleMode as planToggleMode,
  onSessionStartPlan,
  onSessionShutdownPlan,
  onCompactPlan,
  onBeforeAgentStartPlan,
  onToolCallPlan,
  onAgentEndPlan,
} from "../tools/plan.ts";
import { installStatusline } from "../statusline/statusline.ts";

interface MaestroState {
  baseCwd: string;
  activeRuns: Map<
    string,
    {
      action: string;
      startedAt: number;
      correlationId: string;
    }
  >;
}

const TODO_TOGGLE_KEY = "alt+t";
const TODO_TOGGLE_LABEL = "Alt+T";

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  const state: MaestroState = {
    baseCwd: "",
    activeRuns: new Map(),
  };

  // Register dynamic providers from cli-tools.json
  try {
    registerMaestroProviders(pi);
  } catch (error) {
    // Provider registration failures should not block extension load
    console.error(
      `[maestro] Provider registration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
  { action: "moa", prompts: ["Compare auth strategies"], preset: "deep" }`,

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
      state.activeRuns.set(id, {
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
            );

          case "delegate":
            return await executeDelegate(
              params as unknown as DelegateParams,
              signal,
              ctx,
            );

          case "moa":
            return await executeMoa(
              params as unknown as MoaParams,
              signal,
              ctx,
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
        state.activeRuns.delete(id);
      }
    },

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      const asyncLabel =
        args.async === true ? theme.fg("warning", " [async]") : "";

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

      return new Text(
        `${theme.fg("toolTitle", theme.bold("maestro "))}${action}${detail}${asyncLabel}`,
        0,
        0,
      );
    },
  };

  pi.registerTool(maestroTool);

  // === Auxiliary Tool: maestro-wait ===
  const waitTool: ToolDefinition<typeof MaestroWaitParams> = {
    name: "maestro-wait",
    label: "Maestro Wait",
    description: `Block until background (async) maestro runs finish.

- { } — wait for first active run to finish (default)
- { all: true } — wait for all active runs to finish
- { id: "..." } — wait for a specific run
- { timeoutMs: 600000 } — timeout after N ms (runs continue regardless)`,

    parameters: MaestroWaitParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      return executeMaestroWait(
        params as { id?: string; all?: boolean; timeoutMs?: number },
        signal,
        state,
      );
    },
  };

  pi.registerTool(waitTool);

  // === Auxiliary Tool: maestro-status ===
  const statusTool: ToolDefinition<typeof MaestroStatusParams> = {
    name: "maestro-status",
    label: "Maestro Status",
    description: `Inspect maestro run status.

- { } — fleet overview of all active runs
- { id: "..." } — details for a specific run
- { view: "transcript" } — tail the latest run transcript`,

    parameters: MaestroStatusParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult> {
      return executeMaestroStatus(
        params as { id?: string; view?: "fleet" | "transcript" },
        state,
      );
    },
  };

  pi.registerTool(statusTool);

  // === Goal Tool ===
  initGoal(pi);
  registerGoalCommand(pi);

  const goalTool: ToolDefinition<typeof GoalToolParams> = {
    name: "goal",
    label: "Goal",
    description: `Autonomous goal management — 4 actions. Both users (/goal) and LLM can call this.

- set: Create/update/resume goal. { action: "set", objective: "...", tokenBudget: "100k" }
  Omit objective to show status or resume a paused goal.
- done: Mark complete — spawns independent verifier. { action: "done", summary: "..." }
- pause: Toggle pause/resume. { action: "pause" }
- clear: Abandon goal. { action: "clear" }`,

    promptSnippet: "Manage autonomous goals — set, done (with independent verification), pause, clear",
    promptGuidelines: [
      "When a goal is active, keep working until it is complete; do not stop with only a plan or partial progress.",
      "Before calling goal with action 'done', audit the goal requirement by requirement against current files, command output, tests, or external state.",
      "An independent verifier agent will check your completion claim — only mark done when all requirements are verifiably met.",
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
        ...(result.terminate ? { terminate: true } : {}),
      };
    },

    renderCall(args, theme) {
      const action = (args.action as string) ?? "?";
      let detail = "";
      if (action === "set") {
        const obj = (args.objective as string) ?? "";
        detail = obj ? ` ${obj.slice(0, 40)}${obj.length > 40 ? "…" : ""}` : "";
      } else if (action === "done") {
        const sum = (args.summary as string) ?? "";
        detail = sum ? ` ${sum.slice(0, 40)}${sum.length > 40 ? "…" : ""}` : "";
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("goal "))}${action}${detail}`,
        0, 0,
      );
    },
  };

  pi.registerTool(goalTool);

  // === Ask User Question Tool ===
  const askTool: ToolDefinition<typeof AskUserQuestionParams> = {
    name: "ask-user-question",
    label: "Ask User",
    description: `Ask the user structured questions with optional multiple-choice options.

- Single question: { questions: [{ question: "Which approach?", options: [{label: "A"}, {label: "B"}] }] }
- Multiple questions: up to 4 questions in one call
- Multi-select: { questions: [{ question: "Which features?", multiSelect: true, options: [...] }] }
- Open-ended: { questions: [{ question: "What should the name be?" }] }`,

    parameters: AskUserQuestionParams,

    async execute(
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult> {
      return executeAsk(params as unknown as AskParams);
    },

    renderCall(args, theme) {
      const qs = args.questions as unknown[] | undefined;
      const count = qs?.length ?? 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ask "))}${count} question${count !== 1 ? "s" : ""}`,
        0,
        0,
      );
    },
  };

  pi.registerTool(askTool);

  // === Todo Tool ===
  initTodo(pi);

  const todoTool: ToolDefinition<typeof TodoToolParams> = {
    name: "todo",
    label: "Todo",
    description: `Task management with plain-text context and optional Pi skill execution — 7 actions.

- create: { action: "create", subject: "...", context: "...", skill: { name: "maestro-execute", args: "..." } }
- update: { action: "update", id: "...", status: "completed", summary: "..." }
- clear context/skill: { action: "update", id: "...", context: "", skill: null }
- list: { action: "list", filter: { status: "pending" } }
- get: { action: "get", id: "..." }
- delete: { action: "delete", id: "..." }
- clear: { action: "clear" }
- next: { action: "next" } — get next pending task with injected context`,

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
      return new Text(
        `${theme.fg("toolTitle", theme.bold("todo "))}${action}${detail}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as TodoResultDetails | undefined;
      if (!details?.tasks) {
        const text = result.content[0];
        const fallback = text && "text" in text ? text.text : "";
        return new Text(details?.error ? theme.fg("error", fallback) : theme.fg("dim", fallback), 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
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
      return new Text(`${prefix}${theme.fg("muted", summary)}`, 0, 0);
    },
  };

  pi.registerTool(todoTool);

  // === Plan Mode ===
  initPlan(pi);
  registerPlanCommand(pi);

  pi.registerShortcut("shift+q", {
    description: "Toggle Plan/Act mode",
    async handler(ctx: ExtensionContext) {
      await planToggleMode(ctx);
    },
  });

  // === Statusline ===
  installStatusline(pi, () => state);

  // === Todo Widget (above editor) ===
  let widgetCtx: ExtensionContext | undefined;
  let todoExpanded = false;

  function updateTodoWidget(): void {
    if (!widgetCtx) return;
    const tasks = getVisibleTasks();
    if (tasks.length === 0) {
      widgetCtx.ui.setWidget("todo-panel", undefined);
      return;
    }
    widgetCtx.ui.setWidget("todo-panel", () => ({
      render(width: number): string[] {
        return renderTodoWidget(tasks, todoExpanded, width);
      },
      invalidate() {},
    }));
  }

  pi.registerShortcut(TODO_TOGGLE_KEY, {
    description: "Toggle Todo details",
    handler(ctx: ExtensionContext) {
      if (getVisibleTasks().length === 0) {
        ctx.ui.notify("No Todo tasks to display.", "info");
        return;
      }
      todoExpanded = !todoExpanded;
      widgetCtx = ctx;
      updateTodoWidget();
    },
  });

  // === Session lifecycle ===
  pi.on("session_start", (_event, ctx) => {
    state.baseCwd = ctx.cwd;
    widgetCtx = ctx;
    todoExpanded = false;
    goalSessionStart(ctx);
    todoSessionStart(ctx);
    onSessionStartPlan(ctx);
    updateTodoWidget();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.activeRuns.clear();
    widgetCtx?.ui.setWidget("todo-panel", undefined);
    widgetCtx = undefined;
    todoExpanded = false;
    goalSessionShutdown(ctx);
    todoSessionShutdown(ctx);
    onSessionShutdownPlan(ctx);
  });

  pi.on("session_before_compact", (_event, ctx) => {
    goalBeforeCompact(ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
    await goalCompact(event, ctx);
    onCompactPlan(ctx);
  });

  pi.on("input", (event) => {
    return goalInput(event);
  });

  pi.on("tool_call", (event) => {
    // Plan mode tool blocking takes priority
    const planBlock = onToolCallPlan(event);
    if (planBlock) return planBlock;
    return goalToolCall();
  });

  pi.on("before_agent_start", (event) => {
    // Chain: plan system prompt injection, then goal
    const planResult = onBeforeAgentStartPlan(event);
    const effectiveEvent = planResult
      ? { ...event, systemPrompt: planResult.systemPrompt }
      : event;
    const goalResult = goalBeforeAgentStart(effectiveEvent);
    if (planResult && goalResult) {
      return { systemPrompt: goalResult.systemPrompt };
    }
    return goalResult ?? planResult;
  });

  pi.on("agent_end", async (event, ctx) => {
    onAgentEndPlan(event, ctx);
    await goalAgentEnd(event, ctx);
    updateTodoWidget();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "todo") updateTodoWidget();
  });
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
  skill?: { name: string };
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

  const active = tasks.filter((t) => t.status !== "completed");
  const completed = tasks.filter((t) => t.status === "completed");

  for (const task of [...active, ...completed]) {
    lines.push(truncateToWidth(widgetTaskLine(task, tasks), safeWidth, "…"));
  }

  return lines;
}

function renderTodoSummary(tasks: TodoTaskLike[], expanded: boolean, width: number): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const toggleVerb = expanded ? "collapse" : "expand";
  const fullMeta = `${done}/${tasks.length} completed  (${TODO_TOGGLE_LABEL} to ${toggleVerb})`;
  const compactMeta = `${done}/${tasks.length}  (${TODO_TOGGLE_LABEL})`;
  const minimalMeta = `${done}/${tasks.length}`;
  const next = findNextTodoTask(tasks);

  const nextText = next
    ? next.status === "blocked"
      ? `${red("»")} ${red(`Blocked: ${next.subject}`)}`
      : `${green("»")} ${green(next.subject)}`
    : green("✓ All tasks completed");

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
  let line = `  ${icon} ${subject}`;
  if (task.skill) line += dim(`  /${task.skill.name}`);

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
