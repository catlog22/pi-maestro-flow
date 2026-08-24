import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRemoteProgressEvent,
  createRemoteProgressRing,
  groupRemoteTurns,
  remoteSessionSnapshot,
  remoteTurnsSnapshot,
  REMOTE_PROGRESS_RING_MAX_EVENTS,
  type RemoteProgressRing,
} from "../src/extension/remote-observation-projection.ts";
import type {
  RemoteDriverEvent,
  RemoteRunSnapshot,
  RemoteUsage,
} from "../src/remote/types.ts";
import type { ObservationReadOptions, ObservationTarget } from "../src/public/v1/observation.ts";

const RUN_ID = "run-acp-1";
const TARGET: ObservationTarget = { kind: "remote", id: `remote:${RUN_ID}` };

function snapshot(status: RemoteRunSnapshot["status"] = "running", sequence = 0): RemoteRunSnapshot {
  return {
    workerId: "worker-1",
    instanceNonce: "instance-1",
    runId: RUN_ID,
    generation: 1,
    targetId: "linux/acp",
    status,
    lastSequence: sequence,
    updatedAt: 1_000 + sequence,
  };
}

function readOptions(options: Partial<ObservationReadOptions> = {}): ObservationReadOptions {
  return { detail: "full", lines: 20, view: "turns", ...options };
}

function ringFrom(events: RemoteDriverEvent[], updatedAt?: number): RemoteProgressRing {
  let ring = createRemoteProgressRing();
  events.forEach((event, index) => {
    ring = appendRemoteProgressEvent(ring, event, updatedAt ?? 1_000 + index);
  });
  return ring;
}

const text = (text: string, at = 1_010): RemoteDriverEvent => ({ type: "text", text });
const toolStart = (toolCallId: string, toolName: string, at = 1_020): RemoteDriverEvent => ({
  type: "tool",
  tool: { toolCallId, toolName, phase: "start" },
});
const toolEnd = (toolCallId: string, toolName: string, at = 1_025, isError = false, summary?: string): RemoteDriverEvent => ({
  type: "tool",
  tool: { toolCallId, toolName, phase: "end", ...(isError ? { isError: true } : {}), ...(summary ? { summary } : {}) },
});
const usage = (totalTokens: number, at = 1_030): RemoteDriverEvent => ({
  type: "usage",
  usage: { totalTokens } as RemoteUsage,
});
const native = (name: string, at = 1_035): RemoteDriverEvent => ({ type: "native", name, data: { raw: true } });

// ---------------------------------------------------------------------------
// appendRemoteProgressEvent — ring invariant
// ---------------------------------------------------------------------------

test("appendRemoteProgressEvent assigns monotonic cursors starting at 1", () => {
  let ring = createRemoteProgressRing();
  assert.equal(ring.sequence, 0);
  assert.equal(ring.baseCursor, 0);
  ring = appendRemoteProgressEvent(ring, text("first"), 1_010);
  ring = appendRemoteProgressEvent(ring, toolStart("t1", "read"), 1_020);
  assert.equal(ring.sequence, 2);
  assert.equal(ring.baseCursor, 0);
  assert.equal(ring.events[0].cursor, 1);
  assert.equal(ring.events[1].cursor, 2);
  assert.equal(ring.events.length, 2);
});

test("appendRemoteProgressEvent evicts oldest past the ring cap, advancing baseCursor", () => {
  let ring = createRemoteProgressRing();
  for (let i = 0; i < REMOTE_PROGRESS_RING_MAX_EVENTS + 5; i++) {
    ring = appendRemoteProgressEvent(ring, text(`chunk ${i}`), 1_000 + i);
  }
  assert.equal(ring.sequence, REMOTE_PROGRESS_RING_MAX_EVENTS + 5);
  assert.equal(ring.events.length, REMOTE_PROGRESS_RING_MAX_EVENTS);
  // baseCursor = sequence - events.length (points one before the first retained event)
  assert.equal(ring.baseCursor, 5);
  assert.equal(ring.events[0].cursor, 6);
});

test("appendRemoteProgressEvent bounds assistant text to the configured byte limit", () => {
  const long = "x".repeat(20_000);
  const ring = appendRemoteProgressEvent(createRemoteProgressRing(), text(long), 1_010);
  assert.ok(Buffer.byteLength(ring.events[0].text ?? "", "utf8") <= 8 * 1024);
  assert.ok((ring.events[0].text ?? "").length < long.length);
});

test("appendRemoteProgressEvent normalizes tool end events with isError to failed status", () => {
  const ring = ringFrom([toolStart("t1", "bash"), toolEnd("t1", "bash", 1_025, true, "command failed")]);
  assert.equal(ring.events[0].status, "running");
  assert.equal(ring.events[1].status, "failed");
  assert.equal(ring.events[1].summary, "command failed");
});

test("appendRemoteProgressEvent drops native event data and retains only the name (RV-002)", () => {
  // Native data may carry reasoning or credentials; boundedData at the driver
  // only checks size, not redaction. The ring retains only the name.
  const ring = ringFrom([native("agent_thought_chunk")]);
  const event = ring.events[0];
  assert.equal(event.kind, "native");
  assert.equal(event.name, "agent_thought_chunk");
  // The `data` field is not part of the retained event shape at all.
  assert.ok(!("data" in event), "native event data must not be retained");
});

// ---------------------------------------------------------------------------
// groupRemoteTurns — turn grouping
// ---------------------------------------------------------------------------

test("groupRemoteTurns returns empty when no ring or no events", () => {
  assert.deepEqual(groupRemoteTurns(undefined), []);
  assert.deepEqual(groupRemoteTurns(createRemoteProgressRing()), []);
});

test("groupRemoteTurns coalesces consecutive streaming text chunks into one turn (RV-001)", () => {
  // ACP emits one text event per agent_message_chunk; a single assistant
  // message arrives as many text chunks. These must coalesce into ONE turn
  // (the prior implementation opened a new turn per chunk). Within the turn,
  // each chunk renders as its own [assistant] row to preserve the stream shape.
  const turns = groupRemoteTurns(ringFrom([
    text("Hello "),
    text("world"),
    text("!"),
  ]));
  assert.equal(turns.length, 1, "streaming chunks collapse to one turn");
  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].assistantChars, "Hello ".length + "world".length + "!".length);
  assert.equal(turns[0].toolCallCount, 0);
  // Each chunk is a separate [assistant] row (the stream shape is preserved);
  // the trailing space is trimmed by the row formatter.
  assert.deepEqual(turns[0].rows, ["[assistant] Hello", "[assistant] world", "[assistant] !"]);
});

test("groupRemoteTurns refreshes the preview when the first streaming chunk is empty (RV-001 edge)", () => {
  // pi-rpc emits unfiltered empty text_delta events; the first retained chunk
  // may be empty. The turn must still coalesce, and the first non-empty chunk
  // must replace the placeholder preview with real content.
  const turns = groupRemoteTurns(ringFrom([
    text(""),
    text("actual message"),
    text(" continues"),
  ]));
  assert.equal(turns.length, 1, "empty-leading chunks coalesce into one turn");
  assert.equal(turns[0].preview, "actual message");
  assert.equal(turns[0].assistantChars, "actual message continues".length);
});

test("groupRemoteTurns locks the preview on the first non-empty chunk even if it equals the placeholder text", () => {
  // The placeholder is "assistant message"; if the first non-empty chunk
  // content is literally that string, a later chunk must NOT replace it
  // (stabilization on the first meaningful content, not sentinel matching).
  const turns = groupRemoteTurns(ringFrom([
    text(""),
    text("assistant message"),
    text(" more content here"),
  ]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].preview, "assistant message");
  assert.equal(turns[0].assistantChars, "assistant message more content here".length);
});

test("groupRemoteTurns opens a new turn after a tool result separates two assistant messages", () => {
  const turns = groupRemoteTurns(ringFrom([
    text("reading the file"),
    toolStart("t1", "read"),
    toolEnd("t1", "read"),
    text("editing now"),
    toolStart("t2", "edit"),
    toolEnd("t2", "edit"),
  ]));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].preview, "reading the file");
  assert.equal(turns[0].toolCallCount, 1);
  assert.equal(turns[0].toolResultCount, 1);
  assert.equal(turns[1].index, 2);
  assert.equal(turns[1].preview, "editing now");
  assert.equal(turns[1].toolCallCount, 1);
});

test("groupRemoteTurns collects tool-only activity into a 1-based preamble turn (RV-003)", () => {
  const turns = groupRemoteTurns(ringFrom([
    toolStart("t1", "bash"),
    toolEnd("t1", "bash"),
  ]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].preview, "session start");
  assert.equal(turns[0].toolCallCount, 1);
  assert.equal(turns[0].toolResultCount, 1);
});

test("groupRemoteTurns attaches usage and native events to the in-progress turn", () => {
  const turns = groupRemoteTurns(ringFrom([
    text("working"),
    usage(1234),
    native("progress"),
  ]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].index, 1);
  assert.ok(turns[0].rows.some((row) => row === "[usage] 1234 tokens"));
  assert.ok(turns[0].rows.some((row) => row === "[native] progress"));
});

test("groupRemoteTurns marks failed tool results with an exclamation in the row", () => {
  const turns = groupRemoteTurns(ringFrom([
    text("running"),
    toolStart("t1", "bash"),
    toolEnd("t1", "bash", 1_025, true, "exit 1"),
  ]));
  assert.equal(turns[0].toolResultCount, 1);
  assert.ok(turns[0].rows.some((row) => row.startsWith("[result] !") && row.includes("bash") && row.includes("exit 1")));
});

test("groupRemoteTurns bounds long assistant text into one physical line per line", () => {
  const turns = groupRemoteTurns(ringFrom([text("line one\nline two")]));
  assert.deepEqual(turns[0].rows, ["[assistant] line one", "  line two"]);
});

// ---------------------------------------------------------------------------
// remoteTurnsSnapshot — list view
// ---------------------------------------------------------------------------

test("remoteTurnsSnapshot lists turns grouped from the ring with content-aware summary", () => {
  const ring = ringFrom([
    text("first turn work"),
    toolStart("t1", "read"),
    toolEnd("t1", "read"),
    text("second turn work"),
  ]);
  const result = remoteTurnsSnapshot(snapshot("running", 4), ring, { name: "review" }, TARGET, "full", 20, readOptions());
  assert.equal(result.found, true);
  assert.match(result.summary ?? "", /review · running · 2 turns · last 4 events \(bounded ring\)/);
  assert.ok(result.detail?.some((line) => line.startsWith("Turn 1 · first turn work")));
  assert.ok(result.detail?.some((line) => line.startsWith("Turn 2 · second turn work")));
});

test("remoteTurnsSnapshot reports no progress when the ring is empty", () => {
  const result = remoteTurnsSnapshot(snapshot("running", 0), undefined, { name: "build" }, TARGET, "full", 20, readOptions());
  assert.equal(result.found, true);
  assert.match(result.summary ?? "", /no structured progress retained yet/);
  assert.ok(result.detail?.includes("No structured progress events retained for this run."));
});

// ---------------------------------------------------------------------------
// remoteTurnsSnapshot — turn=<n> expansion
// ---------------------------------------------------------------------------

test("remoteTurnsSnapshot expands one turn with assistant text, tool calls, and results", () => {
  const ring = ringFrom([
    text("reading the file now"),
    toolStart("t1", "read"),
    toolEnd("t1", "read", 1_025, false, "file contents"),
  ]);
  const result = remoteTurnsSnapshot(snapshot("running", 3), ring, { name: "review" }, TARGET, "full", 20, readOptions({ turn: 1 }));
  assert.equal(result.found, true);
  assert.match(result.summary ?? "", /Turn 1 · reading the file now · 3 rows · 1 tools/);
  assert.ok(result.detail?.includes("[assistant] reading the file now"));
  assert.ok(result.detail?.includes("[tool] read (running)"));
  assert.ok(result.detail?.some((row) => row.startsWith("[result]") && row.includes("read") && row.includes("file contents")));
});

test("remoteTurnsSnapshot reports turn not found with the turn list as detail", () => {
  const ring = ringFrom([text("only turn")]);
  const result = remoteTurnsSnapshot(snapshot("running", 1), ring, { name: "review" }, TARGET, "full", 20, readOptions({ turn: 9 }));
  assert.match(result.summary ?? "", /Turn 9 not found \(1 turn\)/);
  assert.ok(result.detail?.some((line) => line.startsWith("Turn 1 ·")));
});

test("remoteTurnsSnapshot summary detail only shows the first row of a turn", () => {
  const ring = ringFrom([text("first line\nsecond line"), toolStart("t1", "read")]);
  const result = remoteTurnsSnapshot(snapshot("running", 2), ring, { name: "review" }, TARGET, "summary", 20, readOptions({ turn: 1 }));
  assert.equal(result.detail?.length, 1);
  assert.equal(result.detail?.[0], "[assistant] first line");
});

test("remoteTurnsSnapshot marks settled runs as settled phase", () => {
  const ring = ringFrom([text("done")]);
  const result = remoteTurnsSnapshot(snapshot("completed", 1), ring, { name: "review" }, TARGET, "full", 20, readOptions());
  assert.equal(result.phase, "settled");
  assert.equal(result.outcome, "success");
  assert.equal(result.waitStatus, "completed");
});

// ---------------------------------------------------------------------------
// remoteSessionSnapshot — cursor pagination
// ---------------------------------------------------------------------------

test("remoteSessionSnapshot projects events as a cursor-paginated page", () => {
  const ring = ringFrom([text("first"), toolStart("t1", "read"), toolEnd("t1", "read")]);
  const result = remoteSessionSnapshot(snapshot("running", 3), ring, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session" }));
  assert.equal(result.found, true);
  assert.equal(result.page?.kind, "remote-session");
  assert.equal(result.page?.items.length, 3);
  assert.equal(result.page?.gap, undefined);
  assert.equal(typeof result.page?.nextCursor, "string");
  assert.match(result.revision ?? "", /^remote-session:run-acp-1:3$/);
  assert.ok(result.detail?.some((line) => line.startsWith("[1] assistant: first")));
  assert.ok(result.detail?.some((line) => line.startsWith("[3] tool read completed")));
});

test("remoteSessionSnapshot returns only newer events when a cursor is supplied", () => {
  // First read: ring has 2 events (cursor 1 = text "first", cursor 2 = tool start).
  let ring = ringFrom([text("first"), toolStart("t1", "read")]);
  const first = remoteSessionSnapshot(snapshot("running", 2), ring, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session" }));
  assert.equal(first.page?.items.length, 2);
  const cursor = first.page?.nextCursor;
  assert.ok(cursor);

  // Ring grows: tool end (cursor 3) and second text (cursor 4) appended.
  ring = appendRemoteProgressEvent(ring, toolEnd("t1", "read"), 1_025);
  ring = appendRemoteProgressEvent(ring, text("second"), 1_030);
  const next = remoteSessionSnapshot(snapshot("running", 4), ring, { name: "review" }, { kind: "remote", id: `remote:${RUN_ID}`, cursor }, "full", 20, readOptions({ view: "session", cursor }));
  // cursor at sequence 2 → items are cursor 3 (tool end) and cursor 4 (text second)
  assert.equal(next.page?.items.length, 2);
  assert.equal((next.page?.items[0] as { cursor: number }).cursor, 3);
  assert.equal((next.page?.items[1] as { cursor: number }).cursor, 4);
});

test("remoteSessionSnapshot flags a gap when the cursor precedes the evicted baseCursor", () => {
  let ring = createRemoteProgressRing();
  for (let i = 0; i < REMOTE_PROGRESS_RING_MAX_EVENTS + 3; i++) {
    ring = appendRemoteProgressEvent(ring, text(`chunk ${i}`), 1_000 + i);
  }
  // cursor=1 was evicted (baseCursor is now 3, the first retained event is cursor 4)
  const result = remoteSessionSnapshot(snapshot("running", ring.sequence), ring, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session", cursor: btoa(JSON.stringify({ version: 1, runId: RUN_ID, sequence: 1 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") }));
  assert.equal(result.page?.gap, true);
  assert.ok(result.detail?.some((line) => line.startsWith("Session progress gap:")));
});

test("remoteSessionSnapshot rejects a cursor belonging to another run", () => {
  const ring = ringFrom([text("first")]);
  const foreignCursor = btoa(JSON.stringify({ version: 1, runId: "run-other", sequence: 0 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const result = remoteSessionSnapshot(snapshot("running", 1), ring, { name: "review" }, { kind: "remote", id: `remote:${RUN_ID}`, cursor: foreignCursor }, "full", 20, readOptions({ view: "session", cursor: foreignCursor }));
  assert.equal(result.found, true);
  assert.equal(result.error, "stale-session-cursor");
  assert.match(result.summary ?? "", /belongs to another remote run/);
});

test("remoteSessionSnapshot summary detail omits items when detail=summary", () => {
  const ring = ringFrom([text("first")]);
  const result = remoteSessionSnapshot(snapshot("running", 1), ring, { name: "review" }, TARGET, "summary", 20, readOptions({ view: "session" }));
  assert.equal(result.page?.items.length, 0);
  assert.equal(result.detail, undefined);
});

test("remoteSessionSnapshot reports no activity when the ring is empty", () => {
  const result = remoteSessionSnapshot(snapshot("running", 0), undefined, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session" }));
  assert.equal(result.found, true);
  assert.equal(result.page?.items.length, 0);
  assert.ok(result.detail?.includes("No new run activity published."));
  assert.ok(result.detail?.some((line) => line.startsWith("next-cursor=")));
});

// ---------------------------------------------------------------------------
// Review fixes (RV-003, RV-004, RV-005, terminal states)
// ---------------------------------------------------------------------------

test("RV-003: the tool-only preamble turn is expandable via turn=1", () => {
  const ring = ringFrom([toolStart("t1", "bash"), toolEnd("t1", "bash")]);
  const turns = groupRemoteTurns(ring);
  assert.equal(turns[0].index, 1);
  const expanded = remoteTurnsSnapshot(snapshot("running", 2), ring, { name: "build" }, TARGET, "full", 20, readOptions({ turn: 1 }));
  assert.match(expanded.summary ?? "", /Turn 1 · session start · 2 rows · 1 tools/);
  assert.ok(expanded.detail?.includes("[tool] bash (running)"));
});

test("RV-004: the ring evicts oldest past the byte budget, not just the event count", () => {
  // Each event ~8KB text; the 256KB byte budget evicts before 64 events.
  let ring = createRemoteProgressRing();
  for (let i = 0; i < 40; i++) {
    ring = appendRemoteProgressEvent(ring, text("x".repeat(8 * 1024)), 1_000 + i);
  }
  // 40 * 8KB = 320KB > 256KB budget → oldest evicted, events < 40.
  assert.ok(ring.events.length < 40, "byte budget evicts before the event cap");
  assert.ok(ring.bytes <= 256 * 1024, "ring stays within the byte budget");
  assert.equal(ring.baseCursor, ring.sequence - ring.events.length);
});

test("RV-005: an up-to-date cursor reports the last retained event instead of no activity", () => {
  const ring = ringFrom([text("first"), toolStart("t1", "read")]);
  const first = remoteSessionSnapshot(snapshot("running", 2), ring, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session" }));
  const cursor = first.page?.nextCursor!;
  // Re-read with the same cursor → no new items, but the summary must report
  // the last retained event, not "no published activity".
  const upToDate = remoteSessionSnapshot(snapshot("running", 2), ring, { name: "review" }, { kind: "remote", id: `remote:${RUN_ID}`, cursor }, "full", 20, readOptions({ view: "session", cursor }));
  assert.equal(upToDate.page?.items.length, 0);
  assert.doesNotMatch(upToDate.summary ?? "", /no published activity/);
  assert.match(upToDate.summary ?? "", /up to date/);
  assert.ok(upToDate.detail?.some((line) => line.startsWith("Up to date; last event was")));
});

test("terminal state: failed run surfaces failure outcome in view=turns and view=session", () => {
  const ring = ringFrom([text("working"), toolStart("t1", "bash"), toolEnd("t1", "bash", 1_025, true, "exit 1")]);
  const turns = remoteTurnsSnapshot(snapshot("failed", 3), ring, { name: "build" }, TARGET, "full", 20, readOptions());
  assert.equal(turns.phase, "settled");
  assert.equal(turns.outcome, "failure");
  assert.equal(turns.waitStatus, "failed");
  assert.equal(turns.terminalStatus, "failed");

  const session = remoteSessionSnapshot(snapshot("failed", 3), ring, { name: "build" }, TARGET, "full", 20, readOptions({ view: "session" }));
  assert.equal(session.phase, "settled");
  assert.equal(session.outcome, "failure");
  assert.equal(session.waitStatus, "failed");
});

test("terminal state: cancelled and lost runs surface the canonical terminal outcome", () => {
  const ring = ringFrom([text("working")]);
  const cancelled = remoteTurnsSnapshot(snapshot("cancelled", 1), ring, { name: "build" }, TARGET, "full", 20, readOptions());
  assert.equal(cancelled.outcome, "aborted");
  assert.equal(cancelled.waitStatus, "terminated");
  assert.equal(cancelled.terminalStatus, "cancelled");

  const lost = remoteSessionSnapshot(snapshot("lost", 1), ring, { name: "build" }, TARGET, "full", 20, readOptions({ view: "session" }));
  assert.equal(lost.outcome, "failure");
  assert.equal(lost.waitStatus, "failed");
  assert.equal(lost.terminalStatus, "lost");
});

test("RV-002 regression: a secret in native data never reaches the session page", () => {
  const ring = ringFrom([{ type: "native", name: "agent_thought_chunk", data: { secret: "API_TOKEN=leak-me-12345" } } as RemoteDriverEvent]);
  const session = remoteSessionSnapshot(snapshot("running", 1), ring, { name: "review" }, TARGET, "full", 20, readOptions({ view: "session" }));
  const serialized = JSON.stringify(session);
  assert.doesNotMatch(serialized, /leak-me-12345|API_TOKEN/);
  assert.match(serialized, /agent_thought_chunk/);
});
