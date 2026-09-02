import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RUNTIME_BROKER_SCHEMA_VERSION,
} from "../src/runtime-broker/contracts.ts";
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
  getRuntimeBrokerEndpointWorkspaceId,
  getRuntimeBrokerStateDirectory,
  getRuntimeWorkspaceIdentity,
} from "../src/runtime-broker/private-state.ts";
import { RuntimeBrokerServer } from "../src/runtime-broker/server.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const brokerBin = path.join(packageRoot, "bin", "pi-teammate-broker.mjs");

function makeStateDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function validLock(pid: number, token: string, generation = `generation-${token}`, startedAt = 1): string {
  return `${JSON.stringify({ version: 2, pid, token, generation, startedAt })}\n`;
}

async function listenNet(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
}

async function closeNet(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function delayedProbeEnvelope(endpoint: string, requestId: string, challenge: string): string {
  return `${JSON.stringify({
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result: {
      protocol: RUNTIME_BROKER_PROTOCOL,
      version: RUNTIME_BROKER_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_BROKER_SCHEMA_VERSION,
      workspaceId: getRuntimeBrokerEndpointWorkspaceId(endpoint),
      daemonToken: "late-daemon-token",
      generation: "late-daemon-generation",
      readiness: "ready",
      challenge,
    },
  })}\n`;
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

test("runtime broker Windows tree signalling is bounded and rejects unconfirmed null status", () => {
  const source = fs.readFileSync(new URL("../src/runtime-broker/client.ts", import.meta.url), "utf8");
  const start = source.indexOf("function signalBootstrapProcessTree");
  const end = source.indexOf("function bootstrapProcessTreeExists", start);
  assert.ok(start >= 0 && end > start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /spawnSync\(executable, \["\/PID", String\(pid\), "\/T"/);
  assert.match(implementation, /timeout: BROKER_WINDOWS_TASKKILL_TIMEOUT_MS/);
  assert.match(implementation, /if \(result\.status === null\)/);
  assert.match(implementation, /signal=\$\{result\.signal \?\? "none"\}/);
  assert.match(implementation, /error=\$\{errorCode\}/);
  assert.match(implementation, /result\.status !== 0 && result\.status !== 128/);
  assert.match(implementation, /return result\.status === 0/);
  assert.doesNotMatch(implementation, /result\.status !== null/);

  const reclamationStart = source.indexOf("async function reclaimBootstrapChildOnce");
  const reclamationEnd = source.indexOf("async function waitForPromiseUntil", reclamationStart);
  assert.ok(reclamationStart >= 0 && reclamationEnd > reclamationStart);
  const reclamation = source.slice(reclamationStart, reclamationEnd);
  assert.match(reclamation, /windowsTreeCleanupConfirmed = signalBootstrapProcessTree/);
  assert.match(reclamation, /windowsTreeCleanupConfirmed \|\| bootstrap\.daemonIsLeafProcess/);
  assert.match(reclamation, /was not confirmed reclaimed after forced termination/);
  assert.match(source, /daemonIsLeafProcess = options\.daemonIsLeafProcess \?\? true/);
  assert.match(source, /daemonIsLeafProcess: options\.daemonIsLeafProcess/);
});

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
    const physicalIdentity = getRuntimeWorkspaceIdentity(workspace);
    const aliasIdentity = getRuntimeWorkspaceIdentity(symlinkAlias);
    assert.equal(aliasIdentity.canonicalPath, physicalIdentity.canonicalPath);
    assert.equal(aliasIdentity.workspaceId, physicalIdentity.workspaceId);
    assert.ok(aliasIdentity.legacyWorkspaceIds.length > 0);
    assert.equal(aliasIdentity.legacyWorkspaceIds.includes(aliasIdentity.workspaceId), false);
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

test("daemon lease uses token/generation proof after grace and does not trust a reused PID", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-lock-");
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  try {
    const first = await acquireRuntimeBrokerDaemonLease(stateDirectory, {
      pid: 101,
      token: () => "token-first",
      generation: () => "generation-first",
      now: () => 10,
      processExists: () => true,
    });
    await assert.rejects(
      acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 102,
        token: () => "token-second",
        generation: () => "generation-second",
        now: () => 10,
        processExists: () => true,
      }),
      /already starting/,
    );
    if (process.platform !== "win32") assert.equal(fs.lstatSync(lockPath).mode & 0o777, 0o600);
    assert.doesNotThrow(() => first.assertOwned());
    first.release();
    assert.equal(fs.existsSync(lockPath), false);

    fs.writeFileSync(lockPath, validLock(process.pid, "token-reused-pid", "generation-reused-pid"), { mode: 0o600 });
    const recovered = await acquireRuntimeBrokerDaemonLease(stateDirectory, {
      pid: 103,
      token: () => "token-recovered",
      generation: () => "generation-recovered",
      now: () => 5_000,
      processExists: () => true,
      proveAuthority: () => false,
    });
    const recoveredRecord = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token: string; generation: string };
    assert.equal(recoveredRecord.token, "token-recovered");
    assert.equal(recoveredRecord.generation, "generation-recovered");

    fs.writeFileSync(lockPath, validLock(104, "token-foreign"), "utf8");
    assert.throws(() => recovered.assertOwned(), /lease authority was lost/);
    recovered.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "token-foreign");

    fs.writeFileSync(lockPath, validLock(999_999, "token-race"), "utf8");
    await assert.rejects(
      acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 105,
        token: () => "token-new",
        generation: () => "generation-new",
        now: () => 5_000,
        processExists: () => {
          fs.writeFileSync(lockPath, validLock(106, "token-race"), "utf8");
          return false;
        },
        proveAuthority: () => false,
      }),
      /changed during stale recovery/,
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 106);

    fs.rmSync(lockPath);
    await assert.rejects(
      acquireRuntimeBrokerDaemonLease(stateDirectory, { token: () => "" }),
      /token must be a bounded non-empty string/,
    );
    assert.equal(fs.existsSync(lockPath), false);
    await assert.rejects(
      acquireRuntimeBrokerDaemonLease(stateDirectory, { now: () => Number.POSITIVE_INFINITY }),
      /start time must be a non-negative safe integer/,
    );
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("daemon lease preserves a live lock when authority proof reports a protocol mismatch", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-lock-protocol-mismatch-");
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const originalLock = validLock(process.pid, "protocol-token", "protocol-generation", 1);
  const listener = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        params: { challenge: string };
      };
      socket.write(`${JSON.stringify({
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: {
          protocol: "foreign.runtime-broker",
          version: RUNTIME_BROKER_PROTOCOL_VERSION,
          schemaVersion: RUNTIME_BROKER_SCHEMA_VERSION,
          workspaceId: getRuntimeBrokerEndpointWorkspaceId(endpoint),
          daemonToken: "protocol-token",
          generation: "protocol-generation",
          readiness: "ready",
          challenge: request.params.challenge,
        },
      })}\n`);
    });
  });
  try {
    fs.writeFileSync(lockPath, originalLock, { mode: 0o600 });
    await listenNet(listener, endpoint);
    await assert.rejects(
      acquireRuntimeBrokerDaemonLease(stateDirectory, {
        token: () => "replacement-token",
        generation: () => "replacement-generation",
        now: () => 5_000,
        processExists: () => true,
      }),
      /readiness handshake mismatch/,
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), originalLock);
  } finally {
    await closeNet(listener);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("default daemon proof performs bounded takeover of an unreachable stale authority", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-lock-unreachable-");
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  try {
    fs.writeFileSync(
      lockPath,
      validLock(process.pid, "unreachable-token", "unreachable-generation", 1),
      { mode: 0o600 },
    );
    const startedAt = Date.now();
    const replacement = await acquireRuntimeBrokerDaemonLease(stateDirectory, {
      token: () => "reachable-replacement-token",
      generation: () => "reachable-replacement-generation",
      now: () => 5_000,
      processExists: () => true,
    });
    assert.ok(Date.now() - startedAt < 2_000, "unreachable takeover must stay bounded");
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token: string; generation: string };
    assert.equal(record.token, "reachable-replacement-token");
    assert.equal(record.generation, "reachable-replacement-generation");
    replacement.release();
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("daemon lease release retries transient rename and removal failures and stays idempotent", async () => {
  const originalRenameSync = fsDefault.renameSync;
  const originalRmSync = fsDefault.rmSync;
  for (const failurePoint of ["rename", "remove"] as const) {
    const stateDirectory = makeStateDirectory(`runtime-broker-lock-release-${failurePoint}-retry-`);
    const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
    const lease = await acquireRuntimeBrokerDaemonLease(stateDirectory, {
      token: () => `release-${failurePoint}-token`,
      generation: () => `release-${failurePoint}-generation`,
    });
    let injected = false;
    const isReleaseQuarantine = (value: fs.PathLike) => String(value).startsWith(`${lockPath}.quarantine-`);
    const failingRename = ((source: fs.PathLike, destination: fs.PathLike) => {
      if (!injected && failurePoint === "rename" && String(source) === lockPath && isReleaseQuarantine(destination)) {
        injected = true;
        throw Object.assign(new Error("injected daemon lock rename failure"), { code: "EBUSY" });
      }
      return originalRenameSync(source, destination);
    }) as typeof fsDefault.renameSync;
    const failingRm = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
      if (!injected && failurePoint === "remove" && isReleaseQuarantine(target)) {
        injected = true;
        throw Object.assign(new Error("injected daemon lock removal failure"), { code: "EBUSY" });
      }
      return originalRmSync(target, options);
    }) as typeof fsDefault.rmSync;
    try {
      fsDefault.renameSync = failingRename;
      fsDefault.rmSync = failingRm;
      syncBuiltinESMExports();
      assert.throws(() => lease.release(), /injected daemon lock (?:rename|removal) failure/);
      assert.equal(injected, true);
      assert.equal(
        fs.existsSync(lockPath),
        failurePoint === "rename",
        "rename failure retains the lock; removal failure retains its owned quarantine",
      );

      fsDefault.renameSync = originalRenameSync;
      fsDefault.rmSync = originalRmSync;
      syncBuiltinESMExports();
      lease.release();
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.readdirSync(stateDirectory).some((entry) => entry.includes(".quarantine-")), false);
      assert.doesNotThrow(() => lease.release());
    } finally {
      fsDefault.renameSync = originalRenameSync;
      fsDefault.rmSync = originalRmSync;
      syncBuiltinESMExports();
      lease.release();
      fs.rmSync(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("daemon lease recovers stable empty and truncated lock crash fixtures after the grace window", async () => {
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

      await assert.rejects(
        acquireRuntimeBrokerDaemonLease(stateDirectory, {
          pid: 201,
          token: () => `token-${fixture}-too-soon`,
          generation: () => `generation-${fixture}-too-soon`,
          now: Date.now,
          processExists: () => false,
        }),
        /contended or being initialized/,
      );
      assert.equal(fs.existsSync(lockPath), true, "a fresh incomplete lock must not be stolen from a writer");

      const recovered = await acquireRuntimeBrokerDaemonLease(stateDirectory, {
        pid: 202,
        token: () => `token-${fixture}-recovered`,
        generation: () => `generation-${fixture}-recovered`,
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

test("concurrent connectOrStart calls share one detached broker bootstrap", { timeout: 15_000 }, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-auto-start-");
  let clients: RuntimeBrokerClient[] = [];
  try {
    clients = await Promise.all(Array.from({ length: 4 }, () =>
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 })));
    const lease = await clients[0]!.acquireLease({
      actorId: "actor-auto-start",
      holderId: "holder-auto-start",
      ttlMs: 1_000,
    });
    assert.equal(lease.actorId, "actor-auto-start");
    assert.equal(new Set(clients.map((client) => client.endpoint)).size, 1);
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), true);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopDetachedBroker(stateDirectory);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("concurrent waiters join the active retry generation after the first launch fails", {
  timeout: 20_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-first-failure-retry-");
  const firstMarker = path.join(stateDirectory, "first-attempt.marker");
  const attemptsPath = path.join(stateDirectory, "attempts.log");
  const retryBin = path.join(stateDirectory, "retry-broker.mjs");
  fs.writeFileSync(retryBin, [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, \`${"${process.pid}"}\\n\`);`,
    "let first = false;",
    `try { const fd = fs.openSync(${JSON.stringify(firstMarker)}, "wx"); fs.closeSync(fd); first = true; } catch (error) { if (error?.code !== "EEXIST") throw error; }`,
    "if (first) {",
    "  process.exitCode = 23;",
    "} else {",
    "  await new Promise((resolve) => setTimeout(resolve, 400));",
    `  await import(${JSON.stringify(pathToFileURL(brokerBin).href)});`,
    "}",
    "",
  ].join("\n"), "utf8");

  let clients: RuntimeBrokerClient[] = [];
  try {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 10_000, daemonBinPath: retryBin })));
    const rejected = results.filter((result) => result.status === "rejected");
    assert.deepEqual(rejected, [], rejected.map((result) => String((result as PromiseRejectedResult).reason)).join("\n"));
    clients = results.map((result) => (result as PromiseFulfilledResult<RuntimeBrokerClient>).value);
    assert.equal(fs.readFileSync(attemptsPath, "utf8").trim().split(/\r?\n/).length, 2);
    assert.equal(new Set(clients.map((client) => client.readiness.generation)).size, 1);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE))) {
      await stopDetachedBroker(stateDirectory);
    }
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("connectOrStart preserves each concurrent caller's timeout", { timeout: 15_000 }, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-mixed-timeout-");
  let client: RuntimeBrokerClient | undefined;
  try {
    const short = RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 100 });
    void short.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const long = RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 });
    const [shortResult, longResult] = await Promise.allSettled([short, long]);
    assert.equal(shortResult.status, "rejected");
    assert.equal(longResult.status, "fulfilled");
    if (longResult.status === "fulfilled") client = longResult.value;
  } finally {
    await client?.close();
    await stopDetachedBroker(stateDirectory);
    // The detached broker may still release broker.sqlite on Windows when this
    // runs under --test-concurrency; rmSync's built-in maxRetries/retryDelay
    // tolerates the transient EBUSY/EPERM the way other suite cleanups do.
    fs.rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("bootstrap observes spawn errors, evicts failed generations, and retries without unhandled rejection", {
  timeout: 15_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-spawn-error-");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let client: RuntimeBrokerClient | undefined;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      RuntimeBrokerClient.connectOrStart({
        stateDirectory,
        timeoutMs: 8_000,
        daemonExecutable: path.join(stateDirectory, "missing-node-executable"),
      }),
      /failed after 2 launch attempts/,
    );
    assert.ok(Date.now() - startedAt < 4_000, "spawn failure must surface before the caller timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);

    client = await RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 });
    assert.equal(client.readiness.readiness, "ready");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await client?.close();
    if (fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE))) {
      await stopDetachedBroker(stateDirectory);
    }
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("bootstrap surfaces an early daemon exit without waiting for the full caller timeout", {
  timeout: 15_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-child-exit-");
  fs.mkdirSync(getRuntimeBrokerDatabasePath(stateDirectory));
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 }),
      /failed after 2 launch attempts/,
    );
    assert.ok(Date.now() - startedAt < 5_000, "early child exit must be observed before the caller timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("timed-out bootstrap reclaims late children before allowing a successor generation", {
  timeout: process.platform === "win32" ? 60_000 : 30_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-late-child-timeout-");
  const delayedBin = path.join(stateDirectory, "delayed-broker.mjs");
  const attemptsPath = path.join(stateDirectory, "late-attempts.log");
  const publishPath = path.join(stateDirectory, "late-publish.log");
  fs.writeFileSync(delayedBin, [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(attemptsPath)}, \`${"${process.pid}"}\\n\`);`,
    `process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(attemptsPath)}, \`term:${"${process.pid}"}\\n\`));`,
    "await new Promise((resolve) => setTimeout(resolve, 30_000));",
    `fs.appendFileSync(${JSON.stringify(publishPath)}, \`${"${process.pid}"}\\n\`);`,
    `await import(${JSON.stringify(pathToFileURL(brokerBin).href)});`,
    "",
  ].join("\n"), "utf8");

  // Windows taskkill and child-tree confirmation can consume the two bounded
  // cleanup windows before the caller deadline; keep the production deadline
  // unchanged and give this acceptance fixture room to observe both attempts.
  const callerTimeoutMs = process.platform === "win32" ? 45_000 : 22_000;
  let successor: RuntimeBrokerClient | undefined;
  try {
    await assert.rejects(
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: callerTimeoutMs, daemonBinPath: delayedBin }),
      /failed after 2 launch attempts/,
    );
    const startedPids = fs.readFileSync(attemptsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    assert.equal(startedPids.length, 2);
    assert.equal(startedPids.every((pid) => !runtimeBrokerProcessExists(pid)), true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(fs.existsSync(publishPath), false, "timed-out children must not publish a late listener");
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), false);

    successor = await RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 8_000 });
    assert.equal(successor.readiness.readiness, "ready");
  } finally {
    await successor?.close();
    if (fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE))) {
      await stopDetachedBroker(stateDirectory);
    }
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("silent late endpoint is fenced and cannot replace a newer ready daemon generation", {
  skip: process.platform === "win32" ? "Unix-domain socket stale endpoint takeover" : false,
  timeout: 20_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-late-daemon-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const sockets = new Set<net.Socket>();
  const stale = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        params: { challenge: string };
      };
      setTimeout(() => {
        if (socket.writable) socket.write(delayedProbeEnvelope(endpoint, request.requestId, request.params.challenge));
      }, 1_200);
    });
  });
  let client: RuntimeBrokerClient | undefined;
  let verification: RuntimeBrokerClient | undefined;
  try {
    await listenNet(stale, endpoint);
    client = await RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 10_000 });
    const authority = {
      daemonToken: client.readiness.daemonToken,
      generation: client.readiness.generation,
    };
    assert.notEqual(authority.daemonToken, "late-daemon-token");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    verification = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    assert.equal(verification.readiness.daemonToken, authority.daemonToken);
    assert.equal(verification.readiness.generation, authority.generation);
    const lock = JSON.parse(fs.readFileSync(
      path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE),
      "utf8",
    )) as { token: string; generation: string };
    assert.equal(lock.token, authority.daemonToken);
    assert.equal(lock.generation, authority.generation);
  } finally {
    await verification?.close();
    await client?.close();
    if (fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE))) {
      await stopDetachedBroker(stateDirectory);
    }
    for (const socket of sockets) socket.destroy();
    await closeNet(stale);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("an established client is fenced after a reverse fresh-process daemon lock takeover", {
  timeout: 20_000,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-displaced-generation-");
  const lockPath = path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE);
  const child = spawn(process.execPath, [brokerBin, "serve", "--state-dir", stateDirectory], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  let oldClient: RuntimeBrokerClient | undefined;
  let replacement: RuntimeBrokerServer | undefined;
  let verification: RuntimeBrokerClient | undefined;
  try {
    oldClient = await waitForBrokerClient(stateDirectory, child, () => stderr);
    const lease = await oldClient.acquireLease({
      actorId: "actor-displaced",
      streamId: "stream-displaced",
      holderId: "holder-displaced",
      ttlMs: 60_000,
    }, "displaced-acquire");

    const daemonLeaseModule = pathToFileURL(path.join(
      packageRoot,
      "src",
      "runtime-broker",
      "daemon-lease.ts",
    )).href;
    const takeoverScript = [
      "const { acquireRuntimeBrokerDaemonLease } = await import(process.argv[1]);",
      "await acquireRuntimeBrokerDaemonLease(process.argv[2], {",
      "  token: () => 'takeover-token',",
      "  generation: () => 'takeover-generation',",
      "  startupGraceMs: 0,",
      "  processExists: () => true,",
      "  proveAuthority: () => false,",
      "});",
    ].join("\n");
    const takeover = spawnSync(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", takeoverScript, daemonLeaseModule, stateDirectory],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(takeover.status, 0, takeover.stderr);
    const displacedRecord = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      token: string;
      generation: string;
    };
    assert.equal(displacedRecord.token, "takeover-token");
    assert.equal(displacedRecord.generation, "takeover-generation");

    await assert.rejects(oldClient.commit({
      messageId: "message-must-not-commit",
      actorId: "actor-displaced",
      lease,
      streamId: "stream-displaced",
      expectedRevision: 0,
      events: [{
        eventId: "event-must-not-commit",
        eventType: "displaced.commit",
        payload: { rejected: true },
      }],
    }, "displaced-commit"));
    assert.equal(child.exitCode, null, "authority loss fences the client without requiring daemon exit");

    await oldClient.close();
    oldClient = undefined;
    await stopChild();

    replacement = new RuntimeBrokerServer({ stateDirectory });
    await replacement.listen();
    verification = await RuntimeBrokerClient.connect({ endpoint: replacement.endpoint, timeoutMs: 2_000 });
    assert.equal(await verification.getStreamRevision("stream-displaced"), 0);
  } finally {
    await oldClient?.close();
    await verification?.close();
    await replacement?.close();
    await stopChild();
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
