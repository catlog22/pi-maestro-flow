import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayTunnelExit, GatewayTunnelProvider, GatewayTunnelStartResult } from "../src/gateway/tunnel/contracts.ts";
import { GatewayTunnelProcessOwner, gatewayTunnelInvocationDigest } from "../src/gateway/tunnel/process-owner.ts";
import { GatewayTunnelStateConflictError, GatewayTunnelStateStore } from "../src/gateway/tunnel/state-store.ts";
import { GatewayTunnelSupervisor } from "../src/gateway/tunnel/supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeHarness {
  supervisor: GatewayTunnelSupervisor;
  starts: number;
  stops: number;
  exits: Array<ReturnType<typeof deferred<GatewayTunnelExit>>>;
  deadlines: number[];
  observations: Map<number, { alive: boolean; executableRealpath?: string; processStartIdentity?: string; invocationDigest?: string }>;
}

async function harness(root: string, options: { maxRestarts?: number; terminalProbe?: boolean } = {}): Promise<FakeHarness> {
  const executable = "/fake/provider-tunnel";
  const observations = new Map<number, { alive: boolean; executableRealpath?: string; processStartIdentity?: string; invocationDigest?: string }>();
  const exits: Array<ReturnType<typeof deferred<GatewayTunnelExit>>> = [];
  const deadlines: number[] = [];
  let starts = 0;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "fake",
    async doctor(context) { deadlines.push(context.deadlineAt); return { ok: true }; },
    async start(context): Promise<GatewayTunnelStartResult> {
      deadlines.push(context.deadlineAt);
      starts += 1;
      const pid = 10_000 + starts;
      const args = ["serve", `--generation=${starts}`];
      const processStartIdentity = `boot:${starts}`;
      observations.set(pid, { alive: true, executableRealpath: executable, processStartIdentity, invocationDigest: gatewayTunnelInvocationDigest(executable, args) });
      const exit = deferred<GatewayTunnelExit>();
      exits.push(exit);
      return { pid, executablePath: executable, args, processStartIdentity, exited: exit.promise };
    },
    async probe(context) { deadlines.push(context.deadlineAt); return options.terminalProbe ? { ready: false, terminal: true, detail: "not ready" } : { ready: true, endpoint: "https://tunnel.invalid" }; },
    async stop(context, identity) {
      deadlines.push(context.deadlineAt);
      stops += 1;
      const observed = observations.get(identity.pid);
      if (observed) observed.alive = false;
    },
  };
  const stateStore = new GatewayTunnelStateStore({ path: join(root, "fake.json"), provider: "fake" });
  const processOwner = new GatewayTunnelProcessOwner({ inspect: async (pid) => observations.get(pid) ?? { alive: false } });
  const supervisor = new GatewayTunnelSupervisor({
    provider,
    stateStore,
    processOwner,
    restartBudget: { maxRestarts: options.maxRestarts ?? 1, windowMs: 10_000 },
    canonicalizeExecutable: async (path) => path,
  });
  return {
    supervisor,
    exits,
    deadlines,
    observations,
    get starts() { return starts; },
    get stops() { return stops; },
  };
}

test("double start is single-flight and persists separated desired/observed identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root);
  const [first, second] = await Promise.all([fake.supervisor.start(), fake.supervisor.start()]);
  assert.equal(fake.starts, 1);
  assert.equal(first.generation, 1);
  assert.deepEqual(second, first);
  assert.equal(first.desiredState, "running");
  assert.equal(first.observed.phase, "ready");
  assert.equal(first.executableRealpath, "/fake/provider-tunnel");
  assert.match(first.processStartIdentity!, /^boot:/u);
  assert.match(first.invocationDigest!, /^[a-f0-9]{64}$/u);
  assert.ok(first.ownerToken.length >= 16);
});

test("stale generations and PID reuse are fenced before stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root);
  const ready = await fake.supervisor.start();
  await assert.rejects(() => fake.supervisor.stop({ expectedGeneration: ready.generation + 1 }), GatewayTunnelStateConflictError);
  const observed = fake.observations.get(ready.pid!)!;
  observed.processStartIdentity = "reused:later";
  await assert.rejects(() => fake.supervisor.stop({ expectedGeneration: ready.generation }), /start_identity_mismatch/u);
  assert.equal(fake.stops, 0, "an unverified PID is never handed to provider.stop");
  const failed = await fake.supervisor.status();
  assert.equal(failed?.desiredState, "stopped", "explicit stop fences restart before ownership verification");
  assert.equal(failed?.observed.phase, "failed");
});

test("unexpected exits restart only within the hard crash budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root, { maxRestarts: 1 });
  await fake.supervisor.start();
  fake.exits[0]!.resolve({ code: 1 });
  await until(() => fake.starts === 2);
  assert.equal((await fake.supervisor.status())?.generation, 2);
  fake.exits[1]!.resolve({ code: 2 });
  await until(async () => (await fake.supervisor.status())?.observed.phase === "failed");
  assert.equal(fake.starts, 2, "the second crash exhausts a one-restart budget");
  assert.match((await fake.supervisor.status())?.observed.detail ?? "", /budget exhausted/u);
});

test("explicit stop sets desired=stopped before exit and suppresses auto-restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-explicit-stop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const fake = await harness(root);
  const ready = await fake.supervisor.start();
  const stopped = await fake.supervisor.stop({ expectedGeneration: ready.generation });
  fake.exits[0]!.resolve({ code: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.starts, 1);
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.observed.phase, "stopped");
});

test("a stale start generation cannot overwrite a newer endpoint publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-stale-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = "/fake/cloudflared";
  const args = ["tunnel", "--url", "http://127.0.0.1:9090"];
  const release = deferred<void>();
  let probes = 0;
  const provider: GatewayTunnelProvider = {
    name: "fake",
    async doctor() { return { ok: true }; },
    async start() { return { pid: 55, executablePath: executable, args, processStartIdentity: "boot:55" }; },
    async probe() {
      probes += 1;
      if (probes === 1) return { ready: false, endpoint: "https://old.invalid", retryAfterMs: 1 };
      await release.promise;
      return { ready: true, endpoint: "https://old.invalid" };
    },
    async stop() {},
  };
  const store = new GatewayTunnelStateStore({ path: join(root, "fake.json"), provider: "fake" });
  const owner = new GatewayTunnelProcessOwner({ inspect: async () => ({
    alive: true,
    executableRealpath: executable,
    processStartIdentity: "boot:55",
    invocationDigest: gatewayTunnelInvocationDigest(executable, args),
  }) });
  const supervisor = new GatewayTunnelSupervisor({ provider, stateStore: store, processOwner: owner, canonicalizeExecutable: async (path) => path });
  const starting = supervisor.start({ timeoutMs: 2_000 });
  await until(async () => (await store.read())?.observed.endpoint === "https://old.invalid");
  const old = (await store.read())!;
  await store.save({
    ...old,
    generation: old.generation + 1,
    ownerToken: "new-owner-token-00000001",
    observed: { phase: "starting", changedAt: Date.now(), endpoint: "https://new.invalid" },
    updatedAt: Date.now(),
  }, { expectedGeneration: old.generation, expectedOwnerToken: old.ownerToken });
  release.resolve();
  await assert.rejects(() => starting, GatewayTunnelStateConflictError);
  const current = await store.read();
  assert.equal(current?.generation, old.generation + 1);
  assert.equal(current?.observed.endpoint, "https://new.invalid");
});

test("startup cleanup reuses the exact doctor/start/probe absolute deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root, { terminalProbe: true });
  const deadlineAt = Date.now() + 1_000;
  await assert.rejects(() => fake.supervisor.start({ deadlineAt }), /not ready/u);
  assert.equal(fake.stops, 1);
  assert.ok(fake.deadlines.length >= 4);
  assert.deepEqual(new Set(fake.deadlines), new Set([deadlineAt]));
});
