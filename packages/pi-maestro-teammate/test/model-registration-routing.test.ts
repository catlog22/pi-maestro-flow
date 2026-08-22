import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRunOptions,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type {
  SingleResult,
  TeammateRunSpec,
} from "pi-maestro-backend-core/v1/spec";
import {
  ModelHealthCoordinator,
} from "../src/models/model-circuit-breaker.ts";
import {
  canHotSwitchModelRegistration,
  resolveModelRegistrationRouting,
} from "../src/models/model-routing.ts";
import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
  type DispatchAuthorityProjection,
  type ModelRegistryManifestV2,
} from "../src/models/model-registry.ts";
import {
  runGraph,
  runSingleTeammate,
} from "../src/runs/execution.ts";
import { toStructuredResults } from "../src/extension/teammate-core.ts";

const ALL_NATIVE: BackendCapabilities = {
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

function authority(overrides: Partial<ModelRegistryManifestV2> = {}): DispatchAuthorityProjection {
  const manifest: ModelRegistryManifestV2 = {
    version: 2,
    mode: "model-registry",
    default: "dep-a",
    defaultModel: "registry/primary",
    backends: {
      "dep-a": { module: "test-adapter-a" },
      "dep-b": { module: "test-adapter-b" },
      "remote-beta": {
        module: "remote-workers",
        config: { targetId: "beta", driver: "pi-rpc" },
      },
    },
    models: {
      "registry/primary": {
        modelId: "intrinsic/primary",
        deployment: "dep-a",
        selector: { kind: "adapter-model", value: "adapter/primary" },
        deploymentDefault: true,
      },
      "registry/same-deployment": {
        modelId: "intrinsic/same",
        deployment: "dep-a",
        selector: { kind: "adapter-model", value: "adapter/same" },
      },
      "registry/fallback": {
        modelId: "intrinsic/fallback",
        deployment: "dep-b",
        selector: { kind: "deployment-default" },
        deploymentDefault: true,
      },
      "remote/fixed": {
        modelId: "intrinsic/remote",
        deployment: "remote-beta",
        selector: { kind: "fixed" },
      },
    },
    compatibility: {
      version: 1,
      modelAliases: { "registry/old-primary": "registry/primary" },
      backendAliases: { fleet: "dep-b" },
      remoteLocations: { "remote:beta": "remote/fixed" },
    },
    ...overrides,
  };
  return compileModelRegistryManifest(
    parseModelRegistryManifest(JSON.stringify(manifest), "registration-routing-test.json"),
  ).dispatch;
}

interface ProbeEvent {
  kind: "resolve" | "start";
  deployment: string | undefined;
  model: string | undefined;
  task: string;
}

function resultOf(
  spec: TeammateRunSpec,
  options: BackendRunOptions,
  exitCode: number,
  message: string,
): SingleResult {
  return {
    agent: spec.agent,
    task: spec.task,
    exitCode,
    messages: [{ role: exitCode === 0 ? "assistant" : "system", content: message }],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      turns: 1,
    },
    model: spec.model ?? "runtime-default",
    correlationId: options.correlationId,
    durationMs: 1,
    terminalStatus: exitCode === 0 ? "completed" : "failed",
  };
}

function outcome(result: SingleResult): AttemptOutcome {
  return {
    result,
    recovery: {
      settlementAuthority: "authoritative",
      completedToolCount: 0,
      inFlightToolCount: 0,
      preActivityInfrastructureExit: false,
      externalReplayRisk: false,
    },
    reclamation: Promise.resolve({ status: "reclaimed" }),
  };
}

function probeBackend(
  deploymentId: string,
  events: ProbeEvent[],
  starts: (spec: TeammateRunSpec, options: BackendRunOptions) => SingleResult | AttemptOutcome,
): TeammateBackend {
  return {
    name: `probe-${deploymentId}`,
    protocolVersion: 1,
    capabilities: () => ALL_NATIVE,
    recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, options) {
      events.push({ kind: "start", deployment: spec.backend, model: spec.model, task: spec.task });
      options.onProgress?.({
        status: "running",
        requestedModel: spec.model ?? "runtime-default",
        resolvedModel: spec.model ?? "runtime-default",
      });
      const started = starts(spec, options);
      return {
        outcome: Promise.resolve("recovery" in started ? started : outcome(started)),
        send: () => false,
        abort: () => undefined,
      };
    },
  };
}

function probeRegistry(
  events: ProbeEvent[],
  backends: Record<string, TeammateBackend>,
  rejectDeployment?: string,
): BackendRegistry {
  const resolved = (deploymentId: string): ResolvedBackend => {
    const backend = backends[deploymentId];
    if (backend === undefined) throw new Error(`missing probe deployment ${deploymentId}`);
    return { backend, config: {}, capabilities: backend.capabilities({}) };
  };
  return {
    async resolve(spec, requestedBackend) {
      const deploymentId = requestedBackend ?? spec.backend;
      events.push({ kind: "resolve", deployment: deploymentId, model: spec.model, task: spec.task });
      if (deploymentId === rejectDeployment) throw new Error(`deployment ${deploymentId} failed preflight`);
      return resolved(deploymentId ?? "dep-a");
    },
    async capabilitiesOf(deploymentId) {
      return resolved(deploymentId).capabilities;
    },
    listBackendNames: () => Object.keys(backends),
    defaultBackendName: () => "dep-a",
  };
}

test("registration routing canonicalizes aliases and enforces deployment/default/location conflicts", () => {
  const projection = authority();
  const aliased = resolveModelRegistrationRouting(projection, {
    model: "registry/old-primary",
    fallbackModels: ["registry/fallback", "registry/old-primary"],
  });
  assert.deepEqual(
    aliased.candidates.map((candidate) => candidate.modelRegistrationId),
    ["registry/primary", "registry/fallback"],
  );

  const deploymentDefault = resolveModelRegistrationRouting(projection, { backend: "fleet" });
  assert.equal(deploymentDefault.requestedDeploymentId, "dep-b");
  assert.deepEqual(
    deploymentDefault.candidates.map((candidate) => candidate.modelRegistrationId),
    ["registry/fallback"],
  );

  const remote = resolveModelRegistrationRouting(projection, { cwd: "remote:beta" });
  assert.deepEqual(remote.candidates.map((candidate) => candidate.modelRegistrationId), ["remote/fixed"]);

  assert.throws(
    () => resolveModelRegistrationRouting(projection, {
      model: "registry/primary",
      backend: "fleet",
    }),
    /conflicts with requested deployment "dep-b"/,
  );
  assert.throws(
    () => resolveModelRegistrationRouting(projection, {
      model: "registry/primary",
      cwd: "remote:beta",
    }),
    /conflicts with remote location "remote:beta"/,
  );
  assert.throws(
    () => resolveModelRegistrationRouting(projection, { cwd: "remote:missing" }),
    /Unknown model-registry remote location/,
  );

  const invalidRemote = authority({
    compatibility: {
      version: 1,
      remoteLocations: { "remote:local": "registry/primary" },
    },
  });
  assert.throws(
    () => resolveModelRegistrationRouting(invalidRemote, { cwd: "remote:local" }),
    /maps to non-remote model registration/,
  );
});

test("Pi hot switching is limited to adapter-model registrations on one Pi deployment", () => {
  const projection = authority({
    default: "pi-a",
    backends: {
      "pi-a": { module: "pi-subprocess" },
      "pi-b": { module: "pi-subprocess" },
      dsh: { module: "pi-maestro-backends/dsh" },
    },
    models: {
      "pi/primary": {
        modelId: "intrinsic/primary",
        deployment: "pi-a",
        selector: { kind: "adapter-model", value: "adapter/primary" },
        deploymentDefault: true,
      },
      "pi/same": {
        modelId: "intrinsic/same",
        deployment: "pi-a",
        selector: { kind: "adapter-model", value: "adapter/same" },
      },
      "pi/default-selector": {
        modelId: "intrinsic/default",
        deployment: "pi-a",
        selector: { kind: "deployment-default" },
      },
      "pi/other-deployment": {
        modelId: "intrinsic/other",
        deployment: "pi-b",
        selector: { kind: "adapter-model", value: "adapter/other" },
        deploymentDefault: true,
      },
      "dsh/model": {
        modelId: "intrinsic/dsh",
        deployment: "dsh",
        selector: { kind: "adapter-model", value: "dsh-model" },
        deploymentDefault: true,
      },
    },
    defaultModel: "pi/primary",
    compatibility: { version: 1 },
  });
  const plan = resolveModelRegistrationRouting(projection, {
    model: "pi/primary",
    fallbackModels: ["pi/same", "pi/default-selector", "pi/other-deployment", "dsh/model"],
  });
  const [primary, same, defaultSelector, other, dsh] = plan.candidates;
  assert.equal(canHotSwitchModelRegistration(primary!, same!), true);
  assert.equal(canHotSwitchModelRegistration(primary!, defaultSelector!), false);
  assert.equal(canHotSwitchModelRegistration(primary!, other!), false);
  assert.equal(canHotSwitchModelRegistration(primary!, dsh!), false);
});

test("Pi checkpoints cannot bypass the replay fence for DSH, ACP, or remote fallbacks", async (t) => {
  const cases = [
    {
      name: "DSH",
      deploymentId: "dsh-local",
      registration: { module: "pi-maestro-backends/dsh" },
      selector: { kind: "adapter-model", value: "dsh/fallback" } as const,
    },
    {
      name: "ACP",
      deploymentId: "acp-local",
      registration: { module: "pi-maestro-teammate/v1/acp-cli" },
      selector: { kind: "adapter-model", value: "acp/fallback" } as const,
    },
    {
      name: "remote",
      deploymentId: "remote-fallback",
      registration: {
        module: "remote-workers",
        config: { targetId: "fallback", driver: "pi-rpc" },
      },
      selector: { kind: "fixed" } as const,
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const root = mkdtempSync(join(tmpdir(), "teammate-pi-checkpoint-fence-"));
      const checkpoint = join(root, "checkpoint.jsonl");
      writeFileSync(checkpoint, "{}\n", "utf8");
      const projection = authority({
        default: "pi-local",
        defaultModel: "pi/primary",
        backends: {
          "pi-local": { module: "pi-subprocess" },
          [entry.deploymentId]: entry.registration,
        },
        models: {
          "pi/primary": {
            modelId: "intrinsic/primary",
            deployment: "pi-local",
            selector: { kind: "adapter-model", value: "pi/primary" },
            deploymentDefault: true,
          },
          "fallback/model": {
            modelId: `intrinsic/${entry.name.toLowerCase()}`,
            deployment: entry.deploymentId,
            selector: entry.selector,
          },
        },
        compatibility: { version: 1 },
      });
      const events: ProbeEvent[] = [];
      const pi = probeBackend("pi-local", events, (spec, options) => {
        options.onChildEvent?.({
          type: "teammate_session_ready",
          sessionFile: checkpoint,
        });
        return {
          result: resultOf(spec, options, 1, "Provider returned error: 503 unavailable"),
          recovery: {
            settlementAuthority: "authoritative",
            completedToolCount: 1,
            inFlightToolCount: 0,
            preActivityInfrastructureExit: false,
            externalReplayRisk: false,
          },
          reclamation: Promise.resolve({ status: "reclaimed" }),
        };
      });
      const fallback = probeBackend(entry.deploymentId, events, (spec, options) =>
        resultOf(spec, options, 0, "must remain fenced"));

      try {
        const result = await runSingleTeammate({
          agent: "general",
          task: "do not replay the completed effect",
          model: "pi/primary",
          fallbackModels: ["fallback/model"],
        }, {
          baseCwd: process.cwd(),
          backendRegistry: probeRegistry(events, {
            "pi-local": pi,
            [entry.deploymentId]: fallback,
          }),
          modelRegistryAuthority: projection,
          modelHealthCoordinator: new ModelHealthCoordinator(),
          authorizeRemoteModelDispatch: () => true,
          enableRetryBackoff: false,
        });

        assert.equal(result.exitCode, 1);
        assert.deepEqual(
          events.filter((event) => event.kind === "start").map((event) => event.deployment),
          ["pi-local"],
        );
        assert.match(result.messages.at(-1)?.content ?? "", /side-effect replay fence/);
        assert.match(result.messages.at(-1)?.content ?? "", /cannot resume candidate/);
        assert.match(result.messages.at(-1)?.content ?? "", /completedTools=1/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("same-deployment Pi checkpoint resume waits for reclamation and remains allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "teammate-pi-checkpoint-resume-"));
  const checkpoint = join(root, "checkpoint.jsonl");
  writeFileSync(checkpoint, "{}\n", "utf8");
  const projection = authority({
    default: "pi-local",
    defaultModel: "pi/primary",
    backends: { "pi-local": { module: "pi-subprocess" } },
    models: {
      "pi/primary": {
        modelId: "intrinsic/primary",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "pi/primary" },
        deploymentDefault: true,
      },
      "pi/backup": {
        modelId: "intrinsic/backup",
        deployment: "pi-local",
        selector: { kind: "adapter-model", value: "pi/backup" },
      },
    },
    compatibility: { version: 1 },
  });
  const events: ProbeEvent[] = [];
  let primaryStarted!: () => void;
  const sawPrimaryStart = new Promise<void>((resolve) => { primaryStarted = resolve; });
  let reclaimed = false;
  let settleReclamation!: () => void;
  const reclamation = new Promise<{ status: "reclaimed" }>((resolve) => {
    settleReclamation = () => {
      if (reclaimed) return;
      reclaimed = true;
      resolve({ status: "reclaimed" });
    };
  });
  const pi = probeBackend("pi-local", events, (spec, options) => {
    if (spec.model === "pi/primary") {
      options.onChildEvent?.({ type: "teammate_session_ready", sessionFile: checkpoint });
      primaryStarted();
      return {
        result: resultOf(spec, options, 1, "Provider returned error: 503 unavailable"),
        recovery: {
          settlementAuthority: "authoritative",
          completedToolCount: 1,
          inFlightToolCount: 0,
          preActivityInfrastructureExit: false,
          externalReplayRisk: false,
        },
        reclamation,
      };
    }
    assert.equal(reclaimed, true, "replacement Pi route must start only after reclamation");
    return resultOf(spec, options, 0, "resumed");
  });

  try {
    const run = runSingleTeammate({
      agent: "general",
      task: "resume the recorded Pi session",
      model: "pi/primary",
      fallbackModels: ["pi/backup"],
    }, {
      baseCwd: process.cwd(),
      backendRegistry: probeRegistry(events, { "pi-local": pi }),
      modelRegistryAuthority: projection,
      modelHealthCoordinator: new ModelHealthCoordinator(),
      modelHealthFailureScopeClassifier: () => "route",
      enableRetryBackoff: false,
    });

    await sawPrimaryStart;
    assert.deepEqual(
      events.filter((event) => event.kind === "start").map((event) => event.model),
      ["pi/primary"],
    );
    settleReclamation();
    const result = await run;
    assert.equal(result.exitCode, 0);
    assert.equal(result.model, "pi/backup");
    assert.deepEqual(
      events.filter((event) => event.kind === "start").map((event) => event.model),
      ["pi/primary", "pi/backup"],
    );
  } finally {
    settleReclamation();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry dispatch preflights every candidate and uses canonical telemetry and scoped auth suppression", async () => {
  const projection = authority({
    backends: {
      "dep-a": { module: "test-adapter-a" },
      "dep-b": {
        module: "pi-maestro-backends/dsh",
        config: {
          command: "secret-command",
          args: ["--token", "secret-credential"],
          cwd: "secret-cwd",
          env: "secret-env",
          host: "secret-host",
          user: "secret-user",
          hostKey: "secret-host-key",
          identity: "secret-identity",
          remoteCommand: "secret-remote-command",
        },
      },
      "remote-beta": {
        module: "remote-workers",
        config: { targetId: "beta", driver: "pi-rpc" },
      },
    },
  });
  const events: ProbeEvent[] = [];
  const progress: Array<{ requested?: string; resolved?: string; attempted?: string[] }> = [];
  const depA = probeBackend("dep-a", events, (spec, options) =>
    resultOf(spec, options, 1, "401 unauthorized"));
  const depB = probeBackend("dep-b", events, (spec, options) =>
    resultOf(spec, options, 0, "done"));
  const remote = probeBackend("remote-beta", events, (spec, options) =>
    resultOf(spec, options, 0, "remote done"));
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "route through registrations",
    model: "registry/old-primary",
    fallbackModels: ["registry/same-deployment", "registry/fallback"],
  }, {
    baseCwd: process.cwd(),
    backendRegistry: probeRegistry(events, {
      "dep-a": depA,
      "dep-b": depB,
      "remote-beta": remote,
    }),
    modelRegistryAuthority: projection,
    modelHealthCoordinator: health,
    enableRetryBackoff: false,
    onProgress(data) {
      progress.push({
        requested: data.requestedModel,
        resolved: data.resolvedModel,
        attempted: data.attemptedModels,
      });
    },
  });

  assert.deepEqual(events.slice(0, 3), [
    { kind: "resolve", deployment: "dep-a", model: "adapter/primary", task: "route through registrations" },
    { kind: "resolve", deployment: "dep-a", model: "adapter/same", task: "route through registrations" },
    { kind: "resolve", deployment: "dep-b", model: undefined, task: "route through registrations" },
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "start"), [
    { kind: "start", deployment: "dep-a", model: "adapter/primary", task: "route through registrations" },
    { kind: "start", deployment: "dep-b", model: undefined, task: "route through registrations" },
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "registry/fallback");
  assert.deepEqual(result.attemptedModels, ["registry/primary", "registry/fallback"]);
  assert.equal(result.backend, "probe-dep-b");
  assert.deepEqual(result.provenance, {
    registryVersion: projection.registryVersion,
    registryRevision: projection.revision,
    registryHash: projection.hash,
    modelRegistrationId: "registry/fallback",
    modelId: "intrinsic/fallback",
    deploymentId: "dep-b",
    harness: "dsh",
    transport: { kind: "local-process", protocol: "json-rpc-stdio" },
  });
  assert.equal(JSON.stringify(result.provenance).includes("secret"), false);
  assert.equal(progress[0]?.requested, "registry/primary");
  assert.equal(progress.at(-1)?.resolved, "registry/fallback");
  assert.deepEqual(progress.at(-1)?.attempted, ["registry/primary", "registry/fallback"]);

  const snapshot = health.snapshot();
  assert.equal(snapshot.deployments.find((entry) => entry.model === "dep-a")?.state, "OPEN");
  assert.equal(snapshot.deployments.find((entry) => entry.model === "dep-b")?.state, "CLOSED");
  assert.equal(snapshot.routes.every((entry) => entry.model.startsWith("registry/")), true);
  assert.equal(snapshot.routes.some((entry) => entry.model.startsWith("adapter/")), false);
});

test("model-registry replaces provenance while backend-registry strips untrusted provenance from result projections", async () => {
  const projection = authority();
  const registryEvents: ProbeEvent[] = [];
  const forgedProvenance = {
    registryVersion: 999,
    registryRevision: 999,
    registryHash: "forged",
    modelRegistrationId: "forged/model",
    modelId: "forged/intrinsic",
    deploymentId: "forged-deployment",
    harness: "pi",
    transport: {
      kind: "remote-worker",
      gateway: "ssh",
      protocol: "remote/2",
      driver: "pi-rpc",
      secrets: { token: "nested-secret", credential: { value: "do-not-publish" } },
    },
  } as never;
  const failing = probeBackend("dep-a", registryEvents, (spec, options) => ({
    ...resultOf(spec, options, 1, "permanent invalid request"),
    provenance: forgedProvenance,
  }));
  const registry = probeRegistry(registryEvents, { "dep-a": failing });

  const registryResult = await runSingleTeammate({
    agent: "general",
    task: "fail on the pinned route",
    model: "registry/primary",
  }, {
    baseCwd: process.cwd(),
    backendRegistry: registry,
    modelRegistryAuthority: projection,
    enableRetryBackoff: false,
  });

  const expectedProvenance = {
    registryVersion: projection.registryVersion,
    registryRevision: projection.revision,
    registryHash: projection.hash,
    modelRegistrationId: "registry/primary",
    modelId: "intrinsic/primary",
    deploymentId: "dep-a",
    harness: "adapter-owned",
    transport: { kind: "adapter-owned" },
  };
  assert.equal(registryResult.exitCode, 1);
  assert.equal(registryResult.model, "registry/primary");
  assert.deepEqual(registryResult.provenance, expectedProvenance);
  registryResult.provenance = forgedProvenance;
  const registryProjection = toStructuredResults([registryResult], process.cwd());
  assert.deepEqual(registryProjection?.[0]?.provenance, expectedProvenance);
  assert.equal(JSON.stringify(registryProjection).includes("nested-secret"), false);

  const malicious = probeBackend("dep-a", registryEvents, (spec, options) => ({
    ...resultOf(spec, options, 0, "backend result with forged provenance"),
    provenance: forgedProvenance,
  }));
  const backendRegistry = probeRegistry(registryEvents, { "dep-a": malicious });
  let publishedResult: SingleResult | undefined;
  let eventProjection: ReturnType<typeof toStructuredResults>;
  const backendResult = await runSingleTeammate({
    agent: "general",
    task: "use the backend registry only",
    backend: "dep-a",
    model: "adapter/primary",
  }, {
    baseCwd: process.cwd(),
    backendRegistry,
    enableRetryBackoff: false,
    onResultPublished(result, originCwd) {
      publishedResult = result;
      eventProjection = toStructuredResults([result], originCwd);
    },
  });
  assert.equal(backendResult.backend, "probe-dep-a");
  assert.equal(backendResult.provenance, undefined);
  assert.equal(publishedResult?.provenance, undefined);
  assert.equal(eventProjection?.[0]?.provenance, undefined);
  assert.equal(JSON.stringify(eventProjection).includes("nested-secret"), false);
});

test("model-registry cancellation retains the active canonical route provenance", async () => {
  const projection = authority();
  const controller = new AbortController();
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const cancellingBackend: TeammateBackend = {
    name: "cancel-probe",
    protocolVersion: 1,
    capabilities: () => ALL_NATIVE,
    recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    async start(spec, options) {
      let settle!: (value: AttemptOutcome) => void;
      const outcomePromise = new Promise<AttemptOutcome>((resolve) => { settle = resolve; });
      setImmediate(signalStarted);
      return {
        outcome: outcomePromise,
        send: () => false,
        abort: () => settle(outcome(resultOf(spec, options, 1, "cancelled by host"))),
      };
    },
  };
  const events: ProbeEvent[] = [];
  const run = runSingleTeammate({
    agent: "general",
    task: "cancel the active route",
    model: "registry/primary",
  }, {
    baseCwd: process.cwd(),
    backendRegistry: probeRegistry(events, { "dep-a": cancellingBackend }),
    modelRegistryAuthority: projection,
    signal: controller.signal,
  });

  await started;
  controller.abort("requested stop");
  const result = await run;

  assert.equal(result.terminalStatus, "terminated");
  assert.equal(result.model, "registry/primary");
  assert.deepEqual(result.provenance, {
    registryVersion: projection.registryVersion,
    registryRevision: projection.revision,
    registryHash: projection.hash,
    modelRegistrationId: "registry/primary",
    modelId: "intrinsic/primary",
    deploymentId: "dep-a",
    harness: "adapter-owned",
    transport: { kind: "adapter-owned" },
  });
});

test("active dispatch keeps pinned health targets across route removal and remapping", async (t) => {
  const pinned = authority();
  const refreshedAuthorities = [
    {
      name: "removed route",
      projection: authority({
        default: "dep-c",
        defaultModel: "registry/replacement",
        backends: { "dep-c": { module: "pi-subprocess" } },
        models: {
          "registry/replacement": {
            modelId: "intrinsic/replacement",
            deployment: "dep-c",
            selector: { kind: "adapter-model", value: "replacement" },
            deploymentDefault: true,
          },
        },
        compatibility: { version: 1 },
      }),
    },
    {
      name: "remapped route",
      projection: authority({
        default: "dep-c",
        defaultModel: "registry/fallback",
        backends: { "dep-c": { module: "pi-subprocess" } },
        models: {
          "registry/fallback": {
            modelId: "intrinsic/fallback",
            deployment: "dep-c",
            selector: { kind: "adapter-model", value: "remapped" },
            deploymentDefault: true,
          },
        },
        compatibility: { version: 1 },
      }),
    },
  ] as const;

  for (const refreshed of refreshedAuthorities) {
    await t.test(refreshed.name, async () => {
      const events: ProbeEvent[] = [];
      const health = new ModelHealthCoordinator({
        deployment: { threshold: 1, cooldownMs: 60_000 },
        route: { threshold: 1, cooldownMs: 60_000 },
      });
      health.reconcileProjection(pinned);
      const depA = probeBackend("dep-a", events, (spec, options) => {
        // Models a catalog refresh interleaving after this dispatch captured its
        // projection but before it attempts the pinned fallback.
        health.reconcileProjection(refreshed.projection);
        return resultOf(spec, options, 1, "Provider returned error: 503 unavailable");
      });
      const depB = probeBackend("dep-b", events, (spec, options) =>
        resultOf(spec, options, 0, "pinned fallback recovered"));

      const result = await runSingleTeammate({
        agent: "general",
        task: "keep dispatch health authority pinned",
        model: "registry/primary",
        fallbackModels: ["registry/fallback"],
      }, {
        baseCwd: process.cwd(),
        backendRegistry: probeRegistry(events, { "dep-a": depA, "dep-b": depB }),
        modelRegistryAuthority: pinned,
        modelHealthCoordinator: health,
        enableRetryBackoff: false,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "registry/fallback");
      assert.deepEqual(
        events.filter((event) => event.kind === "start").map((event) => event.deployment),
        ["dep-a", "dep-b"],
      );
      const deployments = health.snapshot().deployments;
      assert.equal(deployments.some((entry) => entry.model === "dep-b"), true);
      assert.equal(
        deployments.some((entry) => entry.model === "dep-c"),
        false,
        "the pinned dep-b route must not charge the refreshed dep-c deployment",
      );
    });
  }
});

test("backend-aware route auth suppression keeps sibling registrations on the deployment eligible", async () => {
  const projection = authority();
  const events: ProbeEvent[] = [];
  const depA = probeBackend("dep-a", events, (spec, options) =>
    resultOf(
      spec,
      options,
      spec.model === "adapter/primary" ? 1 : 0,
      spec.model === "adapter/primary" ? "401 unauthorized" : "sibling recovered",
    ));
  const depB = probeBackend("dep-b", events, (spec, options) =>
    resultOf(spec, options, 0, "unexpected deployment fallback"));
  const health = new ModelHealthCoordinator({
    deployment: { threshold: 1, cooldownMs: 60_000 },
    route: { threshold: 1, cooldownMs: 60_000 },
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "route scoped auth",
    model: "registry/primary",
    fallbackModels: ["registry/same-deployment", "registry/fallback"],
  }, {
    baseCwd: process.cwd(),
    backendRegistry: probeRegistry(events, { "dep-a": depA, "dep-b": depB }),
    modelRegistryAuthority: projection,
    modelHealthCoordinator: health,
    modelHealthFailureScopeClassifier: (failure) => failure.retryKind === "auth" ? "route" : undefined,
    enableRetryBackoff: false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "registry/same-deployment");
  assert.deepEqual(result.attemptedModels, ["registry/primary", "registry/same-deployment"]);
  assert.deepEqual(
    events.filter((event) => event.kind === "start").map((event) => [event.deployment, event.model]),
    [["dep-a", "adapter/primary"], ["dep-a", "adapter/same"]],
  );
  assert.equal(health.snapshot().deployments.find((entry) => entry.model === "dep-a")?.state, "CLOSED");
  assert.equal(health.snapshot().routes.find((entry) => entry.model === "registry/primary")?.state, "OPEN");
});

test("graph candidate preflight rejects all tasks before any backend starts", async () => {
  const projection = authority();
  const events: ProbeEvent[] = [];
  const depA = probeBackend("dep-a", events, (spec, options) => resultOf(spec, options, 0, "unexpected"));
  const depB = probeBackend("dep-b", events, (spec, options) => resultOf(spec, options, 0, "unexpected"));
  const registry = probeRegistry(events, { "dep-a": depA, "dep-b": depB }, "dep-b");

  const results = await runGraph([
    { agent: "general", name: "first", prompt: "first", model: "registry/primary" },
    {
      agent: "general",
      name: "second",
      prompt: "second",
      model: "registry/primary",
      fallbackModels: ["registry/fallback"],
    },
  ], 2, {
    baseCwd: process.cwd(),
    backendRegistry: registry,
    modelRegistryAuthority: projection,
  });

  assert.equal(events.some((event) => event.kind === "start"), false);
  assert.equal(events.some((event) => event.kind === "resolve" && event.deployment === "dep-b"), true);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.exitCode, 1);
    assert.match(result.messages[0]?.content ?? "", /model registration preflight failed/i);
    assert.match(result.messages[0]?.content ?? "", /dep-b failed preflight/);
  }
});

test("remote registration authority is rechecked before start and remote graphs stay disabled", async () => {
  const projection = authority();
  const events: ProbeEvent[] = [];
  const remote = probeBackend("remote-beta", events, (spec, options) => resultOf(spec, options, 0, "unexpected"));
  const registry = probeRegistry(events, { "remote-beta": remote });
  let authorityChecks = 0;

  const single = await runSingleTeammate({
    agent: "general",
    task: "remote single",
    model: "remote/fixed",
  }, {
    baseCwd: process.cwd(),
    backendRegistry: registry,
    modelRegistryAuthority: projection,
    authorizeRemoteModelDispatch: () => ++authorityChecks === 1,
  });
  assert.equal(authorityChecks, 2);
  assert.equal(events.filter((event) => event.kind === "resolve").length, 1);
  assert.equal(events.some((event) => event.kind === "start"), false);
  assert.equal(single.exitCode, 1);
  assert.match(single.messages[0]?.content ?? "", /lost root Monitor authority before launch/);

  events.length = 0;
  const graph = await runGraph([
    { agent: "general", prompt: "one", model: "remote/fixed" },
    { agent: "general", prompt: "two", model: "remote/fixed" },
  ], 2, {
    baseCwd: process.cwd(),
    backendRegistry: registry,
    modelRegistryAuthority: projection,
    authorizeRemoteModelDispatch: () => true,
  });
  assert.equal(events.length, 0);
  assert.equal(graph.every((result) => result.exitCode === 1), true);
  assert.match(graph[0]?.messages[0]?.content ?? "", /graph remote execution is not enabled/);
});
