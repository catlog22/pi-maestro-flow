import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayMaestroReceiptStore } from "../src/gateway/maestro-cli-receipt-store.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayMaestroCliService } from "../src/gateway/services/maestro-cli-service.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import type { RunCliResult, RunCliRunner } from "../src/session/cli-adapter.ts";

async function fixture(t: test.TestContext, runner: RunCliRunner, permissions = { allowSearch: true, allowLoad: true, allowStage: true }) {
  const root = await mkdtemp(join(tmpdir(), "gateway-maestro-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceId = workspaceIdForPath(root);
  const principal = createGatewayPrincipal("http", "caller", { authenticated: true, workspaceId });
  const policy = new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root }] });
  const receipts = new GatewayMaestroReceiptStore(join(root, ".receipts"));
  const service = new GatewayMaestroCliService({
    policy,
    receipts,
    runner,
    security: { enabled: true, ...permissions },
    maxOutputBytes: 64 * 1024,
    timeoutMs: 5_000,
    resolveStageBinding: async (input) => ({ workflowSessionId: input.workflowSessionId, runId: input.runId, executionAuthorityFile: "/host/authority.json" }),
  });
  return { root, workspaceId, principal, receipts, service };
}

function result(args: readonly string[], stdout: string, exitCode = 0, stderr = ""): RunCliResult {
  return { argv: [...args], stdout, stderr, exitCode };
}

test("maestro_cli search and load use fixed server-built argv and explicit failures", async (t) => {
  const calls: string[][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const runner: RunCliRunner = async (args, _cwd, options) => {
    calls.push([...args]);
    signals.push(options?.signal);
    if (args[0] === "--version") return result(args, "maestro 1.4.0\n");
    if (args[0] === "search") return result(args, JSON.stringify({ query: "fence", count: 1, results: [{ id: "spec:S-1" }] }));
    if (args[0] === "load") return result(args, "# Loaded governing record\n");
    return result(args, "", 1, "unexpected command");
  };
  const { service, principal, workspaceId } = await fixture(t, runner);

  const controller = new AbortController();
  const searched = await service.handle(principal, { action: "search", workspaceId, query: "fence", kind: "spec", limit: 5 }, controller.signal);
  assert.equal(searched.ok, true);
  const loaded = await service.handle(principal, { action: "load", workspaceId, source: "knowledge", kind: "spec", id: "spec:S-1" }, controller.signal);
  assert.equal(loaded.ok, true);
  assert.deepEqual(calls, [
    ["--version"],
    ["search", "fence", "--type", "spec", "--limit", "5", "--json", "--workflow-root", calls[1]![8]!],
    ["load", "--type", "spec", "--id", "spec:S-1"],
  ]);
  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);

  const invalid = await service.handle(principal, { action: "load", workspaceId, source: "knowledge", id: "spec:S-1" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "invalid_arguments");
});

test("runtime catalog dispatches typed maestro_cli reads and forwards cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-maestro-runtime-"));
  const workspaceId = workspaceIdForPath(root);
  const principal = createGatewayPrincipal("http", "caller", { authenticated: true, workspaceId });
  const signals: Array<AbortSignal | undefined> = [];
  const runner: RunCliRunner = async (args, _cwd, options) => {
    signals.push(options?.signal);
    if (args[0] === "--version") return result(args, "1.2.3\n");
    return result(args, JSON.stringify({ query: "typed", count: 0, results: [] }));
  };
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "secret" });
  config.security.maestroCli = { enabled: true, allowSearch: true, allowLoad: true, allowStage: false };
  const runtime = await GatewayRuntime.create({ config, cwd: root, maestroRunner: runner });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const searched = await runtime.call("maestro_cli", { action: "search", workspaceId, query: "typed" }, principal, controller.signal);
  assert.equal(searched.ok, true);
  assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test("maestro_cli stage keeps content private and replays a committed receipt without restaging", async (t) => {
  let stageCalls = 0;
  let contentPath = "";
  const runner: RunCliRunner = async (args) => {
    if (args[0] === "--version") return result(args, "2.0.0\n");
    stageCalls += 1;
    assert.deepEqual(args.slice(0, 4), ["knowledge", "stage", "knowhow", "Cache authorization rule"]);
    const marker = args.indexOf("--content-file");
    assert.ok(marker > 0);
    contentPath = args[marker + 1]!;
    assert.equal(args.includes("reauthorize every cache hit"), false);
    assert.equal(await readFile(contentPath, "utf8"), "reauthorize every cache hit");
    if (process.platform !== "win32") assert.equal((await stat(contentPath)).mode & 0o777, 0o600);
    return result(args, JSON.stringify({ session_id: "workflow-1", candidate_id: "KDC-1234567890abcdef", signal_recorded: 0 }));
  };
  const { service, principal, workspaceId, receipts } = await fixture(t, runner);
  const request = {
    action: "stage" as const,
    workspaceId,
    operationId: "stage-1",
    kind: "knowhow" as const,
    title: "Cache authorization rule",
    content: "reauthorize every cache hit",
    workflowSessionId: "workflow-1",
    evidence: ["test:gateway-maestro-cli"],
  };
  const first = await service.handle(principal, request);
  assert.equal(first.ok, true);
  const replay = await service.handle(principal, request);
  assert.equal(replay.ok, true);
  assert.equal(stageCalls, 1);
  assert.equal((await receipts.get(workspaceId, "stage-1"))?.state, "committed");
  await assert.rejects(() => stat(contentPath), { code: "ENOENT" });

  const mismatch = await service.handle(principal, { ...request, content: "different payload" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error?.code, "operation_conflict");
});

test("maestro_cli receipt creation fences concurrent service instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-maestro-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceId = workspaceIdForPath(root);
  const principal = createGatewayPrincipal("http", "caller", { authenticated: true, workspaceId });
  const policy = new GatewayPolicy({ workspaceRoot: root, workspaces: [{ path: root }] });
  let stageCalls = 0;
  const runner: RunCliRunner = async (args) => {
    if (args[0] === "--version") return result(args, "1.0.0\n");
    stageCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return result(args, JSON.stringify({ session_id: "workflow-1", candidate_id: "KDC-race", signal_recorded: 0 }));
  };
  const security = { enabled: true, allowSearch: true, allowLoad: true, allowStage: true };
  const resolveStageBinding = async (input: { workflowSessionId?: string; runId?: string }) => ({ workflowSessionId: input.workflowSessionId, runId: input.runId, executionAuthorityFile: "/host/authority.json" });
  const serviceA = new GatewayMaestroCliService({ policy, security, runner, receipts: new GatewayMaestroReceiptStore(join(root, ".receipts")), resolveStageBinding });
  const serviceB = new GatewayMaestroCliService({ policy, security, runner, receipts: new GatewayMaestroReceiptStore(join(root, ".receipts")), resolveStageBinding });
  const request = { action: "stage" as const, workspaceId, operationId: "race", kind: "knowhow" as const, title: "Race", content: "one payload", workflowSessionId: "workflow-1", evidence: ["test:race"] };
  const outcomes = await Promise.all([serviceA.handle(principal, request), serviceB.handle(principal, request)]);
  assert.equal(stageCalls, 1);
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1);
  assert.equal(outcomes.filter((entry) => entry.error?.code === "maestro_cli_uncertain").length, 1);
});

test("maestro_cli marks failed stage execution uncertain and never retries blindly", async (t) => {
  let stageCalls = 0;
  const runner: RunCliRunner = async (args) => {
    if (args[0] === "--version") return result(args, "1.0.0\n");
    stageCalls += 1;
    return result(args, "", 1, "connection ended after request submission");
  };
  const { service, principal, workspaceId, receipts } = await fixture(t, runner);
  const request = {
    action: "stage" as const,
    workspaceId,
    operationId: "uncertain-1",
    kind: "spec" as const,
    title: "A decision",
    content: "decision content",
    runId: "run-1",
    evidence: ["test:uncertain"],
  };
  const first = await service.handle(principal, request);
  assert.equal(first.ok, false);
  assert.equal(first.error?.code, "maestro_cli_uncertain");
  const replay = await service.handle(principal, request);
  assert.equal(replay.ok, false);
  assert.equal(replay.error?.code, "maestro_cli_uncertain");
  assert.equal(stageCalls, 1);
  assert.equal((await receipts.get(workspaceId, "uncertain-1"))?.state, "uncertain");
});

test("maestro_cli fails closed for permissions, unsupported providers, versions, and malformed JSON", async (t) => {
  const malformed: RunCliRunner = async (args) => args[0] === "--version"
    ? result(args, "0.9.0\n")
    : result(args, "not-json");
  const old = await fixture(t, malformed);
  const oldService = new GatewayMaestroCliService({
    policy: new GatewayPolicy({ workspaceRoot: old.root, workspaces: [{ path: old.root }] }),
    receipts: old.receipts,
    runner: malformed,
    security: { enabled: true, minimumVersion: "1.0.0", allowSearch: true, allowLoad: true, allowStage: true },
  });
  const unsupported = await oldService.handle(old.principal, { action: "search", workspaceId: old.workspaceId, query: "x" });
  assert.equal(unsupported.error?.code, "unsupported_cli");

  const current = await fixture(t, async (args) => args[0] === "--version" ? result(args, "1.2.3\n") : result(args, "not-json"));
  const badJson = await current.service.handle(current.principal, { action: "search", workspaceId: current.workspaceId, query: "x" });
  assert.equal(badJson.ok, false);
  assert.notEqual((badJson.data as { results?: unknown[] } | undefined)?.results?.length, 0);
  const handoff = await current.service.handle(current.principal, { action: "search", workspaceId: current.workspaceId, query: "x", source: "handoff" });
  assert.equal(handoff.error?.code, "unsupported_source");

  const denied = await fixture(t, async (args) => result(args, args[0] === "--version" ? "1.2.3\n" : "{}"), { allowSearch: false, allowLoad: false, allowStage: false });
  assert.equal((await denied.service.handle(denied.principal, { action: "search", workspaceId: denied.workspaceId, query: "x" })).error?.code, "maestro_cli_denied");

  const noResolver = new GatewayMaestroCliService({
    policy: new GatewayPolicy({ workspaceRoot: current.root, workspaces: [{ path: current.root }] }),
    receipts: current.receipts,
    runner: async (args) => result(args, args[0] === "--version" ? "1.2.3\n" : "{}"),
    security: { enabled: true, allowSearch: true, allowLoad: true, allowStage: true },
  });
  const identityFailure = await noResolver.handle(current.principal, {
    action: "stage", workspaceId: current.workspaceId, operationId: "no-binding", kind: "spec",
    title: "No binding", content: "must fail closed", workflowSessionId: "collaboration-session", evidence: ["test:no-binding"],
  });
  assert.equal(identityFailure.error?.code, "workflow_identity_unavailable");
});
