import { type Component, type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTodoActorSelector, type TodoActorRef, type TodoTask } from "../tools/todo.ts";

export interface TodoOverlayParams {
  getTasks: () => readonly TodoTask[];
  requestRender: () => void;
  close: () => void;
}

type TodoOverlayMode = "list" | "detail";

interface MemberScope {
  id: string;
  label: string;
}

export class TodoOverlay implements Component, Focusable {
  focused = false;
  private mode: TodoOverlayMode = "list";
  private scopeIndex = 0;
  private selected = 0;
  private query = "";
  private lastWidth = 80;

  constructor(private readonly params: TodoOverlayParams) {}

  invalidate(): void {}
  dispose(): void {}

  handleInput(data: string): void {
    if (data === "\x1b") {
      if (this.mode === "detail") this.mode = "list";
      else this.params.close();
      this.params.requestRender();
      return;
    }
    if (data === "\x1b[D") {
      this.moveScope(-1);
      return;
    }
    if (data === "\x1b[C" || data === "\t") {
      this.moveScope(1);
      return;
    }
    if (data === "\x1b[A") {
      this.moveSelection(-1);
      return;
    }
    if (data === "\x1b[B") {
      this.moveSelection(1);
      return;
    }
    if (data === "\r" || data === "\n") {
      if (this.selectedTask()) this.mode = "detail";
      this.params.requestRender();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.lastWidth < 20) return;
      this.query = this.query.slice(0, -1);
      this.selected = 0;
      this.params.requestRender();
      return;
    }
    if (isPrintableInput(data)) {
      if (this.lastWidth < 20) return;
      this.query += data;
      this.selected = 0;
      this.params.requestRender();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.lastWidth = safeWidth;
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    this.clampState();
    if (this.mode === "detail" || safeWidth < 72) {
      return this.mode === "detail" ? this.renderDetail(safeWidth) : this.renderList(safeWidth);
    }
    return this.renderWide(safeWidth);
  }

  private renderCompact(width: number): string {
    const task = this.selectedTask() ?? this.filteredTasks()[0];
    return truncateToWidth(task
      ? `Esc · ${statusLabel(task.status)} · ${actorTag(task, this.tasks())} · ${task.subject}`
      : "Esc · Todo · no matching tasks", width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const tasks = this.filteredTasks();
    const rows = [this.header(inner), rule(inner)];
    if (tasks.length === 0) rows.push(fitLine("○ pending · no matching Todo tasks", inner));
    else {
      const start = visibleStart(this.selected, tasks.length, 8);
      for (let index = start; index < Math.min(tasks.length, start + 8); index++) {
        rows.push(this.taskRow(tasks[index], index === this.selected, inner));
      }
    }
    rows.push(this.filterLine(inner, tasks.length));
    rows.push(fitSegments(inner, ["Esc close", "Enter detail", "←→ scope", "↑↓ task", "type filter"]));
    return frame(rows, width);
  }

  private renderWide(width: number): string[] {
    const inner = width - 2;
    const leftWidth = Math.max(30, Math.floor((inner - 3) * 0.52));
    const rightWidth = inner - leftWidth - 3;
    const tasks = this.filteredTasks();
    const selected = this.selectedTask();
    const start = visibleStart(this.selected, tasks.length, 8);
    const left = tasks.length === 0
      ? ["○ pending · no matching Todo tasks"]
      : tasks.slice(start, start + 8).map((task, offset) =>
          this.taskRow(task, start + offset === this.selected, leftWidth)
        );
    const right = this.detailLines(selected, rightWidth);
    const rowCount = Math.max(left.length, right.length, 1);
    const rows = [this.header(inner), rule(inner)];
    for (let index = 0; index < rowCount; index++) {
      rows.push(`${pad(left[index] ?? "", leftWidth)} │ ${pad(right[index] ?? "", rightWidth)}`);
    }
    rows.push(this.filterLine(inner, tasks.length));
    rows.push(fitSegments(inner, ["Esc close", "Enter detail", "←→ scope", "↑↓ task", "type filter"]));
    return frame(rows, width);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const task = this.selectedTask();
    const rows = [fitLine(`Todo · ${this.currentScope().label} · task detail`, inner), rule(inner)];
    rows.push(...this.detailLines(task, inner));
    rows.push(fitSegments(inner, ["Esc back", "←→ scope", "↑↓ task"]));
    return frame(rows, width);
  }

  private detailLines(task: TodoTask | undefined, width: number): string[] {
    if (!task) return [fitLine("○ pending · no task selected", width)];
    const lines = [
      fitLine(`#${task.id} · ${statusLabel(task.status)}`, width),
      fitLine(task.subject, width),
      fitLine(`Created @${actorLabel(task.createdBy, this.tasks())}`, width),
      fitLine(`Assigned @${actorLabel(task.assignee, this.tasks())}`, width),
    ];
    if (task.description) lines.push(fitLine(`Description: ${task.description}`, width));
    if (task.blockedBy.length) lines.push(fitLine(`Blocked by: ${task.blockedBy.join(", ")}`, width));
    if (task.summary) lines.push(fitLine(`Summary: ${task.summary}`, width));
    return lines;
  }

  private header(width: number): string {
    const tasks = this.tasks();
    const completed = tasks.filter((task) => task.status === "completed").length;
    const running = tasks.filter((task) => task.status === "in_progress").length;
    const scopes = this.scopes();
    const scopeText = scopes.map((scope, index) => index === this.scopeIndex ? `[${scope.label}]` : scope.label).join(" ");
    return fitLine(`Todo ${completed}/${tasks.length} done · ${running} active · Scope: ${scopeText}`, width);
  }

  private filterLine(width: number, count: number): string {
    const query = this.query || "type to filter";
    return fitLine(`Filter: ${query} · ${count} task${count === 1 ? "" : "s"}`, width);
  }

  private taskRow(task: TodoTask, selected: boolean, width: number): string {
    return fitLine(`${selected ? "›" : " "} ${statusLabel(task.status)} · ${actorTag(task, this.tasks())} · ${task.subject}`, width);
  }

  private moveScope(delta: number): void {
    const scopes = this.scopes();
    this.scopeIndex = wrapIndex(this.scopeIndex + delta, scopes.length);
    this.selected = 0;
    this.mode = "list";
    this.params.requestRender();
  }

  private moveSelection(delta: number): void {
    const tasks = this.filteredTasks();
    this.selected = wrapIndex(this.selected + delta, tasks.length);
    this.params.requestRender();
  }

  private clampState(): void {
    const scopes = this.scopes();
    this.scopeIndex = clampIndex(this.scopeIndex, scopes.length);
    this.selected = clampIndex(this.selected, this.filteredTasks().length);
  }

  private tasks(): TodoTask[] {
    return this.params.getTasks().filter((task) => !task.origin && task.status !== "deleted") as TodoTask[];
  }

  private scopes(): MemberScope[] {
    const actors = new Map<string, TodoActorRef>();
    for (const task of this.tasks()) {
      actors.set(task.createdBy.id, task.createdBy);
      actors.set(task.assignee.id, task.assignee);
    }
    const members = [...actors.values()].sort((left, right) =>
      left.kind === right.kind ? left.label.localeCompare(right.label) : left.kind === "root" ? -1 : 1
    );
    return [
      { id: "*", label: "All" },
      ...members.map((actor) => ({ id: actor.id, label: actorLabel(actor, this.tasks()) })),
    ];
  }

  private currentScope(): MemberScope {
    return this.scopes()[this.scopeIndex] ?? { id: "*", label: "All" };
  }

  private filteredTasks(): TodoTask[] {
    const scope = this.currentScope();
    const query = this.query.trim().toLocaleLowerCase();
    const priority: Record<string, number> = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
    return this.tasks()
      .filter((task) => scope.id === "*" || task.createdBy.id === scope.id || task.assignee.id === scope.id)
      .filter((task) => !query || [
        task.id,
        task.subject,
        task.description ?? "",
        task.createdBy.label,
        task.assignee.label,
      ].some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((left, right) =>
        (priority[left.status] ?? 4) - (priority[right.status] ?? 4)
        || left.createdAt - right.createdAt
      );
  }

  private selectedTask(): TodoTask | undefined {
    return this.filteredTasks()[this.selected];
  }
}

function actorTag(task: TodoTask, tasks: readonly TodoTask[]): string {
  const created = actorLabel(task.createdBy, tasks);
  const assigned = actorLabel(task.assignee, tasks);
  return task.createdBy.id === task.assignee.id ? `@${assigned}` : `@${created}→@${assigned}`;
}

function actorLabel(actor: TodoActorRef, tasks: readonly TodoTask[]): string {
  return formatTodoActorSelector(actor, tasks.flatMap((task) => [task.createdBy, task.assignee]));
}

function statusLabel(status: TodoTask["status"]): string {
  if (status === "in_progress") return "▶ running";
  if (status === "blocked") return "! blocked";
  if (status === "completed") return "✓ completed";
  if (status === "deleted") return "⊘ deleted";
  return "○ pending";
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !data.includes("\x1b") && [...data].every((char) => char >= " " && char !== "\x7f");
}

function visibleStart(selected: number, length: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, length - size)));
}

function wrapIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index + length) % length;
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return kept.length ? kept.join(" · ") : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
  const fitted = fitLine(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function rule(width: number): string {
  return "─".repeat(Math.max(1, width));
}

function frame(rows: readonly string[], width: number): string[] {
  if (width < 3) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    `╭${"─".repeat(inner)}╮`,
    ...rows.map((row) => `│${pad(row, inner)}│`),
    `╰${"─".repeat(inner)}╯`,
  ];
}
