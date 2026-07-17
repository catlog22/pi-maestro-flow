import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildProgressTree,
  focusTaskIndex,
  selectPriorityProgressRows,
  selectProgressWindow,
  type ProgressPalette,
} from "pi-maestro-teammate/v1/progress-tree";
import type { AgentProgressSnapshot } from "pi-maestro-teammate/v1/types";

import type { SwarmAgentSnapshot } from "./types.ts";

const PLAIN_PALETTE: ProgressPalette = {
  dim: (text) => text,
  accent: (text) => text,
  running: (text) => text,
  success: (text) => text,
  error: (text) => text,
  bold: (text) => text,
};

export function toTeammateProgress(agents: SwarmAgentSnapshot[]): AgentProgressSnapshot[] {
  return agents.map((agent, taskIndex) => ({
    agent: agent.role ?? "swarm-ant",
    name: agent.antId,
    correlationId: agent.correlationId ?? `pending-${taskIndex + 1}`,
    taskIndex,
    dependencies: [],
    status: agent.status,
    recentTools: agent.recentTools,
    toolCount: agent.toolCount,
    tokens: agent.tokens,
    durationMs: agent.durationMs,
    lastMessage: agent.lastMessage,
    error: agent.error,
  }));
}

export function renderSwarmAgentProgress(
  agents: SwarmAgentSnapshot[],
  width: number,
  options: { maxAgents?: number; details?: "focus" | "all" } = {},
): string[] {
  if (agents.length === 0) return [truncateToWidth("○ Ants are waiting for dispatch.", Math.max(1, width), "…")];
  const progress = toTeammateProgress(agents);
  const focus = focusTaskIndex(progress);
  const rows = buildProgressTree(progress, PLAIN_PALETTE);
  const maxAgents = Math.max(1, options.maxAgents ?? agents.length);
  const failed = progress.filter((entry) => entry.status === "failed").map((entry) => entry.taskIndex);
  const window = failed.length > 0
    ? selectPriorityProgressRows(rows, maxAgents, focus, failed)
    : selectProgressWindow(rows, maxAgents, focus);
  const visible = window.rows;
  const lines: string[] = [];
  for (const row of visible) {
    const agent = agents[row.taskIndex]!;
    lines.push(truncateToWidth(row.text, Math.max(1, width), "…"));
    if (options.details === "all" || row.taskIndex === focus) {
      lines.push(truncateToWidth(`   state ${diagnosticState(agent)}`, Math.max(1, width), "…"));
      lines.push(truncateToWidth(`   trail ${agent.path.join(" → ")}`, Math.max(1, width), "…"));
      const activeTool = agent.recentTools?.find((tool) => tool.status === "running")
        ?? agent.recentTools?.at(-1);
      if (activeTool) lines.push(truncateToWidth(`   tool  ${activeTool.name} · ${activeTool.status}`, Math.max(1, width), "…"));
      const message = agent.error ?? agent.lastMessage;
      if (message) lines.push(truncateToWidth(`   ${agent.error ? "error" : "last "} ${message.replace(/\s+/g, " ").trim()}`, Math.max(1, width), "…"));
    }
  }
  const hidden = agents.length - visible.length;
  if (hidden > 0) lines.push(truncateToWidth(`… ${hidden} Ant rows hidden`, Math.max(1, width), "…"));
  return lines;
}

function diagnosticState(agent: SwarmAgentSnapshot): string {
  const stage = agent.stage ?? "explore";
  const activeTool = agent.recentTools?.find((tool) => tool.status === "running");
  const structuredOutput = agent.recentTools?.find((tool) => tool.name === "structured_output");
  if (agent.status === "failed") return `${stage} · failed · inspect error below`;
  if (agent.status === "completed") {
    return `${stage} · settled${agent.completionSignal ? ` via ${agent.completionSignal}` : ""}`;
  }
  if (agent.status === "pending") return `${stage} · queued`;
  if (structuredOutput?.status === "completed") return `${stage} · final output received · settling child`;
  const idleMs = agent.lastActivityAt == null ? 0 : Math.max(0, Date.now() - agent.lastActivityAt);
  if (idleMs >= 15_000) return `${stage} · idle ${formatDuration(idleMs)} · last event received`; 
  if (activeTool) return `${stage} · executing ${activeTool.name}`;
  return `${stage} · streaming response`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
