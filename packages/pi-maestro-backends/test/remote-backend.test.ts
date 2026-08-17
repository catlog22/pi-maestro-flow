import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRunOptions, ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { createRemoteBackend } from "../src/remote/backend.ts";
import type {
  RemoteDriverEvent,
  RemoteDriverId,
  RemoteInputMode,
  RemoteRunCancelResult,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunInputResult,
  RemoteRunSnapshot,
  RemoteTerminalStatus,
  RemoteWorkerManagerLike,
  RemoteWorkerStartRequest,
} from "../src/remote/types.ts";

const CAPTURE: RemoteRunCapture = {
  workerId: "w-1",
  instanceNonce: "n-1",
  runId: "run-1",
  generation: 1,
  monitorOwnerNonce: "mon-1",
  targetId: "beta",
};

/** One event without the envelope fields the fake fills in. */
type EventSeed =
  | { type: "run/event"; event: RemoteDriverEvent }
  | { type: "run/result"; status: RemoteTerminalStatus; result?: string };

/** One recorded `send` call, as the manager received it. */
interface SendCall {
  mode: RemoteInputMode;
  message: string;
}

/**
 * A manager whose every answer the test programs.
 *
 * Real enough to exercise the backend's own decisions — the driver-consistency
 * gate, the steer refusal, the prompt normalization, the receipt path — while
 * starting no process and opening no connection.
 */
class FakeRemoteManager implements RemoteWorkerManagerLike {
  readonly monitorOwnerNonce = CAPTURE.monitorOwnerNonce;
  readonly starts: RemoteWorkerStartRequest[] = [];
  readonly sends: SendCall[] = [];
  readonly cancels: string[] = [];
  /** Events delivered to the backend's subscriber once it subscribes. */
  feed: readonly EventSeed[] = [];
  settleStatus: RemoteRunSnapshot["status"] = "completed";
  sendResult: RemoteRunInputResult | Error = { accepted: true, effectiveMode: "follow_up", receipt: "queued" };
  #listener: ((event: RemoteRunEvent) => void) | undefined;
  #settle: ((snapshot: RemoteRunSnapshot) => void) | undefined;

  constructor(private readonly driver: RemoteDriverId) {}

  resolveTargetDriver(): RemoteDriverId {
    return this.driver;
  }

  start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture> {
    this.starts.push(request);
    return Promise.resolve(CAPTURE);
  }

  subscribe(_capture: RemoteRunCapture, listener: (event: RemoteRunEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  send(_capture: RemoteRunCapture, mode: RemoteInputMode, message: string): Promise<RemoteRunInputResult> {
    this.sends.push({ mode, message });
    return this.sendResult instanceof Error
      ? Promise.reject(this.sendResult)
      : Promise.resolve(this.sendResult);
  }

  cancel(_capture: RemoteRunCapture, reason?: string): Promise<RemoteRunCancelResult> {
    this.cancels.push(reason ?? "");
    return Promise.resolve({ accepted: true, status: "cancelled" });
  }

  /**
   * Stay pending until the test settles the run, the way a real wait does.
   *
   * A wait that resolved immediately would close the run's input window before
   * the caller of `start` ever got its `BackendRun`, so every `send` assertion
   * would read a refusal that no product rule produced.
   */
  wait(): Promise<RemoteRunSnapshot> {
    return new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  /** Deliver the programmed stream, then let `wait` settle. */
  settle(): void {
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
    this.#settle?.(this.snapshot());
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

const SPEC: TeammateRunSpec = { agent: "prober", task: "audit the deploy" };

/**
 * Build the run options a backend receives.
 *
 * @param config - the registration's resolved config.
 * @param onProgress - progress sink, when the test reads it.
 * @returns the options.
 */
function optionsOf(
  config: Record<string, ConfigValue>,
  onProgress?: (data: Record<string, unknown>) => void,
): BackendRunOptions {
  return {
    correlationId: "corr-1",
    baseCwd: process.cwd(),
    host: {},
    config,
    ...(onProgress === undefined ? {} : { onProgress }),
  };
}

test("a registration whose declared driver disagrees with the resolved target refuses to start", async () => {
  const backend = createRemoteBackend(() => new FakeRemoteManager("acp"));

  await assert.rejects(
    () => backend.start(SPEC, optionsOf({ targetId: "beta", driver: "pi-rpc" })),
    (error: Error) => {
      // Both values, so an operator can see which side to change rather than
      // only that the two disagree.
      assert.match(error.message, /declares driver "pi-rpc"/);
      assert.match(error.message, /resolves that target to driver "acp"/);
      return true;
    },
  );
});

test("an acp target refuses steer without touching the wire", async () => {
  const manager = new FakeRemoteManager("acp");
  manager.feed = [{ type: "run/result", status: "completed", result: "done" }];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(SPEC, optionsOf({ targetId: "beta", driver: "acp" }));

  assert.equal(run.send("interrupt now", "steer"), false);
  assert.deepEqual(manager.sends, [], "a refused steer still reached the manager");
  manager.settle();
  await run.outcome;
});

test("a prompt-mode message is delivered as follow_up and recorded as an emulated followUp", async () => {
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [{ type: "run/result", status: "completed", result: "done" }];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(SPEC, optionsOf({ targetId: "beta", driver: "pi-rpc" }));

  assert.equal(run.send("also check the logs", "prompt"), true);
  manager.settle();
  const outcome = await run.outcome;

  assert.deepEqual(manager.sends, [{ mode: "follow_up", message: "also check the logs" }]);
  const normalization = (outcome.result.capabilityDeliveries ?? [])
    .filter((delivery) => delivery.capability === "followUp");
  assert.equal(normalization.length, 1, "the normalization was recorded other than exactly once");
  assert.equal(normalization[0]?.support, "emulated");

  // A run that never normalized anything must not carry the note; otherwise the
  // record says nothing about this run.
  const quiet = new FakeRemoteManager("pi-rpc");
  quiet.feed = [{ type: "run/result", status: "completed", result: "done" }];
  const quietRun = await createRemoteBackend(() => quiet)
    .start(SPEC, optionsOf({ targetId: "beta", driver: "pi-rpc" }));
  assert.equal(quietRun.send("more context", "follow_up"), true);
  quiet.settle();
  const quietOutcome = await quietRun.outcome;
  assert.deepEqual(
    (quietOutcome.result.capabilityDeliveries ?? []).filter((d) => d.capability === "followUp"),
    [],
  );
});

test("a send receipt reaches the host through progress rather than the return value", async () => {
  const progress: Record<string, unknown>[] = [];
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [{ type: "run/result", status: "completed", result: "done" }];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(
    SPEC,
    optionsOf({ targetId: "beta", driver: "pi-rpc" }, (data) => progress.push(data)),
  );

  assert.equal(run.send("first", "follow_up"), true);
  manager.settle();
  await run.outcome;
  // The delivery is asynchronous, so the receipt lands after the caller already
  // read `true`; that is the whole reason it travels on progress.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    progress.some((entry) => String(entry.lastMessage).includes("queued")),
    "the queued receipt never reached the host",
  );

  const failing = new FakeRemoteManager("pi-rpc");
  failing.feed = [{ type: "run/result", status: "completed", result: "done" }];
  failing.sendResult = new Error("the channel closed");
  const failures: Record<string, unknown>[] = [];
  const failingRun = await createRemoteBackend(() => failing).start(
    SPEC,
    optionsOf({ targetId: "beta", driver: "pi-rpc" }, (data) => failures.push(data)),
  );
  assert.equal(failingRun.send("second", "follow_up"), true);
  failing.settle();
  await failingRun.outcome;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    failures.some((entry) => String(entry.lastMessage).includes("remote input failed")),
    "a rejected delivery was swallowed",
  );
});

test("an acp remote run folds its usage events into the settled result", async () => {
  const manager = new FakeRemoteManager("acp");
  manager.feed = [
    { type: "run/event", event: { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: "run/event", event: { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } } },
    { type: "run/result", status: "completed", result: "done" },
  ];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(SPEC, optionsOf({ targetId: "beta", driver: "acp" }));
  manager.settle();
  const outcome = await run.outcome;

  // Usage is a run-level fact rather than a capability: an ACP target declares
  // no usage support anywhere, and its numbers still arrive and still count.
  assert.equal(outcome.result.usage?.inputTokens, 13);
  assert.equal(outcome.result.usage?.outputTokens, 7);
});

test("the capability table is decided by the configured driver alone", () => {
  const backend = createRemoteBackend(() => new FakeRemoteManager("pi-rpc"));

  const acp = backend.capabilities({ driver: "acp", targetId: "t" });
  assert.equal(acp.steer, "unsupported");
  assert.equal(acp.outputSchema, "emulated");

  const piRpc = backend.capabilities({ driver: "pi-rpc", targetId: "t" });
  assert.equal(piRpc.steer, "native");
  assert.equal(piRpc.outputSchema, "native");
});

test("a remote run reports the tool counts its event stream paired", async () => {
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "start" } } },
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "b", toolName: "grep", phase: "start" } } },
    { type: "run/event", event: { type: "tool", tool: { toolCallId: "a", toolName: "read", phase: "end" } } },
    { type: "run/result", status: "completed", result: "done" },
  ];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(SPEC, optionsOf({ targetId: "beta", driver: "pi-rpc" }));
  manager.settle();
  const outcome = await run.outcome;

  assert.equal(outcome.recovery.completedToolCount, 1);
  assert.equal(outcome.recovery.inFlightToolCount, 1);
  assert.equal(outcome.result.terminalStatus, "completed");
});

test("a run whose stream ended without a result is not reported as reclaimed", async () => {
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [{ type: "run/event", event: { type: "text", text: "partial" } }];
  manager.settleStatus = "lost";
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(SPEC, optionsOf({ targetId: "beta", driver: "pi-rpc" }));
  manager.settle();
  const outcome = await run.outcome;

  assert.equal(outcome.result.terminalStatus, "failed");
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
});

test("the backend names the run it started and forwards every event to the host", async () => {
  const seen: Record<string, unknown>[] = [];
  const manager = new FakeRemoteManager("pi-rpc");
  manager.feed = [
    { type: "run/event", event: { type: "text", text: "working" } },
    { type: "run/result", status: "completed", result: "done" },
  ];
  const backend = createRemoteBackend(() => manager);
  const run = await backend.start(
    { ...SPEC, name: "auditor" },
    { ...optionsOf({ targetId: "beta", driver: "pi-rpc" }), onChildEvent: (event) => seen.push(event) },
  );
  manager.settle();
  const outcome: { result: SingleResult } = await run.outcome;

  assert.equal(manager.starts[0]?.targetId, "beta");
  assert.equal(manager.starts[0]?.name, "auditor");
  assert.equal(manager.starts[0]?.objective, SPEC.task);
  assert.equal(seen.length, 2, "the raw event stream did not reach the host verbatim");
  assert.equal(outcome.result.messages[0]?.content, "done");
});
