import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { gatewayIpcAddress, requestGatewayIpcControl, startGatewayIpcServer } from "../src/gateway/ipc.ts";
import { GatewayOwnerActiveError, GatewayOwnerStore } from "../src/gateway/owner-store.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function missing(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}

test("selects a platform-native deterministic local IPC address", () => {
  const first = gatewayIpcAddress("/fake/home", "/fake/home/owner.json");
  const second = gatewayIpcAddress("/fake/home", "/fake/home/owner.json");
  assert.equal(first, second);
  if (process.platform === "win32") assert.match(first, /^\\\\\.\\pipe\\pi-maestro-gateway-/);
  else assert.match(first, /pi-maestro-gateway-.*\.sock$/);
});

test("concurrent daemon starts serialize ownership so exactly one instance wins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-concurrent-owner-"));
  const config = createTestGatewayConfig(root);
  const first = new GatewayDaemon({ config, cwd: root, http: false });
  const second = new GatewayDaemon({ config, cwd: root, http: false });
  t.after(async () => {
    await first.stop();
    await second.stop();
    await rm(root, { recursive: true, force: true });
  });
  const settled = await Promise.allSettled([first.start(), second.start()]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof GatewayOwnerActiveError);
});

test("real connect --stdio performs initialize, list, and call through the daemon", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gateway-ipc-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "gateway-ipc-workspace-"));
  const ownerPath = join(home, ".mcpx", "gateway", "v1", "owner.json");
  const config = createTestGatewayConfig(workspace);
  config.state.ownerPath = ownerPath;
  config.state.workspaceRegistryPath = join(home, ".mcpx", "gateway", "v1", "workspaces.json");
  const daemon = new GatewayDaemon({ config, cwd: workspace, http: false });
  t.after(async () => {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  await daemon.start();

  const duplicate = new GatewayDaemon({ config, cwd: workspace, http: false });
  await assert.rejects(() => duplicate.start(), GatewayOwnerActiveError);

  const env = {
    ...getDefaultEnvironment(),
    HOME: home,
    USERPROFILE: home,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "bin", "pi-maestro-gateway.mjs"), "connect", "--stdio"],
    cwd: packageRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "gateway-ipc-test", version: "1" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["host", "exec", "job", "file", "teammate", "session", "todo", "monitor"]);
  const called = await client.callTool({ name: "host", arguments: { action: "test" } });
  const text = called.content[0];
  assert.equal(text?.type, "text");
  const envelope = JSON.parse(text && text.type === "text" ? text.text : "null") as { ok: boolean; data?: { reachable?: boolean } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.reachable, true);
  await client.close();

  await daemon.stop();
  assert.equal(await missing(ownerPath), true);
  if (process.platform !== "win32") assert.equal(await missing(daemon.ipc?.address ?? gatewayIpcAddress(home, ownerPath)), true);
});

test("stale owner state is replaced and graceful stop releases the new generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-stale-owner-"));
  const config = createTestGatewayConfig(root);
  const address = gatewayIpcAddress(root, config.state.ownerPath);
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(config.state.ownerPath!, JSON.stringify({
    version: 1,
    pid: 2_000_000_000,
    ownerToken: "stale-owner-token",
    socket: address,
    commandIdentity: "stale gateway",
    startedAt: 1,
  }));
  const store = new GatewayOwnerStore({
    ownerPath: config.state.ownerPath,
    commandIdentity: "test gateway",
    isProcessAlive: () => false,
  });
  const daemon = new GatewayDaemon({ config, cwd: root, http: false, ownerStore: store, ipcAddress: address, commandIdentity: "test gateway" });
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });
  await daemon.start();
  assert.notEqual(daemon.owner?.ownerToken, "stale-owner-token");
  await daemon.stop();
  assert.equal(await missing(config.state.ownerPath!), true);
});

test("daemon startup safely migrates an exact legacy PID and refuses a duplicate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-legacy-startup-"));
  const config = createTestGatewayConfig(root);
  const pidPath = join(root, "mcpx-server.pid");
  await writeFile(pidPath, "42\n");
  const address = gatewayIpcAddress(root, config.state.ownerPath);
  const store = new GatewayOwnerStore({
    ownerPath: config.state.ownerPath,
    legacyPidPath: pidPath,
    commandIdentity: "pi-maestro-gateway serve",
    isProcessAlive: (pid) => pid === 42,
    getProcessIdentity: () => "pi-maestro-gateway serve",
  });
  const daemon = new GatewayDaemon({
    config,
    ownerStore: store,
    ipcAddress: address,
    commandIdentity: "pi-maestro-gateway serve",
    legacyPidPaths: [pidPath],
  });
  t.after(async () => {
    const owner = await store.read();
    if (owner) await store.release(owner.ownerToken);
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(() => daemon.start(), GatewayOwnerActiveError);
  const migrated = await store.read();
  assert.equal(migrated?.pid, 42);
  assert.equal(migrated?.commandIdentity, "pi-maestro-gateway serve");
});

test("authenticated IPC status works but stop is refused when the server has no control handler", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-control-refuse-"));
  const config = createTestGatewayConfig(root);
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  const address = gatewayIpcAddress(root, join(root, "control-owner.json"));
  const server = await startGatewayIpcServer(runtime, { address, ownerToken: "control-owner-token" });
  t.after(async () => {
    await server.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const status = await requestGatewayIpcControl({ address, ownerToken: "control-owner-token", action: "status" }) as { ok?: boolean };
  assert.equal(status.ok, true);
  await assert.rejects(
    () => requestGatewayIpcControl({ address, ownerToken: "wrong-owner-token", action: "status" }),
    /owner token is invalid/,
  );
  await assert.rejects(
    () => requestGatewayIpcControl({ address, ownerToken: "control-owner-token", action: "stop" }),
    /stop control is unavailable/,
  );
});

test("IPC status stays responsive when the general runtime call path is blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-control-responsive-"));
  const config = createTestGatewayConfig(root);
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  runtime.call = async () => new Promise(() => undefined);
  const address = gatewayIpcAddress(root, join(root, "responsive-owner.json"));
  const server = await startGatewayIpcServer(runtime, { address, ownerToken: "responsive-owner-token" });
  t.after(async () => {
    await server.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const status = await requestGatewayIpcControl({
    address,
    ownerToken: "responsive-owner-token",
    action: "status",
    timeoutMs: 100,
  }) as { ok?: boolean };
  assert.equal(status.ok, true);
});

test("authenticated IPC stop acknowledges before stopping and resolves daemon completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ipc-control-stop-"));
  const config = createTestGatewayConfig(root);
  const daemon = new GatewayDaemon({ config, cwd: root, http: false });
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });
  await daemon.start();
  const owner = daemon.owner!;
  const stopped = daemon.waitUntilStopped();
  const response = await requestGatewayIpcControl({
    address: owner.socket!,
    ownerToken: owner.ownerToken,
    action: "stop",
  }) as { accepted?: boolean; status?: string };
  assert.deepEqual(response, { accepted: true, status: "stopping", pid: process.pid });
  await stopped;
  assert.equal(await missing(config.state.ownerPath!), true);
});
