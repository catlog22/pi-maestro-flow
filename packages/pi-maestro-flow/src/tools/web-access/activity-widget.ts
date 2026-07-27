import { activityMonitor, type ActivityEntry } from "./activity.ts";

export interface ActivityWidgetState {
  visible: boolean;
  entries: ActivityEntry[];
}

let widgetVisible = false;
let unsubscribe: (() => void) | undefined;

export function toggleActivityWidget(): boolean {
  widgetVisible = !widgetVisible;
  return widgetVisible;
}

export function isActivityWidgetVisible(): boolean {
  return widgetVisible;
}

export function getActivityEntries(): ActivityEntry[] {
  return activityMonitor.getEntries();
}

export function renderActivityWidget(width: number): string[] {
  if (!widgetVisible) return [];
  const entries = activityMonitor.getEntries();
  const inner = Math.max(1, width - 2);
  const lines: string[] = [`Activity (${entries.length})`];
  for (const entry of entries) {
    const elapsed = entry.endMs
      ? `${((entry.endMs - entry.startMs) / 1000).toFixed(1)}s`
      : "running";
    const status = entry.error ? "✗" : entry.endMs ? "✓" : "…";
    const label = entry.type === "search"
      ? `search:${entry.provider ?? "?"}`
      : `fetch:${(entry.url ?? "?").slice(0, 30)}`;
    lines.push(`${status} ${label} ${elapsed}`);
  }
  return lines.map((line) => line.slice(0, inner));
}

export function subscribeActivityUpdates(callback: () => void): () => void {
  return activityMonitor.onUpdate(callback);
}
