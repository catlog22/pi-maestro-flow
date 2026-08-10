import type { ExpertsStatus } from "./observe.ts";
import { getStatus } from "./observe.ts";
import { formatExpertsHarvestStatus } from "./harvest-status.ts";
import type { DispatchRecord, InFlightExpert } from "./types.ts";

function truncate(text: unknown, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * LastDispatch line fields — taskType/agent/stage/forced/at/promptPreview.
 * The model field is deliberately omitted even when the record carries one:
 * routing owns models, the panel never leaks model ids.
 */
function lastDispatchFields(record: DispatchRecord | null): string[] {
  if (!record) return [];
  const fields: string[] = [];
  if (record.taskType) fields.push(`taskType=${record.taskType}`);
  if (record.agent) fields.push(`agent=${record.agent}`);
  if (record.stage) fields.push(`stage=${record.stage}`);
  fields.push(`forced=${Boolean(record.forced)}`);
  if (record.at) fields.push(`at=${record.at}`);
  const preview = truncate(record.promptPreview, 80);
  if (preview) fields.push(`prompt="${preview}"`);
  return fields;
}

/** Pure formatter — no disk writes, no model ids. */
export function formatExpertsStatusPanelFromStatus(status: ExpertsStatus): string {
  const lines: string[] = ["=== Experts Mode Status ==="];

  // Mode
  lines.push(`Mode: ${status.mode}`);

  // LeaderWaiting: yes/no + count + agent ids (comma, max 6)
  const waitingIds = (status.leaderWaitingAgentIds ?? []).slice(0, 6).join(", ");
  lines.push(status.leaderWaiting
    ? `LeaderWaiting: yes (${status.leaderWaitingCount})${waitingIds ? ` agents=[${waitingIds}]` : ""}`
    : "LeaderWaiting: no");

  // ActiveStage: stage + source if present, else "(none)"
  const stage = status.activeStage;
  lines.push(stage
    ? `ActiveStage: ${stage.stage}${stage.source ? ` (source=${stage.source})` : ""}`
    : "ActiveStage: (none)");

  // LastDispatch — omit model field entirely even if present on record
  const lastRecord = (status.lastDispatch && typeof status.lastDispatch === "object"
    ? status.lastDispatch
    : null) as DispatchRecord | null;
  const last = lastDispatchFields(lastRecord);
  lines.push(last.length ? `LastDispatch: ${last.join(" ")}` : "LastDispatch: (none)");

  // InFlight: count + list name|id|agent|taskType (max 8)
  const inFlight: InFlightExpert[] = status.inFlight ?? [];
  lines.push(inFlight.length ? `InFlight: ${inFlight.length}` : "InFlight: 0");
  for (const entry of inFlight.slice(0, 8)) {
    const parts: string[] = [];
    if (entry.name) parts.push(`name=${entry.name}`);
    parts.push(`id=${entry.id}`);
    if (entry.agent) parts.push(`agent=${entry.agent}`);
    if (entry.taskType) parts.push(`taskType=${entry.taskType}`);
    lines.push(`  - ${parts.join(" ")}`);
  }

  // Harvest
  const harvest = formatExpertsHarvestStatus(status.knowledgeSuggestions ?? []);
  lines.push(harvest ? `Harvest: ${harvest}` : "Harvest: (none)");

  // Path + updatedAt if present
  lines.push(`Path: ${status.path}`);
  if (status.updatedAt) lines.push(`updatedAt: ${status.updatedAt}`);

  return lines.join("\n");
}

export function formatExpertsStatusPanel(cwd = process.cwd(), statePath?: string): string {
  return formatExpertsStatusPanelFromStatus(getStatus(cwd, statePath));
}
