import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayControlClient, killGatewayProcessTree, type GatewayProcessSpawner } from "../src/gateway/control-client.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { GatewayOwnerStore } from "../src/gateway/owner-store.ts";

async function createConfig(root: string): Promise<{ configPath: string; ownerPath: string }> {
  const configPath = join(root, "config.yaml");
  const ownerPath = join(root, "owner.json");
  const unix = (value: string) => value.replace(/\\/g, "/");
  await writeFile(configPath, [
    "transport:",
    "  http:",
    "    enabled: false",
    "state:",
    `  root_dir: "${unix(join(root, "state"))}"`,
    `  owner_path: "${unix(ownerPath)}"`,
    `  workspace_registry_path: "${unix(join(root, "workspaces.json"))}"`,
    "logging:",
    "  level: silent",
    "",
  ].join("\n"));
  return { configPath, ownerPath };
}

test("GatewayControlClient starts, restarts, and stops through authenticated IPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await createConfig(root);
  const daemons: GatewayDaemon[] = [];
  const spawnProcess: GatewayProcessSpawner = (path, args) => {
    assert.equal(path, "node-test");
    assert.deepEqual(args, ["gateway-script", "serve", "--json", "--config", configPath]);
    const daemon = new GatewayDaemon({ configPath });
    daemons.push(daemon);
    let exitCode: number | null = null;
    void daemon.start().then(() => daemon.waitUntilStopped()).then(() => { exitCode = 0; });
    return {
      get exitCode() { return exitCode; },
      unref() {},
      kill() { void daemon.stop(); return true; },
    };
  };
  const client = new GatewayControlClient({
    configPath,
    binary: {
      path: "gateway-script",
      version: "test",
      source: "package",
      command: "node-test",
      argsPrefix: ["gateway-script"],
    },
    spawnProcess,
    startupTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
  });
  t.after(async () => { await Promise.all(daemons.map((daemon) => daemon.stop())); });

  const [started, joinedStart] = await Promise.all([client.start(), client.start()]);
  assert.equal(started.online, true);
  assert.equal(joinedStart.owner?.ownerToken, started.owner?.ownerToken);
  assert.equal(daemons.length, 1, "concurrent start callers must share one daemon launch");
  const firstOwnerToken = started.owner?.ownerToken;
  assert.equal(typeof firstOwnerToken, "string");

  const restarted = await client.restart();
  assert.equal(restarted.online, true);
  assert.notEqual(restarted.owner?.ownerToken, firstOwnerToken);
  assert.equal(daemons.length, 2);

  assert.equal(await client.stop(), true);
  assert.deepEqual(await client.status(), { online: false });
  await Promise.all(daemons.map((daemon) => daemon.waitUntilStopped()));
});

test("GatewayControlClient startup timeout is a strict wall-clock deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-control-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await createConfig(root);
  let spawnCount = 0;
  let killed = false;
  const client = new GatewayControlClient({
    configPath,
    startupTimeoutMs: 50,
    binary: { path: "gateway-script", version: "test", source: "package" },
    spawnProcess: () => {
      spawnCount++;
      return { exitCode: null, unref() {}, kill() { killed = true; return true; } };
    },
  });

  const startedAt = Date.now();
  await assert.rejects(() => client.start(), /did not become ready within 50ms/);
  assert.ok(Date.now() - startedAt < 500, "a status probe must not overrun the startup deadline");
  assert.equal(spawnCount, 1);
  assert.equal(killed, true);
});

test("GatewayControlClient converts spawn errors into one bounded start failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-control-spawn-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath } = await createConfig(root);
  const client = new GatewayControlClient({
    configPath,
    startupTimeoutMs: 1_000,
    binary: { path: "missing-gateway", version: "test", source: "package" },
    spawnProcess: () => ({
      exitCode: null,
      once(_event, listener) { queueMicrotask(() => listener(new Error("spawn failed"))); },
      unref() {},
      kill() { return true; },
    }),
  });

  const startedAt = Date.now();
  await assert.rejects(() => client.start(), /spawn failed/);
  assert.ok(Date.now() - startedAt < 500);
});

test("POSIX fallback signals the exact detached process group rather than one PID", async () => {
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  let groupAlive = true;
  await killGatewayProcessTree(4242, {
    platform: "linux",
    alive: () => true,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") groupAlive = false;
      if (signal === 0 && !groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  assert.deepEqual(signals, [[-4242, "SIGTERM"], [-4242, 0]]);
});

test("GatewayControlClient refuses fallback stop when exact process identity differs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-control-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { configPath, ownerPath } = await createConfig(root);
  const ownerStore = new GatewayOwnerStore({ ownerPath, commandIdentity: "expected gateway command" });
  const owner = await ownerStore.claim({ commandIdentity: "expected gateway command" });
  t.after(() => ownerStore.release(owner.ownerToken));
  const client = new GatewayControlClient({ configPath, processIdentity: () => "different command" });

  await assert.rejects(() => client.stop(), /exact command identity/);
  assert.equal((await ownerStore.read())?.ownerToken, owner.ownerToken);
});
