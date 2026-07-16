import { truncateToWidth } from "@earendil-works/pi-tui";

export type GoalWidgetPhase = "normal" | "waiting" | "verifying" | "verified";

export interface GoalWidgetModel {
  objective: string;
  status: "active" | "paused" | "done";
  pauseReason?: "user" | "budget" | "gate" | "error";
  iteration: number;
  tokensUsed: number;
  tokenBudget?: number;
  timeUsedSeconds: number;
}

export interface GoalWidgetTheme {
  fg(color: "accent" | "success" | "warning" | "error" | "dim", text: string): string;
  bold(text: string): string;
}

interface VisualState {
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
  const state = visualState(goal, phase);
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

function visualState(goal: GoalWidgetModel, phase: GoalWidgetPhase): VisualState {
  if (phase === "verifying") return { glyph: "◐", label: "VERIFYING", color: "accent" };
  if (phase === "verified" || goal.status === "done") {
    return { glyph: "✓", label: "VERIFIED", color: "success" };
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
  if (goal.pauseReason === "error") {
    return { glyph: "!", label: "ERROR", color: "error", hint: "/goal resume" };
  }
  return { glyph: "⏸", label: "STOPPED", color: "warning", hint: "/goal resume" };
}

function metricText(goal: GoalWidgetModel, width: number): string {
  const elapsed = formatDuration(goal.timeUsedSeconds);
  const round = `round ${Math.max(1, goal.iteration + 1)}`;
  if (goal.tokenBudget === undefined) return width >= 64 ? `${round} · ${elapsed}` : elapsed;

  const budget = `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
  if (width < 64) return budget;
  return `${round} · ${elapsed} · ${budget} ${progressBar(goal.tokensUsed, goal.tokenBudget)}`;
}

function progressBar(used: number, budget: number): string {
  const size = 8;
  const ratio = budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  const filled = Math.round(ratio * size);
  return `[${"█".repeat(filled)}${"░".repeat(size - filled)}]`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${trimDecimal(value / 1_000)}k`;
  return `${trimDecimal(value / 1_000_000)}m`;
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
