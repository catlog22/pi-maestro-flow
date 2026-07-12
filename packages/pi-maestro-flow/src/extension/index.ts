/**
 * Maestro Agent Extension Entry Point
 *
 * Registers tools:
 *   - maestro: Main tool with action-based dispatch (explore, delegate, moa)
 *   - goal: Autonomous goal management (set/done/pause/clear) with independent verifier
 *   - ask-user-question: Structured questionnaire for user input
 *   - todo: Task management with plain context, optional skills, and step tracking
 *
 * Also registers:
 *   - /goal command
 *   - /plan command + Alt+P shortcut (Plan/Act mode toggle)
 *   - Shift+Tab approval-mode cycle (after remapping Pi effort cycling to Shift+E)
 *   - Dynamic LLM providers
 */

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
import {
  executeAsk,
  type AskParams,
  type AskResultDetails,
} from "../tools/ask.ts";
import {
  initTodo,
  executeTodo,
  getVisibleTasks,
  onAgentEndTodo,
  onBeforeAgentStartTodo,
  onContextTodo,
  onSessionStart as todoSessionStart,
  onSessionShutdown as todoSessionShutdown,
  type TodoParams,
  type TodoResultDetails,
  type TodoTask,
} from "../tools/todo.ts";
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
import { registerCodexHookAdapter, type PermissionMode } from "../hooks/pi-adapter.ts";
import {
  createMaestroCompaction,
  persistMaestroCompactionKnowhow,
} from "../compaction/maestro-compaction.ts";
import { createMidTurnAutoCompaction } from "../compaction/auto-compaction.ts";
import { registerMaestroPackageResources } from "../resources/maestro-package.ts";

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

export const APPROVAL_MODE_CYCLE_KEY = "shift+tab";
export const APPROVAL_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export function nextApprovalMode(current: PermissionMode): PermissionMode {
  const index = APPROVAL_MODES.indexOf(current);
  return APPROVAL_MODES[(index + 1) % APPROVAL_MODES.length] ?? "default";
}

const TODO_TOGGLE_KEY = "alt+t";
const TODO_TOGGLE_LABEL = "Alt+T";

function singleLine(text: string): Component {
  return {
    render: (width: number) => [truncateToWidth(text, Math.max(1, width), "…")],
    invalidate() {},
  };
}

export default function registerMaestroExtension(pi: ExtensionAPI): void {
  const midTurnAutoCompaction = createMidTurnAutoCompaction(pi);
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
      return singleLine(`${theme.fg("toolTitle", theme.bold("goal "))}${action}${detail}`);
    },
  };

  pi.registerTool(goalTool);

  // === Ask User Question Tool ===
  const askTool: ToolDefinition<typeof AskUserQuestionParams> = {
    name: "ask-user-question",
    label: "Ask User",
    description: `Collect structured user answers through a keyboard-first TUI wizard.

- Single question: { questions: [{ question: "Which approach?", options: [{label: "A"}, {label: "B"}] }] }
- Multiple questions: up to 4 questions in one call
- Multi-select: { questions: [{ question: "Which features?", multiSelect: true, options: [...] }] }
- Open-ended: { questions: [{ question: "What should the name be?" }] }

The tool returns structured answers only. Plan mode owns proposed-plan Markdown; /plan approve is the explicit confirmation command.`,

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

    renderResult(result, _opts, theme) {
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
      return singleLine(
        `${theme.fg("success", "✓")} Collected ${count} answer${count === 1 ? "" : "s"}`,
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

- create: { action: "create", subject: "...", context: "...", skills: [{ name: "maestro-execute", role: "primary", args: "..." }] }
- update: { action: "update", id: "...", status: "completed", summary: "..." }
- clear context/skills: { action: "update", id: "...", context: "", skills: [] }
- list: { action: "list", filter: { status: "pending" } }
- get: { action: "get", id: "..." }
- delete: { action: "delete", id: "..." }
- clear: { action: "clear" }
- next: { action: "next" } — activate the next pending task and return its resolved context`,

    promptSnippet: "Track multi-step work and activate the next Todo task with resolved context and optional skill guidance.",
    promptGuidelines: [
      "Use todo for multi-step work that needs explicit progress tracking, dependencies, or resumable task context.",
      "Call todo with action=next to activate the next pending task before executing it.",
      "When an active Todo task is complete, call todo update with status=completed and a concise summary before activating another task.",
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

  // === Plan Mode ===
  initPlan(pi);
  registerPlanTools(pi);
  registerPlanCommand(pi);

  pi.registerShortcut(PLAN_TOGGLE_KEY, {
    description: `Toggle Plan/Act mode (${PLAN_TOGGLE_LABEL})`,
    async handler(ctx: ExtensionContext) {
      await planToggleMode(ctx);
    },
  });

  let approvalMode: PermissionMode = "default";
  pi.registerShortcut(APPROVAL_MODE_CYCLE_KEY, {
    description: "Cycle approval mode",
    async handler(ctx: ExtensionContext) {
      const current: PermissionMode = isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode;
      const next = nextApprovalMode(current);

      if (next === "plan" && !isPlanMode()) await planToggleMode(ctx);
      if (next !== "plan" && isPlanMode()) await planToggleMode(ctx);

      approvalMode = next;
      ctx.ui.setStatus("approval-mode", `APPROVAL ${next}`);
      ctx.ui.notify(`Approval mode: ${next}`, "info");
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
  pi.on("session_start", async (_event, ctx) => {
    state.baseCwd = ctx.cwd;
    widgetCtx = ctx;
    todoExpanded = false;
    goalSessionStart(ctx);
    todoSessionStart(ctx);
    await onSessionStartPlan(ctx);
    ctx.ui.setStatus("approval-mode", `APPROVAL ${isPlanMode() ? "plan" : approvalMode}`);
    updateTodoWidget();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    midTurnAutoCompaction.reset(ctx);
    state.activeRuns.clear();
    widgetCtx?.ui.setWidget("todo-panel", undefined);
    widgetCtx = undefined;
    todoExpanded = false;
    goalSessionShutdown(ctx);
    todoSessionShutdown(ctx);
    onSessionShutdownPlan(ctx);
    ctx.ui.setStatus("approval-mode", undefined);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    goalBeforeCompact(ctx);
    return createMaestroCompaction(event, ctx);
  });

  pi.on("session_compact", async (event, ctx) => {
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

  pi.on("tool_call", (event) => {
    // Plan mode tool blocking takes priority
    const planBlock = onToolCallPlan(event);
    if (planBlock) return planBlock;
    return goalToolCall();
  });

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
    await goalAgentEnd(event, ctx);
    onAgentEndTodo();
    midTurnAutoCompaction.onAgentEnd(ctx);
    updateTodoWidget();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "todo") updateTodoWidget();
  });

  // Register last so existing Plan/Goal guards keep their current short-circuit priority.
  registerCodexHookAdapter(pi, {
    getPermissionMode: () => isPlanMode() ? "plan" : approvalMode === "plan" ? "default" : approvalMode,
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
  skills?: Array<{ name: string; role?: string }>;
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
  let line = `  ${icon} ${subject}`;
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
