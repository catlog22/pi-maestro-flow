import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendCapabilities, BackendRun, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { remoteLocationRouting, runSingleTeammate } from "../src/runs/execution.ts";
import { forgetBackendRegistryConfigSync } from "../src/backends/registry-host.ts";

/**
 * What a nested or proxied dispatch may do with a remote working location.
 *
 * A remote location written by a nested agent must either reach the remote host
 * or fail with a name. It must never become a local directory called
 * `remote:beta` under the base: that is the failure this repository keeps
 * re-growing — a stated routing intent quietly demoted to a local path — and the
 * three cases below are the only thing that would notice.
 *
 * `extension/teammate-proxy.ts` deliberately contains no `remote:` branch of its
 * own. The rule has one home, `remoteLocationRouting`, which sits below every
 * dispatch entry point, so the proxy path inherits it. A second copy in the
 * proxy would be the same fact in two places.
 */

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native",
  forkContext: "native",
  modelSelection: "native",
  thinkingLevel: "native",
  todoBinding: "native",
  toolFilter: "native",
  steer: "native",
  followUp: "native",
  abort: "native",
};

/** One resolve request, as the registry received it. */
interface ResolveRequest {
  spec: TeammateRunSpec;
  requested: string | undefined;
}

/**
 * A workspace registering `remote:beta` and nothing else of its own.
 *
 * @returns the canonical workspace root.
 */
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-nested-")));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", "prober.md"),
    "---\nname: prober\ndescription: \"nested routing probe\"\ntools:\n  - Read\n---\n\n# Prober\n",
    "utf-8",
  );
  writeFileSync(
    join(root, ".pi", "teammate-backends.json"),
    `${JSON.stringify({
      mode: "backend-registry",
      default: "pi-subprocess",
      backends: {
        "remote:beta": {
          module: "remote-workers",
          config: { targetId: "beta", driver: "pi-rpc" },
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  forgetBackendRegistryConfigSync(root);
  return root;
}

/** A backend that settles immediately, so the test reads routing and nothing else. */
function probeBackend(): TeammateBackend {
  return {
    name: "routing-probe",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    recoveryShape: "replay",
    configFields: [],
    resolveConfig: (config) => ({ values: config, errors: [] }),
    start: (spec): Promise<BackendRun> => Promise.resolve({
      outcome: Promise.resolve({
        result: {
          agent: spec.agent,
          task: spec.task,
          exitCode: 0,
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
          model: "",
          correlationId: "corr-1",
          durationMs: 0,
          wakeable: false,
          terminalStatus: "completed" as const,
        },
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
      abort: () => {},
    }),
  };
}

/**
 * Flatten an error and everything it was caused by into one string.
 *
 * @param error - the thrown value.
 * @returns every message in the chain, outermost first.
 */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join("\n");
}

/** A registry that records every resolve request before answering it. */
function recordingRegistryOf(requests: ResolveRequest[]): BackendRegistry {
  const backend = probeBackend();
  return {
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
    capabilitiesOf: async () => CAPABILITIES,
    resolve: async (spec, requested) => {
      requests.push({ spec, requested });
      return { backend, config: {}, capabilities: CAPABILITIES };
    },
  };
}

test("a nested dispatch to a remote location never resolves to a local directory", async () => {
  const root = workspace();
  const requests: ResolveRequest[] = [];
  try {
    await runSingleTeammate(
      { agent: "prober", task: "nested work", cwd: "remote:beta" },
      { baseCwd: root, backendRegistry: recordingRegistryOf(requests) },
    );

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.spec.cwd, undefined);
    assert.equal(request?.spec.backend, "remote:beta");
    assert.equal(request?.requested, "remote:beta");
    // The direct counter-example: resolving the location as a path would have
    // produced `<root>/remote:beta`, so the base would appear in the spec.
    assert.ok(
      !JSON.stringify(request?.spec).includes(root),
      "the remote location was resolved against the local base",
    );
  } finally {
    forgetBackendRegistryConfigSync(root);
  }
});

test("a nested dispatch to a remote location is refused by name instead of running here", async () => {
  const root = workspace();
  // The proxy path supplies no remote Monitor wiring, because
  // `TeammateRuntimeOptions` carries none — which is the whole point: stage one
  // does not open nested remote dispatch, and a task that named another machine
  // must fail rather than run on this one.
  let spawned = 0;
  try {
    // The refusal is a rejection, not a failed `SingleResult`: the registry
    // cannot load the registration at all, so no run exists to report an exit
    // code. Accepting either shape would let that regress unnoticed.
    await assert.rejects(
      runSingleTeammate(
        { agent: "prober", task: "nested work", cwd: "remote:beta" },
        {
          baseCwd: root,
          spawnChildProcess: ((): never => {
            spawned += 1;
            throw new Error("a remote task must never spawn a local child");
          }) as never,
        },
      ),
      (error: unknown) => {
        // The whole cause chain counts as the refusal's text: the registry wraps
        // a load failure and names the registration, while the reason it could
        // not be loaded travels on `cause`.
        const text = errorChain(error);
        assert.match(text, /remote-workers/);
        assert.match(text, /remote Monitor wiring/);
        return true;
      },
    );
  } finally {
    forgetBackendRegistryConfigSync(root);
  }

  assert.equal(spawned, 0, "a remote task started a local child instead of failing by name");
});

test("a remote location routes to a registration name rather than to a directory", () => {
  assert.deepEqual(remoteLocationRouting("remote:beta"), { backend: "remote:beta", targetId: "beta" });
  assert.equal(remoteLocationRouting("/tmp/x"), undefined);
  assert.equal(remoteLocationRouting(undefined), undefined);
  // An empty target still yields a registration name, so the registry refuses it
  // as unregistered rather than a special case swallowing it here.
  assert.deepEqual(remoteLocationRouting("remote:"), { backend: "remote:", targetId: "" });

  // The rule decides routing, not display: `resolvedRunLocation` in
  // extension/index.ts must keep returning a `remote:` location verbatim, or the
  // UI would claim the task runs in a directory on this machine.
});
