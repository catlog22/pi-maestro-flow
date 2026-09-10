import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  _gatewayTuiInternals,
  type GatewaySnapshot,
  type GatewayThreadEntry,
  type GatewayWindowInfo,
} from "../src/tui/gateway-overlay.ts";
import type {
  GatewayRemoteSession,
  GatewayRuntimeWindow,
  GatewayWindowObservation,
} from "../src/tui/gateway-client.ts";
import { collectMcpServers, collectConnections } from "../src/tui/gateway-overlay.ts";

const { normalizeWorkspacePath, workspaceIdForCwd, collectWorkspaces, collectWindows, collectThread, displayNameOf } = _gatewayTuiInternals;

test("workspace path normalization matches the plugin algorithm", () => {
  assert.equal(normalizeWorkspacePath("D:\\pi-maestro-flow"), "d:/pi-maestro-flow");
  assert.equal(normalizeWorkspacePath("D:/pi-maestro-flow/"), "d:/pi-maestro-flow");
  // Known vector from the pi plugin: sha256("d:/pi-maestro-flow")
  assert.equal(
    workspaceIdForCwd("D:/pi-maestro-flow"),
    "7b43995641bf8459224295d6ff3bfe4608ce4da280e0968b42bf9a2a0e320269",
  );
});

test("display name falls back to a window prefix", () => {
  assert.equal(displayNameOf("my-window", "a".repeat(32)), "my-window");
  const fallback = displayNameOf(undefined, "0123456789abcdef0123456789abcdef");
  assert.equal(fallback, "window:01234567");
});

test("collectWorkspaces parses the gateway global config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.yaml");
  await writeFile(config, [
    "server:",
    "    port: 9090",
    "workspaces:",
    "    - name: demo",
    "      path: D:\\demo",
    "    - name: other",
    '      path: "C:\\other dir"',
    "  - name: compact",
    "    path: D:\\compact",
    "",
  ].join("\n"), "utf8");
  const workspaces = collectWorkspaces(config);
  assert.equal(workspaces.length, 3);
  assert.equal(workspaces[0].name, "demo");
  assert.equal(workspaces[0].path, "D:\\demo");
  assert.equal(workspaces[1].path, "C:\\other dir");
  assert.equal(workspaces[2].name, "compact");
  assert.equal(workspaces[2].path, "D:\\compact");
});

test("collectWindows aggregates fresh owner snapshots across all workspaces", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousRoot = process.env.PI_PEER_WORKSPACES_ROOT;
  process.env.PI_PEER_WORKSPACES_ROOT = dir;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_PEER_WORKSPACES_ROOT;
    else process.env.PI_PEER_WORKSPACES_ROOT = previousRoot;
  });
  const now = Date.now();
  const snapshot = (ownerId: string, publishedAt: number, cwd: string) => ({
    version: 1, kind: "owner", workspaceId: "a".repeat(64), normalizedCwd: cwd,
    ownerId, ownerNonce: "b".repeat(32), pid: 100, publishedAt,
    agents: [], settled: [],
  });
  const ownersA = join(dir, "a".repeat(64), "runtime", "owners");
  const ownersB = join(dir, "c".repeat(64), "runtime", "owners");
  await mkdir(ownersA, { recursive: true });
  await mkdir(ownersB, { recursive: true });
  await writeFile(join(ownersA, `${"1".repeat(32)}.json`), JSON.stringify(snapshot("1".repeat(32), now, "d:/ws-a")), "utf8");
  // stale snapshot in the same workspace is dropped
  await writeFile(join(ownersA, `${"2".repeat(32)}.json`), JSON.stringify(snapshot("2".repeat(32), now - 60_000, "d:/ws-a")), "utf8");
  await writeFile(join(ownersA, "junk.json"), "{broken", "utf8");
  // a second workspace contributes its own fresh window
  await writeFile(join(ownersB, `${"3".repeat(32)}.json`), JSON.stringify(snapshot("3".repeat(32), now - 1_000, "d:/ws-b")), "utf8");

  const windows = collectWindows(now);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].ownerId, "1".repeat(32)); // newest first
  assert.equal(windows[0].workspace, "d:/ws-a");
  assert.equal(windows[1].workspace, "d:/ws-b");

  // Missing peer root -> empty.
  process.env.PI_PEER_WORKSPACES_ROOT = join(dir, "missing");
  assert.equal(collectWindows(now).length, 0);
});

test("collectThread aggregates commands and receipts newest first across workspaces", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousRoot = process.env.PI_PEER_WORKSPACES_ROOT;
  process.env.PI_PEER_WORKSPACES_ROOT = dir;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_PEER_WORKSPACES_ROOT;
    else process.env.PI_PEER_WORKSPACES_ROOT = previousRoot;
  });
  const now = Date.now();
  const runtimeA = join(dir, "a".repeat(64), "runtime");
  const runtimeB = join(dir, "c".repeat(64), "runtime");
  const commandsA = join(runtimeA, "commands", "f".repeat(32));
  const responsesA = join(runtimeA, "responses", "f".repeat(32));
  const commandsB = join(runtimeB, "commands", "e".repeat(32));
  await mkdir(commandsA, { recursive: true });
  await mkdir(responsesA, { recursive: true });
  await mkdir(commandsB, { recursive: true });
  await mkdir(join(runtimeA, "owners"), { recursive: true });
  await mkdir(join(runtimeB, "owners"), { recursive: true });
  // owner snapshots give each runtime its workspace label
  const ownerSnapshot = (ownerId: string, cwd: string) => JSON.stringify({
    version: 1, kind: "owner", workspaceId: "a".repeat(64), normalizedCwd: cwd,
    ownerId, ownerNonce: "b".repeat(32), pid: 100, publishedAt: now, agents: [], settled: [],
  });
  await writeFile(join(runtimeA, "owners", `${"f".repeat(32)}.json`), ownerSnapshot("f".repeat(32), "d:/ws-a"), "utf8");
  await writeFile(join(runtimeB, "owners", `${"e".repeat(32)}.json`), ownerSnapshot("e".repeat(32), "d:/ws-b"), "utf8");
  await writeFile(join(commandsA, "c1.json"), JSON.stringify({
    version: 1, kind: "command", commandId: "c1", createdAt: now - 1_000,
    fromOwnerId: "f".repeat(32), toOwnerId: "a".repeat(32), action: "steer",
    message: "do the thing",
  }), "utf8");
  await writeFile(join(commandsA, "c2.json"), JSON.stringify({
    version: 1, kind: "command", commandId: "c2", createdAt: now - 2_000,
    fromOwnerId: "f".repeat(32), toOwnerId: "a".repeat(32), action: "follow_up",
    message: "later task",
  }), "utf8");
  await writeFile(join(responsesA, "c1.json"), JSON.stringify({
    version: 1, kind: "response", commandId: "c1", respondedAt: now,
    fromOwnerId: "a".repeat(32), toOwnerId: "f".repeat(32), status: "accepted",
  }), "utf8");
  // a second workspace contributes its own command
  await writeFile(join(commandsB, "c3.json"), JSON.stringify({
    version: 1, kind: "command", commandId: "c3", createdAt: now - 500,
    fromOwnerId: "e".repeat(32), toOwnerId: "a".repeat(32), action: "steer",
    message: "other workspace",
  }), "utf8");

  const entries = collectThread();
  assert.equal(entries.length, 4);
  assert.equal(entries[0].kind, "response"); // newest first
  assert.equal(entries[0].status, "accepted");
  assert.equal(entries[0].workspace, "d:/ws-a");
  assert.equal(entries[1].commandId, "c3");
  assert.equal(entries[1].workspace, "d:/ws-b");

  // Missing peer root -> empty.
  process.env.PI_PEER_WORKSPACES_ROOT = join(dir, "missing");
  assert.equal(collectThread().length, 0);
});

test("collectMcpServers merges .mcp.json files with later-wins precedence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { github: { type: "stdio", command: "npx", description: "github mcp" } },
  }), "utf8");
  await mkdir(join(dir, ".agents"));
  await writeFile(join(dir, ".agents", "mcp.json"), JSON.stringify({
    mcpServers: { github: { command: "custom-github" }, local: { command: "node" } },
  }), "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  const startedAt = Date.now();
  let servers: ReturnType<typeof collectMcpServers>;
  try {
    servers = collectMcpServers(dir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.ok(Date.now() - startedAt < 500, "dashboard executable discovery must not spawn blocking PATH probes");
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
  assert.equal(servers.length, 2);
  assert.equal(byName.github.source, "agents"); // later file wins
  assert.equal(byName.github.command, "custom-github");
  assert.equal(byName.local.type, "stdio");
  assert.equal(byName.local.command, "node");
  assert.equal(typeof byName.local.executable, "boolean");
});

test("collectConnections parses session list from a live endpoint", async (t) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            status: "ok",
            data: {
              sessions: [
                { remote_session_id: "abc123", workspace_name: "demo", label: "chat", status: "running" },
                { remote_session_id: "def456", workspace_name: "proj", status: "completed" },
              ],
            },
          },
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  const connections = await collectConnections(endpoint);
  assert.ok(connections);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].sessionId, "abc123");
  assert.equal(connections[0].workspace, "demo");
  assert.equal(connections[0].label, "chat");
  assert.equal(connections[0].status, "running");
});

test("collectConnections returns undefined when the endpoint is unreachable", async () => {
  const connections = await collectConnections("http://127.0.0.1:1/mcp");
  assert.equal(connections, undefined);
});

test("e key routes register to onRegisterWorkspace (lease) and unregister to onUnregisterWorkspace", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "gateway-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "gateway.cmd" : "gateway");
  await writeFile(
    shim,
    isWin
      ? `@echo off\r\nif "%1"=="workspace" if "%2"=="list" echo workspaces:\r\nexit /b 0\r\n`
      : `#!/bin/sh\nif [ "$1" = "workspace" ] && [ "$2" = "list" ]; then echo workspaces:; fi\nexit 0\n`,
  );
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const previousBin = process.env.PI_MAESTRO_GATEWAY_BIN;
  const previousPath = process.env.PATH;
  process.env.PI_MAESTRO_GATEWAY_BIN = shim;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  t.after(() => {
    if (previousBin === undefined) delete process.env.PI_MAESTRO_GATEWAY_BIN;
    else process.env.PI_MAESTRO_GATEWAY_BIN = previousBin;
    process.env.PATH = previousPath;
  });

  const registerCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const overlay = new GatewayOverlay({
    cwd: "D:/toggle-demo",
    requestRender: () => undefined,
    close: () => undefined,
    onRegisterWorkspace: async (path) => { registerCalls.push(path); return "registered-leased"; },
    onUnregisterWorkspace: async (path) => { unregisterCalls.push(path); return "unregistered"; },
  });
  const s = overlay;
  t.after(() => overlay.dispose());
  await overlay.refresh();
  // An e key received during the initial/manual refresh must be queued rather
  // than dropped silently.
  s["snapshot"].refreshing = true;
  overlay.handleInput("e");
  assert.match(s["status"], /刷新/);
  s["snapshot"].refreshing = false;
  await overlay.refresh();
  let status = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = s["status"] ?? "";
    if (status === "registered-leased" || status.startsWith("register failed")) break;
  }
  assert.deepEqual(registerCalls, ["D:/toggle-demo"], "register must go through onRegisterWorkspace");
  assert.equal(status, "registered-leased");

  // The register handler triggers a background refresh; let it settle before
  // the next toggle so the refreshing guard does not swallow the e key.
  for (let i = 0; i < 30 && s["snapshot"].refreshing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Workspace-management mode must expose the same e action as the main list.
  s["snapshot"].cwdRegistered = true;
  s["mode"] = "workspace";
  overlay.handleInput("e");
  status = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = s["status"] ?? "";
    if (status === "unregistered" || status.startsWith("remove failed")) break;
  }
  assert.deepEqual(unregisterCalls, ["D:/toggle-demo"], "unregister must go through onUnregisterWorkspace");
  assert.equal(status, "unregistered");
});

test("E key routes register to onRegisterWorkspacePermanent and unregister to onUnregisterWorkspace", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "gateway-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "gateway.cmd" : "gateway");
  await writeFile(
    shim,
    isWin
      ? `@echo off\r\nif "%1"=="workspace" if "%2"=="list" echo workspaces:\r\nexit /b 0\r\n`
      : `#!/bin/sh\nif [ "$1" = "workspace" ] && [ "$2" = "list" ]; then echo workspaces:; fi\nexit 0\n`,
  );
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const previousBin = process.env.PI_MAESTRO_GATEWAY_BIN;
  process.env.PI_MAESTRO_GATEWAY_BIN = shim;
  t.after(() => {
    if (previousBin === undefined) delete process.env.PI_MAESTRO_GATEWAY_BIN;
    else process.env.PI_MAESTRO_GATEWAY_BIN = previousBin;
  });

  const permanentCalls: string[] = [];
  const leaseCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const overlay = new GatewayOverlay({
    cwd: "D:/toggle-demo",
    requestRender: () => undefined,
    close: () => undefined,
    onRegisterWorkspace: async (path) => { leaseCalls.push(path); return "registered-leased"; },
    onRegisterWorkspacePermanent: async (path) => { permanentCalls.push(path); return "registered-permanent"; },
    onUnregisterWorkspace: async (path) => { unregisterCalls.push(path); return "unregistered"; },
  });
  const s = overlay;
  t.after(() => overlay.dispose());
  await overlay.refresh();
  s["snapshot"].refreshing = false;
  overlay.handleInput("E");
  let status = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = s["status"] ?? "";
    if (status === "registered-permanent" || status.startsWith("register failed")) break;
  }
  assert.deepEqual(permanentCalls, ["D:/toggle-demo"], "E must go through onRegisterWorkspacePermanent");
  assert.deepEqual(leaseCalls, [], "E must not use the lease register path");
  assert.equal(status, "registered-permanent");

  // Unregistering is shared between e and E.
  for (let i = 0; i < 30 && s["snapshot"].refreshing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  s["snapshot"].cwdRegistered = true;
  s["mode"] = "workspace";
  overlay.handleInput("E");
  status = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = s["status"] ?? "";
    if (status === "unregistered" || status.startsWith("remove failed")) break;
  }
  assert.deepEqual(unregisterCalls, ["D:/toggle-demo"], "E unregister must go through onUnregisterWorkspace");
  assert.equal(status, "unregistered");
});

test("collectWorkspaces parses expires_at and distinguishes lease types", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.yaml");
  const future = new Date(Date.now() + 300_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  await writeFile(config, [
    "workspaces:",
    "    - name: permanent",
    "      path: D:\perm",
    "    - name: live-lease",
    "      path: D:\live",
    `      expires_at: "${future}"`,
    "    - name: stale-lease",
    "      path: D:\stale",
    `      expires_at: "${past}"`,
    "",
  ].join("\n"), "utf8");
  const workspaces = collectWorkspaces(config);
  assert.equal(workspaces.length, 3);
  assert.equal(workspaces[0].expiresAt, undefined, "permanent entry has no expires_at");
  assert.ok(workspaces[1].expiresAt! > Date.now(), "live lease expires in the future");
  assert.ok(workspaces[2].expiresAt! <= Date.now(), "stale lease expired in the past");
});

test("key dispatch: r=refresh, R=restart, w=workspaces (no r/R overlap)", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "gateway-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "gateway.cmd" : "gateway");
  await writeFile(shim, isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const prevBin = process.env.PI_MAESTRO_GATEWAY_BIN;
  const prevPath = process.env.PATH;
  const prevPidFile = process.env.PI_MAESTRO_GATEWAY_PID_FILE;
  // PID file points at pid 4 (unkillable system process) so R's stop phase is a
  // harmless no-op and never falls into the port-kill fallback (which would
  // target a real gateway on this machine).
  const pidFile = join(dir, "gateway-server.pid");
  await writeFile(pidFile, "4", "utf8");
  process.env.PI_MAESTRO_GATEWAY_BIN = shim;
  process.env.PI_MAESTRO_GATEWAY_PID_FILE = pidFile;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${prevPath ?? ""}`;
  t.after(() => {
    if (prevBin === undefined) delete process.env.PI_MAESTRO_GATEWAY_BIN;
    else process.env.PI_MAESTRO_GATEWAY_BIN = prevBin;
    process.env.PATH = prevPath;
    if (prevPidFile === undefined) delete process.env.PI_MAESTRO_GATEWAY_PID_FILE;
    else process.env.PI_MAESTRO_GATEWAY_PID_FILE = prevPidFile;
  });
  const overlay = new GatewayOverlay({ cwd: "D:/key-demo", requestRender: () => undefined, close: () => undefined, endpointWaitMs: 150 });
  const s = overlay;
  t.after(() => overlay.dispose());
  s["restartGateway"] = async () => { s["status"] = "正在重启 Pi Maestro Gateway…"; };
  await overlay.refresh();

  // A stale tunnel remains a separate T action; s/R own only the built-in daemon.
  s["snapshot"] = {
    ...s["snapshot"],
    endpoint: "online",
    tunnel: { pid: 123, url: "https://stale.trycloudflare.com", alive: false, health: "dead" },
  };
  const staleTunnelView = overlay.render(100).join("\n");
  assert.match(staleTunnelView, /Cloudflare Quick Tunnel.*异常/);
  assert.match(staleTunnelView, /T 重建 Cloudflare/);

  // lowercase w enters workspace mode (previously only uppercase W worked)
  overlay.handleInput("w");
  assert.equal(s["mode"], "workspace", "w must open workspace mode");
  s["mode"] = "list";

  // r triggers a refresh (refreshing set synchronously)
  overlay.handleInput("r");
  assert.equal(s["snapshot"].refreshing, true, "r must refresh");
  for (let i = 0; i < 50 && s["snapshot"].refreshing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // R must NOT refresh (old code mapped r/R both to refresh, making R restart
  // unreachable); it must take the restart path.
  overlay.handleInput("R");
  assert.equal(s["snapshot"].refreshing, false, "R must not refresh");
  assert.ok(String(s["status"]).startsWith("正在重启"), `R must restart, got: ${s["status"]}`);
});

test("window view renders unified sources and incrementally merges observe events", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const session: GatewayRemoteSession = { sessionId: "rs_1", workspace: "demo", label: "primary", status: "running" };
  const window: GatewayRuntimeWindow = {
    id: "piw_1", kind: "managed", managed: true, displayName: "worker", target: "piw_1", ownerId: "piw_1",
    pid: 42, publishedAt: Date.now(), agentCount: 0, status: "running", cursor: 1,
    remoteSessionId: session.sessionId, remoteSessionLabel: "primary", workspace: "demo",
  };
  let observeCalls = 0;
  const sent: Array<Record<string, unknown>> = [];
  const fakeClient = {
    observeWindow: async (): Promise<GatewayWindowObservation> => {
      observeCalls++;
      return observeCalls === 1
        ? {
          source: "managed", window, status: "running", cursor: 2, nextCursor: 2, oldestCursor: 1, hasMore: false,
          events: [{ cursor: 2, kind: "assistant", at: 100, text: "first output" }],
        }
        : {
          source: "managed", window, status: "settled", cursor: 3, nextCursor: 3, oldestCursor: 1, hasMore: false,
          events: [{ cursor: 3, kind: "tool", at: 200, toolName: "bash", status: "completed" }],
        };
    },
    sendWindow: async (input: Record<string, unknown>) => {
      sent.push(input);
      return { windowId: input.targetMode === "new" ? "piw_new" : undefined, action: "prompt", raw: {} };
    },
  };
  const composed: string[] = [];
  const overlay = new GatewayOverlay({
    cwd: "D:/window-view",
    requestRender: () => undefined,
    initialRefresh: false,
    close: () => undefined,
    onComposeWindowMessage: async (_target, _session, mode) => {
      composed.push(mode);
      return { purpose: `${mode} work`, message: `${mode} message`, name: mode === "new" ? "new-worker" : undefined };
    },
  });
  t.after(() => overlay.dispose());
  overlay["refreshGeneration"]++;
  overlay["snapshot"] = {
    refreshing: false, endpoint: "online", workspaces: [], cwdRegistered: false, windows: [], thread: [], mcpServers: [],
    connections: [session], runtimeWindows: [window],
  } satisfies GatewaySnapshot;
  overlay["client"] = fakeClient as never;

  overlay.handleInput("v");
  assert.match(overlay.render(100).join("\n"), /managed · worker · running/);
  overlay.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  let detail = overlay.render(100).join("\n");
  assert.match(detail, /source managed · status running · cursor 2/);
  assert.match(detail, /assistant · first output/);

  await overlay["observeSelectedWindow"](overlay["observeGeneration"]);
  detail = overlay.render(100).join("\n");
  assert.match(detail, /status settled · cursor 3/);
  assert.match(detail, /assistant · first output/);
  assert.match(detail, /tool · bash · completed/);

  overlay.handleInput("\x1b");
  overlay["closed"] = true; // keep send assertions isolated from the post-send refresh probe
  overlay["client"] = fakeClient as never;
  overlay.handleInput("m");
  await new Promise((resolve) => setTimeout(resolve, 0));
  overlay["client"] = fakeClient as never;
  overlay.handleInput("n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(composed, ["existing", "new"]);
  assert.equal(sent[0].window, "piw_1");
  assert.equal(sent[0].confirmed, true);
  assert.equal(sent[1].targetMode, "new");
  assert.equal(typeof sent[1].idempotencyKey, "string");
});

test("window view keeps the local registry fallback when Runtime calls are auth-blocked", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const overlay = new GatewayOverlay({ cwd: "D:/fallback-view", requestRender: () => undefined, getTerminalRows: () => 12, initialRefresh: false, close: () => undefined });
  t.after(() => overlay.dispose());
  overlay["refreshGeneration"]++;
  overlay["snapshot"] = {
    refreshing: false, endpoint: "online", workspaces: [], cwdRegistered: true, mcpServers: [], thread: [],
    connections: [{ sessionId: "rs_1", workspace: "demo", status: "running" }],
    runtimeWindowFallback: "auth",
    windows: Array.from({ length: 20 }, (_, index) => ({
      displayName: index === 0 ? "local-editor" : `local-${index}`,
      ownerId: String(index + 1).padStart(32, "0"), pid: 99 + index, publishedAt: Date.now(), agentCount: 1,
    })),
    tasks: [{ version: 1, id: "task-1", status: "running", cwd: "D:/fallback-view", workspaceId: "a".repeat(64), principalId: "test", createdAt: Date.now(), updatedAt: Date.now() }],
  } satisfies GatewaySnapshot;
  overlay.handleInput("v");
  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /鉴权阻止 Runtime 调用 · 使用 local registry fallback/);
  assert.match(rendered, /local · local-editor/);
  assert.match(rendered, /… 17 more/);
  assert.ok(rendered.split("\n").length <= 12, "fallback rows must honor the terminal-height budget");
});

test("window rendering strips terminal control sequences from remote data", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const overlay = new GatewayOverlay({ cwd: "D:/sanitize-view", requestRender: () => undefined, initialRefresh: false, close: () => undefined });
  t.after(() => overlay.dispose());
  overlay["snapshot"] = {
    refreshing: false, endpoint: "online", workspaces: [], cwdRegistered: false, thread: [], mcpServers: [], windows: [],
    connections: [{ sessionId: "rs_1", workspace: "demo\x1b]52;c;bad\x07", status: "running", label: "label" }],
    runtimeWindows: [{
      id: "piw_1", kind: "managed", managed: true, displayName: "worker\x1b[2J", target: "piw_1", ownerId: "piw_1",
      pid: 1, publishedAt: Date.now(), agentCount: 0, status: "running", cursor: 1,
      remoteSessionId: "rs_1", remoteSessionLabel: "label", workspace: "demo",
    }],
  } satisfies GatewaySnapshot;
  overlay.handleInput("v");
  const rendered = overlay.render(100).join("\n");
  assert.doesNotMatch(rendered, /\x1b\]52/);
  assert.doesNotMatch(rendered, /\x1b\[2J/);
});

test("Gateway install prompt covers missing and verified built-in binaries", async () => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const overlay = new GatewayOverlay({
    cwd: "D:/fork-prompt-demo",
    requestRender: () => undefined,
    close: () => undefined,
  });
  const base = {
    refreshing: false, endpoint: "offline", workspaces: [], cwdRegistered: false,
    thread: [], mcpServers: [], windows: [],
  } satisfies Partial<GatewaySnapshot>;

  overlay["snapshot"] = { ...base, binary: undefined, forkInstalled: false } satisfies GatewaySnapshot;
  let rows = overlay["renderForkRows"](100).join("\n");
  assert.match(rows, /未找到 Pi Maestro Gateway/);
  assert.match(rows, /PI_MAESTRO_GATEWAY_BIN/);
  assert.doesNotMatch(rows, /gateway-for-pmf/);

  rows = overlay.render(100).join("\n");
  assert.match(rows, /Pi Maestro Gateway/);
  assert.match(rows, /1 主页/);
  assert.match(rows, /2 配置/);
  assert.doesNotMatch(rows, /连接监控|\/gateway\b/);

  overlay["snapshot"] = { ...base, binary: "/usr/local/bin/pi-maestro-gateway", forkInstalled: true, forkVersion: "0.9.7" } satisfies GatewaySnapshot;
  rows = overlay["renderForkRows"](100).join("\n");
  assert.match(rows, /Pi Maestro Gateway 已安装/);
  assert.match(rows, /v0\.9\.7/);
});

test("Gateway uses home/config pages, renders two columns, and saves OpenAI tunnel references", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "gateway-cfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  });
  await mkdir(join(dir, ".pi", "agent", "gateway"), { recursive: true });
  await writeFile(join(dir, ".pi", "agent", "gateway", "config.yaml"), [
    "server:",
    "    host: 127.0.0.1",
    "    port: 9090",
    "auth:",
    "    mode: open",
    '    token: ""',
    "security:",
    "    commands:",
    "        default: allow",
    "        allow:",
    "            - ^ls\\b",
    "        confirm: []",
    "        deny: []",
    "        auto_allow_readonly: null",
    "    files:",
    "        max_read_bytes: 1048576",
    "        max_patch_files: 20",
    "        allow: []",
    "        confirm: []",
    "        deny: []",
    "",
  ].join("\n"), "utf8");

  const overlay = new GatewayOverlay({ cwd: "D:/cfg-demo", requestRender: () => undefined, initialRefresh: false, close: () => undefined });
  const renderText = () => overlay.render(110).join("\n");
  const select = (key: string) => {
    overlay["configSelected"] = overlay["configEntries"]().findIndex((entry) => entry.key === key);
    assert.notEqual(overlay["configSelected"], -1, `missing config entry ${key}`);
  };

  overlay.handleInput("c");
  assert.equal(overlay["mode"], "config");
  let text = renderText();
  assert.match(text, /1 主页/);
  assert.match(text, /\[2 配置\]/);
  assert.match(text, /Gateway 基础与命令安全/);
  assert.match(text, /公网隧道与文件安全/);
  assert.match(text, /\[Cloudflare\].*OpenAI experimental/);
  assert.match(text, / │ /, "wide config view must render two columns");

  select("server.port");
  overlay.handleInput("\r");
  for (const digit of "9091") overlay.handleInput(digit);
  overlay.handleInput("\r");

  select("commands.default");
  overlay.handleInput(" ");
  assert.match(renderText(), /default: \x1b\[33mconfirm/);

  select("commandsAllow");
  overlay.handleInput("\r");
  overlay.handleInput("a");
  for (const char of "^pi\\b") overlay.handleInput(char);
  overlay.handleInput("\r");
  assert.match(renderText(), /\^pi\\b/);
  overlay.handleInput("\x1b");

  select("tunnel.provider");
  overlay.handleInput(" ");
  text = renderText();
  assert.match(text, /Cloudflare.*\[OpenAI experimental\]/);
  assert.match(text, /binary_path/);
  assert.match(text, /\/install openai-tunnel/);

  select("tunnel.openai.enabled");
  overlay.handleInput(" ");
  select("tunnel.openai.tunnelIdEnv");
  overlay.handleInput("\r");
  for (const char of "MY_TUNNEL_ID") overlay.handleInput(char);
  overlay.handleInput("\r");

  select("save");
  await overlay["saveConfig"]();
  assert.match(renderText(), /已写入/);
  const after = await readFile(join(dir, ".pi", "agent", "gateway", "config.yaml"), "utf8");
  assert.match(after, /port: 9091/);
  assert.match(after, /default: confirm/);
  assert.match(after, /\^pi\\b/);
  assert.match(after, /\^ls\\b/);
  assert.match(after, /tunnels:/);
  assert.match(after, /enabled: true/);
  assert.match(after, /tunnel_id_env: MY_TUNNEL_ID/);
  assert.doesNotMatch(after, /CONTROL_PLANE_API_KEY:/, "only env names may be persisted, never secret values");

  overlay.handleInput("1");
  assert.equal(overlay["mode"], "list");
  assert.match(renderText(), /\[1 主页\]/);
});

test("Gateway collaboration view distinguishes independent Todo and exposes members plus Monitor cursors", async (t) => {
  const { GatewayOverlay } = await import("../src/tui/gateway-overlay.ts");
  const now = Date.now();
  const todo = {
    version: 1, id: "gw-todo-1", sessionId: "collab-1", revision: 1,
    subject: "Gateway-only work", status: "pending", dependencyIds: [], creatorId: "owner",
    createdAt: now, updatedAt: now,
  } as const;
  const sessionState = {
    version: 1,
    session: { version: 1, id: "collab-1", status: "active", revision: 2, workspaceId: "a".repeat(64), workspacePath: "D:/gateway-ui", createdAt: now, updatedAt: now },
    members: [{ version: 1, id: "owner", sessionId: "collab-1", principalId: "http:bearer:test", role: "owner", status: "active", capabilities: ["session:read", "session:write", "member:manage", "todo:read", "todo:write"], generation: 3, leaseExpiresAt: now + 60_000, joinedAt: now, updatedAt: now }],
    todos: [todo], operations: [], events: [],
  } as never;
  const monitor = { handle: "handle-1", task: { version: 1, id: "handle-1", status: "running", objective: "work", cwd: "D:/gateway-ui", createdAt: now, updatedAt: now, workspaceId: "a".repeat(64), eventCursor: 9, resultCount: 0 } } as never;
  const mutations: Array<Record<string, unknown>> = [];
  const fakeClient = {
    mutateGatewayTodo: async (input: Record<string, unknown>) => { mutations.push(input); return todo; },
    observeGatewayMonitor: async () => ({
      handle: "handle-1", task: { ...monitor.task, status: "lost" }, events: [{ cursor: 7, taskId: "handle-1", type: "state", at: now }],
      nextCursor: 7, oldestCursor: 7, hasMore: false, gap: true,
    }),
  };
  const overlay = new GatewayOverlay({ cwd: "D:/gateway-ui", requestRender: () => undefined, initialRefresh: false, close: () => undefined });
  t.after(() => overlay.dispose());
  overlay["snapshot"] = {
    refreshing: false, endpoint: "online", workspaces: [], cwdRegistered: false, windows: [], thread: [], mcpServers: [],
    collaborativeSessions: [sessionState], collaborationMonitors: { "collab-1": [monitor] }, collaborationMemberIds: { "collab-1": "owner" },
  } as never;
  overlay["client"] = fakeClient as never;

  let text = overlay.render(110).join("\n");
  assert.match(text, /Gateway Todo 与 Pi Todo 独立/);
  overlay.handleInput("g");
  assert.equal(overlay["mode"], "collaboration");
  text = overlay.render(110).join("\n");
  assert.match(text, /CollaborativeSession/);
  assert.match(text, /revision 2/);

  overlay.handleInput("\r");
  text = overlay.render(110).join("\n");
  assert.match(text, /owner · owner\/active · gen 3 · lease/);
  assert.match(text, /Gateway Todo \(1\) · independent; not synchronized with Pi Todo/);
  assert.match(text, /pending · gw-todo-1 · Gateway-only work/);
  assert.match(text, /running · handle-1 · cursor 9/);

  overlay["closed"] = true; // keep the focused action test from starting a disk/network refresh
  overlay.handleInput("a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]!.action, "claim");
  assert.equal(mutations[0]!.expectedSessionRevision, 2);

  overlay["closed"] = false;
  overlay["collaborationItemSelected"] = 1;
  overlay.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  text = overlay.render(110).join("\n");
  assert.match(text, /lost/);
  assert.match(text, /next cursor 7 · oldest 7/);
  assert.match(text, /cursor gap: older Monitor events were lost/);
});
