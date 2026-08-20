import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpxOverlay } from "../src/tui/mcpx-overlay.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  return predicate();
}

async function withFakeMcpx(run: (binPath: string, markerPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcpx-ctl-"));
  const markerPath = join(dir, "started.marker");
  const pidPath = join(dir, "server.pid");
  const isWin = process.platform === "win32";
  const jsPath = join(dir, "fake-mcpx.js");
  await writeFile(jsPath, [
    "const fs = require('node:fs');",
    // Mirror the real binary's contract: -version prints and exits without
    // starting a server (the overlay's refresh probes `mcpx -version`).
    "if (process.argv[2] === '-version') { console.log('mcpx 0.0.0-fake'); process.exit(0); }",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
    // The Go server owns the PID file; the fake mirrors that contract by
    // writing the path the TUI reads (MCPX_PID_FILE override).
    "if (process.env.MCPX_PID_FILE) fs.writeFileSync(process.env.MCPX_PID_FILE, String(process.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const binPath = isWin ? join(dir, "fake-mcpx.cmd") : join(dir, "fake-mcpx");
  if (isWin) {
    await writeFile(binPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, "utf8");
  } else {
    await writeFile(binPath, `#!/bin/sh\nnode "${jsPath}" "$@"\n`, "utf8");
    const { chmod } = await import("node:fs/promises");
    await chmod(binPath, 0o755);
  }
  const previous = process.env.MCPX_BIN;
  const previousPidFile = process.env.MCPX_PID_FILE;
  process.env.MCPX_BIN = binPath;
  process.env.MCPX_PID_FILE = pidPath;
  try {
    await run(binPath, markerPath);
  } finally {
    if (previous === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previous;
    if (previousPidFile === undefined) delete process.env.MCPX_PID_FILE;
    else process.env.MCPX_PID_FILE = previousPidFile;
    // clean up any leftover process tree from the fake server
    const pidFile = join(dir, "server.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        if (isWin) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("s starts the mcpx server and x stops it", async (t) => {
  await withFakeMcpx(async (_binPath, markerPath) => {
    // MCPX_PID_FILE is set by withFakeMcpx to the isolated dir — capture now
    // (the env is restored after run returns).
    const pidFile = process.env.MCPX_PID_FILE as string;
    t.after(async () => {
      // leave no trace: kill a leftover fake process and remove the pid file
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          else process.kill(pid, "SIGKILL");
        }
        const { rmSync } = await import("node:fs");
        rmSync(pidFile, { force: true });
      }
    });
    const overlay = new McpxOverlay({
      cwd: "D:/demo",
      requestRender: () => undefined,
      close: () => undefined,
      endpointWaitMs: 1_000, // the fake server never opens an endpoint
    });
    t.after(() => overlay.dispose());

    // start
    overlay.handleInput("s");
    const started = await waitFor(() => existsSync(markerPath));
    assert.equal(started, true, "fake mcpx process should have started");
    const pidWritten = await waitFor(() => existsSync(pidFile));
    assert.equal(pidWritten, true, "PID file should be written");

    // stop
    overlay.handleInput("x");
    const stopped = await waitFor(() => !existsSync(pidFile));
    assert.equal(stopped, true, "PID file should be removed after stop");
  });
});
