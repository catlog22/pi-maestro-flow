import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureMcpxWorkspace, removeMcpxWorkspace, startWorkspaceLease, stopWorkspaceLease, _resetMcpxBridgeState, isMcpxConfigured, readTunnelState, readOpsPassword, probeTunnelHealth } from "../src/mcpx-bridge.ts";

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
    startWorkspaceLease(root, 300);
    await wait(500);
    const calls = await readFile(logPath, "utf8");
    assert.match(calls, /workspace register --ttl 300s "?.*fixtures"?/);
    stopWorkspaceLease();
    // no further renewals after stop (registeredPaths dedup also guards)
    const calls2 = await readFile(logPath, "utf8");
    assert.equal(calls2.trim().split(/\r?\n/).filter(Boolean).length, 1);
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
