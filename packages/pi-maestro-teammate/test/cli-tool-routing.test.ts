import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeammateBackendRegistry } from "pi-maestro-backends";
import type { BackendCapabilities, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import { forgetBackendRegistryConfigSync } from "../src/backends/registry-host.ts";
import { runSingleTeammate } from "../src/runs/execution.ts";

/**
 * Routing a `cli/<tool>` model to its registration.
 *
 * The inline dispatch this replaces ran the CLI from inside the pi attempt, so
 * the model id never reached the seam. It reaches it now through
 * `backendSpecOf`, which is the only place the mapping exists — a task naming a
 * tool with no registration must be refused by name rather than run somewhere
 * else, and legacy mode, which resolves no registry at all, must say so instead
 * of handing `cli/<tool>` to a provider as a model name.
 */

const ALL_NATIVE: BackendCapabilities = {
  outputSchema: "native", forkContext: "native", modelSelection: "native",
  thinkingLevel: "native", todoBinding: "native", toolFilter: "native",
  steer: "native", followUp: "native", abort: "native",
};

/** What one dispatch asked the registry to resolve. */
interface ResolveRequest {
  task: string;
  selector: string | undefined;
  specBackend: string | undefined;
}

/** A backend that records being started instead of running anything. */
function probeBackend(started: string[]): TeammateBackend {
  return {
    name: "cli-probe",
    protocolVersion: 1,
    capabilities: () => ALL_NATIVE,
    recoveryShape: "replay",
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

function recordingRegistryOf(backend: TeammateBackend, requests: ResolveRequest[]): BackendRegistry {
  return {
    resolve: async (spec, requestedBackend) => {
      requests.push({ task: spec.task, selector: requestedBackend, specBackend: spec.backend });
      return { backend, config: {}, capabilities: backend.capabilities({}) };
    },
    capabilitiesOf: async () => backend.capabilities({}),
    listBackendNames: () => [backend.name],
    defaultBackendName: () => backend.name,
  };
}

/** A workspace with one discoverable agent, and the document it was given. */
function workspace(document?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "cli-routing-"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", "prober.md"),
    "---\nname: prober\ndescription: \"fixture agent\"\ntools:\n  - Read\n---\n\n# Prober\n",
    "utf-8",
  );
  if (document !== undefined) {
    writeFileSync(
      join(root, ".pi", "teammate-backends.json"),
      `${JSON.stringify(document, null, 2)}\n`,
      "utf-8",
    );
  }
  forgetBackendRegistryConfigSync(root);
  return root;
}

test("a cli tool model routes to the registration named after the tool", async () => {
  const started: string[] = [];
  const requests: ResolveRequest[] = [];
  const result = await runSingleTeammate(
    { agent: "general", task: "probe", model: "cli/mock" },
    {
      baseCwd: process.cwd(),
      backendRegistry: recordingRegistryOf(probeBackend(started), requests),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(started, ["probe"]);
  assert.deepEqual(requests, [{ task: "probe", selector: "mock", specBackend: "mock" }]);
  // The model travels on unchanged, so the registration can check that the
  // route it serves is the one being asked for.
  assert.equal(result.model, "cli/mock");
});

test("a plain model still takes the registry default", async () => {
  const started: string[] = [];
  const requests: ResolveRequest[] = [];
  await runSingleTeammate(
    { agent: "general", task: "probe", model: "openai/gpt-5" },
    {
      baseCwd: process.cwd(),
      backendRegistry: recordingRegistryOf(probeBackend(started), requests),
    },
  );

  assert.deepEqual(requests, [{ task: "probe", selector: undefined, specBackend: undefined }]);
});

test("an explicit backend on the task wins over the cli tool model mapping", async () => {
  const started: string[] = [];
  const requests: ResolveRequest[] = [];
  await runSingleTeammate(
    { agent: "general", task: "probe", model: "cli/mock", backend: "chosen" },
    {
      baseCwd: process.cwd(),
      backendRegistry: recordingRegistryOf(probeBackend(started), requests),
    },
  );

  assert.deepEqual(requests, [{ task: "probe", selector: "chosen", specBackend: "chosen" }]);
  assert.deepEqual(started, ["probe"]);
});

test("an unregistered cli tool model is refused by name", async () => {
  const started: string[] = [];
  const registry = new TeammateBackendRegistry(
    { mode: "backend-registry", default: "other", backends: { other: { module: "other" } } },
    async () => probeBackend(started),
  );

  await assert.rejects(
    () => runSingleTeammate(
      { agent: "general", task: "probe", model: "cli/mock" },
      { baseCwd: process.cwd(), backendRegistry: registry },
    ),
    (error: Error) => error.message.includes("mock") && error.message.includes("is not registered"),
  );
  assert.deepEqual(started, [], "an unregistered tool reached a backend anyway");
});

test("a registered cli tool reaches the acp-cli backend through the workspace document", async () => {
  // No injected registry: the document, `dispatchRegistrySync`, and a real
  // `import(module)` are the path a deployment actually takes. Asserting the
  // mapping against a hand-built registry alone would leave the production
  // construction site unproven.
  const root = workspace({
    mode: "backend-registry",
    default: "pi-subprocess",
    backends: {
      mock: {
        module: "pi-maestro-teammate/v1/acp-cli",
        // A command that cannot exist: the backend is reached and refuses to
        // launch, which proves the route without spawning anything.
        config: { command: "pi-teammate-no-such-cli-xyz", modelId: "cli/mock" },
      },
    },
  });

  const result = await runSingleTeammate(
    { agent: "prober", task: "probe", model: "cli/mock" },
    { baseCwd: root },
  );

  assert.equal(result.backend, "acp-cli");
  assert.equal(result.exitCode, 1);
  assert.match(result.messages[0]?.content ?? "", /not launchable/);
});

test("legacy mode refuses a cli tool model and names backend-registry mode", async () => {
  const root = workspace();
  const result = await runSingleTeammate(
    { agent: "prober", task: "probe", model: "cli/mock" },
    { baseCwd: root },
  );

  assert.equal(result.exitCode, 1);
  const message = result.messages[0]?.content ?? "";
  assert.match(message, /cli\/mock/);
  assert.match(message, /backend-registry/);
  assert.match(message, /teammate-backends\.json/);
});
