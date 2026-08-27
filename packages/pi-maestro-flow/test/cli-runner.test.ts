import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRunner } from "../src/session/cli-adapter.ts";

test("default CLI runner honors a pre-aborted signal without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await defaultRunner([], process.cwd(), {
    signal: controller.signal,
    spawnProcess: (() => {
      spawned = true;
      throw new Error("must not spawn");
    }) as never,
  });

  assert.equal(spawned, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /aborted/);
});

test("default CLI runner reclaims descendants when the CLI parent exits first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-normal-close-"));
  const script = join(root, "parent-first.cjs");
  const pidFile = join(root, "descendant.pid");
  let descendantPid: number | undefined;
  await writeFile(script, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    fs.writeFileSync(process.argv[2], String(descendant.pid));
    descendant.unref();
    process.stdout.write("parent complete");
  `);

  try {
    const result = await defaultRunner([script, pidFile], root, {
      executable: process.execPath,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    descendantPid = Number(await waitForFile(pidFile));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "parent complete");
    assert.equal(isProcessRunning(descendantPid), false, "normal success must settle only after descendant reclamation");
  } finally {
    if (descendantPid && isProcessRunning(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("default CLI runner aborts, waits, and removes descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-runner-abort-"));
  const script = join(root, "tree.cjs");
  const pidFile = join(root, "descendant.pid");
  let descendantPid: number | undefined;
  await writeFile(script, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    fs.writeFileSync(process.argv[2], String(descendant.pid));
    setInterval(() => {}, 1000);
  `);

  try {
    const controller = new AbortController();
    const pending = defaultRunner([script, pidFile], root, {
      executable: process.execPath,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      signal: controller.signal,
    });
    descendantPid = Number(await waitForFile(pidFile));
    assert.equal(isProcessRunning(descendantPid), true);

    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /aborted/);
    assert.equal(await waitForProcessExit(descendantPid, 2_000), true, "descendant must be gone before abort settles");
  } finally {
    if (descendantPid && isProcessRunning(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
