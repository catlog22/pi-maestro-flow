import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { GatewayTunnelProviderRequest } from "../src/gateway/tunnel/contracts.ts";
import { createGatewayTunnelDeadline, probeGatewayTunnel } from "../src/gateway/tunnel/probe.ts";
import {
  OPENAI_TUNNEL_CLIENT_CONTRACT,
  isSupportedOpenAiTunnelClientVersion,
  parseOpenAiTunnelClientVersion,
  renderOpenAiTunnelClientConfig,
} from "../src/gateway/tunnel/providers/openai-client-contract.ts";
import { OpenAiTunnelProvider, redactOpenAiTunnelText, type OpenAiTunnelCommandResult } from "../src/gateway/tunnel/providers/openai.ts";

const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const runtimeKey = "rk-runtime-secret-0123456789";
const gatewayToken = "gateway-secret-token-0123456789";
const request: GatewayTunnelProviderRequest = {
  provider: "openai",
  instance: "default",
  generation: 1,
  ownerToken: "owner-token-00000001",
};

function fakeChild(pid = 51001): ChildProcess & { setExit(code: number | null, signal?: NodeJS.Signals | null): void } {
  const child = new EventEmitter() as ChildProcess & { setExit(code: number | null, signal?: NodeJS.Signals | null): void };
  Object.assign(child, {
    pid,
    stdout: null,
    stderr: null,
    stdin: null,
    stdio: [],
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "tunnel-client",
    channel: undefined,
    unref() {},
    ref() {},
    kill() { child.killed = true; return true; },
    disconnect() {},
    send() { return false; },
    setExit(code: number | null, signal: NodeJS.Signals | null = null) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    },
  });
  return child;
}

async function fixture(t: test.TestContext, options: {
  version?: string;
  doctor?: OpenAiTunnelCommandResult;
  fetch?: typeof fetch;
  child?: ReturnType<typeof fakeChild>;
  enabled?: boolean;
  runCommand?: (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<OpenAiTunnelCommandResult>;
  processAlive?: () => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-openai-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
  await writeFile(binary, "fake executable");
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let configPath: string | undefined;
  const child = options.child ?? fakeChild();
  const revoked: string[] = [];
  const runCommand = options.runCommand ?? (async (_command: string, args: readonly string[], commandOptions: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: commandOptions.env });
    if (args[0] === "--version") return { code: 0, stdout: `tunnel-client v${options.version ?? "0.0.14"}\n`, stderr: "" };
    configPath = String(args[2]);
    return options.doctor ?? { code: 0, stdout: "doctor ok", stderr: "" };
  });
  const provider = new OpenAiTunnelProvider({
    enabled: options.enabled ?? true,
    binaryPath: binary,
    environment: { CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: runtimeKey, OPENAI_ADMIN_KEY: "admin-secret" },
    temporaryRoot: root,
    runCommand: runCommand as never,
    spawn: ((_command: string, _args: readonly string[], _spawnOptions: SpawnOptions) => child) as typeof import("node:child_process").spawn,
    fetch: options.fetch,
    issueGatewayCredential: async (_request, ttlMs) => ({ id: "pair-openai-1", token: gatewayToken, expiresAt: Date.now() + ttlMs }),
    revokeGatewayCredential: async (id) => { revoked.push(id); },
    processAlive: options.processAlive ?? (() => child.exitCode === null && !child.killed),
    signalProcess: options.signalProcess,
    now: options.now,
    platform: "linux",
  });
  return { provider, child, root, binary, calls, revoked, get configPath() { return configPath; } };
}

function deadline(ms = 2_000) { return createGatewayTunnelDeadline(ms); }

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("public CLI contract is explicit, version-gated, and contains references rather than secrets", () => {
  assert.deepEqual(OPENAI_TUNNEL_CLIENT_CONTRACT.versionArgs, ["--version"]);
  assert.deepEqual(OPENAI_TUNNEL_CLIENT_CONTRACT.doctorArgs("/tmp/config"), ["doctor", "--config", "/tmp/config"]);
  assert.deepEqual(OPENAI_TUNNEL_CLIENT_CONTRACT.runArgs("/tmp/config"), ["run", "--config", "/tmp/config"]);
  assert.equal(parseOpenAiTunnelClientVersion("tunnel-client v0.0.14"), "0.0.14");
  assert.equal(isSupportedOpenAiTunnelClientVersion("0.0.14"), true);
  assert.equal(isSupportedOpenAiTunnelClientVersion("0.0.13"), false);
  assert.equal(isSupportedOpenAiTunnelClientVersion("0.1.0"), false);
  const config = renderOpenAiTunnelClientConfig({
    tunnelId,
    mcpUrl: "http://127.0.0.1:9090/mcp",
    authorizationFile: "/private/auth",
    healthUrlFile: "/private/health",
    logFile: "/private/log",
  });
  assert.match(config, /api_key: "env:PI_MAESTRO_OPENAI_TUNNEL_RUNTIME_KEY"/u);
  assert.match(config, /Authorization: "file:\/private\/auth"/u);
  assert.doesNotMatch(config, /gateway-secret|runtime-secret/u);
});

test("experimental, missing, and incompatible doctor states are stable and never download", async (t) => {
  const blocked = await fixture(t, { enabled: false });
  let context = deadline();
  assert.deepEqual(await blocked.provider.doctor(context, request), { ok: false, detail: "experimental_blocked: OpenAI Tunnel is experimental and must be explicitly enabled" });
  context.close();
  assert.equal(blocked.calls.length, 0);

  const missingClient = new OpenAiTunnelProvider({ enabled: true, binaryPath: join(blocked.root, "missing-tunnel-client"), environment: { CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: runtimeKey } });
  context = deadline();
  assert.match((await missingClient.doctor(context, request)).detail ?? "", /client_not_installed/u);
  context.close();
  const missingCredentials = new OpenAiTunnelProvider({ enabled: true, binaryPath: blocked.binary, environment: {} });
  context = deadline();
  assert.match((await missingCredentials.doctor(context, request)).detail ?? "", /credentials_missing/u);
  context.close();

  const incompatible = await fixture(t, { version: "0.0.13" });
  context = deadline();
  const result = await incompatible.provider.doctor(context, request);
  context.close();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /client_version_incompatible/u);
  assert.equal(incompatible.calls.length, 1, "doctor performs only executable identity/version validation before artifacts");
  context = deadline();
  const literal = await incompatible.provider.doctor(context, { ...request, input: { experimental: true, runtimeKey: runtimeKey } });
  context.close();
  assert.equal(literal.ok, false);
  assert.match(literal.detail ?? "", /rejects literal secret/u);
  assert.doesNotMatch(literal.detail ?? "", new RegExp(runtimeKey, "u"));
});

test("fake child conformance injects env-only runtime key and owner-only config/Authorization files", async (t) => {
  let spawnEnv: NodeJS.ProcessEnv | undefined;
  let spawnArgs: readonly string[] = [];
  const child = fakeChild();
  const fx = await fixture(t, { child });
  fx.provider["spawnImpl"] = ((_command: string, args: readonly string[], options: SpawnOptions) => {
    spawnArgs = args;
    spawnEnv = options.env;
    return child;
  }) as never;
  const context = deadline();
  t.after(() => context.close());
  const checked = await fx.provider.doctor(context, request);
  assert.equal(checked.ok, true);
  const started = await fx.provider.start(context, request);
  assert.equal(started.opaqueId, tunnelId);
  assert.deepEqual(spawnArgs.slice(0, 2), ["run", "--config"]);
  assert.equal(spawnEnv?.PI_MAESTRO_OPENAI_TUNNEL_RUNTIME_KEY, runtimeKey);
  assert.equal(spawnEnv?.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(spawnEnv?.OPENAI_ADMIN_KEY, undefined);
  assert.ok(fx.configPath);
  const config = readFileSync(fx.configPath!, "utf8");
  const authorizationPath = config.match(/Authorization: "file:([^"]+)"/u)?.[1];
  assert.ok(authorizationPath);
  assert.equal(readFileSync(authorizationPath!, "utf8"), `Bearer ${gatewayToken}\n`);
  assert.doesNotMatch(config, new RegExp(runtimeKey, "u"));
  assert.doesNotMatch(config, new RegExp(gatewayToken, "u"));
  if (process.platform !== "win32") {
    assert.equal(statSync(fx.configPath!).mode & 0o777, 0o600);
    assert.equal(statSync(authorizationPath!).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(fx.configPath!)).mode & 0o777, 0o700);
  }
});

test("readiness requires local MCP and tunnel-client control-plane /readyz", async (t) => {
  let healthAttempts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:9090/mcp")) {
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${gatewayToken}`);
      return new Response("{}", { status: 200 });
    }
    healthAttempts += 1;
    return new Response("", { status: healthAttempts === 1 ? 503 : 200 });
  };
  const fx = await fixture(t, { fetch: fetchImpl });
  const context = deadline();
  t.after(() => context.close());
  await fx.provider.doctor(context, request);
  const started = await fx.provider.start(context, request);
  const config = readFileSync(fx.configPath!, "utf8");
  const healthPath = config.match(/url_file: "([^"]+)"/u)?.[1];
  assert.ok(healthPath);
  await writeFile(healthPath!, "http://127.0.0.1:43210\n");
  const pending = await fx.provider.probe(context, started, request);
  assert.equal(pending.ready, false);
  assert.match(pending.detail ?? "", /HTTP 503/u);
  const ready = await probeGatewayTunnel(context, () => fx.provider.probe(context, started, request));
  assert.equal(ready.ready, true);
  assert.equal(ready.opaqueId, tunnelId);
  assert.match(ready.detail ?? "", /local: ready; control-plane/u);
});

test("doctor failures and child lifecycle redact secrets, revoke, and remove all temporary artifacts", async (t) => {
  const failed = await fixture(t, { doctor: { code: 7, stdout: "", stderr: `api_key=${runtimeKey} Authorization: Bearer ${gatewayToken}` } });
  let context = deadline();
  await failed.provider.doctor(context, request);
  await assert.rejects(() => failed.provider.start(context, request), (error: Error) => {
    assert.match(error.message, /\[REDACTED\]/u);
    assert.doesNotMatch(error.message, /runtime-secret|gateway-secret/u);
    return true;
  });
  context.close();
  assert.deepEqual(failed.revoked, ["pair-openai-1"]);
  assert.equal(existsSync(failed.configPath!), false);

  const child = fakeChild(51002);
  const running = await fixture(t, { child });
  context = deadline();
  await running.provider.doctor(context, { ...request, generation: 2, ownerToken: "owner-token-00000002" });
  await running.provider.start(context, { ...request, generation: 2, ownerToken: "owner-token-00000002" });
  const directory = dirname(running.configPath!);
  assert.equal(existsSync(directory), true);
  child.setExit(9);
  await until(() => !existsSync(directory) && running.revoked.length === 1);
  assert.deepEqual(running.revoked, ["pair-openai-1"]);
  context.close();
  assert.doesNotMatch(redactOpenAiTunnelText(`token=${gatewayToken} api_key=${runtimeKey}`, [gatewayToken, runtimeKey]), /gateway-secret|runtime-secret/u);
});

test("optional real tunnel-client identity/credential smoke gate", { skip: process.env.PI_MAESTRO_OPENAI_TUNNEL_SMOKE !== "1" }, async () => {
  const binaryPath = process.env.OPENAI_TUNNEL_CLIENT_BIN;
  assert.ok(binaryPath, "OPENAI_TUNNEL_CLIENT_BIN is required for the opt-in smoke gate");
  assert.ok(process.env.CONTROL_PLANE_TUNNEL_ID, "CONTROL_PLANE_TUNNEL_ID is required for the opt-in smoke gate");
  assert.ok(process.env.CONTROL_PLANE_API_KEY, "CONTROL_PLANE_API_KEY is required for the opt-in smoke gate");
  const provider = new OpenAiTunnelProvider({ enabled: true, binaryPath });
  const context = deadline(30_000);
  try {
    const result = await provider.doctor(context, request);
    assert.equal(result.ok, true, result.detail);
  } finally { context.close(); }
});

test("explicit stop uses only the supervisor-verified pid and escalates before cleanup", async (t) => {
  let alive = true;
  let now = 0;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const fx = await fixture(t, {
    processAlive: () => alive,
    signalProcess: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL") alive = false; },
    now: () => { now += 1_000; return now; },
  });
  const context = deadline(5_000);
  t.after(() => context.close());
  const started = await fx.provider.start(context, request);
  await fx.provider.stop(context, {
    pid: started.pid,
    executableRealpath: started.executablePath,
    processStartIdentity: "boot:1",
    invocationDigest: "digest",
    generation: 1,
    ownerToken: request.ownerToken,
  }, { ...request, reason: "explicit" });
  assert.deepEqual(signals, [[-started.pid, "SIGTERM"], [-started.pid, "SIGKILL"]]);
  assert.deepEqual(fx.revoked, ["pair-openai-1"]);
  assert.equal(existsSync(fx.configPath!), false);
});
