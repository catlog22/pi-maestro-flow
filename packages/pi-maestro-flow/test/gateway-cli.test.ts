import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main } from "../src/gateway/cli.ts";
import { locateGatewayBinary, resetGatewayBinaryCache } from "../src/gateway/control-client.ts";
import { requestGatewayIpcControl } from "../src/gateway/ipc.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const bin = join(packageRoot, "bin", "pi-maestro-gateway.mjs");

function cleanEnv(home?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(home ? { HOME: home, USERPROFILE: home } : {}),
    NO_COLOR: "1",
  };
}

test("packaged CLI reports machine-readable identity through its jiti wrapper", () => {
  const result = spawnSync(process.execPath, [bin, "version", "--json"], {
    cwd: packageRoot,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout) as { name: string; version: string; protocolVersion: number };
  assert.equal(value.name, "pi-maestro-gateway");
  assert.match(value.version, /^\d+\.\d+\.\d+/);
  assert.equal(value.protocolVersion, 1);
});

test("binary locator falls back to the packaged CLI without a PATH install", (t) => {
  const previousOfficial = process.env.PI_MAESTRO_GATEWAY_BIN;
  const previousLegacy = process.env.MCPX_BIN;
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousOfficial === undefined) delete process.env.PI_MAESTRO_GATEWAY_BIN;
    else process.env.PI_MAESTRO_GATEWAY_BIN = previousOfficial;
    if (previousLegacy === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previousLegacy;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    resetGatewayBinaryCache();
  });
  delete process.env.PI_MAESTRO_GATEWAY_BIN;
  delete process.env.MCPX_BIN;
  process.env.PATH = "";
  resetGatewayBinaryCache();

  const located = locateGatewayBinary();
  assert.ok(located);
  assert.equal(located.path, bin);
  assert.equal(located.source, "package");
  assert.equal(located.command, process.execPath);
  assert.deepEqual(located.argsPrefix, [bin]);
});

test("connect --stdio reports one deterministic offline error", async () => {
  const home = await mkdtemp(join(tmpdir(), "gateway-cli-offline-"));
  try {
    const result = spawnSync(process.execPath, [bin, "connect", "--stdio"], {
      cwd: packageRoot,
      env: cleanEnv(home),
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "Pi Maestro Gateway is offline. Start it with `pi-maestro-gateway serve`.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("serve returns after authenticated IPC stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    "logging:",
    "  level: silent",
    "",
  ].join("\n"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const serving = main(["serve", "--json", "--config", configPath], { stdout, stderr });
  let owner: { socket: string; ownerToken: string } | undefined;
  for (let attempt = 0; attempt < 50 && !owner; attempt++) {
    try { owner = JSON.parse(await readFile(ownerPath, "utf8")); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(owner, "serve should publish its owner before waiting for shutdown");
  await requestGatewayIpcControl({ address: owner.socket, ownerToken: owner.ownerToken, action: "stop" });
  assert.equal(await serving, 0);
  assert.equal((await readFile(ownerPath, "utf8").catch(() => undefined)), undefined);
});

test("service help documents ensure and Windows Startup persistence", async () => {
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  assert.equal(await main(["help"], { stdout }), 0);
  assert.match(output, /service install\|ensure\|start\|stop\|restart\|status\|uninstall/u);
  assert.match(output, /--windows-startup/u);
  assert.match(output, /next interactive sign-in/u);
  assert.match(output, /not a Windows Service/u);
  assert.match(output, /non-interactive SSH session/u);
  assert.match(output, /workspace list/u);
  assert.match(output, /workspace register/u);
  assert.match(output, /workspace renew/u);
  assert.match(output, /workspace remove/u);
  assert.match(output, /migrate-legacy --dry-run\|--apply/u);
});

test("service selectors are mutually exclusive and failures never emit partial JSON", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  assert.equal(await main(["service", "ensure", "--windows-startup", "--detached-fallback", "--json"], { stdout, stderr }), 1);
  assert.equal(output, "");
  assert.match(errors, /mutually exclusive/u);
});

test("legacy service status keeps its JSON response shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  const unix = (value: string) => value.replace(/\\/g, "/");
  await writeFile(configPath, [
    "transport:",
    "  http:",
    "    enabled: false",
    "state:",
    `  root_dir: "${unix(join(root, "state"))}"`,
    "logging:",
    "  level: silent",
    "",
  ].join("\n"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  assert.equal(await main(["service", "status", "--config", configPath, "--json"], { stdout, stderr }), 0, errors);
  assert.deepEqual(JSON.parse(output), { installed: false, running: false, ready: false, degraded: false, fallback: false });
  assert.equal(output.trim().split("\n").length, 1);
});

test("workspace CLI emits redacted machine JSON and enforces generation fences through IPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-workspace-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
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
  const daemon = new GatewayDaemon({ configPath, cwd: root, http: false });
  await daemon.start();
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });

  const invoke = async (args: string[]) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = "";
    let errors = "";
    stdout.on("data", (chunk) => { output += chunk.toString(); });
    stderr.on("data", (chunk) => { errors += chunk.toString(); });
    const code = await main(args, { stdout, stderr });
    return { code, output, errors };
  };

  const registered = await invoke(["workspace", "register", workspace, "--permanent", "--config", configPath, "--json"]);
  assert.equal(registered.code, 0, registered.errors);
  const record = JSON.parse(registered.output) as { id: string; generation: number; ownerToken?: string };
  assert.equal(record.generation, 1);
  assert.equal(record.ownerToken, undefined);

  const listed = await invoke(["workspace", "list", "--config", configPath, "--json"]);
  assert.equal(listed.code, 0, listed.errors);
  assert.ok((JSON.parse(listed.output) as Array<{ id: string; ownerToken?: string }>).some((entry) => entry.id === record.id && entry.ownerToken === undefined));

  const stale = await invoke(["workspace", "renew", record.id, "--generation", "2", "--ttl", "60", "--config", configPath, "--json"]);
  assert.equal(stale.code, 1);
  assert.equal(stale.output, "");
  assert.match(stale.errors, /stale/u);

  const renewed = await invoke(["workspace", "renew", record.id, "--generation", "1", "--ttl", "60", "--config", configPath, "--json"]);
  assert.equal(renewed.code, 0, renewed.errors);
  assert.equal((JSON.parse(renewed.output) as { ownerToken?: string }).ownerToken, undefined);
  const removed = await invoke(["workspace", "remove", record.id, "--generation", "1", "--config", configPath, "--json"]);
  assert.equal(removed.code, 0, removed.errors);
  assert.deepEqual(JSON.parse(removed.output), { removed: true });
});

test("tunnel CLI exposes the built-in Cloudflare provider through native supervisor state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-cli-tunnel-"));
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
    "logging:",
    "  level: silent",
    "",
  ].join("\n"));
  const daemon = new GatewayDaemon({ configPath, cwd: root, http: false });
  await daemon.start();
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  assert.equal(await main(["tunnel", "status", "cloudflare", "--config", configPath, "--json"], { stdout, stderr }), 0, errors);
  const state = JSON.parse(output) as { provider: string; generation?: number; desiredState: string; observed: { phase: string }; ownerToken?: string };
  assert.equal(state.provider, "cloudflare");
  assert.equal(state.generation, undefined, "an unused provider has no fabricated durable generation");
  assert.equal(state.desiredState, "stopped");
  assert.equal(state.observed.phase, "stopped");
  assert.equal(state.ownerToken, undefined);
});

test("tunnel CLI validates Cloudflare Quick Tunnel flags before IPC", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  assert.equal(await main(["tunnel", "start", "cloudflare", "--local-port", "70000", "--json"], { stdout, stderr }), 1);
  assert.equal(output, "");
  assert.match(errors, /local-port must be in \[1, 65535\]/u);
});

test("package manifest exposes the CLI and stable v1 API without removing source compatibility", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: string[];
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.bin?.["pi-maestro-gateway"], "bin/pi-maestro-gateway.mjs");
  assert.equal(manifest.exports?.["./gateway/v1"], "./src/gateway/public/v1/index.ts");
  assert.equal(manifest.exports?.["./src/*"], "./src/*");
  assert.equal(manifest.dependencies?.jiti, "2.7.0");
  assert.ok(manifest.files?.includes("bin/"));
});
