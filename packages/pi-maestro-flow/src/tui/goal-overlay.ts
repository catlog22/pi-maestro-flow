import {
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type GoalDetailEntry,
  type GoalWidgetPhase,
  formatGoalDuration,
  formatGoalTokens,
  goalProgressBar,
  goalVisualState,
} from "./goal-widget.ts";

export type GoalOverlayAction = "switch" | "stop" | "resume" | "clear";

export interface GoalOverlayParams {
  getEntries: () => readonly GoalDetailEntry[];
  getCurrentGoalId: () => string | undefined;
  getPhase: () => GoalWidgetPhase;
  requestRender: () => void;
  close: () => void;
  theme: Theme;
  onAction: (action: GoalOverlayAction, goalId: string) => void | Promise<void>;
  /** Sampled once per passive render; the overlay intentionally owns no clock timer. */
  now?: () => number;
}

type GoalOverlayMode = "list" | "detail" | "confirm";

export class GoalOverlay implements Component, Focusable {
  focused = false;
  private mode: GoalOverlayMode = "list";
  private selected = 0;
  private pending = false;
  private status = "";

  constructor(private readonly params: GoalOverlayParams) {}

  invalidate(): void {}
  dispose(): void {}

  handleInput(data: string): void {
    if (this.pending) return;
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "confirm" || this.mode === "detail") this.mode = "list";
      else this.params.close();
      this.params.requestRender();
      return;
    }

    if (this.mode === "confirm") {
      if (isEnter(data)) {
        const entry = this.selectedEntry();
        this.mode = "list";
        if (entry) void this.execute("clear", entry.id);
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.move(1);
      return;
    }
    if (isEnter(data)) {
      if (this.selectedEntry()) this.mode = this.mode === "detail" ? "list" : "detail";
      this.params.requestRender();
      return;
    }

    const action = actionForInput(data);
    if (!action) return;
    const entry = this.selectedEntry();
    if (!entry) return;
    if (action === "clear") {
      this.mode = "confirm";
      this.params.requestRender();
      return;
    }
    void this.execute(action, entry.id);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const now = this.params.now?.() ?? Date.now();
    this.clampState();
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    if (this.mode === "confirm") return this.renderConfirm(safeWidth);
    if (this.mode === "detail") return this.renderDetail(safeWidth, now);
    if (safeWidth < 88) return this.renderList(safeWidth);
    return this.renderWide(safeWidth, now);
  }

  private renderCompact(width: number): string {
    const theme = this.params.theme;
    const entry = this.selectedEntry();
    const text = entry
      ? `${goalVisualState(entry, this.phaseFor(entry)).glyph} ${this.orderOf(entry)} ${entry.status} · Esc`
      : "Goal · none · Esc";
    return theme.bg("customMessageBg", pad(truncateToWidth(text, width, "…"), width));
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const entries = this.entries();
    const rows: string[] = [this.header(inner), this.separator(inner)];
    const selectedRows = new Set<number>();
    if (entries.length === 0) {
      rows.push(fitLine("○ no goals · /goal create <objective>", inner));
    } else {
      const start = visibleStart(this.selected, entries.length, 8);
      for (let index = start; index < Math.min(entries.length, start + 8); index++) {
        if (index === this.selected) selectedRows.add(rows.length);
        rows.push(this.goalRow(entries[index], index === this.selected, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(this.helpLine(inner));
    return this.card(rows, width, selectedRows);
  }

  private renderWide(width: number, now: number): string[] {
    const inner = width - 2;
    const leftWidth = Math.max(30, Math.floor((inner - 3) * 0.42));
    const rightWidth = inner - leftWidth - 3;
    const entries = this.entries();
    const start = visibleStart(this.selected, entries.length, 8);
    const left = entries.slice(start, start + 8).map((entry, offset) =>
      this.goalRow(entry, start + offset === this.selected, leftWidth)
    );
    const right = this.detailLines(this.selectedEntry(), rightWidth, 5, now);
    const rowCount = Math.max(left.length, right.length, 1);
    const rows: string[] = [this.header(inner), this.separator(inner)];
    const selectedRows = new Set<number>();
    for (let index = 0; index < rowCount; index++) {
      if (entries.length > 0 && start + index === this.selected) selectedRows.add(rows.length);
      rows.push(`${pad(left[index] ?? "", leftWidth)} │ ${pad(right[index] ?? "", rightWidth)}`);
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(this.helpLine(inner));
    return this.card(rows, width, selectedRows);
  }

  private renderDetail(width: number, now: number): string[] {
    const inner = width - 2;
    const rows: string[] = [this.header(inner), this.separator(inner)];
    rows.push(...this.detailLines(this.selectedEntry(), inner, 12, now));
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(this.helpLine(inner, ["Esc back", "↑↓ goal", "s switch", "p stop", "r resume", "x clear"]));
    return this.card(rows, width);
  }

  private renderConfirm(width: number): string[] {
    const inner = width - 2;
    const entry = this.selectedEntry();
    const rows = [
      fitLine(`⊘ Clear ${entry ? `Goal ${this.orderOf(entry)}` : "goal"}? This abandons it permanently.`, inner),
      fitLine(this.params.theme.fg("dim", entry?.objective ?? ""), inner),
      fitLine("Enter confirm · Esc back", inner),
    ];
    return this.card(rows, width);
  }

  private goalRow(entry: GoalDetailEntry, selected: boolean, width: number): string {
    const theme = this.params.theme;
    const state = goalVisualState(entry, this.phaseFor(entry));
    const isCurrent = entry.id === this.params.getCurrentGoalId();
    const budget = entry.tokenBudget !== undefined
      ? ` · ${formatGoalTokens(entry.tokensUsed)}/${formatGoalTokens(entry.tokenBudget)}`
      : "";
    const current = isCurrent ? ` ${theme.fg("dim", "· current")}` : "";
    const label = isCurrent ? theme.bold(state.label) : state.label.toLowerCase();
    return fitLine(
      `${selected ? "›" : " "} ${theme.fg(state.color, state.glyph)} ${this.orderOf(entry)} · ${label}${budget}${current}`,
      width,
    );
  }

  private detailLines(entry: GoalDetailEntry | undefined, width: number, objectiveMax: number, now: number): string[] {
    const theme = this.params.theme;
    if (!entry) return [fitLine("○ no goals · /goal create <objective>", width)];
    const state = goalVisualState(entry, this.phaseFor(entry));
    const isCurrent = entry.id === this.params.getCurrentGoalId();
    const lines: string[] = [];
    const tag = isCurrent ? theme.fg("dim", " · current") : "";
    lines.push(fitLine(
      `${theme.fg(state.color, theme.bold(`${state.glyph} Goal ${this.orderOf(entry)}`))} · ${state.label}${tag}`,
      width,
    ));
    const wrapped = wrapTextWithAnsi(entry.objective, Math.max(10, width));
    lines.push(...wrapped.slice(0, objectiveMax).map((line) => fitLine(line, width)));
    if (wrapped.length > objectiveMax) {
      lines.push(fitLine(theme.fg("dim", `… +${wrapped.length - objectiveMax} more line(s) · Enter for full view`), width));
    }
    lines.push(field("Status", `${entry.status}${entry.pauseReason ? ` (${entry.pauseReason})` : ""}`, width));
    lines.push(field("Round", String(entry.iteration + 1), width));
    lines.push(field("Elapsed", formatGoalDuration(entry.timeUsedSeconds), width));
    lines.push(field("Tokens", tokenDetail(entry), width));
    if (entry.todoSubject) lines.push(field("Task", entry.todoSubject, width));
    if (entry.acceptance?.length) lines.push(field("Acceptance", entry.acceptance.join(" · "), width));
    if (entry.workflowSessionId) lines.push(field("Workflow", entry.workflowSessionId, width));
    if (entry.verificationFailures) {
      lines.push(field("Failures", `${entry.verificationFailures} verification failure${entry.verificationFailures === 1 ? "" : "s"}`, width));
    }
    lines.push(field("Updated", `${formatGoalDuration(ageSeconds(entry.updatedAt, now))} ago`, width));
    if (state.hint) lines.push(field("Hint", theme.fg("dim", state.hint), width));
    return lines;
  }

  private header(width: number): string {
    const theme = this.params.theme;
    const entries = this.entries();
    const active = entries.filter((entry) => entry.status === "active").length;
    const done = entries.filter((entry) => entry.status === "done").length;
    const stopped = entries.length - active - done;
    return fitLine(
      `Goal center · ${entries.length} goal${entries.length === 1 ? "" : "s"} · `
      + `${theme.fg("accent", `${active} active`)} · ${theme.fg("warning", `${stopped} stopped`)} · ${theme.fg("success", `${done} done`)}`,
      width,
    );
  }

  private helpLine(width: number, segments?: string[]): string {
    return fitSegments(width, segments ?? ["Esc close", "Enter detail", "↑↓ goal", "s switch", "p stop", "r resume", "x clear"]);
  }

  private separator(width: number): string {
    return this.params.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
  }

  private card(rows: string[], width: number, selectedRows: ReadonlySet<number> = new Set()): string[] {
    const theme = this.params.theme;
    const edge = "─".repeat(Math.max(0, width - 2));
    const border = (glyph: string) => theme.bg("customMessageBg", theme.fg("borderMuted", glyph));
    const out: string[] = [border(`╭${edge}╮`)];
    rows.forEach((row, index) => {
      const bg = selectedRows.has(index) ? "selectedBg" : "customMessageBg";
      out.push(theme.bg(bg, pad(` ${row}`, width)));
    });
    out.push(border(`╰${edge}╯`));
    return out;
  }

  private move(delta: number): void {
    this.selected = wrapIndex(this.selected + delta, this.entries().length);
    this.params.requestRender();
  }

  private clampState(): void {
    this.selected = clampIndex(this.selected, this.entries().length);
  }

  private entries(): readonly GoalDetailEntry[] {
    return this.params.getEntries();
  }

  private selectedEntry(): GoalDetailEntry | undefined {
    return this.entries()[this.selected];
  }

  private orderOf(entry: GoalDetailEntry): string {
    const entries = this.entries();
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    return `${index + 1}/${entries.length}`;
  }

  private phaseFor(entry: GoalDetailEntry): GoalWidgetPhase {
    return entry.id === this.params.getCurrentGoalId() ? this.params.getPhase() : "normal";
  }

  private async execute(action: GoalOverlayAction, goalId: string): Promise<void> {
    this.pending = true;
    this.status = `${action}…`;
    this.params.requestRender();
    try {
      await this.params.onAction(action, goalId);
      this.status = `${action} done`;
    } catch (error) {
      this.status = `Action failed: ${errorMessage(error)}`;
    } finally {
      this.pending = false;
      this.clampState();
      this.params.requestRender();
    }
  }
}

function actionForInput(data: string): GoalOverlayAction | undefined {
  if (matchesKey(data, "s")) return "switch";
  if (matchesKey(data, "p")) return "stop";
  if (matchesKey(data, "r")) return "resume";
  if (matchesKey(data, "x")) return "clear";
  return undefined;
}

function tokenDetail(entry: GoalDetailEntry): string {
  if (entry.tokenBudget === undefined) {
    return entry.tokensUsed > 0 ? `${formatGoalTokens(entry.tokensUsed)} used · no budget` : "no budget";
  }
  const pct = entry.tokenBudget > 0
    ? Math.min(100, Math.round((entry.tokensUsed / entry.tokenBudget) * 100))
    : 0;
  return `${formatGoalTokens(entry.tokensUsed)}/${formatGoalTokens(entry.tokenBudget)} `
    + `${goalProgressBar(entry.tokensUsed, entry.tokenBudget, 10)} ${pct}%`;
}

function field(label: string, value: string, width: number): string {
  return fitLine(`${label.padEnd(10)} ${value}`, width);
}

function ageSeconds(timestamp: number, now: number): number {
  return Math.max(0, Math.floor((now - timestamp) / 1000));
}

function isEnter(data: string): boolean {
  return matchesKey(data, Key.enter);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function visibleStart(selected: number, length: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, length - size)));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
