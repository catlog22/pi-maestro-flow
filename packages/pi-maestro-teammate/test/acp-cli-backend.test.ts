import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { TeammateBackendRegistry, resolveBackendConfig, validateBackendCapabilities } from "pi-maestro-backends";
import type { BackendRunOptions, ConfigValue } from "pi-maestro-backend-core/v1";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import acpCliBackend, { createAcpCliBackend, recoveryFactsOf } from "../src/backends/acp-cli.ts";
import type { CliToolRunResult, RunLocalCliToolParams } from "../src/cli-tools/local-acp.ts";
import { buildReplayFence } from "../src/runs/recovery-protocol.ts";

/**
 * The generic ACP-CLI backend.
 *
 * The two load-bearing cases are the capability gate — a schema task must be
 * refused before anything is spawned, which is where the replaced dispatch made
 * the same call from inside the run — and the recovery facts, which are the
 * only evidence the host's replay fence has that a failed CLI run already
 * changed something.
 */

const LOCAL_CONFIG: Record<string, ConfigValue> = { command: "mock-cli", modelId: "cli/mock" };

/** A settled run with no tool activity; cases override only what they assert on. */
const CLEAN_RUN: CliToolRunResult = {
  exitCode: 0,
  messages: [{ role: "assistant", content: "done" }],
  usage: {},
  durationMs: 5,
  terminalStatus: "completed",
  completedTools: [],
  inFlightToolCount: 0,
  sawActivity: true,
  settlementAuthority: "authoritative",
};

function runOptionsOf(config: Record<string, ConfigValue>): BackendRunOptions {
  return {
    correlationId: "corr-1",
    baseCwd: process.cwd(),
    host: {},
    config,
  };
}

function specOf(overrides: Partial<TeammateRunSpec> = {}): TeammateRunSpec {
  return { agent: "coder", task: "do the thing", backend: "mock", ...overrides };
}

/** Resolve a registration's config exactly as the registry would. */
function resolved(config: Record<string, ConfigValue>) {
  return resolveBackendConfig(acpCliBackend, config);
}

test("acp-cli declares outputSchema unsupported and the gate rejects a schema task before start", async () => {
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });
  const spec = specOf({ outputSchema: { type: "object" } });
  const { errors } = validateBackendCapabilities(
    [{ spec }],
    () => ({ name: backend.name, capabilities: backend.capabilities(LOCAL_CONFIG) }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /outputSchema/);
  assert.match(errors[0]!, /acp-cli/);
  // The gate runs before dispatch, so nothing may have been launched.
  assert.equal(launches.length, 0);

  // The same backend without a schema passes, so the gate fires on the
  // requirement rather than on the backend.
  const clean = validateBackendCapabilities(
    [{ spec: specOf() }],
    () => ({ name: backend.name, capabilities: backend.capabilities(LOCAL_CONFIG) }),
  );
  assert.deepEqual(clean.errors, []);
});

test("acp-cli reports completed tool calls so a failed run is fence blocked", async () => {
  const backend = createAcpCliBackend(async () => ({
    ...CLEAN_RUN,
    exitCode: 1,
    terminalStatus: "failed",
    completedTools: ["edit_file", "run_command"],
  }));
  const run = await backend.start(specOf(), runOptionsOf(LOCAL_CONFIG));
  const outcome = await run.outcome;
  assert.equal(outcome.recovery.completedToolCount, 2);
  assert.equal(outcome.recovery.preActivityInfrastructureExit, false);
  const fence = buildReplayFence({
    completedToolCount: outcome.recovery.completedToolCount,
    unknownEffect: outcome.recovery.inFlightToolCount > 0,
  });
  assert.equal(fence.blocked, true);
  assert.match(fence.blockedReason ?? "", /completed tools: 2/);
});

test("acp-cli reports a clean run as unfenced", async () => {
  const backend = createAcpCliBackend(async () => CLEAN_RUN);
  const run = await backend.start(specOf(), runOptionsOf(LOCAL_CONFIG));
  const outcome = await run.outcome;
  assert.equal(outcome.recovery.completedToolCount, 0);
  assert.equal(outcome.recovery.inFlightToolCount, 0);
  assert.equal(outcome.result.terminalStatus, "completed");
  const fence = buildReplayFence({
    completedToolCount: outcome.recovery.completedToolCount,
    unknownEffect: outcome.recovery.inFlightToolCount > 0,
  });
  assert.equal(fence.blocked, false);
});

test("acp-cli treats an unfinished tool as an unknown effect", () => {
  const facts = recoveryFactsOf({
    ...CLEAN_RUN,
    exitCode: 1,
    terminalStatus: "lost",
    inFlightToolCount: 1,
  });
  assert.equal(facts.inFlightToolCount, 1);
  assert.equal(facts.externalReplayRisk, true);
  assert.equal(facts.preActivityInfrastructureExit, false);
  const fence = buildReplayFence({
    completedToolCount: facts.completedToolCount,
    unknownEffect: facts.inFlightToolCount > 0,
  });
  assert.equal(fence.blocked, true);
});

test("acp-cli marks a run that never started as a pre-activity exit", () => {
  const facts = recoveryFactsOf({
    ...CLEAN_RUN,
    exitCode: 1,
    terminalStatus: "failed",
    sawActivity: false,
    settlementAuthority: "unknown",
  });
  assert.equal(facts.preActivityInfrastructureExit, true);
  assert.equal(facts.settlementAuthority, "unknown");
});

test("acp-cli refuses a config env entry that carries a value instead of a name", () => {
  const bad = resolved({ ...LOCAL_CONFIG, env: ["API_KEY=sk-secret"] });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0]!, /API_KEY=/);
  // The value never appears in a message that reaches logs and transcripts.
  assert.doesNotMatch(bad.errors[0]!, /sk-secret/);
  assert.deepEqual(resolved({ ...LOCAL_CONFIG, env: ["API_KEY"] }).errors, []);
});

test("acp-cli refuses ssh mode without host user and hostKeySha256", () => {
  const bad = resolved({ ...LOCAL_CONFIG, mode: "ssh" });
  assert.equal(bad.errors.length, 3);
  for (const key of ["host", "user", "hostKeySha256"]) {
    assert.ok(bad.errors.some((error) => error.includes(`"${key}"`)), `missing ${key}`);
  }
  const good = resolved({
    ...LOCAL_CONFIG,
    mode: "ssh",
    host: "build-01",
    user: "agent",
    hostKeySha256: "abc",
  });
  assert.deepEqual(good.errors, []);
});

test("acp-cli refuses a config without a command", () => {
  const bad = resolveBackendConfig(acpCliBackend, { modelId: "cli/mock" });
  assert.ok(bad.errors.some((error) => error.includes("command")), bad.errors.join("; "));
});

test("acp-cli separates the route axis from the CLI's own model catalogue", async () => {
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });

  // The route names the CLI and nothing further, so no model is selected on the
  // session the CLI opens.
  await (await backend.start(specOf({ model: "cli/mock" }), runOptionsOf(LOCAL_CONFIG))).outcome;
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.tool, "mock");
  assert.equal(launches[0]?.acpModel, undefined);

  // Any other value names a model inside that CLI. It reaches the launch rather
  // than being refused, and it does not change which CLI is launched.
  await (await backend.start(
    specOf({ model: "claude-opus-5[thinking=true]" }),
    runOptionsOf(LOCAL_CONFIG),
  )).outcome;
  assert.equal(launches.length, 2);
  assert.equal(launches[1]?.tool, "mock");
  assert.equal(launches[1]?.acpModel, "claude-opus-5[thinking=true]");
});

test("acp-cli applies the registration's model only when the task names the route", async () => {
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });
  const config: Record<string, ConfigValue> = { ...LOCAL_CONFIG, acpModel: "composer-2.5[fast=true]" };

  // Naming only the route leaves the registration's own default in force.
  await (await backend.start(specOf({ model: "cli/mock" }), runOptionsOf(config))).outcome;
  assert.equal(launches[0]?.acpModel, "composer-2.5[fast=true]");

  // A task naming a model overrides that default, so one registration serves a
  // whole CLI rather than one model of it.
  await (await backend.start(specOf({ model: "grok-4.6[effort=high]" }), runOptionsOf(config))).outcome;
  assert.equal(launches[1]?.acpModel, "grok-4.6[effort=high]");

  // A task naming no model at all still gets the registration's default.
  await (await backend.start(specOf(), runOptionsOf(config))).outcome;
  assert.equal(launches[2]?.acpModel, "composer-2.5[fast=true]");
});

test("acp-cli reports the route it was dispatched under beside the model that ran", async () => {
  const backend = createAcpCliBackend(async () => ({
    ...CLEAN_RUN,
    selectedModel: "composer-2.5[fast=true]",
  }));
  const { result } = await (await backend.start(
    specOf({ model: "cli/mock" }),
    runOptionsOf({ ...LOCAL_CONFIG, acpModel: "composer-2.5" }),
  )).outcome;

  // The host dispatched a route and gets it back under the name it used.
  assert.equal(result.model, "cli/mock");
  // What the CLI ran lives in its own namespace and is reported beside it, so
  // two runs of one registration on different models are told apart.
  assert.equal(result.executorModel, "composer-2.5[fast=true]");
});

test("a run that selected no model reports no executor model rather than repeating the route", async () => {
  const backend = createAcpCliBackend(async () => CLEAN_RUN);
  const { result } = await (await backend.start(
    specOf({ model: "cli/mock" }),
    runOptionsOf(LOCAL_CONFIG),
  )).outcome;

  assert.equal(result.model, "cli/mock");
  // Absent, never the route: the CLI stayed on whatever it treats as current,
  // and copying `model` here would claim knowledge the host does not have.
  assert.equal(result.executorModel, undefined);
});

test("a failed run still reports the model it ran on", async () => {
  const backend = createAcpCliBackend(async () => ({
    ...CLEAN_RUN,
    exitCode: 1,
    terminalStatus: "failed",
    messages: [{ role: "system", content: "the CLI gave up" }],
    selectedModel: "grok-4.6[effort=high]",
  }));
  const { result } = await (await backend.start(specOf(), runOptionsOf(LOCAL_CONFIG))).outcome;

  assert.equal(result.exitCode, 1);
  // Which model failed is the first thing a reader needs, so the selection
  // outlives the turn's outcome.
  assert.equal(result.executorModel, "grok-4.6[effort=high]");
});

test("acp-cli defaults its route to the registration name", async () => {
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });
  const run = await backend.start(
    specOf({ backend: "gemini", model: "cli/gemini" }),
    runOptionsOf({ command: "gemini-acp" }),
  );
  const outcome = await run.outcome;
  assert.equal(launches[0]?.tool, "gemini");
  assert.equal(launches[0]?.config.command, "gemini-acp");
  assert.equal(outcome.result.model, "cli/gemini");
});

test("acp-cli aborts the run signal it handed the launcher", async () => {
  let seen: AbortSignal | undefined;
  let finish!: () => void;
  const launched = new Promise<void>((resolve) => { finish = resolve; });
  const backend = createAcpCliBackend(async (params) => {
    seen = params.signal;
    await launched;
    return CLEAN_RUN;
  });
  const run = await backend.start(specOf(), runOptionsOf(LOCAL_CONFIG));
  // Aborted while the launcher is still running, which is the only moment the
  // host calls it: the combined signal is detached once the run settles.
  assert.equal(seen?.aborted, false);
  run.abort();
  assert.equal(seen?.aborted, true);
  finish();
  await run.outcome;
  assert.equal(run.send("hello", "follow_up"), false);
});

test("acp-cli detaches from the dispatch signal once a run settles", async () => {
  // `options.signal` is the dispatch signal and outlives any single run, so a
  // listener left behind accumulates one per task until Node warns past ten.
  const dispatch = new AbortController();
  const backend = createAcpCliBackend(async () => CLEAN_RUN);
  for (let index = 0; index < 12; index += 1) {
    const run = await backend.start(specOf(), {
      ...runOptionsOf(LOCAL_CONFIG),
      signal: dispatch.signal,
    });
    await run.outcome;
  }
  assert.equal(getEventListeners(dispatch.signal, "abort").length, 0);
});

test("acp-cli is loadable through the registry as a default export", async () => {
  const registry = new TeammateBackendRegistry(
    {
      mode: "backend-registry",
      default: "mock",
      backends: { mock: { module: "pi-maestro-teammate/v1/acp-cli", config: LOCAL_CONFIG } },
    },
    (module) => import(module),
  );
  const capabilities = await registry.capabilitiesOf("mock");
  assert.equal(capabilities.outputSchema, "unsupported");
  assert.equal(capabilities.modelSelection, "native");
  const { backend } = await registry.resolve(specOf(), "mock");
  assert.equal(backend.name, "acp-cli");
  assert.equal(backend.protocolVersion, 1);
});

test("acp-cli refuses a non-positive startup timeout and carries a valid one to the launcher", async () => {
  const bad = resolved({ ...LOCAL_CONFIG, startupTimeoutMs: 0 });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0]!, /"startupTimeoutMs" must be a positive number of milliseconds/);
  assert.deepEqual(resolved({ ...LOCAL_CONFIG, startupTimeoutMs: 60_000 }).errors, []);

  // Validation alone proves nothing about the gap this field exists to close:
  // the value has to reach the launcher, which is where the plumbing stopped.
  // `local-acp.test.ts` pins the launcher-to-driver half.
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });
  await (await backend.start(
    specOf({ model: "cli/mock" }),
    runOptionsOf({ ...LOCAL_CONFIG, startupTimeoutMs: 60_000 }),
  )).outcome;
  assert.equal(launches[0]?.startupTimeoutMs, 60_000);

  // Unset stays unset rather than becoming a literal the backend invented.
  const defaults: RunLocalCliToolParams[] = [];
  const plain = createAcpCliBackend(async (params) => {
    defaults.push(params);
    return CLEAN_RUN;
  });
  await (await plain.start(specOf({ model: "cli/mock" }), runOptionsOf(LOCAL_CONFIG))).outcome;
  assert.equal(defaults[0]?.startupTimeoutMs, undefined);
});

test("acp-cli lists the models the agent itself advertises", async () => {
  // A real executable: listing checks the configured command is launchable
  // before reaching the agent, so an unreachable one never gets that far.
  const probeConfig: Record<string, ConfigValue> = {
    command: process.execPath,
    args: ["--version"],
    modelId: "cli/mock",
  };
  const launched: { command: readonly string[]; cwd: string }[] = [];
  const backend = createAcpCliBackend(
    async () => CLEAN_RUN,
    async (target) => {
      launched.push({ command: target.command, cwd: target.cwd });
      return [{
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "default[]",
        options: [
          { value: "default[]", name: "Auto" },
          { value: "composer-2.5[fast=true]", name: "composer-2.5" },
        ],
      }] as never;
    },
  );

  const options = await backend.listConfigOptions!("acpModel", probeConfig, AbortSignal.timeout(1_000));
  assert.deepEqual(options, [
    { value: "default[]", label: "Auto" },
    { value: "composer-2.5[fast=true]", label: "composer-2.5" },
  ]);
  // The probe launches the same command the run path would, so what an operator
  // picks from is what the configured CLI actually offers.
  assert.deepEqual(launched[0]?.command, [process.execPath, "--version"]);
});

test("acp-cli refuses to list options it does not publish, and remote catalogues it cannot reach", async () => {
  let probes = 0;
  const backend = createAcpCliBackend(
    async () => CLEAN_RUN,
    async () => {
      probes += 1;
      return [];
    },
  );

  await assert.rejects(
    () => backend.listConfigOptions!("runTimeoutMs", LOCAL_CONFIG, AbortSignal.timeout(1_000)),
    (error: Error) => error.message.includes("runTimeoutMs"),
  );

  // An ssh registration's catalogue lives on the far host; answering with the
  // local machine's would be a plausible wrong answer, so it refuses instead.
  await assert.rejects(
    () => backend.listConfigOptions!(
      "acpModel",
      { ...LOCAL_CONFIG, mode: "ssh", host: "build-01", user: "agent", hostKeySha256: "abc" },
      AbortSignal.timeout(1_000),
    ),
    (error: Error) => error.message.includes("ssh"),
  );

  // Neither refusal reached the agent.
  assert.equal(probes, 0);
});

test("acp-cli declaring a dynamic field is a registration error without its lister", () => {
  // The pairing the registry enforces, asserted from this backend's own
  // declaration so a field added later cannot quietly become unlistable.
  const dynamic = (acpCliBackend.configFields ?? []).filter((field) => field.kind === "dynamic-enum");
  assert.ok(dynamic.length > 0, "expected acp-cli to declare at least one dynamic field");
  assert.equal(typeof acpCliBackend.listConfigOptions, "function");
});
