import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  _mcpxTuiInternals,
  type McpxSnapshot,
  type McpxThreadEntry,
  type McpxWindowInfo,
} from "../src/tui/mcpx-overlay.ts";
import type {
  McpxRemoteSession,
  McpxRuntimeWindow,
  McpxWindowObservation,
} from "../src/tui/mcpx-client.ts";
import { collectMcpServers, collectConnections } from "../src/tui/mcpx-overlay.ts";

const { normalizeWorkspacePath, workspaceIdForCwd, collectWorkspaces, collectWindows, collectThread, displayNameOf } = _mcpxTuiInternals;

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

test("collectWorkspaces parses the mcpx global config", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
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
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
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
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
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
  const dir = await mkdtemp(join(tmpdir(), "mcpx-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { github: { type: "stdio", command: "npx", description: "github mcp" } },
  }), "utf8");
  await mkdir(join(dir, ".agents"));
  await writeFile(join(dir, ".agents", "mcp.json"), JSON.stringify({
    mcpServers: { github: { command: "custom-github" }, local: { command: "node" } },
  }), "utf8");
  const servers = collectMcpServers(dir);
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
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "mcpx.cmd" : "mcpx");
  await writeFile(
    shim,
    isWin
      ? `@echo off\r\nif "%1"=="workspace" if "%2"=="list" echo workspaces:\r\nexit /b 0\r\n`
      : `#!/bin/sh\nif [ "$1" = "workspace" ] && [ "$2" = "list" ]; then echo workspaces:; fi\nexit 0\n`,
  );
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const previousBin = process.env.MCPX_BIN;
  const previousPath = process.env.PATH;
  process.env.MCPX_BIN = shim;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${previousPath ?? ""}`;
  t.after(() => {
    if (previousBin === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previousBin;
    process.env.PATH = previousPath;
  });

  const registerCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const overlay = new McpxOverlay({
    cwd: "D:/toggle-demo",
    requestRender: () => undefined,
    close: () => undefined,
    onRegisterWorkspace: async (path) => { registerCalls.push(path); return "registered-leased"; },
    onUnregisterWorkspace: async (path) => { unregisterCalls.push(path); return "unregistered"; },
  });
  const s = overlay;
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
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-toggle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "mcpx.cmd" : "mcpx");
  await writeFile(
    shim,
    isWin
      ? `@echo off\r\nif "%1"=="workspace" if "%2"=="list" echo workspaces:\r\nexit /b 0\r\n`
      : `#!/bin/sh\nif [ "$1" = "workspace" ] && [ "$2" = "list" ]; then echo workspaces:; fi\nexit 0\n`,
  );
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const previousBin = process.env.MCPX_BIN;
  process.env.MCPX_BIN = shim;
  t.after(() => {
    if (previousBin === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = previousBin;
  });

  const permanentCalls: string[] = [];
  const leaseCalls: string[] = [];
  const unregisterCalls: string[] = [];
  const overlay = new McpxOverlay({
    cwd: "D:/toggle-demo",
    requestRender: () => undefined,
    close: () => undefined,
    onRegisterWorkspace: async (path) => { leaseCalls.push(path); return "registered-leased"; },
    onRegisterWorkspacePermanent: async (path) => { permanentCalls.push(path); return "registered-permanent"; },
    onUnregisterWorkspace: async (path) => { unregisterCalls.push(path); return "unregistered"; },
  });
  const s = overlay;
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
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
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
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const isWin = process.platform === "win32";
  const shim = join(binDir, isWin ? "mcpx.cmd" : "mcpx");
  await writeFile(shim, isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWin) await (await import("node:fs/promises")).chmod(shim, 0o755);
  const prevBin = process.env.MCPX_BIN;
  const prevPath = process.env.PATH;
  const prevPidFile = process.env.MCPX_PID_FILE;
  // PID file points at pid 4 (unkillable system process) so R's stop phase is a
  // harmless no-op and never falls into the port-kill fallback (which would
  // target a real mcpx on this machine).
  const pidFile = join(dir, "mcpx-server.pid");
  await writeFile(pidFile, "4", "utf8");
  process.env.MCPX_BIN = shim;
  process.env.MCPX_PID_FILE = pidFile;
  process.env.PATH = `${binDir}${isWin ? ";" : ":"}${prevPath ?? ""}`;
  t.after(() => {
    if (prevBin === undefined) delete process.env.MCPX_BIN;
    else process.env.MCPX_BIN = prevBin;
    process.env.PATH = prevPath;
    if (prevPidFile === undefined) delete process.env.MCPX_PID_FILE;
    else process.env.MCPX_PID_FILE = prevPidFile;
  });
  const overlay = new McpxOverlay({ cwd: "D:/key-demo", requestRender: () => undefined, close: () => undefined, endpointWaitMs: 150 });
  const s = overlay;
  await overlay.refresh();

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
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const session: McpxRemoteSession = { sessionId: "rs_1", workspace: "demo", label: "primary", status: "running" };
  const window: McpxRuntimeWindow = {
    id: "piw_1", kind: "managed", managed: true, displayName: "worker", target: "piw_1", ownerId: "piw_1",
    pid: 42, publishedAt: Date.now(), agentCount: 0, status: "running", cursor: 1,
    remoteSessionId: session.sessionId, remoteSessionLabel: "primary", workspace: "demo",
  };
  let observeCalls = 0;
  const sent: Array<Record<string, unknown>> = [];
  const fakeClient = {
    observeWindow: async (): Promise<McpxWindowObservation> => {
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
  const overlay = new McpxOverlay({
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
  } satisfies McpxSnapshot;
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
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const overlay = new McpxOverlay({ cwd: "D:/fallback-view", requestRender: () => undefined, getTerminalRows: () => 12, initialRefresh: false, close: () => undefined });
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
    tasks: [{ task_id: "task-1", remote_session_id: "rs_1", workspace: "demo", action: "delegate", message: "work", purpose: "work", status: "executing", created_at: new Date().toISOString() }],
  } satisfies McpxSnapshot;
  overlay.handleInput("v");
  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /鉴权阻止 Runtime 调用 · 使用 local registry fallback/);
  assert.match(rendered, /local · local-editor/);
  assert.match(rendered, /… 17 more/);
  assert.ok(rendered.split("\n").length <= 12, "fallback rows must honor the terminal-height budget");
});

test("window rendering strips terminal control sequences from remote data", async (t) => {
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const overlay = new McpxOverlay({ cwd: "D:/sanitize-view", requestRender: () => undefined, initialRefresh: false, close: () => undefined });
  t.after(() => overlay.dispose());
  overlay["snapshot"] = {
    refreshing: false, endpoint: "online", workspaces: [], cwdRegistered: false, thread: [], mcpServers: [], windows: [],
    connections: [{ sessionId: "rs_1", workspace: "demo\x1b]52;c;bad\x07", status: "running", label: "label" }],
    runtimeWindows: [{
      id: "piw_1", kind: "managed", managed: true, displayName: "worker\x1b[2J", target: "piw_1", ownerId: "piw_1",
      pid: 1, publishedAt: Date.now(), agentCount: 0, status: "running", cursor: 1,
      remoteSessionId: "rs_1", remoteSessionLabel: "label", workspace: "demo",
    }],
  } satisfies McpxSnapshot;
  overlay.handleInput("v");
  const rendered = overlay.render(100).join("\n");
  assert.doesNotMatch(rendered, /\x1b\]52/);
  assert.doesNotMatch(rendered, /\x1b\[2J/);
});

test("fork install prompt covers not-installed, binary-without-fork, and installed states", async () => {
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const overlay = new McpxOverlay({
    cwd: "D:/fork-prompt-demo",
    requestRender: () => undefined,
    close: () => undefined,
  });
  const base = {
    refreshing: false, endpoint: "offline", workspaces: [], cwdRegistered: false,
    thread: [], mcpServers: [], windows: [],
  } satisfies Partial<McpxSnapshot>;

  // 仅安装插件，mcpx 完全未安装 → 红色安装指引
  overlay["snapshot"] = { ...base, binary: undefined, forkInstalled: false } satisfies McpxSnapshot;
  let rows = overlay["renderForkRows"](100).join("\n");
  assert.match(rows, /未安装 mcpx/);
  assert.match(rows, /npm i -g mcpx-for-pmf/);

  // 有 mcpx 二进制（源码编译/上游包）但未装 mcpx-for-pmf npm 包 → 黄色建议
  overlay["snapshot"] = { ...base, binary: "/usr/local/bin/mcpx", forkInstalled: false } satisfies McpxSnapshot;
  rows = overlay["renderForkRows"](100).join("\n");
  assert.match(rows, /未检测到 mcpx-for-pmf 包/);
  assert.match(rows, /npm i -g mcpx-for-pmf/);

  // fork 已安装 → 绿色确认 + 版本
  overlay["snapshot"] = { ...base, binary: "/usr/local/bin/mcpx", forkInstalled: true, forkVersion: "0.9.7" } satisfies McpxSnapshot;
  rows = overlay["renderForkRows"](100).join("\n");
  assert.match(rows, /mcpx-for-pmf 已安装/);
  assert.match(rows, /v0\.9\.7/);
});

test("C enters inline config mode and edits scalars + lists then saves", async (t) => {
  const { McpxOverlay } = await import("../src/tui/mcpx-overlay.ts");
  const dir = await mkdtemp(join(tmpdir(), "mcpx-cfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Isolate HOME so readMcpxConfigView/writeMcpxConfigChanges hit the temp config.
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  });
  await mkdir(join(dir, ".mcpx"), { recursive: true });
  await writeFile(join(dir, ".mcpx", "config.yaml"), [
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

  const overlay = new McpxOverlay({ cwd: "D:/cfg-demo", requestRender: () => undefined, initialRefresh: false, close: () => undefined });
  const renderText = () => overlay.render(100).join("\n");

  // C (capital) enters inline config mode; c would open the wizard (no onOpenWizard wired).
  overlay.handleInput("C");
  assert.equal(overlay["mode"], "config");
  let text = renderText();
  assert.match(text, /MCPX 配置/);
  assert.match(text, /「服务器监听」/);
  assert.match(text, /host: 127\.0\.0\.1/);
  assert.match(text, /port: 9090/);

  // Navigate to port (down once) and edit it inline with a fresh value.
  overlay.handleInput("\x1b[B"); // down -> port entry
  overlay.handleInput("\r"); // enter edit (draft starts empty)
  overlay.handleInput("9");
  overlay.handleInput("0");
  overlay.handleInput("9");
  overlay.handleInput("1");
  overlay.handleInput("\r"); // commit -> port 9091
  text = renderText();
  assert.match(text, /port: 9091/);

  // Cycle commands.default via space: move down to commands.default and space.
  // Order: host(0) port(1) disable_localhost(2) trust_proxy(3) mode(4) token(5)
  // oauthPassword(6) oauthServerURL(7) default(8) autoAllowReadonly(9)
  // allow(10) confirm(11) deny(12) max_read_bytes(13) max_patch_files(14) ...
  for (let i = 0; i < 7; i++) overlay.handleInput("\x1b[B"); // port -> default (8)
  overlay.handleInput(" "); // cycle allow -> confirm
  text = renderText();
  assert.match(text, /default: \x1b\[33mconfirm/);

  // Open commands.allow list editor, add a rule, then return.
  overlay.handleInput("\x1b[B"); // default -> autoAllowReadonly(9)
  overlay.handleInput("\x1b[B"); // -> allow list(10)
  overlay.handleInput("\r"); // enter list editor
  text = renderText();
  assert.match(text, /列表编辑/);
  assert.match(text, /\^ls\\b/); // existing entry visible
  // add a new rule
  overlay.handleInput("a");
  overlay.handleInput("^");
  overlay.handleInput("p");
  overlay.handleInput("i");
  overlay.handleInput("\\");
  overlay.handleInput("b");
  overlay.handleInput("\r"); // commit add
  text = renderText();
  assert.match(text, /\^pi\\b/);
  // Esc back to top menu
  overlay.handleInput("\x1b");
  assert.equal(overlay["configListKey"], undefined);

  // Navigate to Save action and trigger it. The Save entry is near the bottom:
  // entries 0..17 are scalars/lists, 18 = save, 19 = discard. From allow(10) go down 8.
  for (let i = 0; i < 8; i++) overlay.handleInput("\x1b[B");
  overlay.handleInput("\r"); // save
  // write is synchronous (writeFileSync+rename) so the status is set immediately.
  text = renderText();
  assert.match(text, /已写入/);
  // Verify the file on disk reflects port + default + the new allow rule.
  const after = await readFile(join(dir, ".mcpx", "config.yaml"), "utf8");
  assert.match(after, /port: 9091/);
  assert.match(after, /default: confirm/);
  assert.match(after, /\^pi\\b/);
  assert.match(after, /\^ls\\b/); // existing allow preserved
});
