import type { AgentProgressSnapshot } from "../shared/types.ts";

export interface ProgressPalette {
  dim(text: string): string;
  accent(text: string): string;
  running(text: string): string;
  success(text: string): string;
  error(text: string): string;
  bold(text: string): string;
}

export interface ProgressTreeRow {
  taskIndex: number;
  text: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function progressDurationMs(entry: AgentProgressSnapshot, now = Date.now()): number | undefined {
  const reported = entry.durationMs;
  if (entry.status !== "running" || !entry.startedAt) return reported;
  const startedAt = Date.parse(entry.startedAt);
  if (!Number.isFinite(startedAt)) return reported;
  return Math.max(reported ?? 0, now - startedAt);
}

export function progressIcon(
  status: AgentProgressSnapshot["status"],
  palette: ProgressPalette,
): string {
  if (status === "running") return palette.running("■");
  if (status === "completed") return palette.success("✓");
  if (status === "failed") return palette.error("✗");
  return palette.dim("□");
}

export function progressLabel(entry: AgentProgressSnapshot): string {
  return entry.name ? `@${entry.name}` : entry.agent;
}

function statusText(status: AgentProgressSnapshot["status"], palette: ProgressPalette): string {
  if (status === "running") return palette.running("running");
  if (status === "completed") return palette.success("completed");
  if (status === "failed") return palette.error("failed");
  return palette.dim("pending");
}

export function buildProgressTree(
  progress: AgentProgressSnapshot[],
  palette: ProgressPalette,
): ProgressTreeRow[] {
  const byIndex = new Map<number, AgentProgressSnapshot>();
  for (const entry of progress) byIndex.set(entry.taskIndex, entry);
  const entries = [...byIndex.values()].sort((a, b) => a.taskIndex - b.taskIndex);

  return entries.map((entry) => {
    // Dependencies transfer task results; they are not parent-child agent relations.
    const flowMarker = entry.dependencies.length > 0 ? "→" : "•";
    const type = entry.name ? palette.dim(` (${entry.agent})`) : "";
    const id = entry.correlationId.startsWith("preview-")
      ? ""
      : palette.dim(` #${entry.correlationId.slice(0, 8)}`);
    const dependencyHint = entry.dependencies.length > 0
      ? palette.dim(` ← result${entry.dependencies.length === 1 ? "" : "s"} ${entry.dependencies.map((dependency) => `#${dependency + 1}`).join(", ")}`)
      : "";
    const tokenParts = entry.inputTokens !== undefined || entry.outputTokens !== undefined
      ? [`in ${formatTokens(entry.inputTokens ?? 0)}`, `out ${formatTokens(entry.outputTokens ?? 0)}`]
      : entry.tokens
        ? [`${formatTokens(entry.tokens)} tok`]
        : [];
    const durationMs = progressDurationMs(entry);
    const metaParts = [
      entry.toolCount ? `${entry.toolCount} tools` : "",
      ...tokenParts,
      durationMs !== undefined ? formatDuration(durationMs) : "",
    ].filter(Boolean);
    const meta = metaParts.length > 0 ? palette.dim(` · ${metaParts.join(" · ")}`) : "";
    return {
      taskIndex: entry.taskIndex,
      text: `${palette.dim(flowMarker)} ${palette.accent(String(entry.taskIndex + 1))} ${progressIcon(entry.status, palette)} ${statusText(entry.status, palette)} ${palette.bold(progressLabel(entry))}${type}${id}${dependencyHint}${meta}`,
    };
  });
}

export function focusTaskIndex(progress: AgentProgressSnapshot[]): number | undefined {
  return progress.find((entry) => entry.status === "running")?.taskIndex
    ?? progress.find((entry) => entry.status === "failed")?.taskIndex
    ?? (progress.length > 0 ? progress[progress.length - 1].taskIndex : undefined);
}

export function selectProgressWindow(
  rows: ProgressTreeRow[],
  maxRows: number,
  focusIndex?: number,
): { rows: ProgressTreeRow[]; start: number; total: number } {
  if (rows.length <= maxRows) return { rows, start: 0, total: rows.length };
  const focusRow = Math.max(0, rows.findIndex((row) => row.taskIndex === focusIndex));
  const start = Math.max(0, Math.min(rows.length - maxRows, focusRow - Math.floor(maxRows / 2)));
  return { rows: rows.slice(start, start + maxRows), start, total: rows.length };
}

export function selectPriorityProgressRows(
  rows: ProgressTreeRow[],
  maxRows: number,
  focusIndex: number | undefined,
  pinnedIndexes: readonly number[],
): { rows: ProgressTreeRow[]; total: number; hidden: number } {
  if (rows.length <= maxRows) return { rows, total: rows.length, hidden: 0 };
  const selected = new Set<number>();
  const focusRow = rows.findIndex((row) => row.taskIndex === focusIndex);
  if (focusRow >= 0) selected.add(focusRow);
  for (const taskIndex of pinnedIndexes) {
    const index = rows.findIndex((row) => row.taskIndex === taskIndex);
    if (index >= 0 && selected.size < maxRows) selected.add(index);
  }
  for (let distance = 0; selected.size < maxRows && distance < rows.length; distance++) {
    for (const index of [focusRow - distance, focusRow + distance]) {
      if (index >= 0 && index < rows.length) selected.add(index);
      if (selected.size >= maxRows) break;
    }
  }
  for (let index = rows.length - 1; selected.size < maxRows && index >= 0; index--) selected.add(index);
  const visible = [...selected].sort((a, b) => a - b).slice(0, maxRows).map((index) => rows[index]);
  return { rows: visible, total: rows.length, hidden: rows.length - visible.length };
}
