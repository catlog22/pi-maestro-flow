import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BoardAuthorizationError,
  BoardClaimError,
  BoardConflictError,
  BoardNotFoundError,
  BoardReplayMismatchError,
  BoardStore,
} from "../src/gateway/board-store.ts";
import { createGatewayPrincipal, principalKey } from "../src/gateway/principal.ts";
import { SessionStore } from "../src/gateway/session-store.ts";
import { GatewayTodoStore } from "../src/gateway/todo-store.ts";

const baseNow = 1_700_000_000_000;

async function fixture(t: test.TestContext, options: { maxEvents?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = baseNow;
  const pi = createGatewayPrincipal("stdio", "dispatcher", { authenticated: true, scopes: ["board.dispatch"] });
  const web = createGatewayPrincipal("http", "web-owner", { authenticated: true, scopes: ["board.claim", "board.update"] });
  const other = createGatewayPrincipal("http", "web-other", { authenticated: true, scopes: ["board.claim"] });
  const admin = createGatewayPrincipal("http", "web-admin", { authenticated: true, scopes: ["board.admin"] });
  const sessions = new SessionStore({ cwd: root, sessionsRoot: join(root, "sessions"), now: () => now });
  const todos = new GatewayTodoStore(sessions);
  const boardRoot = join(root, "board-state");
  const board = new BoardStore({
    workspacePath: root,
    boardRoot,
    sessionStore: sessions,
    todoStore: todos,
    now: () => now,
    maxEvents: options.maxEvents,
    maxLeaseTtlMs: 60_000,
  });
  const identity = { principal: web, memberId: "web-member", authMode: "bearer" as const };
  const session = await sessions.create({
    id: "session-1",
    workspacePath: root,
    ownerId: "web-member",
    ownerPrincipalId: principalKey(web),
    leaseTtlMs: 60_000,
  }, { expectedSessionRevision: 0, operationId: "session-create", actorId: "web-member" });
  return {
    root, boardRoot, board, sessions, todos, pi, web, other, admin, identity,
    session: () => session,
    now: () => now,
    tick: (milliseconds: number) => { now += milliseconds; },
  };
}

function createInput(id = "board-1") {
  return {
    id,
    title: "Implement collaborative Board",
    acceptanceCriteria: ["A remote Web principal can claim the task"],
    priority: "high" as const,
    labels: ["gateway"],
    completionPolicy: { requireLinkedTodosCompleted: true, requireReview: true },
  };
}

test("BoardStore persists strict tasks and payload-bound operation replays", async (t) => {
  const value = await fixture(t);
  const options = { principal: value.pi, expectedRevision: 0, operationId: "board-create" };
  const created = await value.board.create(createInput(), options);
  assert.equal(created.status, "open");
  assert.equal(created.phase, "intake");
  assert.equal(created.createdBy.actorType, "pi");
  assert.deepEqual(await value.board.create(createInput(), options), created);
  await assert.rejects(
    () => value.board.create({ ...createInput(), title: "different" }, options),
    BoardReplayMismatchError,
  );

  const reopened = new BoardStore({
    workspacePath: value.root,
    boardRoot: value.boardRoot,
    sessionStore: value.sessions,
    todoStore: value.todos,
    now: value.now,
  });
  assert.deepEqual(await reopened.get(created.id), created);
  assert.equal(await reopened.get("missing"), undefined);
});

test("BoardStore tracks multiple participation endpoints without changing claim ownership", async (t) => {
  const value = await fixture(t);
  const created = await value.board.create(createInput(), { principal: value.pi, expectedRevision: 0, operationId: "create" });
  const piAttached = await value.board.attachEndpoint(created.id, { kind: "pi", endpointId: "pi-session-1" }, {
    principal: value.pi, expectedRevision: 1, operationId: "attach-pi",
  });
  const webAttached = await value.board.attachEndpoint(created.id, { kind: "web", endpointId: "web-session-1" }, {
    principal: value.web, expectedRevision: piAttached.revision, operationId: "attach-web",
  });
  assert.deepEqual(webAttached.endpointBindings?.map(({ kind, endpointId }) => ({ kind, endpointId })), [
    { kind: "pi", endpointId: "pi-session-1" },
    { kind: "web", endpointId: "web-session-1" },
  ]);
  assert.equal(webAttached.claim, undefined);
  await assert.rejects(
    () => value.board.attachEndpoint(created.id, { kind: "web", endpointId: "web-session-1" }, {
      principal: value.other, expectedRevision: webAttached.revision, operationId: "duplicate-web",
    }),
    BoardConflictError,
  );
  await assert.rejects(
    () => value.board.detachEndpoint(created.id, { kind: "web", endpointId: "web-session-1" }, {
      principal: value.other, expectedRevision: webAttached.revision, operationId: "detach-foreign-web",
    }),
    BoardAuthorizationError,
  );
  const detached = await value.board.detachEndpoint(created.id, { kind: "web", endpointId: "web-session-1" }, {
    principal: value.web, expectedRevision: webAttached.revision, operationId: "detach-web",
  });
  assert.deepEqual(detached.endpointBindings?.map((binding) => binding.endpointId), ["pi-session-1"]);
  assert.equal(detached.claim, undefined);
});

test("only one concurrent claimant wins and stale claim generations fail closed", async (t) => {
  const value = await fixture(t);
  const created = await value.board.create(createInput(), { principal: value.pi, expectedRevision: 0, operationId: "create" });
  const attempts = await Promise.allSettled([
    value.board.claim(created.id, { leaseTtlMs: 10_000 }, { principal: value.web, expectedRevision: 1, operationId: "claim-web" }),
    value.board.claim(created.id, { leaseTtlMs: 10_000 }, { principal: value.other, expectedRevision: 1, operationId: "claim-other" }),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
  const claimed = await value.board.get(created.id);
  assert.ok(claimed?.claim);
  const owner = claimed.claim.principalId === principalKey(value.web) ? value.web : value.other;
  const stranger = owner === value.web ? value.other : value.web;
  await assert.rejects(
    () => value.board.renew(created.id, { claimGeneration: claimed.claim!.generation, leaseTtlMs: 10_000 }, {
      principal: stranger, expectedRevision: claimed.revision, operationId: "stale-renew",
    }),
    BoardClaimError,
  );
});

test("Web claim binds an active Session, links Todos, and enforces review completion", async (t) => {
  const value = await fixture(t);
  const todo = await value.todos.create("session-1", { id: "todo-1", subject: "Implement" }, {
    identity: value.identity, actorId: "web-member", expectedSessionRevision: 1, operationId: "todo-create",
  });
  const created = await value.board.create(createInput(), { principal: value.pi, expectedRevision: 0, operationId: "create" });
  const claimed = await value.board.claim(created.id, { leaseTtlMs: 30_000, sessionId: "session-1", memberId: "web-member" }, {
    principal: value.web, expectedRevision: 1, operationId: "claim-bind",
  });
  assert.equal(claimed.sessionBinding?.sessionId, "session-1");
  const planned = await value.board.linkPlan(created.id, { sessionId: "session-1", todoIds: [todo.id], claimGeneration: 1 }, {
    principal: value.web, expectedRevision: 2, operationId: "link-plan",
  });
  const active = await value.board.transition(created.id, { status: "active", phase: "execution", claimGeneration: 1 }, {
    principal: value.web, expectedRevision: planned.revision, operationId: "execute",
  });
  await assert.rejects(
    () => value.board.transition(created.id, { status: "completed", phase: "review", claimGeneration: 1, summary: "done" }, {
      principal: value.web, expectedRevision: active.revision, operationId: "premature-complete",
    }),
    BoardConflictError,
  );

  await value.todos.claim("session-1", todo.id, {
    identity: value.identity, actorId: "web-member", expectedSessionRevision: 2, operationId: "todo-claim",
  });
  await value.todos.advance("session-1", todo.id, "completed", {
    identity: value.identity, actorId: "web-member", expectedSessionRevision: 3, operationId: "todo-complete",
  });
  const reviewing = await value.board.transition(created.id, { phase: "review", claimGeneration: 1 }, {
    principal: value.web, expectedRevision: active.revision, operationId: "review",
  });
  const completed = await value.board.transition(created.id, { status: "completed", claimGeneration: 1, summary: "verified", resourceUris: ["agent://result"] }, {
    principal: value.web, expectedRevision: reviewing.revision, operationId: "complete",
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result?.resourceUris, ["agent://result"]);
});

test("expired active claims are orphaned and require an authorized takeover", async (t) => {
  const value = await fixture(t);
  const created = await value.board.create(createInput(), { principal: value.pi, expectedRevision: 0, operationId: "create" });
  const claimed = await value.board.claim(created.id, { leaseTtlMs: 100, sessionId: "session-1", memberId: "web-member" }, {
    principal: value.web, expectedRevision: 1, operationId: "claim",
  });
  const active = await value.board.transition(created.id, { status: "active", phase: "planning", claimGeneration: 1 }, {
    principal: value.web, expectedRevision: claimed.revision, operationId: "activate",
  });
  value.tick(101);
  assert.equal(value.board.isOrphaned((await value.board.get(created.id))!), true);
  await assert.rejects(
    () => value.board.renew(created.id, { claimGeneration: 1, leaseTtlMs: 100 }, {
      principal: value.web, expectedRevision: active.revision, operationId: "expired-renew",
    }),
    BoardClaimError,
  );
  await assert.rejects(
    () => value.board.update(created.id, { title: "stale claimant write" }, {
      principal: value.web, expectedRevision: active.revision, operationId: "expired-update",
    }),
    BoardClaimError,
  );
  await assert.rejects(
    () => value.board.transition(created.id, { status: "blocked" }, {
      principal: value.web, expectedRevision: active.revision, operationId: "expired-transition",
    }),
    BoardClaimError,
  );
  await assert.rejects(
    () => value.board.transition(created.id, { status: "cancelled" }, {
      principal: value.admin, expectedRevision: active.revision, operationId: "admin-orphan-transition",
    }),
    BoardClaimError,
  );
  await assert.rejects(
    () => value.board.claim(created.id, { leaseTtlMs: 100 }, { principal: value.other, expectedRevision: active.revision, operationId: "reclaim" }),
    BoardClaimError,
  );
  await assert.rejects(
    () => value.board.takeover(created.id, { leaseTtlMs: 100, reason: "expired" }, { principal: value.other, expectedRevision: active.revision, operationId: "unauthorized-takeover" }),
    BoardAuthorizationError,
  );
  const taken = await value.board.takeover(created.id, { leaseTtlMs: 100, reason: "operator recovery" }, {
    principal: value.admin, expectedRevision: active.revision, operationId: "admin-takeover",
  });
  assert.equal(taken.claim?.generation, 2);
  assert.equal(taken.claim?.actorType, "web");
});

test("Board event cursors remain monotonic across retention gaps and workspace partitions", async (t) => {
  const value = await fixture(t, { maxEvents: 2 });
  const created = await value.board.create(createInput(), { principal: value.pi, expectedRevision: 0, operationId: "create" });
  const first = await value.board.update(created.id, { title: "second" }, { principal: value.pi, expectedRevision: 1, operationId: "update-1" });
  await value.board.update(created.id, { title: "third" }, { principal: value.pi, expectedRevision: first.revision, operationId: "update-2" });
  const page = await value.board.observe(0, 10);
  assert.equal(page.gap, true);
  assert.deepEqual(page.events.map((event) => event.cursor), [2, 3]);
  assert.equal(page.nextCursor, 3);

  const otherRoot = await mkdtemp(join(tmpdir(), "gateway-board-other-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const otherBoard = new BoardStore({
    workspacePath: otherRoot,
    boardRoot: value.boardRoot,
    sessionStore: value.sessions,
    todoStore: value.todos,
  });
  assert.notEqual(otherBoard.path, value.board.path);
  await assert.rejects(
    () => otherBoard.claim(created.id, { sessionId: "session-1", memberId: "web-member" }, {
      principal: value.web, expectedRevision: 0, operationId: "cross-workspace",
    }),
    BoardNotFoundError,
  );
});
