import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type WorkflowRunView,
  type WorkflowTodoView,
  type WorkflowViewModel,
  workflowStatusLabel,
} from "../session/view-model.ts";

export type MaestroPanelMode = "collapsed" | "todo" | "panorama";

export function nextMaestroPanelMode(mode: MaestroPanelMode): MaestroPanelMode {
  if (mode === "collapsed") return "todo";
  if (mode === "todo") return "panorama";
  return "collapsed";
}

export function renderMaestroPanel(
  view: WorkflowViewModel,
  mode: MaestroPanelMode,
  width: number,
): string[] {
  if (!shouldShowMaestroPanel(view, mode)) return [];
  const safeWidth = Math.max(1, width);
  if (safeWidth < 20) return [renderNarrow(view, safeWidth)];

  const inner = Math.max(1, safeWidth - 2);
  const rows: string[] = [];
  if (view.goal) {
    rows.push(sectionHeading("Goal", inner));
    rows.push(fitLine(`${workflowStatusLabel(view.goal.status)} · ${view.goal.objective}${formatBudget(view)}`, inner));
  }

  if (mode === "panorama") {
    rows.push(sectionHeading(`Session ${view.sessionLabel}`, inner));
    if (view.runs.length === 0) rows.push(fitLine("○ pending · no runs", inner));
    for (const run of prioritizedRuns(view.runs).slice(0, 8)) rows.push(renderRun(run, inner));
  }

  rows.push(sectionHeading(mode === "todo" ? "Todo" : "Todo · local", inner));
  const localTodos = view.todos.filter((todo) => todo.origin !== "mirror");
  if (localTodos.length === 0) rows.push(fitLine("✓ completed · no local tasks", inner));
  for (const todo of prioritizedTodos(localTodos).slice(0, 6)) rows.push(renderTodo(todo, inner, localTodos));

  const action = view.recoveryAction ?? view.nextAction;
  if (action) rows.push(fitLine(`» Next: ${action}`, inner));
  return frame(rows, safeWidth);
}

export function shouldShowMaestroPanel(_view: WorkflowViewModel, mode: MaestroPanelMode): boolean {
  return mode !== "collapsed";
}

function renderNarrow(view: WorkflowViewModel, width: number): string {
  const action = view.recoveryAction ?? view.nextAction;
  const content = action ? `» ${action}` : workflowStatusLabel(view.status);
  return truncateToWidth(content, width, "…");
}

function renderRun(run: WorkflowRunView, width: number): string {
  const label = `${shortRunLabel(run)} · ${workflowStatusLabel(run.status, run.attempt)}`;
  const details = [run.gate, run.verdict, run.artifactsCount ? `${run.artifactsCount} artifacts` : ""]
    .filter(Boolean)
    .join(" · ");
  return fitLine(details ? `${label} · ${details}` : label, width);
}

function renderTodo(
  todo: WorkflowTodoView,
  width: number,
  allTodos: readonly WorkflowTodoView[],
): string {
  const blocked = todo.blockedBy.length ? ` · blocked by ${todo.blockedBy.join(",")}` : "";
  const actor = todo.assignee
    ? todo.createdBy && todo.createdBy.id !== todo.assignee.id
      ? ` · @${todoActorLabel(todo.createdBy, allTodos)}→@${todoActorLabel(todo.assignee, allTodos)}`
      : ` · @${todoActorLabel(todo.assignee, allTodos)}`
    : "";
  return fitLine(`${workflowStatusLabel(todo.status)}${actor} · ${todo.subject}${blocked}`, width);
}

function todoActorLabel(
  actor: { id: string; label: string },
  todos: readonly WorkflowTodoView[],
): string {
  const ids = new Set(todos.flatMap((todo) => [todo.createdBy, todo.assignee])
    .filter((candidate): candidate is { id: string; label: string } => Boolean(candidate))
    .filter((candidate) => candidate.label === actor.label)
    .map((candidate) => candidate.id));
  if (ids.size < 2) return actor.label;
  for (let length = Math.min(4, actor.id.length); length < actor.id.length; length++) {
    const prefix = actor.id.slice(0, length);
    if ([...ids].every((candidate) => candidate === actor.id || !candidate.startsWith(prefix))) {
      return `${actor.label}#${prefix}`;
    }
  }
  return `${actor.label}#${actor.id}`;
}

function shortRunLabel(run: WorkflowRunView): string {
  const sequence = run.sequence != null ? String(run.sequence).padStart(3, "0") : run.id;
  return `${sequence}/${run.command}`;
}

function formatBudget(view: WorkflowViewModel): string {
  if (view.goal?.tokensUsed == null || view.goal.tokenBudget == null) return "";
  return ` · ${formatTokens(view.goal.tokensUsed)}/${formatTokens(view.goal.tokenBudget)}`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  return `${Math.round(value / 1_000)}k`;
}

function prioritizedRuns(runs: readonly WorkflowRunView[]): WorkflowRunView[] {
  const priority = { failed: 0, blocked: 1, waiting_user: 2, retrying: 3, running: 4 } as const;
  return [...runs].sort((left, right) =>
    (priority[left.status as keyof typeof priority] ?? 5)
      - (priority[right.status as keyof typeof priority] ?? 5)
      || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
  );
}

function prioritizedTodos(todos: readonly WorkflowTodoView[]): WorkflowTodoView[] {
  const priority = { running: 0, blocked: 1, waiting_user: 2, pending: 3 } as const;
  return [...todos].sort((left, right) =>
    (priority[left.status as keyof typeof priority] ?? 4)
      - (priority[right.status as keyof typeof priority] ?? 4),
  );
}

function sectionHeading(label: string, width: number): string {
  return fitLine(`─ ${label} ${"─".repeat(Math.max(0, width - visibleWidth(label) - 3))}`, width);
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function frame(rows: readonly string[], width: number): string[] {
  if (width < 3) return rows.map((row) => truncateToWidth(row, width, "…"));
  const inner = width - 2;
  return [
    `┌${"─".repeat(inner)}┐`,
    ...rows.map((row) => {
      const content = truncateToWidth(row, inner, "…");
      return `│${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}│`;
    }),
    `└${"─".repeat(inner)}┘`,
  ];
}
