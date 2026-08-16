import assert from "node:assert/strict";
import test from "node:test";
import type { Writable } from "node:stream";
import type {
  AttemptOutcome,
  BackendRun,
  BackendRunOptions,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { ControlMode, SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { runSingleTeammate, sendRpcMessage } from "../src/runs/execution.ts";
import { wrapLeasedMessage } from "../src/runs/session-handoff.ts";

/**
 * Addressing a backend that publishes no child stdin.
 *
 * The host writes control lines to a pipe captured when a Pi child spawned. A
 * backend reaching its runtime another way published nothing, so `teammate-send`
 * reported "no restorable runtime" for a runtime that was running and able to
 * take the message — its `BackendRun.send` was implemented and unreachable.
 *
 * These drive the real `sendRpcMessage` the host calls, so they fail if the
 * translation stops matching the line protocol rather than only if a
 * hand-written stand-in does.
 */

interface Delivered { message: string; mode: ControlMode }

function registryOf(backend: TeammateBackend): BackendRegistry {
  return {
    resolve: async () => ({ backend, config: {}, capabilities: backend.capabilities({}) }),
    capabilitiesOf: async () => backend.capabilities({}),
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
  };
}

/** Run a probe backend, capturing the pipe the host is handed. */
async function withChannel(
  accept: boolean,
  body: (stdin: Writable, delivered: Delivered[]) => void,
): Promise<SingleResult> {
  const delivered: Delivered[] = [];
  let captured: Writable | undefined;
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });

  const backend: TeammateBackend = {
    name: "channel-probe",
    protocolVersion: 1,
    capabilities: () => ({
      outputSchema: "native", forkContext: "native", modelSelection: "native",
      thinkingLevel: "native", todoBinding: "native", toolFilter: "native",
      steer: "native", followUp: "native", abort: "native",
    }),
    recoveryShape: "in-context-continuation",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, runOptions) {
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
        outcome: running.then(() => ({
          result,
          recovery: {
            settlementAuthority: "authoritative" as const,
            completedToolCount: 0,
            inFlightToolCount: 0,
            preActivityInfrastructureExit: false,
            externalReplayRisk: false,
          },
          reclamation: Promise.resolve({ status: "reclaimed" as const }),
        })),
        send(message: string, mode: ControlMode): boolean {
          if (!accept) return false;
          delivered.push({ message, mode });
          return true;
        },
        abort: () => undefined,
      };
    },
  };

  const finished = runSingleTeammate({ agent: "general", task: "stay up" }, {
    baseCwd: process.cwd(),
    backendRegistry: registryOf(backend),
    onChildSpawned: (stdin) => { captured = stdin; },
  });

  // The host is handed the channel while the run is still live, which is the
  // only window in which teammate-send is meaningful.
  await new Promise((done) => setImmediate(done));
  assert.notEqual(captured, undefined, "the host was never handed a control channel");
  body(captured!, delivered);
  release();
  return finished;
}

test("a backend with no child stdin is still addressable while it runs", async () => {
  await withChannel(true, (stdin, delivered) => {
    assert.equal(stdin.writable, true);
    assert.equal(sendRpcMessage(stdin, "keep going", "follow_up"), true);
    assert.deepEqual(delivered, [{ message: "keep going", mode: "follow_up" }]);
  });
});

test("the lease envelope is stripped before the message reaches the backend", async () => {
  await withChannel(true, (stdin, delivered) => {
    const token = { owner: "root", epoch: 1, id: "L-1" } as never;
    // The host wraps for the Pi child's protocol; a backend addressed through
    // the contract must not receive the envelope.
    sendRpcMessage(stdin, "with lease", "follow_up", token);
    assert.equal(delivered[0]?.message, "with lease");
    assert.match(wrapLeasedMessage("with lease", token), /^\[/);
  });
});

test("a prompt keeps its mode rather than arriving as a follow-up", async () => {
  await withChannel(true, (stdin, delivered) => {
    sendRpcMessage(stdin, "new turn", "prompt");
    assert.deepEqual(delivered, [{ message: "new turn", mode: "prompt" }]);
  });
});

test("a backend refusing the message reports a failed send, not a silent success", async () => {
  await withChannel(false, (stdin, delivered) => {
    // A false return must survive the pipe-shaped call; reporting success for
    // an undelivered message is worse than reporting failure.
    assert.equal(sendRpcMessage(stdin, "refused", "follow_up"), false);
    assert.deepEqual(delivered, []);
  });
});

test("a settled run stops accepting messages it can no longer deliver", async () => {
  let stdin!: Writable;
  await withChannel(true, (captured) => { stdin = captured; });
  await new Promise((done) => setImmediate(done));
  assert.equal(stdin.writable, false);
  assert.equal(sendRpcMessage(stdin, "too late", "follow_up"), false);
});
