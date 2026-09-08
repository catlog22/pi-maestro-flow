import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoardStore } from "../src/gateway/board-store.ts";
import { GatewayHandoffRecordStore, parseGatewayHandoffDocument } from "../src/gateway/handoff-record-store.ts";
import { gatewayHandoffOriginForTransport } from "../src/gateway/handoff-record-contracts.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { createGatewayPrincipal, principalKey } from "../src/gateway/principal.ts";
import { GatewayHandoffService } from "../src/gateway/services/handoff-service.ts";
import { SessionStore } from "../src/gateway/session-store.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { GatewayTodoStore } from "../src/gateway/todo-store.ts";
import { gatewayHandoffRoot, workspaceIdForPath } from "../src/gateway/state-paths.ts";

const now = Date.now();

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gateway-handoff-records-"));
  const other = await mkdtemp(join(tmpdir(), "gateway-handoff-other-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); });
  const principal = createGatewayPrincipal("http", "owner", { authenticated: true, workspaceId: workspaceIdForPath(root) });
  const sessions = new SessionStore({ cwd: root, sessionsRoot: join(root, "sessions"), now: () => now });
  const todos = new GatewayTodoStore(sessions);
  const board = new BoardStore({ workspacePath: root, sessionStore: sessions, todoStore: todos, now: () => now });
  const records = new GatewayHandoffRecordStore({ root: gatewayHandoffRoot(root), maxRecords: 64 });
  const policy = new GatewayPolicy({ workspaces: [root, other] });
  const service = new GatewayHandoffService({ policy, sessions, records, boardStoreForWorkspace: () => board, authMode: "bearer" });
  return { root, other, principal, sessions, board, records, service, workspaceId: workspaceIdForPath(root) };
}

function boardMutation(principal: ReturnType<typeof createGatewayPrincipal>, revision: number, operationId: string) {
  return { principal, expectedRevision: revision, operationId };
}

function sessionMutation(principal: ReturnType<typeof createGatewayPrincipal>, revision: number, operationId: string) {
  return { expectedSessionRevision: revision, operationId, actorId: "member-owner", identity: { principal, memberId: "member-owner", authMode: "bearer" as const } };
}

test("handoff service projects Board completion and Session closure without conflating completion", async (t) => {
  const { root, principal, sessions, board, service, workspaceId } = await fixture(t);
  const sessionState = await sessions.create({ id: "session-1", workspacePath: root, ownerId: "member-owner", ownerPrincipalId: principalKey(principal) }, { expectedSessionRevision: 0, operationId: "session-create", actorId: "member-owner" });
  const sessionHandoff = { summary: "Session evidence", nextSteps: ["Resume separately"] };
  await sessions.close(sessionState.session.id, sessionMutation(principal, 1, "session-close"), sessionHandoff, gatewayHandoffOriginForTransport("http"));

  await board.create({ id: "board-1", title: "Board work", completionPolicy: { requireLinkedTodosCompleted: false } }, boardMutation(principal, 0, "board-create"));
  const handoff = { summary: "Reusable operational state", nextSteps: ["Run final checks"], resourceUris: ["agent://evidence"] };
  await board.handoff("board-1", handoff, boardMutation(principal, 1, "board-handoff"), gatewayHandoffOriginForTransport("http"));
  await board.claim("board-1", { leaseTtlMs: 60_000 }, boardMutation(principal, 2, "board-claim"));
  await board.transition("board-1", { status: "active", phase: "execution", claimGeneration: 1 }, boardMutation(principal, 3, "board-active"));
  await board.transition("board-1", { status: "completed", claimGeneration: 1 }, boardMutation(principal, 4, "board-complete"));

  const response = await service.handle(principal, { action: "search", workspaceId, memberId: "member-owner", query: "operational final" });
  assert.equal(response.ok, true);
  const boardRecord = (response.data as { records: Array<{ source: { authority: string }; projection: string; origin: { surface: string; transport: string; evidenceKind: string }; governanceState: string }> }).records[0];
  assert.equal(boardRecord?.source.authority, "board");
  assert.equal(boardRecord?.projection, "completed");
  assert.deepEqual(boardRecord?.origin, { surface: "web", transport: "http", evidenceKind: "project" });
  assert.equal(boardRecord?.governanceState, "operational");

  const sessionsOnly = await service.handle(principal, { action: "list", workspaceId, memberId: "member-owner", authority: "session" });
  const sessionRecord = (sessionsOnly.data as { records: Array<{ projection: string; resumable: boolean }> }).records[0];
  assert.equal(sessionRecord?.projection, "unknown");
  assert.equal(sessionRecord?.resumable, false);

  const hiddenWithoutMembership = await service.handle(principal, { action: "list", workspaceId, authority: "session" });
  assert.deepEqual((hiddenWithoutMembership.data as { records: unknown[]; hasMore: boolean }).records, []);
  assert.equal((hiddenWithoutMembership.data as { hasMore: boolean }).hasMore, false);
});

test("record projection is immutable, idempotent, digest-checked, and YAML-front-matter backed", async (t) => {
  const { principal, board, records, service, workspaceId, root } = await fixture(t);
  await board.create({ id: "board-1", title: "Board work", completionPolicy: { requireLinkedTodosCompleted: false } }, boardMutation(principal, 0, "create"));
  await board.handoff("board-1", { summary: "Immutable state" }, boardMutation(principal, 1, "handoff"));
  await Promise.all([
    service.handle(principal, { action: "list", workspaceId }),
    service.handle(principal, { action: "list", workspaceId }),
  ]);
  const page = await records.list(workspaceId);
  assert.equal(page.records.length, 1);
  const record = page.records[0]!;
  assert.deepEqual(await Promise.all([records.put(record), records.put(record)]), [record, record]);
  const document = await readFile(join(gatewayHandoffRoot(root), workspaceId, `${record.id}.md`), "utf8");
  assert.match(document, /^---\nversion: 1\nschema: gateway-handoff\/1/m);
  assert.deepEqual(parseGatewayHandoffDocument(document), record);
  await assert.rejects(() => records.put({ ...record, contentSha256: "0".repeat(64) }), /digest/);
});

test("runtime catalog publishes and dispatches authorized handoff reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-handoff-runtime-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const workspaceId = workspaceIdForPath(root);
  const principal = createGatewayPrincipal("http", "owner", { authenticated: true, workspaceId });
  await runtime.call("board", {
    action: "create", workspaceId, taskId: "runtime-board", title: "Runtime handoff",
    completionPolicy: { requireLinkedTodosCompleted: false, requireReview: false }, expectedRevision: 0, operationId: "create",
  }, principal);
  await runtime.call("board", {
    action: "handoff", workspaceId, taskId: "runtime-board", handoff: { summary: "Catalog visible state" },
    expectedRevision: 1, operationId: "handoff",
  }, principal);
  const response = await runtime.call("handoff", { action: "search", workspaceId, query: "Catalog visible" }, principal);
  assert.equal(response.ok, true);
  assert.equal((response.data as { records: Array<{ source: { entityId: string } }> }).records[0]?.source.entityId, "runtime-board");
});

test("workspace authorization happens before handoff results or counts", async (t) => {
  const { principal, board, service, workspaceId, other } = await fixture(t);
  await board.create({ id: "board-1", title: "Secret", completionPolicy: { requireLinkedTodosCompleted: false } }, boardMutation(principal, 0, "create"));
  await board.handoff("board-1", { summary: "Secret handoff" }, boardMutation(principal, 1, "handoff"));
  const foreign = createGatewayPrincipal("http", "foreign", { authenticated: true, workspaceId: workspaceIdForPath(other) });
  const response = await service.handle(foreign, { action: "list", workspaceId });
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, "not_found");
  assert.equal(response.data, undefined);
});
