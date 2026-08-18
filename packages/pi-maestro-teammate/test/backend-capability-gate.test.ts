import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCapabilities, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import type { NormalizedTask } from "../src/runs/execution-infra.ts";
import { runGraph, runSingleTeammate } from "../src/runs/execution.ts";

/**
 * Capability adjudication on the single-dispatch and graph paths.
 *
 * `runGraph` has always rejected a task whose backend cannot serve a required
 * capability, but five production call sites dispatch a single teammate
 * directly and skipped that check: a task carrying todos ran on a backend
 * without a queue binding, the field was dropped in silence, and the run
 * settled as a clean success that had simply never touched the queue.
 *
 * The gate must fire on the requirement, not on the backend, so the cases
 * below drive both directions — a backend that cannot serve is rejected, and
 * the same backend serving a task that asks for nothing is not.
 *
 * The graph cases drive the same gate through a registry, because the graph
 * reads its capability table from `registry.resolve` rather than from a
 * backend handed to it: a graph adjudicated against the wrong table, or one
 * that never consulted the registry at all, would gate on stale capabilities.
 */

const ALL_NATIVE: BackendCapabilities = {
  outputSchema: "native", forkContext: "native", modelSelection: "native",
  thinkingLevel: "native", todoBinding: "native", toolFilter: "native",
  steer: "native", followUp: "native", abort: "native",
};

/** A backend that records being started instead of running anything. */
function probeBackend(
  todoBinding: BackendCapabilities["todoBinding"],
  started: string[],
): TeammateBackend {
  return {
    name: "capability-probe",
    protocolVersion: 1,
    capabilities: () => ({ ...ALL_NATIVE, todoBinding }),
    recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, runOptions) {
      started.push(spec.task);
      const result: SingleResult = {
        agent: spec.agent,
        task: spec.task,
        exitCode: 0,
        messages: [{ role: "assistant", content: "done" }],
        usage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheWriteTokens: 0, cost: 0, turns: 1,
        },
        model: spec.model ?? "",
        correlationId: runOptions.correlationId,
        durationMs: 1,
        terminalStatus: "completed",
      };
      return {
        outcome: Promise.resolve({
          result,
          recovery: {
            settlementAuthority: "authoritative" as const,
            completedToolCount: 0,
            inFlightToolCount: 0,
            preActivityInfrastructureExit: false,
            externalReplayRisk: false,
          },
          reclamation: Promise.resolve({ status: "reclaimed" as const }),
        }),
        send: () => false,
        abort: () => undefined,
      };
    },
  };
}

function registryOf(backend: TeammateBackend): BackendRegistry {
  return {
    resolve: async () => ({ backend, config: {}, capabilities: backend.capabilities({}) }),
    capabilitiesOf: async () => backend.capabilities({}),
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
  };
}

/** What one task looked like when the graph asked the registry to resolve it. */
interface ResolveRequest {
  task: string;
  selector: string | undefined;
}

/** `registryOf`, plus a record of every resolve request it served. */
function recordingRegistryOf(backend: TeammateBackend, requests: ResolveRequest[]): BackendRegistry {
  return {
    ...registryOf(backend),
    resolve: async (spec, requestedBackend) => {
      requests.push({ task: spec.task, selector: requestedBackend });
      return { backend, config: {}, capabilities: backend.capabilities({}) };
    },
  };
}

/** Dispatch one task and report what the backend saw. */
async function dispatch(
  todoBinding: BackendCapabilities["todoBinding"],
  todos: string[] | undefined,
): Promise<{ result: SingleResult; started: string[] }> {
  const started: string[] = [];
  const result = await runSingleTeammate(
    { agent: "general", task: "work the queue", ...(todos === undefined ? {} : { todos }) },
    { baseCwd: process.cwd(), backendRegistry: registryOf(probeBackend(todoBinding, started)) },
  );
  return { result, started };
}

test("a single dispatch needing todos is rejected by a backend that cannot bind them", async () => {
  const { result, started } = await dispatch("unsupported", ["#12"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.terminalStatus, "failed");
  // Rejected before dispatch, which is the whole point: adjudicating after the
  // run would have burned a model turn to learn what the capability table said
  // up front.
  assert.deepEqual(started, [], "the backend was started despite serving no queue binding");
  assert.match(result.messages[0]?.content ?? "", /todoBinding/);
  assert.match(result.messages[0]?.content ?? "", /capability-probe/);
});

test("a single dispatch needing todos runs on a backend that binds them", async () => {
  const { result, started } = await dispatch("native", ["#12"]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(started, ["work the queue"], "a capable backend was gated anyway");
});

test("a single dispatch asking for no todos runs on a backend that cannot bind them", async () => {
  const { result, started } = await dispatch("unsupported", undefined);

  // The requirement comes from the task, not from the backend's inventory: a
  // gate keyed on the capability table alone would ground every task here.
  assert.equal(result.exitCode, 0);
  assert.deepEqual(started, ["work the queue"], "a task requiring nothing was gated");
});

const queueTask: NormalizedTask = {
  agent: "general",
  name: "queue-worker",
  prompt: "work the queue",
  todos: ["#12"],
};

test("a graph task needing todos is rejected by the registry table of its backend", async () => {
  const started: string[] = [];
  const requests: ResolveRequest[] = [];
  const results = await runGraph([queueTask], 1, {
    baseCwd: process.cwd(),
    backendRegistry: recordingRegistryOf(probeBackend("unsupported", started), requests),
  });

  assert.equal(results[0].exitCode, 1);
  assert.equal(results[0].terminalStatus, "failed");
  assert.match(results[0].messages[0]?.content ?? "", /todoBinding/);
  assert.match(results[0].messages[0]?.content ?? "", /capability-probe/);
  assert.deepEqual(started, [], "the backend was started despite serving no queue binding");
  // Adjudication must carry the task's own prompt and selector into the
  // registry: resolving an empty task, or always resolving the default, would
  // read a table that dispatch never uses.
  assert.deepEqual(requests, [{ task: "work the queue", selector: undefined }]);
});

test("a graph task needing todos runs on a registry backend that binds them", async () => {
  const started: string[] = [];
  const requests: ResolveRequest[] = [];
  const results = await runGraph([queueTask], 1, {
    baseCwd: process.cwd(),
    backendRegistry: recordingRegistryOf(probeBackend("native", started), requests),
  });

  assert.equal(results[0].exitCode, 0);
  assert.deepEqual(started, ["work the queue"], "a capable backend was gated anyway");
  assert.deepEqual(requests[0], { task: "work the queue", selector: undefined });
});

test("a graph whose backend cannot be resolved settles every task instead of throwing", async () => {
  const started: string[] = [];
  const failing: BackendRegistry = {
    ...registryOf(probeBackend("native", started)),
    resolve: async () => {
      throw new Error("registration \"ghost\" names no loadable module");
    },
  };
  const tasks: NormalizedTask[] = [
    { agent: "general", name: "first", prompt: "one" },
    { agent: "general", name: "second", prompt: "two" },
  ];

  const results = await runGraph(tasks, 1, { baseCwd: process.cwd(), backendRegistry: failing });

  // A registry that cannot answer is a graph-level rejection: every task
  // settles as failed, so no row is left pending in the caller or the UI.
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminalStatus, "failed");
    assert.match(result.messages[0]?.content ?? "", /Teammate backend could not be resolved for this graph/);
    assert.match(result.messages[0]?.content ?? "", /names no loadable module/);
  }
  assert.deepEqual(started, []);
});
