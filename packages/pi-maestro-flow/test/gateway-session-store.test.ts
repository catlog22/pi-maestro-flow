import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { principalKey } from "../src/gateway/principal.ts";
import { SessionAuthorizationError } from "../src/gateway/identity-store.ts";
import { GatewayTodoClaimError, GatewayTodoDependencyError, GatewayTodoStore } from "../src/gateway/todo-store.ts";
import { SessionConflictError, SessionLeaseError, SessionReplayMismatchError, SessionStore, SessionStoreError } from "../src/gateway/session-store.ts";
import { parseCollaborativeSessionState } from "../src/gateway/session-contracts.ts";

const baseNow = 1_700_000_000_000;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gateway-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = baseNow;
  const principal = createGatewayPrincipal("stdio", "owner", { authenticated: true });
  const store = new SessionStore({ cwd: root, sessionsRoot: join(root, "sessions"), now: () => now });
  const state = await store.create({ id: "session-1", workspacePath: root, ownerId: "member-owner", ownerPrincipalId: principalKey(principal), leaseTtlMs: 60_000 }, { expectedSessionRevision: 0, operationId: "create-1", actorId: "member-owner" });
  const identity = { principal, memberId: "member-owner", authMode: "bearer" as const };
  return { root, store, state, identity, tick(ms = 1) { now += ms; } };
}

function mutation(revision: number, operationId: string, identity: Awaited<ReturnType<typeof fixture>>["identity"]) {
  return { expectedSessionRevision: revision, operationId, actorId: identity.memberId, identity };
}

test("collaboration contracts are strict, versioned, and cross-session closed", async (t) => {
  const { state, store } = await fixture(t);
  assert.equal(parseCollaborativeSessionState(state).session.version, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.path(state.session.id))).mode & 0o777, 0o600);
  }
  assert.throws(() => parseCollaborativeSessionState({ ...state, extra: true }));
  assert.throws(() => parseCollaborativeSessionState({ ...state, members: [{ ...state.members[0], sessionId: "other" }] }), /different session/);
});

test("concurrent writers linearize with required CAS and conflicts perform zero writes", async (t) => {
  const { store, state, identity } = await fixture(t);
  const todos = new GatewayTodoStore(store);
  const before = await readFile(store.path(state.session.id), "utf8");
  const results = await Promise.allSettled([
    todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "op-a", identity)),
    todos.create(state.session.id, { id: "b", subject: "B" }, mutation(1, "op-b", identity)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && result.reason instanceof SessionConflictError));
  const afterRace = await readFile(store.path(state.session.id), "utf8");
  assert.notEqual(afterRace, before);
  await assert.rejects(() => todos.create(state.session.id, { id: "stale", subject: "stale" }, mutation(1, "op-stale", identity)), SessionConflictError);
  assert.equal(await readFile(store.path(state.session.id), "utf8"), afterRace);
  assert.equal((await store.require(state.session.id)).session.revision, 2);
});

test("idempotent replay is payload-bound and does not write", async (t) => {
  const { store, state, identity } = await fixture(t); const todos = new GatewayTodoStore(store);
  const first = await todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "same-op", identity));
  const path = store.path(state.session.id); const before = await readFile(path, "utf8"); const beforeStat = await stat(path);
  const replay = await todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "same-op", identity));
  assert.deepEqual(replay, first); assert.equal(await readFile(path, "utf8"), before); assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs);
  const attacker = { principal: createGatewayPrincipal("http", "attacker", { authenticated: true }), memberId: identity.memberId, authMode: "bearer" as const };
  await assert.rejects(() => todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "same-op", attacker)), SessionAuthorizationError);
  await assert.rejects(() => todos.create(state.session.id, { id: "a", subject: "changed" }, mutation(1, "same-op", identity)), SessionReplayMismatchError);
  assert.equal(await readFile(path, "utf8"), before);
});

test("close returns and replays the committed session snapshot", async (t) => {
  const { store, state, identity, tick } = await fixture(t);
  tick(42);
  const closed = await store.close(state.session.id, mutation(1, "close", identity));
  const persisted = await store.require(state.session.id);
  const operation = persisted.operations.find((entry) => entry.id === "close");

  assert.equal(closed.status, "closed");
  assert.equal(closed.revision, 2);
  assert.equal(closed.updatedAt, baseNow + 42);
  assert.deepEqual(closed, persisted.session);
  assert.equal(operation?.committedRevision, 2);
  assert.deepEqual(operation?.result, persisted.session);

  const replay = await store.close(state.session.id, mutation(1, "close", identity));
  assert.deepEqual(replay, persisted.session);
});

test("close atomically stores a final handoff and replays it", async (t) => {
  const { store, state, identity } = await fixture(t);
  const handoff = { summary: "Continue verification", nextSteps: ["Run focused tests"], resourceUris: ["agent://session-handoff"] };
  const closed = await store.close(state.session.id, mutation(1, "close-with-handoff", identity), handoff);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.handoff, handoff);
  const persisted = await store.require(state.session.id);
  const operation = persisted.operations.find((entry) => entry.id === "close-with-handoff");
  assert.deepEqual(operation?.result, persisted.session);
  const replay = await store.close(state.session.id, mutation(1, "close-with-handoff", identity), handoff);
  assert.deepEqual(replay, persisted.session);
});

test("Todo dependencies reject missing references and cycles", async (t) => {
  const { store, state, identity } = await fixture(t); const todos = new GatewayTodoStore(store);
  await assert.rejects(() => todos.create(state.session.id, { id: "bad", subject: "bad", dependencyIds: ["missing"] }, mutation(1, "bad", identity)), GatewayTodoDependencyError);
  assert.equal((await store.require(state.session.id)).session.revision, 1);
  await todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "a", identity));
  await todos.create(state.session.id, { id: "b", subject: "B", dependencyIds: ["a"] }, mutation(2, "b", identity));
  await assert.rejects(() => todos.setDependencies(state.session.id, "a", ["b"], mutation(3, "cycle", identity)), GatewayTodoDependencyError);
  assert.equal((await store.require(state.session.id)).session.revision, 3);
});

test("claim, release, advance, dependency and one-active-claim invariants hold", async (t) => {
  const { store, state, identity } = await fixture(t); const todos = new GatewayTodoStore(store);
  await todos.create(state.session.id, { id: "a", subject: "A" }, mutation(1, "a", identity));
  await todos.create(state.session.id, { id: "b", subject: "B" }, mutation(2, "b", identity));
  await todos.create(state.session.id, { id: "c", subject: "C", dependencyIds: ["a"] }, mutation(3, "c", identity));
  await assert.rejects(() => todos.claim(state.session.id, "c", mutation(4, "claim-c-early", identity)), GatewayTodoClaimError);
  await todos.claim(state.session.id, "a", mutation(4, "claim-a", identity));
  await assert.rejects(() => todos.claim(state.session.id, "b", mutation(5, "claim-b-early", identity)), /already has/);
  await todos.release(state.session.id, "a", mutation(5, "release-a", identity));
  await todos.claim(state.session.id, "a", mutation(6, "reclaim-a", identity));
  const done = await todos.advance(state.session.id, "a", "completed", mutation(7, "done-a", identity)); assert.equal(done.status, "completed");
  const claimed = await todos.claim(state.session.id, "c", mutation(8, "claim-c", identity)); assert.equal(claimed.assigneeId, identity.memberId);
});

test("member ACL, open read-only policy, and lease generations fail closed", async (t) => {
  const { store, state, identity, tick } = await fixture(t); const todos = new GatewayTodoStore(store);
  await assert.rejects(() => todos.create(state.session.id, { id: "open", subject: "open" }, { ...mutation(1, "open", identity), identity: { ...identity, authMode: "open" as const } }), SessionAuthorizationError);
  const observerPrincipal = createGatewayPrincipal("http", "observer", { authenticated: true });
  const observer = await store.joinMember(state.session.id, { id: "observer", principalId: principalKey(observerPrincipal), role: "observer", leaseTtlMs: 10 }, mutation(1, "join-observer", identity));
  const observerIdentity = { principal: observerPrincipal, memberId: observer.id, authMode: "bearer" as const };
  await assert.rejects(() => todos.create(state.session.id, { id: "observer-write", subject: "no" }, mutation(2, "observer-write", observerIdentity)), SessionAuthorizationError);
  await todos.create(state.session.id, { id: "owner-task", subject: "Owner task" }, mutation(2, "owner-task", identity));
  const agentPrincipal = createGatewayPrincipal("http", "agent", { authenticated: true });
  const agent = await store.joinMember(state.session.id, { id: "agent", principalId: principalKey(agentPrincipal), role: "agent" }, mutation(3, "join-agent", identity));
  const agentIdentity = { principal: agentPrincipal, memberId: agent.id, authMode: "bearer" as const };
  await assert.rejects(() => todos.advance(state.session.id, "owner-task", "blocked", mutation(4, "agent-block", agentIdentity)), GatewayTodoClaimError);
  tick(11);
  await assert.rejects(() => store.mutateAuthorized(state.session.id, "probe", {}, mutation(4, "expired", observerIdentity), "session:read", () => true), SessionAuthorizationError);
  await assert.rejects(() => store.renewMember(state.session.id, observer.id, 2, 100, { ...mutation(4, "stale-generation", observerIdentity) }), SessionLeaseError);
  const renewed = await store.renewMember(state.session.id, observer.id, 1, 100, { ...mutation(4, "renew", observerIdentity) }); assert.equal(renewed.generation, 2);
});

test("restart restores exact Todo, operation, event, and session state; corruption never rewrites", async (t) => {
  const { root, store, state, identity } = await fixture(t); const todos = new GatewayTodoStore(store);
  await todos.create(state.session.id, { id: "durable", subject: "Survive" }, mutation(1, "durable-create", identity));
  await todos.claim(state.session.id, "durable", mutation(2, "durable-claim", identity));
  const before = await store.require(state.session.id);
  const restarted = new SessionStore({ cwd: root, sessionsRoot: join(root, "sessions"), now: () => baseNow + 5000 });
  assert.deepEqual(await restarted.require(state.session.id), before);
  assert.equal((await restarted.require(state.session.id)).todos[0]?.status, "in_progress");
  const path = store.path(state.session.id); await writeFile(path, "{broken", "utf8"); const corrupt = await readFile(path, "utf8");
  await assert.rejects(() => restarted.require(state.session.id), SessionStoreError);
  assert.equal(await readFile(path, "utf8"), corrupt);
});
