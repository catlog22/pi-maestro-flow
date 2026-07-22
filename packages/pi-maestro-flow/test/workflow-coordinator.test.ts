import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  defaultRunner,
  RunCliAdapter,
  type RunCliResult,
  type RunDoneOptions,
  type RunEditOptions,
} from "../src/session/cli-adapter.ts";
import {
  WorkflowCoordinator,
  WorkflowLeaseBusyError,
  WorkflowLeaseStore,
  type WorkflowRunAdapter,
  type WorkflowSnapshotProvider,
} from "../src/session/coordinator.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";
import { executeRunControl } from "../src/tools/run-control.ts";

test("coordinator attaches brief-first and fences old continuation markers across done and next", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-coordinator-"));
  const snapshot = workflowSnapshot("running");
  const bridge = fakeBridge(snapshot);
  const calls: string[][] = [];
  const adapter = fakeAdapter(calls, {
    onDone(_runId, _sessionId, options) {
      snapshot.session!.runs[0]!.status = "sealed";
      snapshot.session!.activeRunId = null;
      snapshot.session!.chain[0]!.status = options.verdict === "needs-retry" ? "pending" : "sealed";
      snapshot.session!.chain[0]!.runId = null;
    },
    onNext() {
      snapshot.session!.runs.push({
        ...snapshot.session!.runs[0]!,
        runId: "run-2",
        status: "running",
        startedAt: "2026-07-15T00:01:00.000Z",
        endedAt: null,
      });
      snapshot.session!.activeRunId = "run-2";
      snapshot.session!.chain[0]!.status = "running";
      snapshot.session!.chain[0]!.runId = "run-2";
    },
  });
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    const attached = await coordinator.attach("host-1");
    assert.equal(attached.brief?.stdout, "brief run-1");
    assert.deepEqual(calls[0], ["brief", "run-1", "session-1"]);

    const marker = coordinator.continuationMarker(3);
    assert.equal(coordinator.acceptsContinuation(marker), true);
    assert.equal(coordinator.acceptsContinuation(marker), false, "continuation marker must be single-use");
    const fencedMarker = coordinator.continuationMarker(3);
    await coordinator.fenceContinuation();
    assert.equal(coordinator.acceptsContinuation(fencedMarker), false);
    const doneMarker = coordinator.continuationMarker(4);
    const completed = await coordinator.done("run-1", { verdict: "needs-retry" });
    assert.equal(completed.command.stdout, "done run-1");
    assert.equal(coordinator.acceptsContinuation(doneMarker), false);
    assert.deepEqual(calls.at(-1), ["done", "run-1", "session-1", "needs-retry"]);

    const next = await coordinator.next();
    assert.equal(next.command.stdout, "next session-1");
    assert.deepEqual(calls.at(-1), ["next", "session-1", ""]);
    assert.equal(next.snapshot.session!.activeRunId, "run-2");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease is atomic under first-acquire concurrency and stale takeover raises epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  const clock = () => now;
  const first = new WorkflowLeaseStore(root, 1_000, clock);
  const second = new WorkflowLeaseStore(root, 1_000, clock);
  try {
    const contenders = await Promise.allSettled([
      first.acquire("session-1", "host-1"),
      second.acquire("session-1", "host-2"),
    ]);
    const fulfilled = contenders.filter((result) => result.status === "fulfilled");
    const rejected = contenders.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof WorkflowLeaseBusyError);
    const firstWon = contenders[0]!.status === "fulfilled";
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const original = fulfilled[0]!.value;
    now = new Date("2026-07-15T00:00:02.000Z");
    const replacement = await loser.acquire("session-1", firstWon ? "host-2" : "host-1");
    assert.ok(replacement.epoch > original.epoch);
    await winner.release();
    assert.equal((await loser.heartbeat()).token, replacement.token);
  } finally {
    await first.release();
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease storage is private and tightens existing POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-mode-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-private.lease");
  const owner = new WorkflowLeaseStore(root);
  const observer = new WorkflowLeaseStore(root);
  try {
    await owner.acquire("session-private", "host-owner");
    await owner.heartbeat();
    const entries = await readdir(directory);
    const claimPath = join(directory, entries.find((entry) => entry.endsWith(".claim.json"))!);
    const statePath = join(directory, entries.find((entry) => entry.endsWith(".state.json"))!);
    assert.equal((await lstat(claimPath)).isFile(), true);
    assert.equal((await lstat(statePath)).isFile(), true);

    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      await Promise.all([chmod(directory, 0o777), chmod(claimPath, 0o666), chmod(statePath, 0o666)]);
      await assert.rejects(observer.acquire("session-private", "host-observer"), WorkflowLeaseBusyError);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    }
  } finally {
    await owner.release();
    await observer.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease rejects a non-regular claim target", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-non-file-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-invalid.lease");
  try {
    await mkdir(join(directory, "1.claim.json"), { recursive: true });
    await assert.rejects(
      new WorkflowLeaseStore(root).acquire("session-invalid", "host-owner"),
      /Workflow lease path must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session lease rejects a symlink claim target on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-symlink-"));
  const directory = join(root, ".workflow", "tmp", "hook", "session-symlink.lease");
  try {
    await mkdir(directory, { recursive: true });
    const target = join(root, "outside.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, join(directory, "1.claim.json"));
    await assert.rejects(
      new WorkflowLeaseStore(root).acquire("session-symlink", "host-owner"),
      /Workflow lease path must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale takeover fences an already-validated old heartbeat and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-fence-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  let publishReached!: () => void;
  let resumePublish!: () => void;
  const reachedPublish = new Promise<void>((resolve) => { publishReached = resolve; });
  const publishResumed = new Promise<void>((resolve) => { resumePublish = resolve; });
  let pauseHeartbeat = true;
  const oldOwner = new WorkflowLeaseStore(root, 1_000, () => now, {
    async beforeHeartbeatPublish() {
      if (!pauseHeartbeat) return;
      pauseHeartbeat = false;
      publishReached();
      await publishResumed;
    },
  });
  const newOwner = new WorkflowLeaseStore(root, 1_000, () => now);
  try {
    await oldOwner.acquire("session-1", "host-old");
    const oldHeartbeat = oldOwner.heartbeat();
    await reachedPublish;

    now = new Date("2026-07-15T00:00:02.000Z");
    const replacement = await newOwner.acquire("session-1", "host-new");
    await oldOwner.release();
    resumePublish();

    await assert.rejects(oldHeartbeat, WorkflowLeaseBusyError);
    assert.equal(oldOwner.current(), undefined, "the fenced owner must not retain a held lease illusion");
    assert.equal((await newOwner.heartbeat()).token, replacement.token);
  } finally {
    resumePublish();
    await oldOwner.release();
    await newOwner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat publication failure clears ownership and blocks continuation and mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-heartbeat-failure-"));
  const snapshot = workflowSnapshot("running");
  const calls: string[][] = [];
  const store = new WorkflowLeaseStore(root, 1_000, () => new Date("2026-07-15T00:00:00.000Z"), {
    async beforeHeartbeatPublish() {
      throw new Error("injected heartbeat publication failure");
    },
  });
  const coordinator = new WorkflowCoordinator(
    fakeBridge(snapshot),
    fakeAdapter(calls),
    store,
  );
  try {
    await coordinator.attach("host-1");
    const marker = coordinator.continuationMarker(1);

    await assert.rejects(store.heartbeat(), /injected heartbeat publication failure/);
    assert.equal(store.current(), undefined);
    assert.equal(coordinator.acceptsContinuation(marker), false);
    assert.throws(() => coordinator.continuationMarker(2), /lease is not held/);
    await assert.rejects(coordinator.done("run-1"), /lease is not held/);
    assert.equal(calls.some(([operation]) => operation === "done"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("every coordinator mutation rejects a canonical Session switch after attach before fencing or CLI", async () => {
  const scenarios: Array<{
    name: string;
    status: "running" | "failed" | "completed";
    mutate: (coordinator: WorkflowCoordinator) => Promise<unknown>;
  }> = [
    { name: "next", status: "completed", mutate: (coordinator) => coordinator.next() },
    { name: "done", status: "running", mutate: (coordinator) => coordinator.done("run-1") },
    { name: "edit", status: "running", mutate: (coordinator) => coordinator.edit(["review"]) },
    { name: "fenceContinuation", status: "running", mutate: (coordinator) => coordinator.fenceContinuation() },
  ];

  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `pi-workflow-switch-${scenario.name}-`));
    const snapshot = workflowSnapshot(scenario.status);
    let refreshCount = 0;
    const bridge: WorkflowSnapshotProvider = {
      async refresh() {
        refreshCount++;
        if (refreshCount === 2) {
          snapshot.session!.sessionId = "session-2";
          snapshot.sessionGeneration = "canonical:valid:session-2:1";
          snapshot.canonicalClaim = { activeSessionId: "session-2", status: "valid" };
        }
        return snapshot;
      },
      getSnapshot() { return snapshot; },
    };
    const calls: string[][] = [];
    const store = new WorkflowLeaseStore(root);
    const coordinator = new WorkflowCoordinator(
      bridge,
      fakeAdapter(calls),
      store,
    );
    try {
      await coordinator.attach("host-1");
      const leaseBefore = store.current();
      await assert.rejects(
        scenario.mutate(coordinator),
        /lease belongs to session-1, but the active canonical Session is session-2/,
        scenario.name,
      );
      assert.equal(store.current()?.token, leaseBefore?.token, `${scenario.name} must not fence the old lease`);
      assert.equal(
        calls.some(([operation]) => ["next", "done", "edit"].includes(operation ?? "")),
        false,
        `${scenario.name} must not reach a mutating CLI call`,
      );
    } finally {
      await coordinator.release();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("coordinator mutation fails closed when the canonical Session disappears after attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-missing-session-"));
  const attachedSnapshot = workflowSnapshot("running");
  const missingSnapshot: WorkflowSnapshot = {
    ...attachedSnapshot,
    sessionGeneration: "none",
    canonicalClaim: undefined,
    session: undefined,
  };
  let refreshCount = 0;
  const bridge: WorkflowSnapshotProvider = {
    async refresh() { return ++refreshCount === 1 ? attachedSnapshot : missingSnapshot; },
    getSnapshot() { return refreshCount <= 1 ? attachedSnapshot : missingSnapshot; },
  };
  const calls: string[][] = [];
  const coordinator = new WorkflowCoordinator(
    bridge,
    fakeAdapter(calls),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("host-1");
    await assert.rejects(coordinator.done("run-1"), /No active canonical Workflow Session/);
    assert.equal(calls.some(([operation]) => operation === "done"), false);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("attach heartbeats its token and safely stops on Session switch and release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-heartbeat-"));
  const snapshot = workflowSnapshot("running");
  const store = new WorkflowLeaseStore(root, 1_000);
  const coordinator = new WorkflowCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    store,
    5,
  );
  const oldSessionObserver = new WorkflowLeaseStore(root, 1_000);
  try {
    const first = await coordinator.attach("host-1");
    await waitUntil(() => Date.parse(store.current()!.heartbeatAt) > Date.parse(first.lease.heartbeatAt));
    const oldMarker = coordinator.continuationMarker(1);

    snapshot.session!.sessionId = "session-2";
    snapshot.session!.activeRunId = "run-2";
    snapshot.session!.runs[0]!.runId = "run-2";
    snapshot.session!.chain[0]!.runId = "run-2";
    await coordinator.attach("host-2");
    assert.equal(coordinator.acceptsContinuation(oldMarker), false);
    const oldLease = await oldSessionObserver.acquire("session-1", "observer");
    assert.equal(oldLease.sessionId, "session-1", "switch must release the old Session lease");

    await coordinator.release();
    assert.equal(store.current(), undefined);
    await delay(20);
    assert.equal(store.current(), undefined, "released heartbeat must not reacquire or refresh a lease");
  } finally {
    await coordinator.release();
    await oldSessionObserver.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation rejects failed and blocked gates at issue and consume boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-gates-"));
  const snapshot = workflowSnapshot("running");
  const coordinator = new WorkflowCoordinator(
    fakeBridge(snapshot),
    fakeAdapter([]),
    new WorkflowLeaseStore(root),
  );
  try {
    await coordinator.attach("host-1");
    for (const status of ["failed", "blocked"] as const) {
      snapshot.session!.gates = [{ id: `session-${status}`, blocking: true, status }];
      assert.throws(() => coordinator.continuationMarker(1), /Blocking gate failure/);
      snapshot.session!.gates = [];
      snapshot.session!.runs[0]!.gates = [{ id: `run-${status}`, blocking: true, status }];
      assert.throws(() => coordinator.continuationMarker(1), /Blocking gate failure/);
      snapshot.session!.runs[0]!.gates = [];
    }
    const marker = coordinator.continuationMarker(2);
    snapshot.session!.runs[0]!.gates = [{ id: "late-block", blocking: true, status: "blocked" }];
    assert.equal(coordinator.acceptsContinuation(marker), false);
    snapshot.session!.runs[0]!.gates = [];
    const doneMarker = coordinator.continuationMarker(3);
    await coordinator.done("run-1", { verdict: "blocked" });
    assert.equal(coordinator.acceptsContinuation(doneMarker), false, "done must fence pending continuation");
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI adapter maps canonical check, next, done, and edit commands", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "run --help") {
      return result(args, "Commands:\n  prepare <step>\n  brief <run-id>\n  check <run-id>\n  next\n  complete <run-id>\n  edit [commands...]\n");
    }
    return result(args, "ok");
  });

  const capabilities = await adapter.capabilities();
  assert.deepEqual([...capabilities.commands], ["prepare", "brief", "check", "next", "complete", "edit"]);
  await adapter.check("run-1", "session-1");
  assert.deepEqual(calls.at(-1), [
    "run", "check", "run-1", "--session", "session-1", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.next("session-1", "step-2");
  assert.deepEqual(calls.at(-1), [
    "run", "next", "--session", "session-1", "--pick", "step-2", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.done("run-1", "session-1", {
    verdict: "done-with-concerns",
    notes: ["note"],
    decisions: ["decision"],
  });
  assert.deepEqual(calls.at(-1), [
    "run", "complete", "run-1", "--session", "session-1", "--verdict", "done-with-concerns",
    "--note", "note", "--decision", "decision", "--json", "--workflow-root", "D:/workspace",
  ]);
  await adapter.edit(["review"], { sessionId: "session-1", after: "latest", args: "--scope core" });
  assert.deepEqual(calls.at(-1), [
    "run", "edit", "review", "--session", "session-1", "--after", "latest",
    "--args", "--scope core", "--workflow-root", "D:/workspace",
  ]);
});

test("run-control forwards canonical lifecycle inputs without legacy action aliases", async () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const command = result([], "ok");
  const transition = { command, snapshot: workflowSnapshot("running") };
  const coordinator = {
    async check(runId?: string) { calls.push(["check", runId]); return command; },
    async next(pick?: string) { calls.push(["next", pick]); return transition; },
    async done(runId: string, options: RunDoneOptions) { calls.push(["done", runId, options]); return transition; },
    async edit(commands: readonly string[], options: Omit<RunEditOptions, "sessionId">) {
      calls.push(["edit", commands, options]);
      return transition;
    },
  } as unknown as WorkflowCoordinator;

  assert.equal((await executeRunControl({ action: "check", runId: "run-1" }, coordinator)).ok, true);
  assert.equal((await executeRunControl({ action: "next", pick: "step-2" }, coordinator)).ok, true);
  assert.equal((await executeRunControl({
    action: "done",
    runId: "run-1",
    verdict: "done-with-concerns",
    notes: ["note"],
  }, coordinator)).ok, true);
  assert.equal((await executeRunControl({
    action: "edit",
    commands: ["review"],
    after: "latest",
    args: "--scope core",
  }, coordinator)).ok, true);

  assert.deepEqual(calls, [
    ["check", "run-1"],
    ["next", "step-2"],
    ["done", "run-1", {
      verdict: "done-with-concerns",
      summary: undefined,
      reason: undefined,
      notes: ["note"],
      decisions: undefined,
      evidence: undefined,
      artifacts: undefined,
    }],
    ["edit", ["review"], {
      after: "latest",
      replace: undefined,
      remove: undefined,
      args: "--scope core",
      stage: undefined,
      goalRef: undefined,
      insertedBy: undefined,
    }],
  ]);
});

test("default CLI runner times out and terminates a hung process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-timeout-"));
  try {
    const execution = await defaultRunner(
      ["-e", "setInterval(() => undefined, 1000)"],
      root,
      { executable: process.execPath, timeoutMs: 50, maxOutputBytes: 1024 },
    );
    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /timed out after 50ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner bounds UTF-8 output by bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-output-"));
  try {
    const execution = await defaultRunner(
      ["-e", "process.stdout.write('界'.repeat(4096)); setInterval(() => undefined, 1000)"],
      root,
      { executable: process.execPath, timeoutMs: 5_000, maxOutputBytes: 128 },
    );
    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /output exceeded 128 bytes/);
    assert.ok(Buffer.byteLength(execution.stdout, "utf8") <= 128);
    assert.ok(Buffer.byteLength(execution.stderr, "utf8") <= 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner settles once and removes listeners when error races close", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.emit("error", new Error("spawn failed"));
      child.emit("close", 1);
    });
    return child;
  };
  let settlements = 0;
  const execution = await defaultRunner([], process.cwd(), { spawnProcess: spawnProcess as never }).then((result) => {
    settlements++;
    return result;
  });
  await delay(10);

  assert.equal(execution.exitCode, 1);
  assert.match(execution.stderr, /spawn failed/);
  assert.equal(settlements, 1);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

function fakeBridge(snapshot: WorkflowSnapshot): WorkflowSnapshotProvider {
  return {
    async refresh() { return snapshot; },
    getSnapshot() { return snapshot; },
  };
}

function fakeAdapter(
  calls: string[][],
  hooks: {
    onNext?: (sessionId: string, pick?: string) => void;
    onDone?: (runId: string, sessionId: string, options: RunDoneOptions) => void;
    onEdit?: (commands: readonly string[], options: RunEditOptions) => void;
  } = {},
): WorkflowRunAdapter {
  return {
    async prepare(step) { calls.push(["prepare", step]); return result([], `prepare ${step}`); },
    async brief(runId, sessionId) { calls.push(["brief", runId, sessionId ?? ""]); return result([], `brief ${runId}`); },
    async check(runId, sessionId) { calls.push(["check", runId, sessionId ?? ""]); return result([], `check ${runId}`); },
    async next(sessionId, pick) {
      calls.push(["next", sessionId, pick ?? ""]);
      hooks.onNext?.(sessionId, pick);
      return result([], `next ${sessionId}`);
    },
    async done(runId, sessionId, options = {}) {
      calls.push(["done", runId, sessionId, options.verdict ?? "done"]);
      hooks.onDone?.(runId, sessionId, options);
      return result([], `done ${runId}`);
    },
    async edit(commands, options) {
      calls.push(["edit", ...commands, options.sessionId]);
      hooks.onEdit?.(commands, options);
      return result([], `edit ${commands.join(" ")}`);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await delay(5);
  }
}

function workflowSnapshot(status: "running" | "failed" | "completed"): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "fingerprint" },
    diagnostics: [],
    session: {
      sessionId: "session-1",
      intent: "Complete integration",
      status: "running",
      revision: 1,
      activeRunId: "run-1",
      definitionOfDone: "done",
      gates: [],
      chain: [{ step: "execute", command: "execute", status, runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status,
        goal: "execute",
        args: ["--scope", "core"],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function result(args: readonly string[], stdout: string): RunCliResult {
  return { argv: [...args], stdout, stderr: "", exitCode: 0 };
}
