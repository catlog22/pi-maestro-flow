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
  const depthCache = new Map<number, number>();

  function depthOf(taskIndex: number, visiting = new Set<number>()): number {
    const cached = depthCache.get(taskIndex);
    if (cached !== undefined) return cached;
    if (visiting.has(taskIndex)) return 0;
    visiting.add(taskIndex);
    const entry = byIndex.get(taskIndex);
    const depth = !entry || entry.dependencies.length === 0
      ? 0
      : 1 + Math.max(0, ...entry.dependencies.map((dependency) => depthOf(dependency, visiting)));
    visiting.delete(taskIndex);
    depthCache.set(taskIndex, depth);
    return depth;
  }

  const ordered = entries
    .map((entry) => ({ entry, depth: depthOf(entry.taskIndex) }))
    .sort((a, b) => a.depth - b.depth || a.entry.taskIndex - b.entry.taskIndex);
  const groupCounts = new Map<number, number>();
  const groupSeen = new Map<number, number>();
  for (const item of ordered) groupCounts.set(item.depth, (groupCounts.get(item.depth) ?? 0) + 1);

  return ordered.map(({ entry, depth }) => {
    const seen = groupSeen.get(depth) ?? 0;
    groupSeen.set(depth, seen + 1);
    const connector = seen === (groupCounts.get(depth) ?? 1) - 1 ? "└─" : "├─";
    const prefix = depth > 0 ? "│ ".repeat(depth) : "";
    const type = entry.name ? palette.dim(` (${entry.agent})`) : "";
    const id = entry.correlationId.startsWith("preview-")
      ? ""
      : palette.dim(` #${entry.correlationId.slice(0, 8)}`);
    const dependencyHint = entry.dependencies.length > 0
      ? palette.dim(` ← ${entry.dependencies.map((dependency) => dependency + 1).join(",")}`)
      : "";
    const metaParts = [
      entry.toolCount ? `${entry.toolCount} tools` : "",
      entry.tokens ? `${entry.tokens} tok` : "",
      entry.durationMs ? formatDuration(entry.durationMs) : "",
    ].filter(Boolean);
    const meta = metaParts.length > 0 ? palette.dim(` · ${metaParts.join(" · ")}`) : "";
    return {
      taskIndex: entry.taskIndex,
      text: `${palette.dim(prefix + connector)} ${palette.accent(String(entry.taskIndex + 1))} ${progressIcon(entry.status, palette)} ${statusText(entry.status, palette)} ${palette.bold(progressLabel(entry))}${type}${id}${dependencyHint}${meta}`,
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
