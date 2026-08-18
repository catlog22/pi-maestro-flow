import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCapabilities, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { runSingleTeammate } from "../src/runs/execution.ts";
import { normalizeTeammateParams, singleRunParamsOf } from "../src/runs/execution-infra.ts";

/**
 * A todo binding, from the request the model writes down to `spec.todos`.
 *
 * Every earlier case on this seam handed `todos` straight to
 * `runSingleTeammate` or to `backend.start`, and that call shape does not exist
 * in the product: the dispatch path builds its params from a normalized task.
 * It built them without `todos` for four releases, so `spec.todos` was
 * undefined on every single dispatch while the capability gate, the fail-loud
 * bridge assertion, and three green test files all keyed off it.
 *
 * These cases therefore start where the request does — the `tasks` array the
 * teammate tool receives — and run it through the product's own normalization
 * and projection. Nothing here constructs a spec.
 */

const ALL_NATIVE: BackendCapabilities = {
  outputSchema: "native", forkContext: "native", modelSelection: "native",
  thinkingLevel: "native", todoBinding: "native", toolFilter: "native",
  steer: "native", followUp: "native", abort: "native",
};

/** A backend that records the spec it was started with instead of running it. */
function probeBackend(
  todoBinding: BackendCapabilities["todoBinding"],
  started: TeammateRunSpec[],
): TeammateBackend {
  return {
    name: "todo-probe",
    protocolVersion: 1,
    capabilities: () => ({ ...ALL_NATIVE, todoBinding }),
    recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, runOptions) {
      started.push(spec);
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

/**
 * Dispatch a request exactly as the extension does.
 *
 * `normalizeTeammateParams` then `singleRunParamsOf` is the product's own
 * projection, in the order the root tool and the nested proxy both apply it.
 * The request is the only thing this test writes.
 */
async function dispatchRequest(
  request: { agent: string; prompt: string; todo?: string | string[] },
  todoBinding: BackendCapabilities["todoBinding"] = "native",
): Promise<{ result: SingleResult; started: TeammateRunSpec[] }> {
  const normalization = normalizeTeammateParams({ tasks: [request] });
  assert.equal(normalization.error, undefined, "the request did not survive normalization");
  const singleTask = normalization.tasks[0]!;
  const started: TeammateRunSpec[] = [];
  const result = await runSingleTeammate(
    singleRunParamsOf(singleTask, { task: singleTask.prompt }),
    { baseCwd: process.cwd(), backendRegistry: registryOf(probeBackend(todoBinding, started)) },
  );
  return { result, started };
}

test("a single-task request's todo binding reaches the backend spec", async () => {
  const { result, started } = await dispatchRequest({
    agent: "general",
    prompt: "work the queue",
    todo: ["#12", "#13"],
  });

  assert.equal(result.terminalStatus, "completed", result.messages[0]?.content);
  assert.equal(started.length, 1, "the backend was never started");
  // Ids travel as written, in the order the request gave them: the priority
  // order is the binding, so a projection that sorted or de-duplicated across
  // it would change which task the agent is told to run first.
  assert.deepEqual(started[0]!.todos, ["#12", "#13"]);
});

test("a single-task request that binds one todo reaches the backend spec", async () => {
  // The scalar form is what a model writes for the common case, and it takes a
  // different branch through normalization than the array.
  const { started } = await dispatchRequest({ agent: "general", prompt: "work it", todo: "#12" });

  assert.deepEqual(started[0]!.todos, ["#12"]);
});

test("a request binding no todo leaves the field absent on the spec", async () => {
  // The negative direction: without it, the assertions above would pass equally
  // for a projection that hard-coded a queue onto every run.
  const { started } = await dispatchRequest({ agent: "general", prompt: "just work" });

  assert.equal(started[0]!.todos, undefined);
});

test("a single-task request binding todos is refused by a backend that cannot serve them", async () => {
  // The claim the capability gate makes, driven from the request rather than
  // from a hand-built spec: with `todos` missing from the projection the gate
  // saw an empty requirement set and let every such dispatch through.
  const { result, started } = await dispatchRequest(
    { agent: "general", prompt: "work the queue", todo: "#12" },
    "unsupported",
  );

  assert.equal(result.terminalStatus, "failed");
  assert.match(result.messages[0]?.content ?? "", /todoBinding/);
  assert.match(result.messages[0]?.content ?? "", /todo-probe/);
  assert.deepEqual(started, [], "the backend ran despite serving no queue binding");
});
