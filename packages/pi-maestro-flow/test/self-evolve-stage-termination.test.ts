import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeSelfEvolveStageProcessForTest } from "../src/self-evolve/extension.ts";

test("self-evolve stage executor reclaims descendants when the stage parent exits first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-self-evolve-stage-normal-close-"));
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
    process.stdout.write("staged");
  `);

  try {
    const result = await executeSelfEvolveStageProcessForTest(
      process.execPath,
      [script, pidFile],
      { cwd: root, timeoutMs: 5_000 },
    );
    descendantPid = Number(await waitForFile(pidFile));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "staged");
    assert.equal(isProcessRunning(descendantPid), false, "stage success must settle only after descendant reclamation");
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
