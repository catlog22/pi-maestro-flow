import { activityMonitor, type ActivityEntry } from "./activity.ts";

export interface ActivityWidgetState {
  visible: boolean;
  entries: readonly ActivityEntry[];
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

export function getActivityEntries(): readonly ActivityEntry[] {
  return activityMonitor.getEntries();
}

export function renderActivityWidget(width: number): string[] {
  if (!widgetVisible) return [];
  const entries = activityMonitor.getEntries();
  const inner = Math.max(1, width - 2);
  const lines: string[] = [`Activity (${entries.length})`];
  for (const entry of entries) {
    const elapsed = entry.endTime
      ? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
      : "running";
    const status = entry.error ? "✗" : entry.endTime ? "✓" : "…";
    const label = entry.type === "api"
      ? `api:${(entry.query ?? "?").slice(0, 30)}`
      : `fetch:${(entry.url ?? "?").slice(0, 30)}`;
    lines.push(`${status} ${label} ${elapsed}`);
  }
  return lines.map((line) => line.slice(0, inner));
}

export function subscribeActivityUpdates(callback: () => void): () => void {
  return activityMonitor.onUpdate(callback);
}
