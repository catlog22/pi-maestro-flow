import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceSessionObservationSnapshot,
  workspaceTodosObservationSnapshot,
} from "../src/extension/workspace-session-observation.ts";
import {
  buildWorkspaceOwnerSnapshot,
  createWorkspacePeerIdentity,
  type WorkspaceMainSessionProgress,
  type WorkspaceTodoSnapshot,
} from "../src/extension/workspace-peers.ts";

const OWNER_ID = "a".repeat(32);
const OWNER_NONCE = "b".repeat(32);
const OTHER_NONCE = "c".repeat(32);
const TARGET = { kind: "workspace", id: `owner:${OWNER_ID}` } as const;

function owner(
  progress?: WorkspaceMainSessionProgress,
  ownerNonce = OWNER_NONCE,
  todos?: readonly WorkspaceTodoSnapshot[],
) {
  const identity = createWorkspacePeerIdentity("D:/workspace-session-observation", {
    ownerId: OWNER_ID,
    ownerNonce,
  });
  return buildWorkspaceOwnerSnapshot(identity, {
    sessionId: "session-1",
    sessionName: "worker-window",
    mainActivityAt: 1_030,
    ...(progress ? { mainProgress: progress } : {}),
    ...(todos ? { todos } : {}),
    agents: [],
    settled: [],
  }, 1_040);
}

function progress(sequence: number, baseCursor: number, events: WorkspaceMainSessionProgress["events"]): WorkspaceMainSessionProgress {
  return {
    updatedAt: events.at(-1)?.at ?? 1_000,
    sequence,
    baseCursor,
    events,
  };
}

test("workspace session observation projects sanitized progress and marks settle provisional", () => {
  const snapshot = workspaceSessionObservationSnapshot(owner(progress(3, 0, [
    { kind: "assistant", at: 1_010, text: "working on the request" },
    { kind: "tool", at: 1_020, toolCallId: "tool-1", toolName: "read", status: "completed" },
    { kind: "lifecycle", at: 1_030, phase: "agent_settled" },
  ])), TARGET, "full", 20);

  assert.equal(snapshot.found, true);
  assert.match(snapshot.summary, /lifecycle agent_settled \(provisional\)/);
  assert.equal(snapshot.page?.kind, "workspace-session");
  assert.equal(snapshot.page?.gap, undefined);
  assert.equal(snapshot.page?.items.length, 3);
  assert.deepEqual(snapshot.page?.items[0], {
    cursor: 1,
    kind: "assistant",
    at: 1_010,
    text: "working on the request",
  });
  assert.deepEqual(snapshot.page?.items[2], {
    cursor: 3,
    kind: "lifecycle",
    at: 1_030,
    phase: "agent_settled",
    provisional: true,
  });
  assert.match(snapshot.revision ?? "", /^workspace-session:[a-f0-9]{32}:3:\d+$/);
  assert.equal(typeof snapshot.page?.nextCursor, "string");
});

test("workspace session cursor returns only newer events", () => {
  const first = workspaceSessionObservationSnapshot(owner(progress(2, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "assistant", at: 1_020, text: "first" },
  ])), TARGET, "full", 20);
  const cursor = first.page?.nextCursor;
  assert.ok(cursor);

  const next = workspaceSessionObservationSnapshot(owner(progress(3, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "assistant", at: 1_020, text: "first" },
    { kind: "tool", at: 1_030, toolCallId: "tool-2", toolName: "bash", status: "running" },
  ])), { ...TARGET, cursor }, "full", 20, cursor);

  assert.deepEqual(next.page?.items, [{
    cursor: 3,
    kind: "tool",
    at: 1_030,
    toolCallId: "tool-2",
    toolName: "bash",
    status: "running",
  }]);
});

test("workspace session cursor replays a streamed assistant event when its content revision changes", () => {
  const firstProgress = progress(1, 0, [
    { kind: "assistant", at: 1_010, text: "a" },
  ]);
  firstProgress.revision = 1;
  const first = workspaceSessionObservationSnapshot(owner(firstProgress), TARGET, "full", 20);
  const cursor = first.page?.nextCursor;
  assert.ok(cursor);

  const updatedProgress = progress(1, 0, [
    { kind: "assistant", at: 1_011, text: "assistant streaming update" },
  ]);
  updatedProgress.revision = 2;
  const updated = workspaceSessionObservationSnapshot(
    owner(updatedProgress),
    { ...TARGET, cursor },
    "full",
    20,
    cursor,
  );

  assert.deepEqual(updated.page?.items, [{
    cursor: 1,
    kind: "assistant",
    at: 1_011,
    text: "assistant streaming update",
  }]);
  assert.notEqual(updated.revision, first.revision);
});

test("workspace session cursor reports bounded-ring gaps and stale incarnations", () => {
  const first = workspaceSessionObservationSnapshot(owner(progress(2, 0, [
    { kind: "lifecycle", at: 1_010, phase: "turn_start" },
    { kind: "assistant", at: 1_020, text: "first" },
  ])), TARGET, "full", 20);
  const cursor = first.page?.nextCursor;
  assert.ok(cursor);

  const gap = workspaceSessionObservationSnapshot(owner(progress(6, 5, [
    { kind: "assistant", at: 1_060, text: "retained" },
  ])), { ...TARGET, cursor }, "full", 20, cursor);
  assert.equal(gap.page?.gap, true);
  assert.deepEqual(gap.page?.items, [{ cursor: 6, kind: "assistant", at: 1_060, text: "retained" }]);
  assert.match(gap.detail?.[0] ?? "", /requested 2, retained from 5/);

  const stale = workspaceSessionObservationSnapshot(owner(progress(1, 0, [
    { kind: "assistant", at: 2_000, text: "new incarnation" },
  ]), OTHER_NONCE), { ...TARGET, cursor }, "full", 20, cursor);
  assert.equal(stale.nativeStatus, "stale-cursor");
  assert.equal(stale.outcome, "failure");
  assert.equal(stale.error, "stale-session-cursor");
});

test("workspace session summary with no progress remains bounded and cursorable", () => {
  const snapshot = workspaceSessionObservationSnapshot(owner(), TARGET, "summary", 20);
  assert.match(snapshot.summary, /no published activity/);
  assert.deepEqual(snapshot.page?.items, []);
  assert.equal(typeof snapshot.page?.nextCursor, "string");
  assert.match(snapshot.revision ?? "", /:0$/);
});

test("workspace todos observation renders structured items and bounded detail", () => {
  const todos: WorkspaceTodoSnapshot[] = [
    {
      id: "todo-1",
      subject: "Build the release",
      status: "in_progress",
      assigneeLabel: "worker",
      dispatchId: "dispatch-1",
      scheduleId: "release",
      stepId: "build",
      updatedAt: 1_010,
    },
    {
      id: "todo-2",
      subject: "Verify artifacts",
      status: "completed",
      updatedAt: 1_020,
    },
  ];
  const snapshot = workspaceTodosObservationSnapshot(owner(undefined, OWNER_NONCE, todos), TARGET, "full", 1);

  assert.equal(snapshot.found, true);
  assert.equal(snapshot.page?.kind, "workspace-todos");
  assert.equal(snapshot.page?.items.length, 2);
  assert.deepEqual(snapshot.page?.items[0], todos[0]);
  assert.match(snapshot.summary, /2 total · 1 active · 1 bound/);
  assert.equal(snapshot.detail?.length, 1);
  assert.match(snapshot.detail?.[0] ?? "", /\[todo-2\] completed · Verify artifacts/);
  assert.match(snapshot.revision ?? "", /^workspace-todos:1040:[a-f0-9]{16}$/);

  const changed = workspaceTodosObservationSnapshot(owner(undefined, OWNER_NONCE, [
    { ...todos[0], status: "completed", updatedAt: 1_030 },
    todos[1],
  ]), TARGET, "full", 1);
  assert.notEqual(changed.revision, snapshot.revision);
});

test("workspace todos summary retains counts but omits structured items and detail", () => {
  const todos: WorkspaceTodoSnapshot[] = [
    { id: "todo-1", subject: "Queued", status: "pending", updatedAt: 1_010 },
  ];
  const snapshot = workspaceTodosObservationSnapshot(owner(undefined, OWNER_NONCE, todos), TARGET, "summary", 20);

  assert.match(snapshot.summary, /1 total · 1 active · 0 bound/);
  assert.deepEqual(snapshot.page?.items, []);
  assert.equal(snapshot.detail, undefined);
});

test("workspace todos observation strips CR LF ESC from structured items and detail", () => {
  const snapshotOwner = owner();
  snapshotOwner.todos = [{
    id: "todo\r\n1\x1b",
    subject: "line\r\nbreak\x1b[31m",
    status: "in_progress",
    assigneeLabel: "worker\nname",
    dispatchId: "dispatch\r\n1",
    scheduleId: "release\x1b",
    stepId: "step\n1",
    updatedAt: 1_020,
  }];
  const snapshot = workspaceTodosObservationSnapshot(snapshotOwner, TARGET, "full", 20);
  const rendered = JSON.stringify({ items: snapshot.page?.items, detail: snapshot.detail });

  assert.ok(!rendered.includes("\\r"));
  assert.ok(!rendered.includes("\\n"));
  assert.ok(!rendered.includes("\\u001b"));
  assert.match(snapshot.detail?.[0] ?? "", /todo  1/);
  assert.match(snapshot.detail?.[0] ?? "", /line  break/);
});
