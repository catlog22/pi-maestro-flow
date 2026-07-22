import { type Component, type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type WorkflowRunView,
  type WorkflowViewModel,
  workflowStatusLabel,
} from "../session/view-model.ts";

export type SessionOverlayAction = "pause" | "resume" | "decision" | "brief" | "check" | "next" | "done";

export interface SessionOverlayParams {
  view: WorkflowViewModel;
  requestRender: () => void;
  close: () => void;
  onAction: (action: SessionOverlayAction, runId?: string) => void | Promise<void>;
}

type OverlayMode = "list" | "detail" | "confirm";

export class SessionOverlay implements Component, Focusable {
  focused = false;
  private view: WorkflowViewModel;
  private mode: OverlayMode = "list";
  private selected = 0;
  private pending = false;
  private status = "";
  private confirmAction: "done" | undefined;

  constructor(private readonly params: SessionOverlayParams) {
    this.view = params.view;
  }

  invalidate(): void {}
  dispose(): void {}

  update(view: WorkflowViewModel): void {
    this.view = view;
    this.selected = clampIndex(this.selected, view.runs.length);
    this.params.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    if (this.mode === "confirm") return this.renderConfirm(safeWidth);
    if (this.mode === "detail") return this.renderDetail(safeWidth);
    return this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (this.pending) return;
    if (data === "\x1b") {
      if (this.mode === "confirm") {
        this.mode = "detail";
        this.confirmAction = undefined;
      } else if (this.mode === "detail") {
        this.mode = "list";
      } else {
        this.params.close();
      }
      this.params.requestRender();
      return;
    }

    if (this.mode === "confirm") {
      if (isEnter(data) && this.confirmAction) void this.execute(this.confirmAction);
      return;
    }

    if (data === "\x1b[A" || data === "k") {
      this.selected = wrapIndex(this.selected - 1, this.view.runs.length);
      this.params.requestRender();
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.selected = wrapIndex(this.selected + 1, this.view.runs.length);
      this.params.requestRender();
      return;
    }
    if (isEnter(data)) {
      this.mode = "detail";
      this.params.requestRender();
      return;
    }

    const action = actionForInput(data);
    if (!action) return;
    if (action === "done") {
      this.confirmAction = action;
      this.mode = "confirm";
      this.params.requestRender();
      return;
    }
    void this.execute(action);
  }

  private renderCompact(width: number): string {
    const action = this.view.recoveryAction ?? this.view.nextAction;
    const content = action
      ? `» ${action}`
      : `${workflowStatusLabel(this.view.status)} · Esc close`;
    return truncateToWidth(content, width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const rows = [
      fitLine(`Session ${this.view.sessionLabel} · ${workflowStatusLabel(this.view.status)}`, inner),
      rule(inner),
    ];
    if (this.view.runs.length === 0) {
      rows.push(fitLine("○ pending · no runs", inner));
    } else {
      const start = Math.max(0, Math.min(this.selected - 3, this.view.runs.length - 7));
      for (let index = start; index < Math.min(this.view.runs.length, start + 7); index++) {
        rows.push(this.renderRunRow(this.view.runs[index], index === this.selected, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(fitSegments(inner, this.controlSegments("Esc close")));
    return frame(rows, width);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const run = this.selectedRun();
    const rows = [fitLine(`Session ${this.view.sessionLabel} · run detail`, inner), rule(inner)];
    if (!run) {
      rows.push(fitLine("○ pending · no run selected", inner));
    } else {
      rows.push(fitLine(`${run.id}/${run.command} · ${workflowStatusLabel(run.status, run.attempt)}`, inner));
      if (run.gate) rows.push(fitLine(`Gate: ${run.gate}`, inner));
      if (run.verdict) rows.push(fitLine(`Verdict: ${run.verdict}`, inner));
      rows.push(fitLine(`Artifacts: ${run.artifactsCount}`, inner));
      if (run.blockedBy) rows.push(fitLine(`Blocked by: ${run.blockedBy}`, inner));
      if (run.nextAction) rows.push(fitLine(`» Next: ${run.nextAction}`, inner));
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(fitSegments(inner, this.controlSegments("Esc back")));
    return frame(rows, width);
  }

  private renderConfirm(width: number): string[] {
    const inner = width - 2;
    const run = this.selectedRun();
    const rows = [
      fitLine(`✓ Complete ${run?.id ?? "session"}?`, inner),
      fitLine("Enter confirm · Esc back", inner),
    ];
    return frame(rows, width);
  }

  private renderRunRow(run: WorkflowRunView, selected: boolean, width: number): string {
    const marker = selected ? "›" : " ";
    const sequence = run.sequence != null ? String(run.sequence).padStart(3, "0") : run.id;
    const meta = [run.gate, run.verdict].filter(Boolean).join(" · ");
    const content = `${marker} ${sequence}/${run.command} · ${workflowStatusLabel(run.status, run.attempt)}${meta ? ` · ${meta}` : ""}`;
    return fitLine(content, width);
  }

  private controlSegments(escapeLabel: string): string[] {
    const segments = [];
    const recovery = this.view.recoveryAction ?? this.view.nextAction;
    if (recovery) segments.push(`» ${recovery}`);
    segments.push("Enter detail", "r resume", "p pause", "b brief", "c check", "n next");
    if (this.view.decisionPending) segments.push("d decision");
    segments.push("D done", escapeLabel);
    return segments;
  }

  private selectedRun(): WorkflowRunView | undefined {
    return this.view.runs[this.selected];
  }

  private async execute(action: SessionOverlayAction): Promise<void> {
    const selected = this.selected;
    this.pending = true;
    this.status = `${action}…`;
    this.params.requestRender();
    try {
      await this.params.onAction(action, this.selectedRun()?.id);
      this.status = `${action} requested`;
      this.mode = "detail";
      this.confirmAction = undefined;
    } catch (error) {
      this.selected = clampIndex(selected, this.view.runs.length);
      this.status = `Action failed: ${errorMessage(error)}`;
      this.mode = "detail";
      this.confirmAction = undefined;
    } finally {
      this.pending = false;
      this.params.requestRender();
    }
  }
}

function actionForInput(data: string): SessionOverlayAction | undefined {
  if (data === "p") return "pause";
  if (data === "r") return "resume";
  if (data === "d") return "decision";
  if (data === "b") return "brief";
  if (data === "c") return "check";
  if (data === "n") return "next";
  if (data === "D") return "done";
  return undefined;
}

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  if (kept.length === 0) return truncateToWidth(segments[0] ?? "", width, "…");
  return kept.join(" · ");
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function rule(width: number): string {
  return "─".repeat(Math.max(1, width));
}

function frame(rows: readonly string[], width: number): string[] {
  if (width < 3) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    `╭${"─".repeat(inner)}╮`,
    ...rows.map((row) => {
      const content = fitLine(row, inner);
      return `│${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}│`;
    }),
    `╰${"─".repeat(inner)}╯`,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
