import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import {
  GatewayTeammateService,
  type GatewayTeammateControl,
  type GatewayTeammatePort,
} from "../src/gateway/services/teammate-service.ts";
import {
  GATEWAY_TASK_LOST_ERROR,
  TaskJournal,
} from "../src/gateway/task-journal.ts";
import type { SingleResult } from "pi-maestro-teammate/v1/types";

function usage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 };
}

function result(prompt: string, correlationId: string, index = 0): SingleResult {
  return {
    agent: "general",
    task: prompt,
    exitCode: 0,
    messages: [{ role: "assistant", content: `done-${index}` }],
    usage: usage(),
    model: "test/model",
    correlationId,
    publicationId: `publication-${index}`,
    durationMs: 1,
  };
}

class FakePort implements GatewayTeammatePort {
  calls: Array<{ control: GatewayTeammateControl; message: string; mode: string }> = [];
  options?: Parameters<GatewayTeammatePort["runTeammate"]>[1];
  resultSet: SingleResult[] = [];
  deferred?: Promise<SingleResult[]>;
  resolveDeferred?: (results: SingleResult[]) => void;

  async runTeammate(_params: Parameters<GatewayTeammatePort["runTeammate"]>[0], options: Parameters<GatewayTeammatePort["runTeammate"]>[1]): Promise<SingleResult[]> {
    this.options = options;
    const correlationId = options.taskCorrelationIds?.[0] ?? "child";
    options.onChildSpawned?.({} as never, () => true, undefined, correlationId, 1);
    options.onProgress?.({
      agent: "general",
      correlationId,
      status: "running",
      recentTools: [],
      toolCount: 0,
      tokens: 1,
      durationMs: 1,
      lastActivityAt: Date.now(),
      startedAt: Date.now(),
      lastMessage: "working",
    });
    if (this.deferred) return this.deferred;
    return this.resultSet.length > 0 ? this.resultSet : [result("work", correlationId)];
  }

  send(control: GatewayTeammateControl, message: string, mode: "steer" | "follow_up" | "interrupt"): boolean {
    this.calls.push({ control, message, mode });
    return true;
  }

  defer(): void {
    this.deferred = new Promise<SingleResult[]>((resolve) => { this.resolveDeferred = resolve; });
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("Gateway teammate accepts promptly, isolates principals, and exposes cursor pages", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = createGatewayPrincipal("stdio", "owner", { workspacePath: root });
  const other = createGatewayPrincipal("stdio", "other", { workspacePath: root });
  const port = new FakePort();
  port.defer();
  const results = [result("work", "child", 0), result("work", "child-2", 1), result("work", "child-3", 2)];
  const service = new GatewayTeammateService({ port, baseCwd: root, journal: new TaskJournal({ path: join(root, "tasks.json") }), maxPageItems: 2 });

  const accepted = await service.start(owner, { tasks: [{ prompt: "work", agent: "general" }], cwd: root });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, "accepted");
  const taskId = accepted.data!.taskId;
  await eventually(() => port.options !== undefined);
  port.resolveDeferred?.(results);
  const hidden = await service.list(other);
  assert.deepEqual(hidden.data?.tasks, []);

  const observed = await service.observe(owner, taskId, { limit: 2 });
  assert.equal(observed.ok, true);
  assert.ok((observed.data?.events.length ?? 0) <= 2);
  const next = observed.data?.nextCursor ?? 0;
  const observedAgain = await service.observe(owner, taskId, { cursor: next, limit: 2 });
  assert.equal(observedAgain.ok, true);
  const firstCursors = new Set((observed.data?.events ?? []).map((event) => event.cursor));
  for (const event of observedAgain.data?.events ?? []) assert.equal(firstCursors.has(event.cursor), false);

  const page1 = await service.result(owner, taskId, { limit: 2 });
  assert.equal(page1.ok, true);
  assert.ok((page1.data?.items.length ?? 0) <= 2);
  const page2 = await service.result(owner, taskId, { cursor: page1.data?.nextCursor, limit: 2 });
  assert.equal(page2.ok, true);
  assert.ok((page2.data?.items.length ?? 0) <= 2);
  assert.notDeepEqual(page1.data?.items.map((item) => item.cursor), page2.data?.items.map((item) => item.cursor));

  const terminal = await service.wait(owner, taskId, { timeoutMs: 2_000 });
  assert.equal(terminal.data?.task.status, "completed");
});

test("Gateway teammate routes steer/follow_up/interrupt and makes cancel idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-send-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = createGatewayPrincipal("stdio", "owner", { workspacePath: root });
  const port = new FakePort();
  port.defer();
  const service = new GatewayTeammateService({ port, baseCwd: root, journal: new TaskJournal({ path: join(root, "tasks.json") }) });
  const accepted = await service.start(owner, { tasks: [{ prompt: "work", agent: "general" }], cwd: root });
  const taskId = accepted.data!.taskId;
  await eventually(() => port.options !== undefined && (port as { calls: unknown[] }).calls.length === 0);

  assert.equal((await service.send(owner, taskId, { message: "queued", mode: "steer" })).ok, true);
  assert.equal((await service.send(owner, taskId, { message: "again", mode: "follow_up" })).ok, true);
  assert.equal((await service.send(owner, taskId, { message: "replace", mode: "interrupt" })).ok, true);
  assert.deepEqual(port.calls.map((call) => call.mode), ["steer", "follow_up", "interrupt"]);

  const cancelled = await service.cancel(owner, taskId, "stop");
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.data?.cancelled, true);
  const repeated = await service.cancel(owner, taskId);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.data?.alreadyTerminal, true);
  port.resolveDeferred?.([]);
  await service.shutdown();
});

test("Gateway teammate closes only the matching child control generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = createGatewayPrincipal("stdio", "owner", { workspacePath: root });
  const port = new FakePort();
  port.defer();
  const service = new GatewayTeammateService({ port, baseCwd: root, journal: new TaskJournal({ path: join(root, "tasks.json") }) });
  const accepted = await service.start(owner, { tasks: [{ prompt: "work", agent: "general" }], cwd: root });
  const taskId = accepted.data!.taskId;
  await eventually(() => port.options !== undefined);
  const options = port.options!;
  options.onChildSpawned?.({} as never, () => true, undefined, taskId, 2);
  options.onChildClosed?.(taskId, 1, { reason: "old generation closed" } as never);
  assert.equal((await service.send(owner, taskId, { message: "new child", mode: "steer" })).ok, true);
  assert.equal(port.calls.at(-1)?.control.generation, 2, "stale close must not remove the replacement generation");
  options.onChildClosed?.(taskId, 2, { reason: "current generation closed" } as never);
  const staleSend = await service.send(owner, taskId, { message: "must not reach closed stdin", mode: "steer" });
  assert.equal(staleSend.ok, false);
  assert.equal(staleSend.error?.code, "task_not_running");
  port.resolveDeferred?.([]);
  await service.shutdown();
});

test("TaskJournal prunes expired terminal records at capacity but retains active records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100;
  const journal = new TaskJournal({ path: join(root, "tasks.json"), maxTasks: 2, terminalRetentionMs: 10, now: () => now });
  const base = { version: 1 as const, cwd: root, workspaceId: "workspace", principalId: "stdio:owner", createdAt: 1, updatedAt: 1 };
  await journal.upsert({ ...base, id: "terminal", status: "completed", finishedAt: 1 });
  await journal.upsert({ ...base, id: "active", status: "running" });
  now = 100;
  await journal.upsert({ ...base, id: "replacement", status: "queued", createdAt: 100, updatedAt: 100 });
  assert.deepEqual((await journal.list()).map((record) => record.id).sort(), ["active", "replacement"]);
});

test("Gateway teammate applies separate result and task retention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100;
  const owner = createGatewayPrincipal("stdio", "owner", { workspacePath: root });
  const service = new GatewayTeammateService({
    port: new FakePort(),
    baseCwd: root,
    journalPath: join(root, "tasks.json"),
    now: () => now,
    taskRetentionMs: 10,
    resultRetentionMs: 5,
  });
  const accepted = await service.start(owner, { tasks: [{ prompt: "work", agent: "general" }], cwd: root });
  const taskId = accepted.data!.taskId;
  await service.wait(owner, taskId, { timeoutMs: 2_000 });
  now = 106;
  const withoutResults = await service.result(owner, taskId);
  assert.equal(withoutResults.ok, true);
  assert.deepEqual(withoutResults.data?.results, []);
  now = 111;
  assert.equal((await service.observe(owner, taskId)).error?.code, "task_not_found");
});

test("TaskJournal recovers running records as lost without persisting prompts or results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-teammate-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "tasks.json");
  const journal = new TaskJournal({ path, now: () => 100 });
  await journal.upsert({
    version: 1,
    id: "task-1",
    status: "running",
    cwd: root,
    workspaceId: "workspace-1",
    principalId: "stdio:owner",
    createdAt: 1,
    updatedAt: 2,
  });
  const recovered = await journal.recover();
  assert.equal(recovered[0]?.status, "lost");
  assert.equal(recovered[0]?.error, GATEWAY_TASK_LOST_ERROR);
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /prompt|result|secret/i);

  const port = new FakePort();
  const service = new GatewayTeammateService({ port, baseCwd: root, journal: new TaskJournal({ path, now: () => 100 }) });
  const owner = createGatewayPrincipal("stdio", "owner", { workspacePath: root });
  const listed = await service.list(owner);
  assert.equal(listed.data?.tasks[0]?.status, "lost");
  assert.equal(port.options, undefined, "recovery must never resume a task");
});
