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
  lines.push("", `Mode: ${status.mode}`);

  // LeaderWaiting: yes/no + count + agent ids (comma, max 6)
  const waitingIds = (status.leaderWaitingAgentIds ?? []).slice(0, 6).join(", ");
  lines.push("", status.leaderWaiting
    ? `LeaderWaiting: yes (${status.leaderWaitingCount})${waitingIds ? ` agents=[${waitingIds}]` : ""}`
    : "LeaderWaiting: no");

  // ActiveStage: stage + source if present, else "(none)"
  const stage = status.activeStage;
  lines.push("", stage
    ? `ActiveStage: ${stage.stage}${stage.source ? ` (source=${stage.source})` : ""}`
    : "ActiveStage: (none)");

  // LastDispatch — omit model field entirely even if present on record
  const lastRecord = (status.lastDispatch && typeof status.lastDispatch === "object"
    ? status.lastDispatch
    : null) as DispatchRecord | null;
  const last = lastDispatchFields(lastRecord);
  lines.push("", last.length ? `LastDispatch: ${last.join(" ")}` : "LastDispatch: (none)");

  // InFlight: count + list name|id|agent|taskType (max 8)
  const inFlight: InFlightExpert[] = status.inFlight ?? [];
  lines.push("", inFlight.length ? `InFlight: ${inFlight.length}` : "InFlight: 0");
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
  lines.push("", harvest ? `Harvest: ${harvest}` : "Harvest: (none)");

  // Path + updatedAt if present
  lines.push("", `Path: ${status.path}`);
  if (status.updatedAt) lines.push(`updatedAt: ${status.updatedAt}`);

  return lines.join("\n");
}

export function formatExpertsStatusPanel(cwd = process.cwd(), statePath?: string): string {
  return formatExpertsStatusPanelFromStatus(getStatus(cwd, statePath));
}

/** CLI panel views for the /experts command (roster|waiting|harvest|status). */
export type ExpertsPanelView = "status" | "roster" | "waiting" | "harvest";

/**
 * Roster section — roles only, never models.
 * Enabled entries first; each row: id | agent | taskType | label | caps | enabled.
 */
export function formatExpertsRosterPanelFromStatus(status: ExpertsStatus): string {
  const lines: string[] = ["=== Experts Roster ==="];
  const roster = (status.roster ?? []).slice().sort((a, b) => {
    if ((a.enabled !== false) !== (b.enabled !== false)) return a.enabled === false ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  if (roster.length === 0) {
    lines.push("(no roster — using taskType defaults)");
  } else {
    for (const entry of roster) {
      const caps = (entry.capabilities ?? []).join(",");
      lines.push([
        entry.id,
        entry.agent,
        entry.defaultTaskType,
        entry.label ?? "",
        caps,
        entry.enabled === false ? "disabled" : "enabled",
      ].join(" | "));
    }
  }
  lines.push("role ≠ model — routing owns models");
  return lines.join("\n");
}

/**
 * Waiting section — leaderWaiting + in-flight expert units + active stage.
 * While leaderWaiting, the Lead must not claim done.
 */
export function formatExpertsWaitingPanelFromStatus(status: ExpertsStatus): string {
  const lines: string[] = ["=== Experts Waiting ==="];
  const ids = (status.leaderWaitingAgentIds ?? []).join(", ");
  lines.push(status.leaderWaiting
    ? `LeaderWaiting: yes (${status.leaderWaitingCount})${ids ? ` agents=[${ids}]` : ""}`
    : "LeaderWaiting: no");

  const inFlight: InFlightExpert[] = (status.inFlight ?? []).slice(0, 20);
  lines.push(inFlight.length ? `InFlight: ${inFlight.length}` : "InFlight: 0");
  for (const entry of inFlight) {
    const parts: string[] = [];
    if (entry.name) parts.push(`name=${entry.name}`);
    parts.push(`id=${entry.id}`);
    if (entry.agent) parts.push(`agent=${entry.agent}`);
    if (entry.taskType) parts.push(`taskType=${entry.taskType}`);
    lines.push(`  - ${parts.join(" ")}`);
  }

  const stage = status.activeStage;
  lines.push(stage
    ? `ActiveStage: ${stage.stage}${stage.source ? ` (source=${stage.source})` : ""}`
    : "ActiveStage: (none)");

  if (status.leaderWaiting) {
    lines.push("Hint: do not claim done while waiting — consume teammate-complete/settle first");
  }
  return lines.join("\n");
}

/**
 * Harvest section — pending P7 knowhow suggestions (never auto-promoted).
 * Suggestion rows: id | kind | title (≤72) | score; max 20 rows.
 */
export function formatExpertsHarvestPanelFromStatus(status: ExpertsStatus): string {
  const lines: string[] = ["=== Experts Harvest ==="];
  const suggestions = status.knowledgeSuggestions ?? [];
  const summary = formatExpertsHarvestStatus(suggestions);
  if (!summary) {
    lines.push("(none — settle harvest is suggest-only)");
  } else {
    lines.push(`Summary: ${summary}`);
    for (const s of suggestions.slice(0, 20)) {
      lines.push(`  - ${s.id} | ${s.kind} | ${truncate(s.title, 72)} | score=${s.score}`);
    }
  }
  lines.push("Never auto-promote — stage only via maestro knowledge stage");
  return lines.join("\n");
}

/** View dispatcher for the /experts CLI (default status view). */
export function formatExpertsPanelFromStatus(
  status: ExpertsStatus,
  view: ExpertsPanelView = "status",
): string {
  switch (view) {
    case "roster":
      return formatExpertsRosterPanelFromStatus(status);
    case "waiting":
      return formatExpertsWaitingPanelFromStatus(status);
    case "harvest":
      return formatExpertsHarvestPanelFromStatus(status);
    case "status":
    default:
      return formatExpertsStatusPanelFromStatus(status);
  }
}

export function formatExpertsPanel(
  cwd = process.cwd(),
  view: ExpertsPanelView = "status",
  statePath?: string,
): string {
  return formatExpertsPanelFromStatus(getStatus(cwd, statePath), view);
}
