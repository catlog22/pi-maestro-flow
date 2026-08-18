import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureMcpxWorkspace, _resetMcpxBridgeState } from "../src/mcpx-bridge.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withFakeMcpx(run: (logPath: string, binDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcpx-bridge-"));
  const logPath = join(dir, "calls.log");
  const binDir = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "mcpx.cmd" : "mcpx");
  await writeFile(
    shim,
    isWin
      ? `@echo off\r\necho %*>> "${logPath}"\r\nexit /b 0\r\n`
      : `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`,
  );
  if (!isWin) await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  try {
    await run(logPath, binDir);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
}

test("registers the project root with mcpx on startup", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withFakeMcpx(async (logPath) => {
    const root = join(process.cwd(), "fixtures");
    ensureMcpxWorkspace(root);
    await wait(500);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /workspace register "?.*fixtures"?/);
  });
});

test("deduplicates repeated registrations of the same path", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withFakeMcpx(async (logPath) => {
    const root = join(process.cwd(), "fixtures");
    ensureMcpxWorkspace(root);
    ensureMcpxWorkspace(root);
    await wait(500);
    const calls = await readFile(logPath, "utf8");
    assert.equal(calls.trim().split(/\r?\n/).filter(Boolean).length, 1);
  });
});

test("skips registration when PI_MCPX_BRIDGE=0", async (t) => {
  t.after(() => {
    delete process.env.PI_MCPX_BRIDGE;
    _resetMcpxBridgeState();
  });
  await withFakeMcpx(async (logPath) => {
    process.env.PI_MCPX_BRIDGE = "0";
    ensureMcpxWorkspace(join(process.cwd(), "fixtures"));
    await wait(500);
    const calls = await readFile(logPath, "utf8").catch(() => "");
    assert.equal(calls.trim(), "");
  });
});
