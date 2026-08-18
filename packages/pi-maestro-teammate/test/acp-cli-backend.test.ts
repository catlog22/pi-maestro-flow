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

test("acp-cli refuses a model that is not the route this registration serves", async () => {
  const launches: RunLocalCliToolParams[] = [];
  const backend = createAcpCliBackend(async (params) => {
    launches.push(params);
    return CLEAN_RUN;
  });
  await assert.rejects(
    () => backend.start(specOf({ model: "cli/other" }), runOptionsOf(LOCAL_CONFIG)),
    (error: Error) => error.message.includes("cli/mock") && error.message.includes("cli/other"),
  );
  assert.equal(launches.length, 0);
  // The route it does serve reaches the CLI under that tool name.
  const run = await backend.start(specOf({ model: "cli/mock" }), runOptionsOf(LOCAL_CONFIG));
  await run.outcome;
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.tool, "mock");
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
