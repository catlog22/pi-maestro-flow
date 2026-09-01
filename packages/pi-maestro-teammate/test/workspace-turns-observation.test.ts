import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTurnsSnapshot, groupWorkspacePeerTurns } from "../src/extension/workspace-turns-observation.ts";
import {
  buildWorkspaceOwnerSnapshot,
  createWorkspacePeerIdentity,
  type WorkspaceMainSessionProgress,
  type WorkspaceMainSessionProgressEvent,
  type WorkspaceAgentSnapshot,
  type WorkspaceSettledSnapshot,
} from "../src/extension/workspace-peers.ts";
import type {
  ObservationReadOptions,
  ObservationTarget,
} from "../src/public/v1/observation.ts";

const OWNER_ID = "a".repeat(32);
const OWNER_NONCE = "b".repeat(32);
const TARGET: ObservationTarget = { kind: "workspace", id: `owner:${OWNER_ID}` };

function identity(ownerId = OWNER_ID, ownerNonce = OWNER_NONCE) {
  return createWorkspacePeerIdentity("D:/workspace-turns-observation", { ownerId, ownerNonce });
}

function progress(
  sequence: number,
  baseCursor: number,
  events: WorkspaceMainSessionProgressEvent[],
  updatedAt?: number,
): WorkspaceMainSessionProgress {
  return {
    updatedAt: updatedAt ?? events.at(-1)?.at ?? 1_000,
    sequence,
    baseCursor,
    events,
  };
}

function owner(
  options: {
    progress?: WorkspaceMainSessionProgress;
    agents?: WorkspaceAgentSnapshot[];
    settled?: WorkspaceSettledSnapshot[];
    mainActivityAt?: number;
  } = {},
) {
  return buildWorkspaceOwnerSnapshot(identity(), {
    sessionId: "session-1",
    sessionName: "worker-window",
    mainActivityAt: options.mainActivityAt ?? 1_040,
    agents: options.agents ?? [],
    settled: options.settled ?? [],
    ...(options.progress ? { mainProgress: options.progress } : {}),
  }, 1_050);
}

function readOptions(options: Partial<ObservationReadOptions> = {}): ObservationReadOptions {
  return {
    detail: "full",
    lines: 20,
    view: "turns",
    ...options,
  };
}

const agent = (correlationId: string, status: "running" | "sleeping" = "running"): WorkspaceAgentSnapshot => ({
  correlationId,
  agent: "general",
  status,
  startedAt: 1_000,
  lastActivityAt: 1_020,
  summary: "agent summary",
  outputTail: ["output line 1", "output line 2"],
});

const settled = (
  correlationId: string,
  status: "completed" | "failed" | "terminated" = "completed",
  result?: string,
): WorkspaceSettledSnapshot => ({
  correlationId,
  agent: "general",
  status,
  settledAt: 1_030,
  summary: "settled summary",
  ...(result === undefined ? {} : { result }),
});

// ---------------------------------------------------------------------------
// groupWorkspacePeerTurns — turn grouping from the progress ring
// ---------------------------------------------------------------------------

test("groupWorkspacePeerTurns returns empty when no progress or no events", () => {
  assert.deepEqual(groupWorkspacePeerTurns(undefined), []);
  assert.deepEqual(groupWorkspacePeerTurns(progress(0, 0, [])), []);
});

test("groupWorkspacePeerTurns groups events into turns by turn_start boundaries", () => {
  const turns = groupWorkspacePeerTurns(progress(6, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "assistant", at: 1_020, text: "reading the file" },
    { kind: "tool", at: 1_025, toolCallId: "t1", toolName: "read", status: "running" },
    { kind: "tool", at: 1_026, toolCallId: "t1", toolName: "read", status: "completed" },
    { kind: "lifecycle", at: 1_030, phase: "turn_start" },
    { kind: "assistant", at: 1_040, text: "editing now" },
  ]));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].toolCallCount, 1);
  assert.equal(turns[0].toolResultCount, 1);
  assert.equal(turns[0].assistantChars, "reading the file".length);
  assert.equal(turns[0].preview, "reading the file");
  assert.equal(turns[1].index, 2);
  assert.equal(turns[1].preview, "editing now");
  assert.equal(turns[1].toolCallCount, 0);
});

test("groupWorkspacePeerTurns collects preamble events into turn 0 before first turn_start", () => {
  const turns = groupWorkspacePeerTurns(progress(3, 0, [
    { kind: "assistant", at: 1_005, text: "preamble assistant text" },
    { kind: "tool", at: 1_008, toolCallId: "t0", toolName: "bash", status: "completed" },
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
  ]));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].index, 0);
  assert.equal(turns[0].preview, "preamble assistant text");
  assert.equal(turns[0].toolResultCount, 1);
  assert.equal(turns[1].index, 1);
  assert.equal(turns[1].preview, "lifecycle turn_start");
});

test("groupWorkspacePeerTurns marks failed tool results with an exclamation", () => {
  const turns = groupWorkspacePeerTurns(progress(3, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "tool", at: 1_020, toolCallId: "t1", toolName: "bash", status: "running" },
    { kind: "tool", at: 1_025, toolCallId: "t1", toolName: "bash", status: "failed" },
  ]));
  assert.equal(turns[0].toolCallCount, 1);
  assert.equal(turns[0].toolResultCount, 1);
  assert.ok(turns[0].rows.some((row) => row.startsWith("[result] !") && row.includes("bash")), "failed result row");
});

test("groupWorkspacePeerTurns bounds long assistant text into one physical line per line", () => {
  const long = "line one\nline two";
  const turns = groupWorkspacePeerTurns(progress(2, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "assistant", at: 1_020, text: long },
  ]));
  assert.deepEqual(turns[0].rows, ["[lifecycle] turn_start", "[assistant] line one", "  line two"]);
});

// ---------------------------------------------------------------------------
// workspaceTurnsSnapshot — list view (no turn=<n>)
// ---------------------------------------------------------------------------

test("workspaceTurnsSnapshot lists turns grouped from mainProgress with content-aware summary", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: progress(4, 0, [
      { kind: "lifecycle", at: 1_010, phase: "turn_start" },
      { kind: "assistant", at: 1_020, text: "first turn work" },
      { kind: "lifecycle", at: 1_030, phase: "turn_start" },
      { kind: "assistant", at: 1_040, text: "second turn work" },
    ]) }),
    TARGET,
    "full",
    20,
    readOptions(),
  );
  assert.equal(snapshot.found, true);
  assert.match(snapshot.summary, /worker-window · 2 turns · last 4 events \(bounded ring\)/);
  assert.ok(snapshot.detail?.some((line) => line.startsWith("Turn 1 · first turn work")));
  assert.ok(snapshot.detail?.some((line) => line.startsWith("Turn 2 · second turn work")));
  // The old "do not publish full turns" disclaimer must be gone when progress exists.
  assert.doesNotMatch(snapshot.summary ?? "", /do not publish full turns/);
});

test("workspaceTurnsSnapshot collects a lone lifecycle event into a preamble turn", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: progress(1, 0, [
      { kind: "lifecycle", at: 1_010, phase: "agent_start" },
    ]) }),
    TARGET,
    "full",
    20,
    readOptions(),
  );
  assert.equal(snapshot.found, true);
  // A lone agent_start (no turn_start) still forms a preamble turn 0 with one row.
  assert.ok(snapshot.detail?.some((line) => line.startsWith("Turn 0 ·")));
  assert.match(snapshot.summary ?? "", /1 turn · last 1 event \(bounded ring\)/);
});

test("workspaceTurnsSnapshot reports no turns when progress has zero events", () => {
  // An empty events array with valid sequence/baseCursor is the only path that
  // yields the "no turns" listing line.
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: { updatedAt: 1_000, sequence: 0, baseCursor: 0, events: [] } }),
    TARGET,
    "full",
    20,
    readOptions(),
  );
  assert.equal(snapshot.found, true);
  // Empty events fall back to the run-list view (no progress to group).
  assert.match(snapshot.summary ?? "", /snapshot-limited/);
});

// ---------------------------------------------------------------------------
// workspaceTurnsSnapshot — turn=<n> expansion
// ---------------------------------------------------------------------------

test("workspaceTurnsSnapshot expands one turn with assistant text, tool calls, and results", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: progress(4, 0, [
      { kind: "lifecycle", at: 1_010, phase: "turn_start" },
      { kind: "assistant", at: 1_020, text: "reading the file now" },
      { kind: "tool", at: 1_025, toolCallId: "t1", toolName: "read", status: "running" },
      { kind: "tool", at: 1_026, toolCallId: "t1", toolName: "read", status: "completed" },
    ]) }),
    TARGET,
    "full",
    20,
    readOptions({ turn: 1 }),
  );
  assert.equal(snapshot.found, true);
  assert.match(snapshot.summary ?? "", /Turn 1 · reading the file now · 4 rows · 1 tools/);
  assert.ok(snapshot.detail?.includes("[lifecycle] turn_start"));
  assert.ok(snapshot.detail?.includes("[assistant] reading the file now"));
  assert.ok(snapshot.detail?.includes("[tool] read (running)"));
  assert.ok(snapshot.detail?.some((row) => row.startsWith("[result]") && row.includes("read")));
  // Must NOT collapse to a run summary — the turn interior is published.
  assert.doesNotMatch(snapshot.detail?.[0] ?? "", /^@/);
});

test("workspaceTurnsSnapshot reports turn not found with the turn list as detail", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: progress(2, 0, [
      { kind: "lifecycle", at: 1_010, phase: "turn_start" },
      { kind: "assistant", at: 1_020, text: "only turn" },
    ]) }),
    TARGET,
    "full",
    20,
    readOptions({ turn: 9 }),
  );
  assert.equal(snapshot.found, true);
  assert.match(snapshot.summary ?? "", /Turn 9 not found \(1 turn\)/);
  assert.ok(snapshot.detail?.some((line) => line.startsWith("Turn 1 ·")));
});

test("workspaceTurnsSnapshot summary detail only shows the first row of a turn", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ progress: progress(3, 0, [
      { kind: "lifecycle", at: 1_010, phase: "turn_start" },
      { kind: "assistant", at: 1_020, text: "first line\nsecond line" },
      { kind: "tool", at: 1_025, toolCallId: "t1", toolName: "read", status: "completed" },
    ]) }),
    TARGET,
    "summary",
    20,
    readOptions({ turn: 1 }),
  );
  assert.equal(snapshot.detail?.length, 1);
  assert.equal(snapshot.detail?.[0], "[lifecycle] turn_start");
});

// ---------------------------------------------------------------------------
// workspaceTurnsSnapshot — fallback to run list when no progress
// ---------------------------------------------------------------------------

test("workspaceTurnsSnapshot falls back to run list when peer published no mainProgress", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ agents: [agent("cid-1")], settled: [settled("cid-2", "completed", "all done")] }),
    TARGET,
    "full",
    20,
    readOptions(),
  );
  assert.equal(snapshot.found, true);
  assert.equal(snapshot.nativeStatus, "running");
  assert.equal(snapshot.phase, "active");
  assert.match(snapshot.summary ?? "", /2 runs · snapshot-limited \(workspace peer published no session progress; showing runs\)/);
  assert.ok(snapshot.detail?.some((line) => /Run 1 · @cid-1 running/.test(line)));
  assert.ok(snapshot.detail?.some((line) => /Run 2 · @cid-2 completed/.test(line)));
});

test("workspaceTurnsSnapshot run-list fallback never exposes a legacy settled result body", () => {
  const legacyOwner = owner({ agents: [], settled: [] });
  legacyOwner.settled = [settled("cid-2", "completed", "final\nresult")];
  const snapshot = workspaceTurnsSnapshot(
    legacyOwner,
    TARGET,
    "full",
    20,
    readOptions({ turn: 1 }),
  );
  assert.equal(snapshot.found, true);
  assert.equal(snapshot.phase, "settled");
  assert.match(snapshot.summary ?? "", /Run 1 · @cid-2 completed/);
  assert.ok(snapshot.detail?.some((line) => line.includes("settled summary")));
  assert.equal(snapshot.detail?.some((line) => line === "-- result --"), false);
  assert.equal(snapshot.detail?.some((line) => line === "final"), false);
});

test("workspaceTurnsSnapshot run-list fallback reports run not found", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ agents: [agent("cid-1")] }),
    TARGET,
    "full",
    20,
    readOptions({ turn: 5 }),
  );
  assert.equal(snapshot.nativeStatus, "running");
  assert.equal(snapshot.phase, "active");
  assert.match(snapshot.summary ?? "", /Run 5 not found \(1 run\)/);
  assert.ok(snapshot.detail?.some((line) => line.startsWith("Run 1 ·")));
});

test("workspaceTurnsSnapshot run-list fallback with no runs reports empty window activity", () => {
  const snapshot = workspaceTurnsSnapshot(
    owner({ agents: [], settled: [] }),
    TARGET,
    "full",
    20,
    readOptions(),
  );
  assert.equal(snapshot.found, true);
  assert.equal(snapshot.nativeStatus, "completed");
  assert.equal(snapshot.phase, "settled");
  assert.deepEqual(snapshot.detail, ["No window activity recorded in the peer snapshot."]);
});
