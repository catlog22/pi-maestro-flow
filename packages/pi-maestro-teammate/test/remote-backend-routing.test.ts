import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type {
  RemoteDriverId,
  RemoteInputMode,
  RemoteRunCancelResult,
  RemoteRunInputResult,
  RemoteStartedRun,
  RemoteWorkerManagerLike,
  RemoteWorkerStartRequest,
} from "pi-maestro-backends/remote";
import { runSingleTeammate } from "../src/runs/execution.ts";
import {
  backendRegistryConfigSync,
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
} from "../src/backends/registry-host.ts";
import { createRemoteManagerPort, remoteMonitorEventSink } from "../src/backends/remote-workers.ts";
import type {
  RemoteDriverEvent,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteStatus,
  RemoteTerminalStatus,
} from "../src/remote/types.ts";
import type { RemoteWorkerManager } from "../src/remote/worker-manager.ts";

/**
 * A remote location is a backend selector, end to end.
 *
 * The task travels the ordinary dispatch path: the workspace document puts the
 * host in registry mode, `remote:beta` is an ordinary registration, and the run
 * settles into an outcome folded from the events the manager published. Only the
 * manager itself is a fake — it is the one part that would otherwise need a real
 * SSH connection and a real daemon.
 */

const CAPTURE: RemoteRunCapture = {
  workerId: "w-1",
  instanceNonce: "n-1",
  runId: "run-1",
  generation: 1,
  monitorOwnerNonce: "mon-1",
  targetId: "beta",
};

/** Payload of one event, without the envelope fields the fake fills in. */
type EventSeed =
  | { type: "run/state"; status: RemoteStatus }
  | { type: "run/event"; event: RemoteDriverEvent }
  | { type: "run/result"; status: RemoteTerminalStatus; result?: string; error?: string };

/** A manager that answers from a script instead of a remote host. */
class FakeRemoteManager implements RemoteWorkerManagerLike {
  readonly monitorOwnerNonce = CAPTURE.monitorOwnerNonce;
  readonly starts: RemoteWorkerStartRequest[] = [];
  readonly sends: { mode: RemoteInputMode; message: string }[] = [];
  /** Delivered to the backend's subscriber when the run settles. */
  feed: readonly EventSeed[] = [];
  settleStatus: RemoteRunSnapshot["status"] = "completed";
  #listener: ((event: RemoteRunEvent) => void) | undefined;

  constructor(private readonly driver: RemoteDriverId = "pi-rpc") {}

  resolveTargetDriver(): RemoteDriverId {
    return this.driver;
  }

  async start(
    request: RemoteWorkerStartRequest,
    onEvent: (event: RemoteRunEvent) => void,
  ): Promise<RemoteStartedRun> {
    this.starts.push(request);
    this.#listener = onEvent;
    return {
      capture: CAPTURE,
      unsubscribe: () => {
        this.#listener = undefined;
      },
    };
  }

  send(_capture: RemoteRunCapture, mode: RemoteInputMode, message: string): Promise<RemoteRunInputResult> {
    this.sends.push({ mode, message });
    return Promise.resolve({ accepted: true, effectiveMode: mode, receipt: "queued" });
  }

  cancel(): Promise<RemoteRunCancelResult> {
    return Promise.resolve({ accepted: true, status: "cancelled" });
  }

  /**
   * Publish the scripted stream, then settle.
   *
   * Deferred to a later tick, which is the ordinary case: a run whose events
   * arrive while it is running rather than all at once during admission. The
   * admission-time ordering is a real manager's job to reproduce, and the test
   * that covers it drives one.
   *
   * @returns the terminal snapshot.
   */
  async wait(): Promise<RemoteRunSnapshot> {
    await new Promise((resolve) => setImmediate(resolve));
    for (const [index, seed] of this.feed.entries()) {
      this.#listener?.({
        workerId: CAPTURE.workerId,
        instanceNonce: CAPTURE.instanceNonce,
        runId: CAPTURE.runId,
        generation: CAPTURE.generation,
        sequence: index + 1,
        updatedAt: 1_000 + index,
        ...seed,
      } as RemoteRunEvent);
    }
    return this.snapshot();
  }

  snapshot(): RemoteRunSnapshot {
    return {
      workerId: CAPTURE.workerId,
      instanceNonce: CAPTURE.instanceNonce,
      runId: CAPTURE.runId,
      generation: CAPTURE.generation,
      targetId: CAPTURE.targetId,
      status: this.settleStatus,
      lastSequence: this.feed.length,
      updatedAt: 2_000,
    };
  }
}

/**
 * A workspace whose `remote:beta` registration routes to the remote backend.
 *
 * @param options - execution mode and the target's declared driver.
 * @returns the canonical workspace root.
 */
function workspace(options: {
  mode?: "legacy" | "backend-registry";
  driver?: RemoteDriverId;
} = {}): string {
  // Canonical, because the dispatch canonicalizes the base and a symlinked
  // /var → /private/var on macOS would otherwise make every path comparison
  // below compare two spellings of the same directory.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-routing-")));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", "prober.md"),
    "---\nname: prober\ndescription: \"remote routing probe\"\ntools:\n  - Read\n---\n\n# Prober\n",
    "utf-8",
  );
  writeFileSync(
    join(root, ".pi", "teammate-backends.json"),
    `${JSON.stringify({
      mode: options.mode ?? "backend-registry",
      default: "pi-subprocess",
      backends: {
        "remote:beta": {
          module: "remote-workers",
          config: { targetId: "beta", driver: options.driver ?? "pi-rpc" },
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  forgetBackendRegistryConfigSync(root);
  return root;
}

test("a task located at remote beta resolves the remote registration and settles a real attempt outcome", async () => {
  const root = workspace();
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "start" } } },
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "b", toolName: "grep", phase: "start" } } },
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "end" } } },
    { type: "run/result", status: "completed", result: "the deploy is clean" },
  ];

  const result = await runSingleTeammate(
    { agent: "prober", task: "audit the deploy", cwd: "remote:beta" },
    { baseCwd: root, remoteManagerOf: () => manager },
  );

  assert.equal(manager.starts.length, 1, "the remote registration never started a run");
  assert.equal(manager.starts[0]?.targetId, "beta");
  // Only `remote:beta` maps to this module, so naming it proves the registry
  // resolved the registration rather than falling through to the default.
  assert.equal(result.backend, "remote-workers");
  assert.equal(result.terminalStatus, "completed");
  // Folded from the paired tool events, not a constant: two starts, one end.
  assert.equal(result.toolCount, 1);
  assert.equal(result.messages[0]?.content, "the deploy is clean");
});

test("a monitor event reaches both the session recorder and the backend subscriber", async () => {
  // The real manager's shape, not the port's: `createRemoteManagerPort` adapts
  // one into the other, so handing it a port-shaped fake would have it read a
  // `{ capture, unsubscribe }` pair where a capture belongs.
  const manager = {
    monitorOwnerNonce: CAPTURE.monitorOwnerNonce,
    start: async () => CAPTURE,
  } as unknown as RemoteWorkerManager;
  const binding = createRemoteManagerPort(manager);
  const recorded: [RemoteRunCapture, RemoteRunEvent][] = [];
  const delivered: RemoteRunEvent[] = [];
  const onEvent = remoteMonitorEventSink(
    (capture, event) => binding.publish(capture, event),
    (capture, event) => recorded.push([capture, event]),
  );
  await binding.port.start(
    { targetId: "beta", name: "prober", objective: "audit" },
    (event) => delivered.push(event),
  );

  const event: RemoteRunEvent = {
    workerId: CAPTURE.workerId,
    instanceNonce: CAPTURE.instanceNonce,
    runId: CAPTURE.runId,
    generation: CAPTURE.generation,
    sequence: 1,
    updatedAt: 1_000,
    type: "run/state",
    status: "running",
  };
  onEvent(CAPTURE, event);

  assert.equal(delivered.length, 1, "the backend subscriber never saw the event");
  assert.equal(recorded.length, 1, "the Monitor session recorder never saw the event");

  // A superseded Monitor term reuses run ids, so the fence has to be the whole
  // capture. Without this half, a `publish` that delivered to every subscriber
  // unconditionally would pass the assertions above.
  onEvent({ ...CAPTURE, generation: CAPTURE.generation + 1 }, { ...event, generation: CAPTURE.generation + 1 });

  assert.equal(delivered.length, 1, "a stale capture reached the backend subscriber");
  assert.equal(recorded.length, 2, "the recorder stopped seeing events it must still record");
});

test("the host port forwards send cancel and snapshot to the manager verbatim", async () => {
  // The real manager's shape again: these three port members are pure
  // delegation, so a fake that records its arguments is the only way to see
  // whether anything was added, dropped, or answered locally.
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const sendResult: RemoteRunInputResult = { accepted: true, effectiveMode: "steer", receipt: "injected" };
  const cancelResult: RemoteRunCancelResult = { accepted: false, status: "running" };
  const snapshotResult: RemoteRunSnapshot = {
    workerId: CAPTURE.workerId,
    instanceNonce: CAPTURE.instanceNonce,
    runId: CAPTURE.runId,
    generation: CAPTURE.generation,
    targetId: CAPTURE.targetId,
    status: "waiting",
    lastSequence: 7,
    updatedAt: 3_000,
  };
  const manager = {
    monitorOwnerNonce: CAPTURE.monitorOwnerNonce,
    send: (...args: readonly unknown[]) => {
      calls.push({ method: "send", args });
      return Promise.resolve(sendResult);
    },
    cancel: (...args: readonly unknown[]) => {
      calls.push({ method: "cancel", args });
      return Promise.resolve(cancelResult);
    },
    snapshot: (...args: readonly unknown[]) => {
      calls.push({ method: "snapshot", args });
      return snapshotResult;
    },
  } as unknown as RemoteWorkerManager;
  const { port } = createRemoteManagerPort(manager);

  // Identity, not deep equality: the backend folds the object the manager
  // returned, so an adapter that rebuilt one would be answering for it.
  assert.equal(await port.send(CAPTURE, "steer", "change course", "cmd-1"), sendResult);
  assert.equal(await port.cancel(CAPTURE, "host abort", "cmd-2"), cancelResult);
  assert.equal(port.snapshot(CAPTURE), snapshotResult);

  assert.deepEqual(calls, [
    { method: "send", args: [CAPTURE, "steer", "change course", "cmd-1"] },
    { method: "cancel", args: [CAPTURE, "host abort", "cmd-2"] },
    { method: "snapshot", args: [CAPTURE] },
  ]);
});

test("a start that the manager rejects unsubscribes before rethrowing", async () => {
  const failure = new Error("the remote host refused the connection");
  let started = 0;
  const manager = {
    monitorOwnerNonce: CAPTURE.monitorOwnerNonce,
    start: () => {
      started += 1;
      return started === 1 ? Promise.resolve(CAPTURE) : Promise.reject(failure);
    },
  } as unknown as RemoteWorkerManager;
  const binding = createRemoteManagerPort(manager);
  const live: RemoteRunEvent[] = [];
  const refused: RemoteRunEvent[] = [];

  await binding.port.start(
    { targetId: "beta", name: "prober", objective: "audit" },
    (event) => live.push(event),
  );
  await assert.rejects(
    () => binding.port.start(
      { targetId: "beta", name: "prober", objective: "audit again" },
      (event) => refused.push(event),
    ),
    (error: unknown) => {
      // The manager's own error object, not a wrapper: the host reports this
      // text, and rethrowing a new one would lose what the manager said.
      assert.equal(error, failure);
      return true;
    },
  );

  binding.publish(CAPTURE, {
    workerId: CAPTURE.workerId,
    instanceNonce: CAPTURE.instanceNonce,
    runId: CAPTURE.runId,
    generation: CAPTURE.generation,
    sequence: 1,
    updatedAt: 1_000,
    type: "run/state",
    status: "running",
  });

  // The refused run gets nothing, and the run that did start still gets
  // everything: the cleanup on the failure path removes its own subscription
  // and leaves the pump intact for the subscribers it shares the binding with.
  assert.deepEqual(refused, [], "a run the manager refused still receives events");
  assert.equal(live.length, 1, "the surviving subscriber stopped receiving events");
});

test("the remote location becomes the backend selector and clears the spec cwd", async () => {
  const root = workspace();
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [{ type: "run/result", status: "completed", result: "done" }];
  const seen: { spec: TeammateRunSpec; requested: string | undefined }[] = [];
  const inner = dispatchRegistrySync(root, () => {
    throw new Error("this test never starts a Pi child");
  }, () => manager)!;
  const registry: BackendRegistry = {
    ...inner,
    listBackendNames: () => inner.listBackendNames(),
    defaultBackendName: () => inner.defaultBackendName(),
    capabilitiesOf: (name) => inner.capabilitiesOf(name),
    resolve: async (spec, requestedBackend) => {
      seen.push({ spec, requested: requestedBackend });
      return await inner.resolve(spec, requestedBackend);
    },
  };

  await runSingleTeammate(
    { agent: "prober", task: "audit the deploy", cwd: "remote:beta" },
    { baseCwd: root, backendRegistry: registry, remoteManagerOf: () => manager },
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.spec.backend, "remote:beta");
  assert.equal(seen[0]?.requested, "remote:beta");
  // The literal location never becomes a directory: resolving it against the
  // base would have produced `<root>/remote:beta`, a local path for a task that
  // named another machine.
  assert.equal(seen[0]?.spec.cwd, undefined);
});

test("a remote task under legacy execution mode is refused instead of running locally", async () => {
  const root = workspace({ mode: "legacy" });
  const manager = new FakeRemoteManager("pi-rpc");
  assert.equal(backendRegistryConfigSync(root).mode, "legacy");

  const result = await runSingleTeammate(
    { agent: "prober", task: "audit the deploy", cwd: "remote:beta" },
    { baseCwd: root, remoteManagerOf: () => manager },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.terminalStatus, "failed");
  assert.match(result.messages[0]?.content ?? "", /refusing to run a remote task on this machine/);
  assert.match(result.messages[0]?.content ?? "", /remote:beta/);
  assert.equal(manager.starts.length, 0, "a legacy-mode remote task still reached the manager");
});

test("an acp remote target refuses a steering task before any process starts", async () => {
  const root = workspace({ driver: "acp" });
  const manager = new FakeRemoteManager("acp");
  const registry = dispatchRegistrySync(root, () => {
    throw new Error("this test never starts a Pi child");
  }, () => manager)!;

  // Decided from the registration's own config, with no run in existence: the
  // verdict costs no process and no model turn.
  const capabilities = await registry.capabilitiesOf("remote:beta");
  assert.equal(capabilities.steer, "unsupported");
  assert.equal(manager.starts.length, 0, "reading the capability table started a run");

  // And the declaration is what the backend does: a steering message is refused
  // outright rather than delivered late under its own name.
  const { backend, config } = await registry.resolve({ agent: "prober", task: "audit", backend: "remote:beta" }, "remote:beta");
  const run = await backend.start(
    { agent: "prober", task: "audit the deploy" },
    { correlationId: "corr-1", baseCwd: root, host: {}, config },
  );
  assert.equal(run.send("change course", "steer"), false);
  assert.deepEqual(manager.sends, [], "a refused steer still reached the wire");
  await run.outcome;
});

test("a backend written capability delivery survives the host emulation record", async () => {
  const root = workspace({ driver: "acp" });
  const manager = new FakeRemoteManager("acp");
  manager.feed = [{ type: "run/result", status: "completed", result: '{"ok": true}' }];

  const result = await runSingleTeammate(
    {
      agent: "prober",
      task: "audit the deploy",
      cwd: "remote:beta",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
    { baseCwd: root, remoteManagerOf: () => manager },
  );

  const deliveries = result.capabilityDeliveries ?? [];
  // The backend's own record of how it served the schema.
  assert.ok(
    deliveries.some((delivery) => /no structured-output wire contract/.test(delivery.note ?? "")),
    "the backend's own emulation record was overwritten by the host's",
  );
  // The host's record of the same adjudication, appended rather than assigned.
  assert.ok(
    deliveries.some((delivery) => /served by host-side compensation/.test(delivery.note ?? "")),
    "the host never recorded its emulation verdict",
  );
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("the root dispatch hands the run its remote Monitor wiring", () => {
  // Every case above supplies `remoteManagerOf` itself, and the option is
  // optional, so deleting the one production injection leaves the compiler and
  // this file green while every remote dispatch fails. The injection sits inside
  // a closure no test can reach, so it is guarded as source text — the same
  // reason backend-selector-plumbing.test.ts guards the projection that way.
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  assert.match(
    source,
    /remoteManagerOf: \(\) => ensureRemoteMonitorBinding\(\)/,
    "the root dispatch no longer passes remoteManagerOf, so a remote registration refuses every task by naming a missing Monitor term while the host is in Monitor mode",
  );
});
