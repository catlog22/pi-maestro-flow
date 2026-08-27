import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureMcpxWorkspace, registerMcpxWorkspacePermanent, removeMcpxWorkspace, startWorkspaceLease, stopWorkspaceLease, _resetMcpxBridgeState, isMcpxConfigured, readTunnelState, readOpsPassword, readMcpxBearerToken, probeTunnelHealth, detectMcpxForPmf, removeWorkspaceByPath, readDelegatedTasks, isQuickTunnelCommandLine, isValidTunnelPort, setQuickTunnelDiscoveryForTest, readMcpxConfigView, writeMcpxConfigChanges, quickTunnelArgs } from "../src/mcpx-bridge.ts";

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
  // MCPX_BIN wins over PATH and the real ~/.mcpx/bin install; pin the shim.
  const previousBin = process.env.MCPX_BIN;
  process.env.MCPX_BIN = shim;
  try {
    await run(logPath, binDir);
  } finally {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
}

test("registers a workspace when invoked (opt-in, e key / bridge API)", async (t) => {
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

test("registers with a TTL lease and removes it", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withFakeMcpx(async (logPath) => {
    const root = join(process.cwd(), "fixtures");
    ensureMcpxWorkspace(root, 300);
    await wait(500);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /workspace register --ttl 300s "?.*fixtures"?/);
    removeMcpxWorkspace(root);
    await wait(500);
    const calls2 = await readFile(logPath, "utf8");
    assert.match(calls2, /workspace remove "?.*fixtures"?/);
  });
});

test("lease heartbeat registers and renews; stop clears the timer", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withFakeMcpx(async (logPath) => {
    const root = join(process.cwd(), "fixtures");
    const registered = await startWorkspaceLease(root, 300);
    assert.equal(registered, true);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /workspace register --ttl 300s "?.*fixtures"?/);
    stopWorkspaceLease();
    // no further renewals after stop (registeredPaths dedup also guards)
    const calls2 = await readFile(logPath, "utf8");
    assert.equal(calls2.trim().split(/\r?\n/).filter(Boolean).length, 1);
  });
});

test("permanent registration registers without a TTL flag", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withFakeMcpx(async (logPath) => {
    const root = join(process.cwd(), "fixtures");
    const registered = await registerMcpxWorkspacePermanent(root);
    assert.equal(registered, true);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /workspace register "?.*fixtures"?/);
    assert.doesNotMatch(calls, /--ttl/);
    // a single register call: no heartbeat is started for permanent entries
    assert.equal(calls.trim().split(/\r?\n/).filter(Boolean).length, 1);
  });
});

// --- tunnel health & config detection ---

/** Isolate the bridge's config/PID reads under a temp HOME so tests do not
 * touch the user's real ~/.mcpx state. */
async function withIsolatedHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mcpx-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  // On Windows the bridge reads homedir() which resolves USERPROFILE; on POSIX
  // it reads HOME. Pin both so the temp dir wins on every platform.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
}

test("readMcpxBearerToken only returns bearer or dual mode tokens", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n  mode: bearer\n  token: "abc"\n');
    assert.equal(readMcpxBearerToken(), "abc");
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n  mode: oauth\n  token: "ignored"\n');
    assert.equal(readMcpxBearerToken(), undefined);
  });
});

test("isMcpxConfigured is false when no config exists", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async () => {
    assert.equal(isMcpxConfigured(), false);
  });
});

test("isMcpxConfigured is false for an open mode config", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), "server:\n    port: 9090\nauth:\n    mode: open\n");
    assert.equal(isMcpxConfigured(), false);
  });
});

test("isMcpxConfigured is true for bearer mode", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'server:\n    port: 9090\nauth:\n    mode: bearer\n    token: "abc"\n');
    assert.equal(isMcpxConfigured(), true);
  });
});

test("isMcpxConfigured requires server_url for oauth mode", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'server:\n    port: 9090\nauth:\n    mode: oauth\n    oauth:\n        password: "x"\n        server_url: ""\n');
    assert.equal(isMcpxConfigured(), false);
    await writeFile(join(home, ".mcpx", "config.yaml"), 'server:\n    port: 9090\nauth:\n    mode: oauth\n    oauth:\n        password: "x"\n        server_url: "https://abc.trycloudflare.com"\n');
    assert.equal(isMcpxConfigured(), true);
  });
});

test("readTunnelState reports unknown health and no pid/url when nothing is configured", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async () => {
    const state = readTunnelState();
    assert.equal(state.health, "unknown");
    assert.equal(state.alive, false);
    assert.equal(state.pid, undefined);
    assert.equal(state.url, undefined);
  });
});

test("readTunnelState reads server_url from config", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n    mode: oauth\n    oauth:\n        server_url: "https://tunnel.example.com"\n');
    const state = readTunnelState();
    assert.equal(state.url, "https://tunnel.example.com");
    assert.equal(state.health, "unknown");
  });
});

test("probeTunnelHealth returns dead for an unreachable URL", async () => {
  // A port that refuses connections fast (no server bound) → "dead".
  const health = await probeTunnelHealth("http://127.0.0.1:1");
  assert.equal(health, "dead");
});

test("probeTunnelHealth returns ok for a 200 initialize", async () => {
  // Stand up a tiny HTTP server that answers 200 to POST /mcp.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake", version: "1" } } }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "ok");
  } finally {
    server.close();
  }
});

test("probeTunnelHealth returns auth for a 401 with WWW-Authenticate", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcpx", resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"' });
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "auth");
  } finally {
    server.close();
  }
});

test("probeTunnelHealth retries Cloudflare Error 1033 until the edge is ready", async () => {
  const { createServer } = await import("node:http");
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts++;
    if (attempts < 3) {
      res.writeHead(530, { "Content-Type": "text/html" });
      res.end("<title>Cloudflare Tunnel error</title><p>Error 1033</p>");
      return;
    }
    res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mcpx", resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "auth");
    assert.equal(attempts, 3);
  } finally {
    server.close();
  }
});

test("probeTunnelHealth keeps persistent Cloudflare Error 1033 dead", async () => {
  const { createServer } = await import("node:http");
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts++;
    res.writeHead(530, { "Content-Type": "text/html" });
    res.end("<title>Cloudflare Tunnel error</title><p>Error 1033</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "dead");
    assert.equal(attempts, 3);
  } finally {
    server.close();
  }
});

test("probeTunnelHealth returns dead for a 403 (mcpx host guard / misconfig)", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end('Forbidden: invalid Host header "x"');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "dead");
  } finally {
    server.close();
  }
});

test("probeTunnelHealth rejects public HTTP and does not follow redirects", async (t) => {
  const { createServer } = await import("node:http");
  let redirectedHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/mcp") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/mcp" });
      res.end();
      return;
    }
    redirectedHits++;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await probeTunnelHealth(`http://127.0.0.1:${port}`), "dead");
    assert.equal(redirectedHits, 0);
    assert.equal(await probeTunnelHealth("http://example.com"), "dead");
  } finally {
    server.close();
  }
});

test("probeTunnelHealth returns dead for a 401 without WWW-Authenticate (not mcpx's OAuth handshake)", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      // A 401 with no resource_metadata is not mcpx's OAuth start (e.g. an
      // upstream proxy's own 401). Must NOT be reported as a healthy "auth".
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "proxy auth required" }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await probeTunnelHealth(`http://127.0.0.1:${port}`);
    assert.equal(health, "dead");
  } finally {
    server.close();
  }
});

test("isMcpxConfigured accepts bearer with 2-space indent (hand-edited yaml)", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), "server:\n  port: 9090\nauth:\n  mode: bearer\n  token: abc\n");
    assert.equal(isMcpxConfigured(), true);
  });
});

test("isMcpxConfigured accepts implicit bearer (no mode, token set)", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    // No explicit mode line — mcpx's EffectiveAuthMode treats a token as bearer.
    await writeFile(join(home, ".mcpx", "config.yaml"), 'server:\n  port: 9090\nauth:\n  token: "abc"\n');
    assert.equal(isMcpxConfigured(), true);
  });
});

test("isMcpxConfigured rejects open mode even with config present", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), "server:\n  port: 9090\nauth:\n  mode: open\n");
    assert.equal(isMcpxConfigured(), false);
  });
});

test("readConfigServerURL tolerates a trailing comment on the server_url line", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n  mode: oauth\n  oauth:\n    server_url: "https://tun.example.com" # production\n');
    const state = readTunnelState();
    assert.equal(state.url, "https://tun.example.com");
  });
});

test("readOpsPassword returns the persisted oauth password", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n  mode: oauth\n  oauth:\n    password: "my-secret-pw"\n    server_url: "https://t.example.com"\n');
    assert.equal(readOpsPassword(), "my-secret-pw");
  });
});

test("readOpsPassword returns undefined when password is empty", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), 'auth:\n  mode: oauth\n  oauth:\n    password: ""\n    server_url: "https://t.example.com"\n');
    assert.equal(readOpsPassword(), undefined);
  });
});

test("detectMcpxForPmf returns an installed boolean shape", async (t) => {
  t.after(_resetMcpxBridgeState);
  const r = detectMcpxForPmf();
  assert.equal(typeof r.installed, "boolean");
  // version 只在 installed=true 时有意义
  if (r.installed) assert.equal(typeof r.version, "string");
});

test("removeWorkspaceByPath calls `mcpx workspace remove <path>` and reports ok", async (t) => {
  t.after(_resetMcpxBridgeState);
  const dir = await mkdtemp(join(tmpdir(), "mcpx-rm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "mcpx.cmd" : "mcpx");
  // 记录被调用的参数，workspace remove 成功退出
  const log = join(dir, "args.txt");
  // Windows echo 重定向用正斜杠路径避免转义问题
  const logPath = log.replace(/\\/g, "/");
  await writeFile(shim, isWin
    ? `@echo off\r\necho %* > "${logPath}"\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}"\nexit 0\n`);
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const prev = process.env.MCPX_BIN;
  process.env.MCPX_BIN = shim;
  t.after(() => { if (prev === undefined) delete process.env.MCPX_BIN; else process.env.MCPX_BIN = prev; });

  const r = removeWorkspaceByPath("D:/to-remove");
  assert.equal(r.ok, true);
  const args = await readFile(log, "utf8");
  assert.match(args, /workspace remove/, "must call `workspace remove`");
  assert.match(args, /D:\/to-remove/, "must pass the path through");
});

test("readDelegatedTasks merges registry entry with result file", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    const dir = join(home, ".mcpx", "tasks", "delegated", "sess-1");
    await mkdir(dir, { recursive: true });
    // registry entry: status delivered (task in flight)
    await writeFile(join(dir, "task-1.json"), JSON.stringify({
      task_id: "task-1", remote_session_id: "sess-1", workspace: "demo",
      action: "delegate", message: "do thing", purpose: "test", status: "delivered",
      created_at: "2026-08-20T10:00:00Z",
    }));
    // companion result file: pi wrote completed + summary
    await writeFile(join(dir, "task-1.result.json"), JSON.stringify({
      task_id: "task-1", status: "completed", result: "done", result_summary: ["a", "b"],
      completed_at: "2026-08-20T10:05:00Z",
    }));
    const tasks = readDelegatedTasks();
    assert.ok(tasks && tasks.length === 1);
    assert.equal(tasks[0].task_id, "task-1");
    assert.equal(tasks[0].status, "completed", "result file promotes status");
    assert.deepEqual(tasks[0].result_summary, ["a", "b"]);
  });
});

test("readDelegatedTasks returns undefined when registry absent", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async () => {
    assert.equal(readDelegatedTasks(), undefined);
  });
});

test("readDelegatedTasks scopes to a session id", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    for (const sess of ["sess-a", "sess-b"]) {
      const dir = join(home, ".mcpx", "tasks", "delegated", sess);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `t-${sess}.json`), JSON.stringify({
        task_id: `t-${sess}`, remote_session_id: sess, workspace: "w",
        action: "spawn", message: "x", purpose: "x", status: "executing",
        created_at: "2026-08-20T10:00:00Z",
      }));
    }
    const all = readDelegatedTasks();
    assert.equal(all?.length, 2, "no scope = all sessions");
    const a = readDelegatedTasks("sess-a");
    assert.equal(a?.length, 1);
    assert.equal(a![0].task_id, "t-sess-a");
  });
});

test("readTunnelState alive matches the real process table (tasklist CSV fix)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tunnel-alive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prev = process.env.MCPX_TUNNEL_PID_FILE;
  const file = join(dir, "cloudflared.pid");
  process.env.MCPX_TUNNEL_PID_FILE = file;
  t.after(() => {
    if (prev === undefined) delete process.env.MCPX_TUNNEL_PID_FILE;
    else process.env.MCPX_TUNNEL_PID_FILE = prev;
  });
  // own pid is alive — the old last-column CSV parse always read Mem Usage and
  // reported every live process as dead.
  await writeFile(file, String(process.pid), "utf8");
  assert.equal(readTunnelState().alive, true, "own pid must be detected alive");
  // impossible pid is dead
  await writeFile(file, "4194304", "utf8");
  assert.equal(readTunnelState().alive, false, "impossible pid must be dead");
});

test("Quick Tunnel matching requires the exact local URL command", () => {
  assert.deepEqual(quickTunnelArgs(19090), ["tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:19090"]);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --protocol http2 --url http://127.0.0.1:19090", 19090), true);
  assert.equal(isQuickTunnelCommandLine('"C:\\\\Program Files\\\\cloudflared\\\\cloudflared.exe" tunnel --protocol http2 --url http://127.0.0.1:19090', 19090), true);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --url http://127.0.0.1:19090", 19090), true, "legacy quick tunnels remain discoverable for cleanup");
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel run named-tunnel", 19090), false);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --protocol http2 --url http://127.0.0.1:19091", 19090), false);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --protocol quic --url http://127.0.0.1:19090", 19090), false);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --protocol http2 --url http://localhost:19090", 19090), false);
  assert.equal(isQuickTunnelCommandLine("cloudflared tunnel --protocol http2 --url http://127.0.0.1:19090 --no-autoupdate", 19090), false);
});

test("Quick Tunnel port validation covers TCP bounds", () => {
  assert.equal(isValidTunnelPort(1), true);
  assert.equal(isValidTunnelPort(65_535), true);
  assert.equal(isValidTunnelPort(0), false);
  assert.equal(isValidTunnelPort(65_536), false);
  assert.equal(isValidTunnelPort(9090.5), false);
});

const FULL_CONFIG = [
  "server:",
  "    host: 127.0.0.1",
  "    port: 9090",
  "    disable_localhost_protection: true",
  "    trust_proxy_headers: true",
  "auth:",
  "    mode: oauth",
  '    token: ""',
  "    oauth:",
  '        password: "5G6unz"',
  '        server_url: "https://abc.trycloudflare.com"',
  "        token_ttl: 86400",
  "security:",
  "    commands:",
  "        default: allow",
  "        allow:",
  "            - ^ls\\b",
  "            - ^pi\\b",
  "        confirm:",
  "            - ^git push",
  "        deny:",
  "            - ^rm -rf /",
  "        auto_allow_readonly: null",
  "    files:",
  "        max_read_bytes: 1048576",
  "        max_patch_files: 20",
  "        allow:",
  "            - ^~/projects\\b",
  "        confirm: []",
  "        deny:",
  "            - ^/etc",
  "",
].join("\n");

test("readMcpxConfigView parses all editable fields", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), FULL_CONFIG, "utf8");
    const v = readMcpxConfigView();
    assert.ok(v, "view must parse when config exists");
    assert.equal(v!.server.host, "127.0.0.1");
    assert.equal(v!.server.port, 9090);
    assert.equal(v!.server.disableLocalhostProtection, true);
    assert.equal(v!.server.trustProxyHeaders, true);
    assert.equal(v!.auth.mode, "oauth");
    assert.equal(v!.auth.oauthPassword, "5G6unz");
    assert.equal(v!.auth.oauthServerURL, "https://abc.trycloudflare.com");
    assert.equal(v!.commands.default, "allow");
    assert.deepEqual(v!.commands.allow, ["^ls\\b", "^pi\\b"]);
    assert.deepEqual(v!.commands.confirm, ["^git push"]);
    assert.deepEqual(v!.commands.deny, ["^rm -rf /"]);
    assert.equal(v!.commands.autoAllowReadonly, null);
    assert.equal(v!.files.maxReadBytes, 1_048_576);
    assert.equal(v!.files.maxPatchFiles, 20);
    assert.deepEqual(v!.files.allow, ["^~/projects\\b"]);
    assert.deepEqual(v!.files.deny, ["^/etc"]);
  });
});

test("readMcpxConfigView returns undefined when config is missing", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async () => {
    assert.equal(readMcpxConfigView(), undefined);
  });
});

test("writeMcpxConfigChanges applies partial changes and preserves untouched sections", async (t) => {
  t.after(_resetMcpxBridgeState);
  await withIsolatedHome(async (home) => {
    await mkdir(join(home, ".mcpx"), { recursive: true });
    await writeFile(join(home, ".mcpx", "config.yaml"), FULL_CONFIG, "utf8");
    const { summary } = writeMcpxConfigChanges({
      port: 9091,
      commandsDeny: ["^rm -rf /", "^mkfs"],
      filesMaxReadBytes: 2_097_152,
    });
    const after = await readFile(join(home, ".mcpx", "config.yaml"), "utf8");
    assert.match(after, /port: 9091/);
    assert.match(after, /\^mkfs/); // new deny rule appended
    assert.match(after, /\^rm -rf \/\s*$/m); // existing deny preserved (trailing slash)
    assert.match(after, /max_read_bytes: 2097152/);
    // untouched sections survive
    assert.match(after, /mode: oauth/);
    assert.match(after, /password: "5G6unz"/);
    assert.match(after, /\^ls\\b/); // commands.allow preserved
    assert.ok(summary.some((line) => line.includes("9091")));
    assert.ok(summary.some((line) => line.includes("files.max_read_bytes: 2097152")));
    // re-reading gives the updated values
    const v = readMcpxConfigView()!;
    assert.equal(v.server.port, 9091);
    assert.deepEqual(v.commands.deny, ["^rm -rf /", "^mkfs"]);
    assert.equal(v.files.maxReadBytes, 2_097_152);
  });
});
