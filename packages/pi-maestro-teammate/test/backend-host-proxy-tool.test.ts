import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRunOptions, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import {
  registerTeammateChildToolBroker,
  type TeammateChildToolBrokerRequest,
} from "../src/runs/child-extensions.ts";
import { runSingleTeammate } from "../src/runs/execution.ts";

/**
 * How a non-Pi backend reaches a host-implemented tool.
 *
 * The host used to hand every backend an empty `host`, so a runtime that could
 * have served todos had no route to the queue. These drive the real dispatch so
 * they observe the closure the host actually builds, not one assembled here.
 */

function registryOf(backend: TeammateBackend): BackendRegistry {
  return {
    resolve: async () => ({ backend, config: {}, capabilities: backend.capabilities({}) }),
    capabilitiesOf: async () => backend.capabilities({}),
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
  };
}

/** A backend that hands its run options back out instead of running anything. */
function capturingBackend(captured: BackendRunOptions[]): TeammateBackend {
  return {
    name: "proxy-probe",
    protocolVersion: 1,
    capabilities: () => ({
      outputSchema: "native", forkContext: "native", modelSelection: "native",
      thinkingLevel: "native", todoBinding: "native", toolFilter: "native",
      steer: "native", followUp: "native", abort: "native",
    }),
    recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, runOptions) {
      captured.push(runOptions);
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

/** Run one attempt and return the options the backend was started with. */
async function attemptOptions(task = "reach the queue"): Promise<BackendRunOptions> {
  const captured: BackendRunOptions[] = [];
  await runSingleTeammate({ agent: "general", task }, {
    baseCwd: process.cwd(),
    backendRegistry: registryOf(capturingBackend(captured)),
  });
  assert.equal(captured.length, 1);
  return captured[0]!;
}

test("a backend reaches the host todo broker under its own attempt identity", async () => {
  const seen: TeammateChildToolBrokerRequest[] = [];
  const release = registerTeammateChildToolBroker("todo", async (request) => {
    seen.push(request);
    return { content: [{ type: "text", text: "[]" }] };
  });
  try {
    const options = await attemptOptions();
    assert.notEqual(options.host.proxyToolCall, undefined);
    await options.host.proxyToolCall!({
      toolName: "todo",
      args: { action: "list" },
      correlationId: options.correlationId,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.toolName, "todo");
    assert.deepEqual(seen[0]!.input, { action: "list" });
    assert.equal(seen[0]!.actor.correlationId, options.correlationId);
  } finally {
    release();
  }
});

test("a backend asking for an unbrokered host tool is refused by name", async () => {
  const options = await attemptOptions();
  await assert.rejects(
    options.host.proxyToolCall!({ toolName: "todo", args: {}, correlationId: options.correlationId }),
    /no host tool broker is registered for "todo"/,
  );
});

test("two concurrent attempts each reach the broker as themselves", async () => {
  const seen: TeammateChildToolBrokerRequest[] = [];
  const release = registerTeammateChildToolBroker("todo", async (request) => {
    seen.push(request);
    return { content: [{ type: "text", text: "[]" }] };
  });
  try {
    const [first, second] = await Promise.all([attemptOptions("one"), attemptOptions("two")]);
    await Promise.all([first, second].map((options) => options.host.proxyToolCall!({
      toolName: "todo",
      args: { action: "list" },
      correlationId: options.correlationId,
    })));
    assert.equal(seen.length, 2);
    const actors = seen.map((request) => request.actor.correlationId);
    // An attempt that could be mistaken for another is the failure this whole
    // identity chain exists to prevent.
    assert.notEqual(actors[0], actors[1]);
    assert.deepEqual([...actors].sort(), [first.correlationId, second.correlationId].sort());
  } finally {
    release();
  }
});
