import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  normalizeWorkflowStatus,
  workflowStatusLabel,
} from "./view-model.ts";

export interface RunEventDetails {
  runId: string;
  command?: string;
  status: string;
  attempt?: number;
  verdict?: string;
  artifactsCount?: number;
  nextAction?: string;
}

export function renderRunEvent(
  details: RunEventDetails,
  expanded: boolean,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const status = normalizeWorkflowStatus(details.status);
  const action = details.nextAction;
  const label = `${details.runId}${details.command ? `/${details.command}` : ""}`;
  const summary = action
    ? `» ${action} · ${workflowStatusLabel(status, details.attempt)} · ${label}`
    : `${workflowStatusLabel(status, details.attempt)} · ${label}`;
  if (!expanded || safeWidth < 20) return [truncateToWidth(summary, safeWidth, "…")];

  const lines = [summary];
  const metadata = [
    details.verdict ? `Verdict: ${details.verdict}` : "",
    details.artifactsCount != null ? `Artifacts: ${details.artifactsCount}` : "",
  ].filter(Boolean).join(" · ");
  if (metadata) lines.push(metadata);
  if (action) lines.push(`Next: ${action}`);
  return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
}

export function createRunEventComponent(
  details: RunEventDetails,
  expanded: boolean,
): Component {
  return {
    render(width: number): string[] {
      return renderRunEvent(details, expanded, width);
    },
    invalidate() {},
  };
}
