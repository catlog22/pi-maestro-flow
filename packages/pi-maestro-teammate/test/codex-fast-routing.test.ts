import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyModelRouting, loadModelRoutingState, saveGlobalProfileFastMode, saveProjectFastMode, saveProjectRoleMapping, saveSessionModelRoutingOverrides, validateModelRoutingV3Rules, validateModelRoutingV4Rules } from "../src/models/model-routing.ts";
import { applyCodexFast, resolveChildCodexFast } from "../src/shared/codex-fast.ts";
import { registerChildCodexFast } from "../src/extension/child-codex-fast.ts";
import { parseProxyTeammateParams } from "../src/extension/teammate-proxy.ts";
import { TeammateParams } from "../src/extension/schemas.ts";
import { buildPiArgs, normalizeTeammateParams, singleRunParamsOf } from "../src/runs/execution-infra.ts";
import { runSingleTeammate, runGraph } from "../src/runs/execution.ts";
import { resolveAgent } from "../src/agents/agents.ts";
import type { TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import { createTeammateSettingsProvider } from "../src/settings/teammate-settings-provider.ts";
import { TeammateControlCenter } from "../src/tui/model-mapping-overlay.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-test" };
const payload = { model: "gpt-test", input: [], tools: [{ name: "read" }], instructions: "unchanged", reasoning: { effort: "low" } };
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
function workspace(t: test.TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-fast-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  return { cwd, global: path.join(cwd, "global", "teammate-models.json"), project: path.join(cwd, ".pi", "teammate-models.json") };
}

test("V1/V2/V3 migration preserves model/null/thinking and writes independent V4 Fast maps", (t) => {
  for (const version of [1, 2, 3]) {
    const { cwd, global, project } = workspace(t);
    fs.mkdirSync(path.dirname(global), { recursive: true });
    const rules = { mappings: { analysis: "provider/model", testing: null }, thinkingLevels: { analysis: "high" }, roleMappings: { reviewer: { model: "provider/role", thinking: "low" } } };
    fs.writeFileSync(global, JSON.stringify(version === 3 ? { version, defaultProfile: "default", profiles: { default: { name: "Default", ...rules } } } : { version, ...rules }));
    const before = loadModelRoutingState(cwd, global);
    assert.equal(before.config.version, 4);
    assert.equal(before.config.fastModes, undefined);
    saveProjectFastMode(cwd, "analysis", false, global);
    saveGlobalProfileFastMode(cwd, "default", "testing", true, global);
    const after = loadModelRoutingState(cwd, global);
    assert.deepEqual(after.global.profiles.default.mappings, rules.mappings);
    assert.deepEqual(after.global.profiles.default.thinkingLevels, rules.thinkingLevels);
    assert.deepEqual(after.global.profiles.default.roleMappings, rules.roleMappings);
    assert.deepEqual(after.config.fastModes, { testing: true, analysis: false });
    assert.equal(JSON.parse(fs.readFileSync(project, "utf8")).version, 4);
    assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).version, 4);
  }
});

test("V3 stays strict, V4 rejects invalid Fast grammar without coercing false", () => {
  const rules = { mappings: {}, thinkingLevels: {}, fastModes: { analysis: false }, roleMappings: { reviewer: { fast: null } } };
  assert.throws(() => validateModelRoutingV3Rules(rules), /Unknown/);
  assert.doesNotThrow(() => validateModelRoutingV4Rules(rules));
  for (const fast of ["false", 0, {}, []]) {
    assert.throws(() => validateModelRoutingV4Rules({ ...rules, fastModes: { analysis: fast } }), /Fast/);
    assert.throws(() => validateModelRoutingV4Rules({ ...rules, roleMappings: { reviewer: { fast } } }), /Fast/);
  }
});

test("Fast precedence is task > top-level > taskType > role/frontmatter; null falls through and false is authoritative", (t) => {
  const { cwd, global } = workspace(t);
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "fast-worker.md"), "---\nname: fast-worker\ndescription: fast worker\nfast: true\n---\nKeep prompt\n");
  assert.equal(resolveAgent(cwd, "fast-worker")?.fast, true);
  saveGlobalProfileFastMode(cwd, "default", "analysis", true, global);
  saveProjectRoleMapping(cwd, "fast-worker", { fast: false }, global);
  const route = (extra = {}) => applyModelRouting({ tasks: [{ agent: "fast-worker", prompt: "work", taskType: "analysis" }], ...extra }, cwd, [], global).tasks[0];
  assert.equal(route().fast, true);
  assert.equal(route({ fast: false }).fast, false);
  assert.equal(route({ fast: true, tasks: [{ agent: "fast-worker", prompt: "work", fast: false }] }).fast, false);
  saveProjectFastMode(cwd, "analysis", null, global);
  assert.equal(route().fast, false);
  saveProjectRoleMapping(cwd, "fast-worker", { fast: null }, global);
  assert.equal(route().fast, true);
  saveSessionModelRoutingOverrides(cwd, "session", { mappings: {}, thinkingLevels: {}, fastModes: { analysis: false } }, global);
  assert.equal(applyModelRouting({ tasks: [{ prompt: "work", taskType: "analysis" }] }, cwd, [], global, undefined, "session").tasks[0].fast, false);
});

test("root schema, proxy parsing, normalization and single/chain projection preserve explicit false", () => {
  const params = { fast: true, tasks: [{ prompt: "first", name: "first", fast: false }, { prompt: "{first}", name: "second" }] };
  assert.equal(Check(TeammateParams, params), true);
  const parsed = parseProxyTeammateParams(params)!;
  assert.equal(parsed.fast, true);
  assert.equal(parsed.tasks[0].fast, false);
  const normalized = normalizeTeammateParams(parsed);
  assert.equal(normalized.tasks[0].fast, false);
  assert.equal(normalized.tasks[1].fast, true);
  assert.equal(singleRunParamsOf(normalized.tasks[0], { task: "first" }).fast, false);
  assert.equal(Check(TeammateParams, { ...params, fast: "false" }), false);
  assert.equal(parseProxyTeammateParams({ ...params, tasks: [{ prompt: "x", fast: null }] }), undefined);
  assert.match(normalizeTeammateParams({ ...params, fast: "false" as never }).error!, /boolean/);
});

test("Settings Fast read/save/unset and compensating transaction preserve old bytes and independent fields", async (t) => {
  const { cwd, global, project } = workspace(t);
  fs.mkdirSync(path.dirname(global), { recursive: true });
  const oldGlobal = JSON.stringify({ version: 3, defaultProfile: "default", profiles: { default: { name: "Default", mappings: { analysis: "provider/model" }, thinkingLevels: { analysis: "high" } } } });
  const oldProject = JSON.stringify({ version: 3, applyOverrides: false, overrides: { mappings: {}, thinkingLevels: {} } });
  fs.writeFileSync(global, oldGlobal);
  fs.writeFileSync(project, oldProject);
  const provider = createTeammateSettingsProvider({ getGlobalPath: () => global, discoverTaskTypes: () => ["analysis"], discoverRoles: () => ["reviewer"] });
  const context = { cwd, locale: "en" as const };
  const description = await provider.describe({ context });
  assert.ok(description.settings.some((setting) => setting.key === "role.reviewer.fast" && setting.editor.kind === "boolean"));
  const before = await provider.read({ context });
  const changes = [{ operation: "set" as const, key: "routing.analysis.fast", scope: "global" as const, value: true }, { operation: "set" as const, key: "routing.analysis.fast", scope: "project" as const, value: false }, { operation: "set" as const, key: "role.reviewer.fast", scope: "project" as const, value: false }];
  const prepared = await provider.prepare!({ context, transactionId: "fast", changes, expectedRevisions: before.configured.resources });
  assert.equal(prepared.prepared, true);
  const committed = await provider.commit!({ context, transactionId: "fast", prepareToken: prepared.prepareToken! });
  assert.equal(committed.snapshot.effective.values.find((v) => v.key === "routing.analysis.fast")?.value, false);
  assert.equal(committed.snapshot.effective.values.find((v) => v.key === "role.reviewer.fast")?.value, false);
  assert.equal(loadModelRoutingState(cwd, global).config.thinkingLevels.analysis, "high");
  const rolledBack = await provider.rollback!({ context, transactionId: "fast", prepareToken: prepared.prepareToken!, committedRevisions: committed.revisions });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(fs.readFileSync(global, "utf8"), oldGlobal);
  assert.equal(fs.readFileSync(project, "utf8"), oldProject);
  saveGlobalProfileFastMode(cwd, "default", "analysis", true, global);
  saveProjectFastMode(cwd, "analysis", false, global);
  const snapshot = await provider.read({ context });
  const unset = await provider.prepare!({ context, transactionId: "unset", changes: [{ operation: "unset", key: "routing.analysis.fast", scope: "project" }], expectedRevisions: snapshot.configured.resources });
  const uncommitted = await provider.commit!({ context, transactionId: "unset", prepareToken: unset.prepareToken! });
  assert.equal(uncommitted.snapshot.effective.values.find((v) => v.key === "routing.analysis.fast")?.value, true);
  const invalid = await provider.validate({ context, transactionId: "invalid", changes: [{ operation: "set", key: "routing.analysis.fast", scope: "project", value: "off" }] });
  assert.equal(invalid.valid, false);
});

test("Control Center task and role Fast have inherit/on/off, narrow layout and failure-safe saves", async (t) => {
  const { cwd, global } = workspace(t);
  const values: Array<boolean | null> = [];
  let fail = true;
  const center = new TeammateControlCenter({ cwd, globalFilePath: global, availableModels: [], agents: [], activeAgents: [], theme, requestRender() {}, close() {}, saveFast(_type, fast) { if (fail) throw new Error("save blocked"); values.push(fast); } });
  t.after(() => center.dispose());
  center.handleInput("\r");
  center.handleInput("fast");
  center.handleInput("\r");
  assert.match(center.render(100).join("\n"), /Codex Fast/);
  for (const width of [1, 20, 39, 80]) assert.ok(center.render(width).every((line) => visibleWidth(line) <= width));
  center.handleInput("\x1b[B");
  center.handleInput("\x1b[B");
  center.handleInput("\r");
  await pause();
  assert.match(center.render(100).join("\n"), /Save failed.*save blocked/);
  assert.deepEqual(values, []);
  fail = false;
  center.handleInput("\r");
  await pause();
  assert.deepEqual(values, [false]);
  center.handleInput("fast");
  center.handleInput("\r");
  center.handleInput("\x1b[A");
  center.handleInput("\x1b[A");
  center.handleInput("\r");
  await pause();
  assert.deepEqual(values, [false, null]);
  const role = resolveAgent(cwd, "general")!;
  const roleValues: unknown[] = [];
  const roles = new TeammateControlCenter({ cwd, globalFilePath: global, availableModels: [], agents: [role], activeAgents: [], theme, initialTab: "roles", requestRender() {}, close() {}, saveRoleRules(_role, rules) { roleValues.push(rules); } });
  t.after(() => roles.dispose());
  roles.handleInput("\r"); roles.handleInput("fast"); roles.handleInput("\r"); roles.handleInput("\x1b[B"); roles.handleInput("\r");
  await pause();
  assert.deepEqual(roleValues, [{ fast: true }]);
});

test("child hook honors false over enabled project defaults and isolates every non-Codex request", (t) => {
  const { cwd } = workspace(t);
  fs.writeFileSync(path.join(cwd, ".pi", "codex-fast.json"), '{"enabled":true}');
  const old = process.env.PI_TEAMMATE_CODEX_FAST;
  t.after(() => { if (old === undefined) delete process.env.PI_TEAMMATE_CODEX_FAST; else process.env.PI_TEAMMATE_CODEX_FAST = old; });
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  registerChildCodexFast({ on(name, handler) { handlers.set(name, handler as never); } } as ExtensionAPI);
  const emit = (model = codex) => handlers.get("before_provider_request")!({ payload } as never, { cwd, model } as never);
  delete process.env.PI_TEAMMATE_CODEX_FAST;
  assert.deepEqual(emit(), { ...payload, service_tier: "priority" });
  process.env.PI_TEAMMATE_CODEX_FAST = "false";
  assert.equal(emit(), undefined);
  process.env.PI_TEAMMATE_CODEX_FAST = "true";
  for (const model of [{ ...codex, provider: "anthropic" }, { ...codex, provider: "openai" }, { ...codex, api: "openai-responses" }]) assert.equal(emit(model), undefined);
  assert.equal(applyCodexFast({ ...payload, model: "other" }, codex, true), undefined);
  assert.equal(applyCodexFast({ ...payload, input: {} }, codex, true), undefined);
  assert.equal("service_tier" in payload, false);
  assert.equal(resolveChildCodexFast(cwd, "false"), false);
  const args = buildPiArgs(resolveAgent(cwd, "general")!, { agent: "general", fast: false }, "prompt-file");
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.some((arg) => arg.replaceAll("\\", "/").endsWith("/extension/index.ts")));
  assert.equal(args.includes("--fast"), false);
});

test("child reports malformed Fast config once, caches it, and reloads on session start", (t) => {
  const { cwd } = workspace(t);
  const config = path.join(cwd, ".pi", "codex-fast.json");
  fs.writeFileSync(config, "broken-json");
  const previous = process.env.PI_TEAMMATE_CODEX_FAST;
  delete process.env.PI_TEAMMATE_CODEX_FAST;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_TEAMMATE_CODEX_FAST;
    else process.env.PI_TEAMMATE_CODEX_FAST = previous;
  });
  assert.throws(() => resolveChildCodexFast(cwd, undefined));
  assert.equal(resolveChildCodexFast(cwd, "false"), false);
  assert.equal(resolveChildCodexFast(cwd, "true"), true);
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const warnings: string[] = [];
  registerChildCodexFast({ on(name, handler) { handlers.set(name, handler as never); } } as ExtensionAPI);
  const ctx = { cwd, model: codex, ui: { notify(text: string, level: string) {
    assert.equal(level, "warning");
    warnings.push(text);
  } } };
  const emit = (name: string) => handlers.get(name)!({ payload } as never, ctx as never);
  assert.equal(emit("before_provider_request"), undefined);
  assert.equal(emit("before_provider_request"), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Codex Fast disabled/);
  fs.writeFileSync(config, '{"enabled":true}');
  assert.equal(emit("before_provider_request"), undefined, "config is cached between session starts");
  emit("session_start");
  assert.deepEqual(emit("before_provider_request"), { ...payload, service_tier: "priority" });
});

// Faithful local spawn seam: no provider requests, network, subprocess or authentication.
function spawnRecorder(records: Array<{ args: string[]; fast: string | undefined }>): NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]> {
  return ((_command, args, options) => {
    records.push({ args: [...(args ?? [])], fast: options?.env?.PI_TEAMMATE_CODEX_FAST });
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let closed = false;
    const close = () => { if (closed) return; closed = true; Object.assign(child, { exitCode: 0 }); child.emit("exit", 0, null); child.emit("close", 0, null); };
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), connected: false, exitCode: null, signalCode: null, kill() { queueMicrotask(close); return true; } });
    stdin.once("data", () => queueMicrotask(() => {
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      for (const event of [{ type: "agent_start" }, { type: "turn_start" }, { type: "message_end", message }, { type: "turn_end", message, toolResults: [] }, { type: "agent_end", messages: [message] }]) stdout.write(`${JSON.stringify(event)}\n`);
      setTimeout(close, 10);
    }));
    return child;
  }) as NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]>;
}

test("actual local Pi launch transports on/off/unset and clears inherited overrides", async (t) => {
  const { cwd } = workspace(t);
  const old = process.env.PI_TEAMMATE_CODEX_FAST;
  process.env.PI_TEAMMATE_CODEX_FAST = "true";
  t.after(() => { if (old === undefined) delete process.env.PI_TEAMMATE_CODEX_FAST; else process.env.PI_TEAMMATE_CODEX_FAST = old; });
  const records: Array<{ args: string[]; fast: string | undefined }> = [];
  for (const fast of [false, true, undefined]) {
    const result = await runSingleTeammate({ agent: "general", task: "work", model: "openai-codex/gpt-test", fast }, { baseCwd: cwd, spawnChildProcess: spawnRecorder(records), childPiVersion: "0.99.0", enableRetryBackoff: false });
    assert.equal(result.exitCode, 0, JSON.stringify(result.messages));
  }
  assert.deepEqual(records.map((record) => record.fast), ["false", "true", undefined]);
  assert.ok(records.every((record) => !record.args.includes("--fast")));
});

test("chain execution keeps per-task Fast across dependent child launches", async (t) => {
  const { cwd } = workspace(t);
  const records: Array<{ args: string[]; fast: string | undefined }> = [];
  const tasks = normalizeTeammateParams({ fast: true, tasks: [{ prompt: "first", name: "first", fast: false }, { prompt: "{first}", name: "second" }] }).tasks;
  const results = await runGraph(tasks, 1, { baseCwd: cwd, spawnChildProcess: spawnRecorder(records), childPiVersion: "0.99.0", enableRetryBackoff: false });
  assert.deepEqual(results.map((result) => result.exitCode), [0, 0]);
  assert.deepEqual(records.map((record) => record.fast), ["false", "true"]);
});

test("normalized backend-registry Pi launch preserves explicit false through the backend run spec", async (t) => {
  const { cwd } = workspace(t);
  fs.writeFileSync(path.join(cwd, ".pi", "teammate-backends.json"), JSON.stringify({ mode: "backend-registry", default: "pi-subprocess", backends: {} }));
  const records: Array<{ args: string[]; fast: string | undefined }> = [];
  const result = await runSingleTeammate({ agent: "general", task: "work", fast: false }, { baseCwd: cwd, spawnChildProcess: spawnRecorder(records), childPiVersion: "0.99.0", enableRetryBackoff: false });
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages));
  assert.equal(result.backend, "pi-subprocess");
  assert.deepEqual(records.map((record) => record.fast), ["false"]);
});

test("non-Pi backends receive no Fast field and report the unsupported request rather than pretending it was applied", async (t) => {
  const { cwd } = workspace(t);
  let receivedFast = false;
  const backend: TeammateBackend = {
    name: "cli-probe", protocolVersion: 1, recoveryShape: "replay",
    resolveConfig: (config) => ({ values: config, errors: [] }),
    capabilities: () => ({ outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native", todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native" }),
    async start(spec, options) {
      receivedFast = Object.hasOwn(spec, "fast");
      return { send: () => false, abort() {}, outcome: Promise.resolve({
        result: { agent: spec.agent, task: spec.task, exitCode: 0, messages: [{ role: "assistant", content: "done" }], model: "cli-probe", correlationId: options.correlationId, durationMs: 1, terminalStatus: "completed", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 } },
        recovery: { settlementAuthority: "authoritative", completedToolCount: 0, inFlightToolCount: 0, preActivityInfrastructureExit: false, externalReplayRisk: false },
        reclamation: Promise.resolve({ status: "reclaimed" }),
      }) };
    },
  };
  const registry: BackendRegistry = { resolve: async () => ({ backend, config: {}, capabilities: backend.capabilities({}) }), capabilitiesOf: async () => backend.capabilities({}), listBackendNames: () => [backend.name], defaultBackendName: () => backend.name };
  const result = await runSingleTeammate({ agent: "general", task: "work", fast: true }, { baseCwd: cwd, backendRegistry: registry });
  assert.equal(result.exitCode, 0);
  assert.equal(receivedFast, false);
  assert.ok(result.warnings?.some((warning) => /Fast is not applied/.test(warning)));
});
