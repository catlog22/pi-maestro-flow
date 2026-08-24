import {
  workspaceWindowLifecycle,
  type WorkspaceMainSessionProgress,
  type WorkspaceMainSessionProgressEvent,
  type WorkspaceOwnerSnapshot,
} from "./workspace-peers.ts";
import type {
  ObservationDetail,
  ObservationReadOptions,
  ObservationSnapshot,
  ObservationTarget,
} from "../public/v1/observation.ts";

/**
 * Workspace peer `view="turns"` projection. Unlike a local teammate (which
 * owns its full session transcript), a workspace peer publishes only a bounded
 * content-aware progress ring (`owner.mainProgress.events`). This module groups
 * that ring into turns so the Monitor window can read another session's
 * assistant text, tool calls, and tool results — not just the run list.
 *
 * The published ring is bounded (last {@link MAX_MAIN_SESSION_PROGRESS_EVENTS}
 * events), so turns before the ring window are not visible. `view="session"`
 * remains the cursor-paginated stream view; this turns view is the
 * turn-grouped, expandable counterpart.
 */

const LINE_CHARS = 4_000;
const PREVIEW_CHARS = 100;

export interface WorkspacePeerTurn {
  /** 1-based turn index across the published event ring (0 = preamble). */
  index: number;
  startedAt: number;
  /** First assistant text line in the turn, or a lifecycle label. */
  preview: string;
  assistantChars: number;
  toolCallCount: number;
  toolResultCount: number;
  /** Rendered detail lines for this turn (assistant, tool, lifecycle rows). */
  rows: string[];
}

const WORKSPACE_TURN_CAPABILITIES = {
  inspect: true,
  wait: true,
  cancel: false,
  message: true,
  supervise: true,
} as const;

/** Bounded first-line preview of an assistant event. */
function assistantPreview(event: WorkspaceMainSessionProgressEvent): string {
  if (event.kind !== "assistant") return "";
  const text = event.text.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 3)}...` : text;
}

/** Render an assistant event as bounded physical lines. */
function formatAssistantRows(event: WorkspaceMainSessionProgressEvent): string[] {
  if (event.kind !== "assistant") return [];
  const physical = event.text.replace(/\r\n/g, "\n").split("\n");
  return (physical.length > 0 ? physical : [""]).map((line, index) => {
    const clipped = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;
    return index === 0 ? `[assistant] ${clipped}`.trimEnd() : `  ${clipped}`;
  });
}

/**
 * Group the peer's published main-session progress events into turns. Every
 * `turn_start` lifecycle event opens a new turn; events before the first
 * `turn_start` (and after `agent_start`) form a preamble turn (index 0) so no
 * published content is hidden. Mirrors the local teammate view=turns
 * semantics but operates on the bounded cross-process ring.
 */
export function groupWorkspacePeerTurns(
  progress: WorkspaceMainSessionProgress | undefined,
): WorkspacePeerTurn[] {
  if (!progress || progress.events.length === 0) return [];
  const turns: WorkspacePeerTurn[] = [];
  let current: WorkspacePeerTurn | undefined;
  let nextIndex = 1;
  const append = (event: WorkspaceMainSessionProgressEvent): void => {
    if (!current) {
      current = {
        index: 0,
        startedAt: event.at,
        preview: "session start",
        assistantChars: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        rows: [],
      };
      turns.push(current);
    }
    if (event.kind === "assistant") {
      current.assistantChars += event.text.length;
      if (!current.preview || current.preview === "session start" || current.preview.startsWith("lifecycle ")) {
        current.preview = assistantPreview(event);
      }
      current.rows.push(...formatAssistantRows(event));
    } else if (event.kind === "tool") {
      if (event.status === "running") {
        current.toolCallCount += 1;
        current.rows.push(`[tool] ${event.toolName} (running)`);
      } else {
        current.toolResultCount += 1;
        current.rows.push(`[result]${event.status === "failed" ? " !" : ""} ${event.toolName}`);
      }
    } else if (event.kind === "lifecycle") {
      current.rows.push(`[lifecycle] ${event.phase}`);
    }
  };
  for (const event of progress.events) {
    if (event.kind === "lifecycle" && event.phase === "turn_start") {
      current = {
        index: nextIndex++,
        startedAt: event.at,
        preview: "lifecycle turn_start",
        assistantChars: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        rows: [`[lifecycle] turn_start`],
      };
      turns.push(current);
      continue;
    }
    append(event);
  }
  return turns;
}

interface WorkspaceRunRow {
  index: number;
  name: string;
  status: string;
  summary: string;
  outputTail: readonly string[];
  startedAt: number;
  result?: string;
}

/** Build the bounded run list from live agents and settled records. */
function collectWorkspaceRuns(owner: WorkspaceOwnerSnapshot): WorkspaceRunRow[] {
  return [
    ...owner.agents.map((agent, index) => ({
      index: index + 1,
      name: agent.name ?? agent.correlationId.slice(0, 8),
      status: agent.status,
      summary: agent.summary ?? "",
      outputTail: agent.outputTail ?? [],
      startedAt: agent.startedAt,
    })),
    ...owner.settled.map((record, index) => ({
      index: owner.agents.length + index + 1,
      name: record.name ?? record.correlationId.slice(0, 8),
      status: record.status,
      summary: record.summary ?? record.status,
      outputTail: [],
      startedAt: record.settledAt,
      ...(record.result === undefined ? {} : { result: record.result }),
    })),
  ];
}

/**
 * Run-list fallback for peers that published no session progress. Returns a
 * bounded snapshot of agent summaries, output tails, and settled results.
 */
function workspaceRunListSnapshot(
  owner: WorkspaceOwnerSnapshot,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  options: ObservationReadOptions,
): ObservationSnapshot {
  const runs = collectWorkspaceRuns(owner);
  const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
  if (options.turn !== undefined) {
    const run = runs.find((candidate) => candidate.index === options.turn);
    if (!run) {
      return {
        target,
        found: true,
        nativeStatus: "unknown",
        phase: "unknown",
        summary: `Run ${options.turn} not found (${runs.length} run${runs.length === 1 ? "" : "s"}).`,
        detail: runs.map((candidate) =>
          `Run ${candidate.index} · @${candidate.name} ${candidate.status}${candidate.summary ? ` · ${candidate.summary.slice(0, 60)}` : ""}`,
        ),
        updatedAt: owner.publishedAt,
        capabilities: WORKSPACE_TURN_CAPABILITIES,
      };
    }
    const detailLines = [
      `@${run.name} ${run.status} · started ${new Date(run.startedAt).toISOString()}`,
      ...(run.summary ? [run.summary] : []),
      ...(detail !== "summary" ? run.outputTail.slice(-lines) : []),
      ...(detail !== "summary" && run.result
        ? [`-- result --`, ...run.result.split("\n").slice(0, Math.max(lines, 1))]
        : []),
    ];
    return {
      target,
      found: true,
      nativeStatus: run.status,
      phase: run.status === "completed" || run.status === "failed" ? "settled" : "active",
      summary: `Run ${run.index} · @${run.name} ${run.status}`,
      ...(detail !== "summary" && detailLines.length > 1 ? { detail: detailLines } : {}),
      updatedAt: owner.publishedAt,
      capabilities: WORKSPACE_TURN_CAPABILITIES,
    };
  }
  const listLines = runs.length === 0
    ? ["No window activity recorded in the peer snapshot."]
    : runs.map((run) =>
      `Run ${run.index} · @${run.name} ${run.status}${run.summary ? ` · ${run.summary.slice(0, 80)}` : ""}`,
    );
  return {
    target,
    found: true,
    nativeStatus: "unknown",
    phase: "unknown",
    summary: `${windowName} · ${runs.length} run${runs.length === 1 ? "" : "s"} · snapshot-limited (workspace peer published no session progress; showing runs)`,
    detail: listLines,
    updatedAt: owner.publishedAt,
    capabilities: WORKSPACE_TURN_CAPABILITIES,
  };
}

/**
 * Workspace peer `view="turns"` snapshot. Groups `owner.mainProgress.events`
 * into turns (by `turn_start` boundaries) and exposes assistant text, tool
 * calls, and tool results with `turn=<n>` expansion. Falls back to the
 * run-list view when the peer published no session progress.
 */
export function workspaceTurnsSnapshot(
  owner: WorkspaceOwnerSnapshot,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  options: ObservationReadOptions,
): ObservationSnapshot {
  const lifecycle = workspaceWindowLifecycle(owner);
  const progress = owner.mainProgress;
  if (!progress || progress.events.length === 0) {
    return workspaceRunListSnapshot(owner, target, detail, lines, options);
  }
  const turns = groupWorkspacePeerTurns(progress);
  const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
  const bounded = `${turns.length} turn${turns.length === 1 ? "" : "s"} · last ${progress.events.length} event${progress.events.length === 1 ? "" : "s"} (bounded ring)`;
  if (options.turn !== undefined) {
    const turn = turns.find((candidate) => candidate.index === options.turn);
    if (!turn) {
      return {
        target,
        found: true,
        nativeStatus: lifecycle.status,
        phase: lifecycle.settled ? "settled" : "active",
        summary: `Turn ${options.turn} not found (${turns.length} turn${turns.length === 1 ? "" : "s"}).`,
        detail: turns.map((candidate) =>
          `Turn ${candidate.index} · ${candidate.preview.slice(0, 60)} · ${candidate.rows.length} rows`,
        ),
        updatedAt: progress.updatedAt,
        capabilities: WORKSPACE_TURN_CAPABILITIES,
      };
    }
    const detailLines = detail === "summary"
      ? turn.rows.slice(0, 1)
      : turn.rows.slice(-Math.max(lines, 1));
    return {
      target,
      found: true,
      nativeStatus: lifecycle.status,
      phase: lifecycle.settled ? "settled" : "active",
      summary: `Turn ${turn.index} · ${turn.preview.slice(0, PREVIEW_CHARS)} · ${turn.rows.length} rows · ${turn.toolCallCount} tools`,
      ...(detailLines.length > 0 ? { detail: detailLines } : {}),
      updatedAt: progress.updatedAt,
      capabilities: WORKSPACE_TURN_CAPABILITIES,
    };
  }
  const listLines = turns.length === 0
    ? ["No session turns in the published progress ring."]
    : turns.map((turn) => {
      const tools = turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} tools` : "";
      const chars = turn.assistantChars > 0 ? ` · ${turn.assistantChars} chars` : "";
      return `Turn ${turn.index} · ${turn.preview.slice(0, PREVIEW_CHARS)} · ${turn.rows.length} rows${tools}${chars}`;
    });
  return {
    target,
    found: true,
    nativeStatus: lifecycle.status,
    phase: lifecycle.settled ? "settled" : "active",
    summary: `${windowName} · ${bounded}`,
    detail: listLines,
    updatedAt: progress.updatedAt,
    capabilities: WORKSPACE_TURN_CAPABILITIES,
  };
}
