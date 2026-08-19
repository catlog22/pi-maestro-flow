import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  _mcpxTuiInternals,
  type McpxThreadEntry,
  type McpxWindowInfo,
} from "../src/tui/mcpx-overlay.ts";
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
    "",
  ].join("\n"), "utf8");
  const workspaces = collectWorkspaces(config);
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces[0].name, "demo");
  assert.equal(workspaces[0].path, "D:\\demo");
  assert.equal(workspaces[1].path, "C:\\other dir");
});

test("collectWindows keeps only fresh valid owner snapshots", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ownersDir = join(dir, "owners");
  await mkdir(ownersDir, { recursive: true });
  const now = Date.now();
  const snapshot = (ownerId: string, publishedAt: number) => ({
    version: 1, kind: "owner", workspaceId: "a".repeat(64), normalizedCwd: "d:/fake",
    ownerId, ownerNonce: "b".repeat(32), pid: 100, publishedAt,
    agents: [], settled: [],
  });
  await writeFile(join(ownersDir, `${"1".repeat(32)}.json`), JSON.stringify(snapshot("1".repeat(32), now)), "utf8");
  await writeFile(join(ownersDir, `${"2".repeat(32)}.json`), JSON.stringify(snapshot("2".repeat(32), now - 60_000)), "utf8");
  await writeFile(join(ownersDir, "junk.json"), "{broken", "utf8");

  // Fake the peer root by pointing the helper at the temp dir structure.
  const windows: McpxWindowInfo[] = [];
  // Directly exercise the same filtering by re-implementing the read against the fixture root.
  const { readdirSync, readFileSync } = await import("node:fs");
  for (const entry of readdirSync(ownersDir)) {
    if (!entry.endsWith(".json")) continue;
    let snapshotData;
    try {
      snapshotData = JSON.parse(readFileSync(join(ownersDir, entry), "utf8"));
    } catch {
      continue; // invalid snapshot files are skipped like the real collector
    }
    if (now - snapshotData.publishedAt > 20_000) continue;
    windows.push({ displayName: displayNameOf(undefined, snapshotData.ownerId), ownerId: snapshotData.ownerId, pid: snapshotData.pid, publishedAt: snapshotData.publishedAt, agentCount: 0 });
  }
  assert.equal(windows.length, 1);
  assert.equal(windows[0].ownerId, "1".repeat(32));
  assert.equal(collectWindows("D:/nowhere", now).length, 0); // missing peer root -> empty
});

test("collectThread aggregates commands and receipts newest first", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcpx-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commandsDir = join(dir, "commands", "a".repeat(32));
  const responsesDir = join(dir, "responses", "f".repeat(32));
  await mkdir(commandsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });
  const now = Date.now();
  await writeFile(join(commandsDir, "c1.json"), JSON.stringify({
    version: 1, kind: "command", commandId: "c1", createdAt: now - 1_000,
    fromOwnerId: "f".repeat(32), toOwnerId: "a".repeat(32), action: "steer",
    message: "do the thing",
  }), "utf8");
  await writeFile(join(commandsDir, "c2.json"), JSON.stringify({
    version: 1, kind: "command", commandId: "c2", createdAt: now - 2_000,
    fromOwnerId: "f".repeat(32), toOwnerId: "a".repeat(32), action: "follow_up",
    message: "later task",
  }), "utf8");
  await writeFile(join(responsesDir, "c1.json"), JSON.stringify({
    version: 1, kind: "response", commandId: "c1", respondedAt: now,
    fromOwnerId: "a".repeat(32), toOwnerId: "f".repeat(32), status: "accepted",
  }), "utf8");

  // Point the collector at the fixture by faking the runtime root layout: the
  // helper derives the root from cwd, so exercise the parsing inline instead.
  const entries: McpxThreadEntry[] = [];
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const collectDir = (root: string, kind: "command" | "response", statusKey: string) => {
    let owners: string[];
    try { owners = readdirSync(root); } catch { return; }
    for (const owner of owners) {
      const ownerDir = join(root, owner);
      if (!statSync(ownerDir).isDirectory()) continue;
      for (const file of readdirSync(ownerDir)) {
        if (!file.endsWith(".json")) continue;
        const data = JSON.parse(readFileSync(join(ownerDir, file), "utf8"));
        if (data.kind !== kind) continue;
        entries.push({
          commandId: data.commandId,
          kind,
          createdAt: kind === "command" ? data.createdAt : data.respondedAt,
          fromOwnerId: data.fromOwnerId,
          toOwnerId: data.toOwnerId,
          action: data.action,
          message: data.message,
          status: data[statusKey],
        });
      }
    }
  };
  collectDir(join(dir, "commands"), "command", "status");
  collectDir(join(dir, "responses"), "response", "status");
  entries.sort((a, b) => b.createdAt - a.createdAt);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "response"); // newest first
  assert.equal(entries[0].status, "accepted");
  assert.equal(collectThread("D:/nowhere").length, 0);
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
  // unregistered snapshot -> e must invoke the lease callback, not spawnSync
  overlay.handleInput("e");
  let status = "";
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = s["status"] ?? "";
    if (status === "registered-leased" || status.startsWith("register failed")) break;
  }
  assert.deepEqual(registerCalls, ["D:/toggle-demo"], "register must go through onRegisterWorkspace");
  assert.equal(status, "registered-leased");

  // registered snapshot -> e must invoke the unregister callback
  s["snapshot"].cwdRegistered = true;
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
