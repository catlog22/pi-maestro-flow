import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCapabilities, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import { runSingleTeammate } from "../src/runs/execution.ts";

/**
 * Capability adjudication on the single-dispatch path.
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
