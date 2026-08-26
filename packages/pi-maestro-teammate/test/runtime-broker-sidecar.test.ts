import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import { probeRuntimeBrokerCapability } from "../src/runtime-broker/capability.ts";
import {
  acquireRuntimeBrokerDaemonLease,
  runtimeBrokerProcessExists,
} from "../src/runtime-broker/daemon-lease.ts";
import {
  RUNTIME_BROKER_DAEMON_LOCK_FILE,
  canonicalizeRuntimeBrokerWorkspace,
  ensurePrivateRuntimeBrokerDirectory,
  getRuntimeBrokerDatabasePath,
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerStateDirectory,
} from "../src/runtime-broker/private-state.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const brokerBin = path.join(packageRoot, "bin", "pi-teammate-broker.mjs");

function makeStateDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function validLock(pid: number, token: string): string {
  return `${JSON.stringify({ version: 1, pid, token, startedAt: 1 })}\n`;
}

async function waitForBrokerClient(
  stateDirectory: string,
  child: ChildProcess,
  diagnostics: () => string,
): Promise<RuntimeBrokerClient> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`broker exited before readiness: ${diagnostics()}`);
    try {
      return await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 100 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`timed out waiting for broker readiness: ${diagnostics()}`);
}

async function stopDetachedBroker(stateDirectory: string): Promise<void> {
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number };
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(record.pid), "/t", "/f"], { windowsHide: true });
  } else {
    try {
      process.kill(record.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 8_000;
  while (runtimeBrokerProcessExists(record.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(runtimeBrokerProcessExists(record.pid), false, "detached broker must terminate during test cleanup");
}

test("runtime broker state paths are private and Windows pipe names are stable and state-scoped", () => {
  const root = makeStateDirectory("runtime-broker-state-");
  try {
    const stateDirectory = path.join(root, "private");
    ensurePrivateRuntimeBrokerDirectory(stateDirectory);
    const stat = fs.lstatSync(stateDirectory);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);

    const first = getRuntimeBrokerEndpoint(path.join(root, "workspace-a"), "win32");
    const repeated = getRuntimeBrokerEndpoint(path.join(root, "workspace-a"), "win32");
    const second = getRuntimeBrokerEndpoint(path.join(root, "workspace-b"), "win32");
    assert.match(first, /^\\\\\.\\pipe\\pi-teammate-broker-[a-f0-9]{24}$/);
    assert.equal(first, repeated);
    assert.notEqual(first, second);
    assert.throws(
      () => getRuntimeBrokerEndpoint(path.join(root, "x".repeat(150)), "linux"),
      /too long for a Unix-domain socket/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime broker workspace identity canonicalizes Windows case and physical path aliases", () => {
  const root = makeStateDirectory("runtime-broker-workspace-alias-");
  const workspace = path.join(root, "Workspace");
  const symlinkAlias = path.join(root, "workspace-link");
  fs.mkdirSync(workspace);
  try {
    const caseAlias = workspace.toUpperCase();
    assert.equal(
      canonicalizeRuntimeBrokerWorkspace(workspace, "win32"),
      canonicalizeRuntimeBrokerWorkspace(caseAlias, "win32"),
    );
    const stateFromCase = getRuntimeBrokerStateDirectory(workspace, "win32");
    const stateFromCaseAlias = getRuntimeBrokerStateDirectory(caseAlias, "win32");
    assert.equal(stateFromCase, stateFromCaseAlias);
    assert.equal(getRuntimeBrokerEndpoint(stateFromCase, "win32"), getRuntimeBrokerEndpoint(stateFromCaseAlias, "win32"));
    assert.equal(getRuntimeBrokerDatabasePath(stateFromCase), getRuntimeBrokerDatabasePath(stateFromCaseAlias));

    const missing = path.join(root, "missing", "..", "Future-Workspace");
    const missingAlias = path.join(root, "future-workspace");
    assert.equal(
      canonicalizeRuntimeBrokerWorkspace(missing, "win32"),
      canonicalizeRuntimeBrokerWorkspace(missingAlias, "win32"),
    );

    fs.symlinkSync(workspace, symlinkAlias, process.platform === "win32" ? "junction" : "dir");
    const physicalState = getRuntimeBrokerStateDirectory(workspace);
    const aliasState = getRuntimeBrokerStateDirectory(symlinkAlias);
    assert.equal(aliasState, physicalState);
    assert.equal(getRuntimeBrokerEndpoint(aliasState), getRuntimeBrokerEndpoint(physicalState));
    assert.equal(getRuntimeBrokerDatabasePath(aliasState), getRuntimeBrokerDatabasePath(physicalState));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private state rejects a symlink directory", () => {
  const root = makeStateDirectory("runtime-broker-symlink-");
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => ensurePrivateRuntimeBrokerDirectory(link), /not a private directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("daemon lease enforces one instance, recovers a stale PID, and releases only its token", () => {
  const stateDirectory = makeStateDirectory("runtime-broker-lock-");
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  try {
    const first = acquireRuntimeBrokerDaemonLease(stateDirectory, {
      pid: 101,
      token: () => "token-first",
      now: () => 10,
      processExists: () => true,
    });
    assert.throws(
      () => acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 102,
        token: () => "token-second",
        processExists: () => true,
      }),
      /already running/,
    );
    if (process.platform !== "win32") assert.equal(fs.lstatSync(lockPath).mode & 0o777, 0o600);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, validLock(999_999, "token-stale"), { mode: 0o600 });
    const recovered = acquireRuntimeBrokerDaemonLease(stateDirectory, {
      pid: 103,
      token: () => "token-recovered",
      now: () => 20,
      processExists: () => false,
    });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "token-recovered");

    fs.writeFileSync(lockPath, validLock(104, "token-foreign"), "utf8");
    recovered.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "token-foreign");

    fs.writeFileSync(lockPath, validLock(999_999, "token-race"), "utf8");
    assert.throws(
      () => acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 105,
        token: () => "token-new",
        processExists: () => {
          fs.writeFileSync(lockPath, validLock(106, "token-race"), "utf8");
          return false;
        },
      }),
      /changed during stale recovery/,
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 106);

    fs.rmSync(lockPath);
    assert.throws(
      () => acquireRuntimeBrokerDaemonLease(stateDirectory, { token: () => "" }),
      /token must be a bounded non-empty string/,
    );
    assert.equal(fs.existsSync(lockPath), false);
    assert.throws(
      () => acquireRuntimeBrokerDaemonLease(stateDirectory, { now: () => Number.POSITIVE_INFINITY }),
      /start time must be a non-negative safe integer/,
    );
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("daemon lease recovers stable empty and truncated lock crash fixtures after the grace window", () => {
  for (const fixture of ["empty", "truncated"] as const) {
    const stateDirectory = makeStateDirectory(`runtime-broker-lock-${fixture}-crash-`);
    const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
    try {
      const script = fixture === "empty"
        ? "const fs=require('node:fs'); fs.openSync(process.argv[1], 'wx', 0o600);"
        : "const fs=require('node:fs'); const fd=fs.openSync(process.argv[1], 'wx', 0o600); fs.writeSync(fd, '{\\\"version\\\":1');";
      const crashed = spawnSync(process.execPath, ["-e", script, lockPath], { windowsHide: true });
      assert.equal(crashed.status, 0, crashed.stderr?.toString());
      assert.equal(fs.existsSync(lockPath), true);

      assert.throws(
        () => acquireRuntimeBrokerDaemonLease(stateDirectory, {
          pid: 201,
          token: () => `token-${fixture}-too-soon`,
          now: Date.now,
          processExists: () => false,
        }),
        /contended or being initialized/,
      );
      assert.equal(fs.existsSync(lockPath), true, "a fresh incomplete lock must not be stolen from a writer");

      const recovered = acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 202,
        token: () => `token-${fixture}-recovered`,
        now: () => Date.now() + 5_000,
        processExists: () => false,
      });
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, `token-${fixture}-recovered`);
      recovered.release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("capability probe reports node:sqlite and the native IPC transport without writing protocol output", () => {
  const stateDirectory = makeStateDirectory("runtime-broker-capability-");
  try {
    const capability = probeRuntimeBrokerCapability(stateDirectory);
    assert.equal(capability.ok, true, capability.reason ?? "runtime broker capability probe failed");
    assert.equal(capability.sqlite, true);
    assert.equal(capability.protocol, "pi.runtime-broker");
    assert.equal(capability.version, 1);
    assert.equal(capability.endpoint, getRuntimeBrokerEndpoint(stateDirectory));
    assert.equal(capability.transport, process.platform === "win32" ? "named-pipe" : "unix-socket");
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("sidecar import closure contains only Node builtins and driver-neutral Runtime modules", () => {
  const files = [
    ["runtime-broker", "contracts.ts"],
    ["runtime-broker", "sqlite-store.ts"],
    ["runtime-broker", "lease-manager.ts"],
    ["runtime-broker", "private-state.ts"],
    ["runtime-broker", "daemon-lease.ts"],
    ["runtime-broker", "capability.ts"],
    ["runtime-broker", "server.ts"],
    ["runtime-broker", "client.ts"],
    ["runtime-broker", "cli.ts"],
    ["runtime-v2", "contracts.ts"],
    ["runtime-v2", "validation.ts"],
  ] as const;
  for (const [directory, file] of files) {
    const source = fs.readFileSync(path.join(packageRoot, "src", directory, file), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-/);
    const imports = [...source.matchAll(/(?:from\s+|import\()(["'])([^"']+)\1/g)].map((match) => match[2]!);
    for (const specifier of imports) {
      assert.equal(
        specifier.startsWith("node:")
          || specifier.startsWith("./")
          || (directory === "runtime-broker" && specifier === "../runtime-v2/validation.ts"),
        true,
        `${directory}/${file} imports disallowed sidecar dependency ${specifier}`,
      );
    }
  }
  const binSource = fs.readFileSync(brokerBin, "utf8");
  assert.doesNotMatch(binSource, /@earendil-works\/pi-/);
  assert.match(binSource, /import \{ createJiti \} from "jiti"/);
  assert.match(binSource, /jiti\.import\("\.\.\/src\/runtime-broker\/cli\.ts"\)/);
});

test("broker bin probe emits one parseable JSON line and suppresses the SQLite ExperimentalWarning", () => {
  const stateDirectory = makeStateDirectory("runtime-broker-bin-probe-");
  try {
    const result = spawnSync(process.execPath, [brokerBin, "probe", "--state-dir", stateDirectory], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const capability = JSON.parse(lines[0]!) as { ok: boolean; sqlite: boolean; endpoint: string };
    assert.equal(capability.ok, true);
    assert.equal(capability.sqlite, true);
    assert.equal(capability.endpoint, getRuntimeBrokerEndpoint(stateDirectory));
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature|ExperimentalWarning/);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("connectOrStart bootstraps one detached broker for the default SQLite path", { timeout: 15_000 }, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-auto-start-");
  let client: RuntimeBrokerClient | undefined;
  try {
    client = await RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 });
    const lease = await client.acquireLease({
      actorId: "actor-auto-start",
      holderId: "holder-auto-start",
      ttlMs: 1_000,
    });
    assert.equal(lease.actorId, "actor-auto-start");
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), true);
  } finally {
    await client?.close();
    await stopDetachedBroker(stateDirectory);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("broker bin serve starts a real sidecar and accepts an IPC request", { timeout: 15_000 }, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-bin-serve-");
  const child = spawn(process.execPath, [brokerBin, "serve", "--state-dir", stateDirectory], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let client: RuntimeBrokerClient | undefined;
  try {
    client = await waitForBrokerClient(stateDirectory, child, () => stderr);
    const lease = await client.acquireLease({
      actorId: "actor-bin",
      holderId: "holder-bin",
      ttlMs: 1_000,
      now: 10,
    }, "bin-request-1");
    assert.equal(lease.actorId, "actor-bin");
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /SQLite is an experimental feature|ExperimentalWarning/);
  } finally {
    await client?.close();
    if (child.exitCode === null) child.kill();
    await once(child, "exit");
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
