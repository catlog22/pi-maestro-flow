import { truncateToWidth } from "@earendil-works/pi-tui";
import { altKey } from "../key-labels.ts";

export type GoalWidgetPhase = "normal" | "waiting" | "retrying" | "verifying" | "verified";

/**
 * Single source of truth for pause reasons. Re-exported by tools/goal.ts as
 * PauseReason; keeping one literal list here stops the widget model from
 * silently narrowing what the domain can actually produce.
 */
export type GoalPauseReason = "user" | "budget" | "gate" | "stalled";

export interface GoalWidgetModel {
  objective: string;
  status: "active" | "paused" | "done";
  pauseReason?: GoalPauseReason;
  iteration: number;
  tokensUsed: number;
  tokenBudget?: number;
  timeUsedSeconds: number;
  retryAttempt?: number;
  retryMaxRetries?: number;
}

export interface GoalPanelEntry extends GoalWidgetModel {
  id: string;
  todoSubject?: string;
}

export interface GoalDetailEntry extends GoalPanelEntry {
  startedAt: number;
  updatedAt: number;
  verificationFailures?: number;
  acceptance?: string[];
  workflowSessionId?: string;
}

export interface GoalWidgetTheme {
  fg(color: "accent" | "success" | "warning" | "error" | "dim", text: string): string;
  bold(text: string): string;
}

export interface GoalVisualState {
  glyph: string;
  label: string;
  color: "accent" | "success" | "warning" | "error";
  hint?: string;
}

export function renderGoalWidget(
  goal: GoalWidgetModel,
  phase: GoalWidgetPhase,
  width: number,
  theme: GoalWidgetTheme,
): string[] {
  const safeWidth = Math.max(1, width);
  const state = goalVisualState(goal, phase);
  const title = theme.fg(state.color, theme.bold(`${state.glyph} Goal`));
  if (safeWidth < 20) return [truncateToWidth(`${title} ${state.label}`, safeWidth, "…")];

  const metrics = metricText(goal, safeWidth);
  const hint = state.hint ? ` · ${theme.fg("dim", state.hint)}` : "";
  const header = `${title} · ${state.label}${metrics ? ` · ${metrics}` : ""}${hint}`;
  if (safeWidth < 44) return [truncateToWidth(header, safeWidth, "…")];

  const lines = [truncateToWidth(header, safeWidth, "…")];
  const objectivePrefix = theme.fg("dim", "↳ ");
  lines.push(truncateToWidth(`${objectivePrefix}${goal.objective}`, safeWidth, "…"));
  return lines;
}

/**
 * Compact below-editor strip: the current goal gets one metric line, every
 * other goal collapses into a status chip on a shared line. Objective text
 * and other details live in the Goal overlay (Alt+G).
 */
export function renderGoalPanel(
  goals: GoalPanelEntry[],
  currentGoalId: string | undefined,
  phase: GoalWidgetPhase,
  width: number,
  theme: GoalWidgetTheme,
): string[] {
  const safeWidth = Math.max(1, width);
  if (goals.length === 0) return [];
  const total = goals.length;
  const lines: string[] = [];
  const chips: string[] = [];
  goals.forEach((goal, index) => {
    const order = `${index + 1}/${total}`;
    if (goal.id === currentGoalId) {
      const state = goalVisualState(goal, phase);
      const title = theme.fg(state.color, theme.bold(`${state.glyph} Goal ${order}`));
      if (safeWidth < 20) {
        lines.push(truncateToWidth(`${title} ${state.label}`, safeWidth, "…"));
        return;
      }
      const metrics = metricText(goal, safeWidth);
      const hint = state.hint ? ` · ${theme.fg("dim", state.hint)}` : "";
      const detail = ` · ${theme.fg("dim", `${altKey("G")} details`)}`;
      const header = `${title} · ${state.label}${metrics ? ` · ${metrics}` : ""}${hint}${detail}`;
      lines.push(truncateToWidth(header, safeWidth, "…"));
      return;
    }
    const state = goalVisualState(goal, "normal");
    chips.push(`${theme.fg(state.color, state.glyph)} ${order} ${theme.fg("dim", state.label.toLowerCase())}`);
  });
  if (chips.length > 0) lines.push(truncateToWidth(chips.join(" · "), safeWidth, "…"));
  return lines;
}

export function goalVisualState(goal: GoalWidgetModel, phase: GoalWidgetPhase): GoalVisualState {
  if (phase === "verifying") return { glyph: "◐", label: "VERIFYING", color: "accent" };
  if (phase === "verified" || goal.status === "done") {
    return { glyph: "✓", label: "VERIFIED", color: "success" };
  }
  if (phase === "retrying") {
    return {
      glyph: "↻",
      label: `RETRYING ${goal.retryAttempt ?? 1}/${goal.retryMaxRetries ?? 5}`,
      color: "warning",
    };
  }
  if (phase === "waiting") {
    return { glyph: "○", label: "WAITING", color: "warning", hint: "/goal resume" };
  }
  if (goal.status === "active") return { glyph: "▶", label: "ACTIVE", color: "accent" };
  if (goal.pauseReason === "budget") {
    return { glyph: "!", label: "BUDGET", color: "warning", hint: "/goal resume --tokens …" };
  }
  if (goal.pauseReason === "gate") {
    return { glyph: "!", label: "BLOCKED", color: "error", hint: "resolve Workflow gate" };
  }
  return { glyph: "⏸", label: "STOPPED", color: "warning", hint: "/goal resume" };
}

function metricText(goal: GoalWidgetModel, width: number): string {
  const elapsed = formatGoalDuration(goal.timeUsedSeconds);
  const round = `round ${Math.max(1, goal.iteration + 1)}`;
  if (goal.tokenBudget === undefined) return width >= 64 ? `${round} · ${elapsed}` : elapsed;

  const budget = `${formatGoalTokens(goal.tokensUsed)}/${formatGoalTokens(goal.tokenBudget)}`;
  if (width < 64) return budget;
  return `${round} · ${elapsed} · ${budget} ${goalProgressBar(goal.tokensUsed, goal.tokenBudget)}`;
}

export function goalProgressBar(used: number, budget: number, size = 8): string {
  const ratio = budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  const filled = Math.round(ratio * size);
  return `[${"█".repeat(filled)}${"░".repeat(size - filled)}]`;
}

export function formatGoalDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatGoalTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${trimDecimal(value / 1_000)}k`;
  return `${trimDecimal(value / 1_000_000)}m`;
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
