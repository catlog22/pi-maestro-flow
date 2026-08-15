import assert from "node:assert/strict";
import test from "node:test";
import type {
  AttemptOutcome,
  BackendRunOptions,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { runSingleTeammate } from "../src/runs/execution.ts";

/**
 * The side-effect replay fence, applied through the backend seam.
 *
 * The contract's `recoveryShape` describes what a backend could do, not what the
 * host does. The host's only failover is a fresh attempt under the next model
 * candidate, with a new correlation id — a replay whatever a backend declares.
 * These tests pin that: a backend claiming in-context continuation is fenced
 * exactly like one claiming replay, because nothing in the host resumes the
 * failed run's own session.
 */

const PROVIDER_ERROR = "Provider returned error: 503 unavailable";

interface FenceProbe {
  backend: TeammateBackend;
  /** Models the registry was asked to run, in order. */
  launched: (string | undefined)[];
}

function probeBackend(
  recoveryShape: TeammateBackend["recoveryShape"],
  completedToolCount: number,
): FenceProbe {
  const launched: (string | undefined)[] = [];
  const backend: TeammateBackend = {
    name: "probe",
    protocolVersion: 1,
    capabilities: {
      outputSchema: "native",
      forkContext: "native",
      modelSelection: "native",
      thinkingLevel: "native",
      todoBinding: "native",
      toolFilter: "native",
      steer: "native",
      followUp: "native",
      abort: "native",
    },
    recoveryShape,
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec: TeammateRunSpec, options: BackendRunOptions) {
      launched.push(spec.model);
      const result: SingleResult = {
        agent: spec.agent,
        task: spec.task,
        exitCode: 1,
        messages: [{ role: "system", content: PROVIDER_ERROR }],
        usage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheWriteTokens: 0, cost: 0, turns: 1,
        },
        model: spec.model ?? "",
        correlationId: options.correlationId,
        durationMs: 1,
        toolCount: completedToolCount,
        terminalStatus: "failed",
      };
      const outcome: AttemptOutcome = {
        result,
        recovery: {
          // Authoritative: without it the run is blocked for a different
          // reason, and the fence itself would never be the thing under test.
          settlementAuthority: "authoritative",
          completedToolCount,
          inFlightToolCount: 0,
          preActivityInfrastructureExit: false,
          externalReplayRisk: false,
        },
        reclamation: Promise.resolve({ status: "reclaimed" }),
      };
      return {
        outcome: Promise.resolve(outcome),
        send: () => false,
        abort: () => undefined,
      };
    },
  };
  return { backend, launched };
}

function registryOf(backend: TeammateBackend): BackendRegistry {
  return {
    resolve: async () => ({ backend, config: {} }),
    capabilitiesOf: async () => backend.capabilities,
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
  };
}

async function runProbe(probe: FenceProbe): Promise<SingleResult> {
  return runSingleTeammate({
    agent: "general",
    task: "Do not repeat side effects",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
  }, {
    baseCwd: process.cwd(),
    backendRegistry: registryOf(probe.backend),
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    enableRetryBackoff: false,
  });
}

test("a completed tool fences model fallback through the backend seam", async () => {
  const probe = probeBackend("replay", 1);
  const result = await runProbe(probe);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(probe.launched, ["provider/primary"]);
  assert.match(result.messages.at(-1)?.content ?? "", /side-effect replay fence/);
  assert.match(result.messages.at(-1)?.content ?? "", /completedTools=1/);
});

test("declaring in-context continuation does not clear the fence", async () => {
  const probe = probeBackend("in-context-continuation", 1);
  const result = await runProbe(probe);
  // The backend could resume its own session; the host never asks it to. It
  // starts a fresh attempt instead, which would repeat the completed tool.
  assert.deepEqual(probe.launched, ["provider/primary"]);
  assert.match(result.messages.at(-1)?.content ?? "", /side-effect replay fence/);
});

test("with no completed tools the fence clears and the next model runs", async () => {
  const probe = probeBackend("in-context-continuation", 0);
  const result = await runProbe(probe);
  assert.deepEqual(probe.launched, ["provider/primary", "provider/backup"]);
  assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
});

test("the dispatch records which backend served the run", async () => {
  const probe = probeBackend("replay", 0);
  const result = await runProbe(probe);
  assert.equal(result.backend, "probe");
});

test("a fenced run records the failover it was denied, not just a message", async () => {
  const probe = probeBackend("replay", 1);
  const result = await runProbe(probe);
  const withheld = (result.capabilityDeliveries ?? []).find((d) => d.support === "withheld");
  assert.equal(withheld?.capability, "modelSelection");
  assert.match(withheld?.note ?? "", /completedTools=1/);
});

test("an unfenced run records no withheld capability", async () => {
  const probe = probeBackend("replay", 0);
  const result = await runProbe(probe);
  assert.equal((result.capabilityDeliveries ?? []).some((d) => d.support === "withheld"), false);
});
