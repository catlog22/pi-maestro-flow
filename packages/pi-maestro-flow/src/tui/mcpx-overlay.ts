/**
 * McpxOverlay — configure and monitor the mcpx (mcpx for pmf) connection:
 * binary/endpoint status, registered workspaces, discoverable Pi windows and
 * cross-window message history (workspace-peer file protocol).
 *
 * Keys: ↑↓/jk select history · Enter details · r refresh · R restart · e register/unregister cwd · s start · x stop · t tunnel refresh · w workspaces · c wizard · p password · Esc close
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { locateMcpx, readTunnelState, probeTunnelHealth, restartQuickTunnel, updateConfigServerURL, stopMcpx, readOpsPassword, detectMcpxForPmf, removeWorkspaceByPath, readDelegatedTasks, type TunnelState, type DelegatedTask } from "../mcpx-bridge.ts";

const MCPX_DEFAULT_ENDPOINT = "http://127.0.0.1:9090/mcp";
const PEER_STALE_MS = 20_000;

export interface McpxWorkspaceInfo {
  name: string;
  path: string;
  /** Lease expiry (ms epoch) for TTL-registered windows; undefined = permanent. */
  expiresAt?: number;
}

export interface McpxWindowInfo {
  displayName: string;
  ownerId: string;
  pid: number;
  publishedAt: number;
  agentCount: number;
  contextPressure?: number;
}

export interface McpxThreadEntry {
  commandId: string;
  kind: "command" | "response";
  createdAt: number;
  fromOwnerId: string;
  toOwnerId: string;
  action?: string;
  message?: string;
  status?: string;
}

export interface McpxMcpServerInfo {
  name: string;
  type: string;
  command: string;
  source: "global" | "project" | "agents" | "mcpx";
  executable: boolean;
  description?: string;
}

export interface McpxConnectionInfo {
  sessionId: string;
  workspace: string;
  label?: string;
  status: string;
}

export interface McpxSnapshot {
  refreshing: boolean;
  binary?: string;
  version?: string;
  endpoint: "unknown" | "online" | "offline";
  endpointVersion?: string;
  configPath?: string;
  workspaces: McpxWorkspaceInfo[];
  cwdRegistered: boolean;
  /** cwd is in config.yaml but its lease already expired and is waiting for mcpx's sweep. */
  cwdLeaseStale?: boolean;
  windows: McpxWindowInfo[];
  thread: McpxThreadEntry[];
  mcpServers: McpxMcpServerInfo[];
  connections?: McpxConnectionInfo[];
  tunnel?: TunnelState;
  /** Delegated tasks from the mcpx file registry (all sessions). */
  tasks?: DelegatedTask[];
  /** mcpx-for-pmf fork installed as a global npm package? */
  forkInstalled?: boolean;
  forkVersion?: string;
  /** PERF-RV-006: ops password read once during refresh, cached for renders. */
  opsPassword?: string;
  error?: string;
}

export interface McpxOverlayParams {
  cwd: string;
  requestRender: () => void;
  close: () => void;
  onRegisterWorkspace?: (path: string) => Promise<string>;
  onUnregisterWorkspace?: (path: string) => Promise<string>;
  onOpenWizard?: () => void;
  /** Endpoint readiness wait for startMcpx (ms); tests shorten this. */
  endpointWaitMs?: number;
}

type OverlayMode = "list" | "detail" | "workspace";

function normalizeWorkspacePath(value: string): string {
  let normalized = value.replace(/\\/g, "/");
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

function workspaceIdForCwd(cwd: string): string {
  return createHash("sha256").update(normalizeWorkspacePath(cwd), "utf8").digest("hex");
}

function peerRuntimeRoot(cwd: string): string {
  return join(homedir(), ".pi", "teammate", "workspaces", workspaceIdForCwd(cwd), "runtime");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface OwnerSnapshotFile {
  version?: number;
  kind?: string;
  ownerId?: string;
  ownerNonce?: string;
  pid?: number;
  publishedAt?: number;
  sessionName?: string;
  contextPressure?: number;
  agents?: unknown[];
}

function displayNameOf(sessionName: string | undefined, ownerId: string): string {
  const label = sessionName || `window:${ownerId.slice(0, 8)}`;
  return label.length > 64 ? `${label.slice(0, 61)}...` : label;
}

function collectWindows(cwd: string, now: number): McpxWindowInfo[] {
  const ownersDir = join(peerRuntimeRoot(cwd), "owners");
  let entries: string[];
  try {
    entries = readdirSync(ownersDir);
  } catch {
    return [];
  }
  const windows: McpxWindowInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(ownersDir, entry);
    // PERF-RV-013: stat the file and skip stale ones BEFORE reading/parsing.
    // Owner snapshots are written periodically; a file whose mtime is older
    // than PEER_STALE_MS (20s) belongs to a window that already went offline
    // and cannot be fresh, so skip the readFileSync+JSON.parse entirely.
    try {
      const stat = statSync(fullPath);
      if (now - stat.mtimeMs > PEER_STALE_MS) continue;
    } catch {
      continue; // file vanished between readdir and stat — skip
    }
    const snapshot = readJson<OwnerSnapshotFile>(fullPath);
    if (!snapshot || snapshot.kind !== "owner" || !snapshot.ownerId) continue;
    if (now - (snapshot.publishedAt ?? 0) > PEER_STALE_MS) continue;
    windows.push({
      displayName: displayNameOf(snapshot.sessionName, snapshot.ownerId),
      ownerId: snapshot.ownerId,
      pid: snapshot.pid ?? 0,
      publishedAt: snapshot.publishedAt ?? 0,
      agentCount: snapshot.agents?.length ?? 0,
      contextPressure: snapshot.contextPressure,
    });
  }
  windows.sort((a, b) => b.publishedAt - a.publishedAt);
  return windows;
}

function collectThread(cwd: string): McpxThreadEntry[] {
  const root = peerRuntimeRoot(cwd);
  const entries: McpxThreadEntry[] = [];
  // PERF-RV-005: Instead of reading and parsing every JSON file (which grows
  // linearly with history), we stat each file's mtime, sort by mtime desc, and
  // only read+parse the most recent ~60 files. We then slice to 30 as before.
  // This bounds the cost as the commands/responses directories grow large.
  const MAX_READ = 60;

  /** Collect file paths and mtimes from a two-level directory tree. */
  function collectFileMeta(dir: string): Array<{ path: string; mtime: number }> {
    const files: Array<{ path: string; mtime: number }> = [];
    let owners: string[];
    try {
      owners = readdirSync(dir);
    } catch {
      return files;
    }
    for (const owner of owners) {
      const ownerDir = join(dir, owner);
      try {
        if (!statSync(ownerDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of readdirSync(ownerDir)) {
        if (!file.endsWith(".json")) continue;
        if (file.includes(".processing")) continue;
        const fullPath = join(ownerDir, file);
        try {
          files.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
        } catch {
          // file vanished — skip
        }
      }
    }
    return files;
  }

  const commandFiles = collectFileMeta(join(root, "commands"));
  const responseFiles = collectFileMeta(join(root, "responses"));
  const allFiles = [...commandFiles, ...responseFiles];
  allFiles.sort((a, b) => b.mtime - a.mtime);
  const toRead = allFiles.slice(0, MAX_READ);

  for (const { path } of toRead) {
    // Distinguish commands from responses by the directory path: commands live
    // under root/commands/, responses under root/responses/.
    const normalizedPath = path.replace(/\\/g, "/");
    if (normalizedPath.includes("/commands/")) {
      const command = readJson<{
        kind?: string; commandId?: string; createdAt?: number;
        fromOwnerId?: string; toOwnerId?: string; action?: string; message?: string;
      }>(path);
      if (!command || command.kind !== "command" || !command.commandId) continue;
      entries.push({
        commandId: command.commandId,
        kind: "command",
        createdAt: command.createdAt ?? 0,
        fromOwnerId: command.fromOwnerId ?? "",
        toOwnerId: command.toOwnerId ?? "",
        action: command.action,
        message: command.message,
      });
    } else if (normalizedPath.includes("/responses/")) {
      const response = readJson<{
        kind?: string; commandId?: string; respondedAt?: number;
        fromOwnerId?: string; toOwnerId?: string; status?: string;
      }>(path);
      if (!response || response.kind !== "response" || !response.commandId) continue;
      entries.push({
        commandId: response.commandId,
        kind: "response",
        createdAt: response.respondedAt ?? 0,
        fromOwnerId: response.fromOwnerId ?? "",
        toOwnerId: response.toOwnerId ?? "",
        status: response.status,
      });
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries.slice(0, 30);
}

function collectWorkspaces(configPath: string): McpxWorkspaceInfo[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const workspaces: McpxWorkspaceInfo[] = [];
  let current: McpxWorkspaceInfo | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const nameMatch = line.match(/^\s{4}-\s+name:\s*(.+)$/);
    if (nameMatch) {
      current = { name: nameMatch[1].trim(), path: "" };
      workspaces.push(current);
      continue;
    }
    const pathMatch = line.match(/^\s{6}path:\s*(.+)$/);
    if (pathMatch && current) {
      current.path = pathMatch[1].trim().replace(/^"|"$/g, "");
      continue;
    }
    const expMatch = line.match(/^\s{6}expires_at:\s*(.+)$/);
    if (expMatch && current) {
      const parsed = Date.parse(expMatch[1].trim().replace(/^"|"$/g, ""));
      if (Number.isFinite(parsed)) current.expiresAt = parsed;
    }
  }
  return workspaces;
}

interface McpJsonServer {
  type?: string;
  command?: string;
  description?: string;
}

// PERF-RV-004: cache isExecutableOnPath results within a single refresh cycle.
// The map is cleared at the start of each refresh() so a manual re-probe (r key)
// re-checks, but repeated renders within the same refresh reuse results.
const executablePathCache = new Map<string, boolean>();

// collectMcpServers mirrors the mcpx merge order for .mcp.json:
// global → project → .agents/mcp.json → .mcpx/.mcp.json (later wins).
export function collectMcpServers(cwd: string): McpxMcpServerInfo[] {
  const files: Array<{ path: string; source: McpxMcpServerInfo["source"] }> = [
    { path: join(homedir(), ".mcpx", ".mcp.json"), source: "global" },
    { path: join(cwd, ".mcp.json"), source: "project" },
    { path: join(cwd, ".agents", "mcp.json"), source: "agents" },
    { path: join(cwd, ".mcpx", ".mcp.json"), source: "mcpx" },
  ];
  const merged = new Map<string, McpxMcpServerInfo>();
  for (const { path, source } of files) {
    let parsed: { mcpServers?: Record<string, McpJsonServer> };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      const command = server.command ?? "";
      merged.set(name, {
        name,
        type: server.type ?? "stdio",
        command,
        source,
        executable: command ? isExecutableOnPath(command) : false,
        description: server.description,
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isExecutableOnPath(command: string): boolean {
  // PERF-RV-004: reuse cached result within a refresh cycle.
  if (executablePathCache.has(command)) return executablePathCache.get(command)!;
  let result: boolean;
  if (command.includes("/") || command.includes("\\")) {
    result = existsSync(command);
  } else {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
      timeout: 5_000,
      shell: process.platform === "win32",
    });
    result = probe.status === 0;
  }
  executablePathCache.set(command, result);
  return result;
}

// collectConnections probes the running mcpx endpoint for Remote Sessions.
// Returns undefined when the endpoint is unreachable or unauthenticated.
export async function collectConnections(endpoint: string): Promise<McpxConnectionInfo[] | undefined> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session", arguments: { action: "list", limit: 20 } } }),
      signal: AbortSignal.timeout(3_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    let payload: { result?: { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> } };
    if (contentType.includes("text/event-stream")) {
      // COR-RV-009: mirror probeEndpoint's approach — try parsing each data:
      // line and keep the last SUCCESSFUL parse, discarding malformed frames
      // instead of taking the raw last line and parsing once.
      let parsed: typeof payload | undefined;
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          try {
            parsed = JSON.parse(line.slice(5).trim());
          } catch {
            // skip malformed frames — keep the last successful parse
          }
        }
      }
      if (!parsed) return undefined;
      payload = parsed;
    } else {
      payload = JSON.parse(raw);
    }
    const sc = payload?.result?.structuredContent as
      | { data?: { sessions?: Array<{ remote_session_id?: string; workspace_name?: string; workspace?: string; label?: string; status?: string }> } }
      | undefined;
    const sessions = sc?.data?.sessions;
    if (!sessions) return undefined;
    return sessions.map((session) => ({
      sessionId: session.remote_session_id ?? "",
      workspace: session.workspace_name ?? session.workspace ?? "",
      label: session.label,
      status: session.status ?? "",
    })).filter((session) => session.sessionId);
  } catch {
    return undefined;
  }
}

async function probeEndpoint(configPath: string): Promise<{ endpoint: string; reachable: boolean; endpointVersion?: string }> {
  let endpoint = MCPX_DEFAULT_ENDPOINT;
  try {
    const raw = readFileSync(configPath, "utf8");
    const portMatch = raw.match(/^\s{4}port:\s*(\d+)/m);
    if (portMatch) endpoint = `http://127.0.0.1:${portMatch[1]}/mcp`;
  } catch {
    // default endpoint
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcpx-tui", version: "1.0.0" } } }),
      signal: AbortSignal.timeout(2_000),
    });
    // Any HTTP response (even 401/403) proves mcpx is up and listening — only a
    // network failure (thrown) means offline. auth-mode servers reject an
    // unauthenticated initialize with 401, which must NOT read as "未运行".
    const reachable = true;
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    let payload: { result?: { serverInfo?: { name?: string; version?: string } } } | undefined;
    if (contentType.includes("text/event-stream")) {
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            // skip malformed frames
          }
        }
      }
    } else {
      try {
        payload = JSON.parse(raw);
      } catch {
        // non-JSON response
      }
    }
    const info = payload?.result?.serverInfo;
    // 200 → real serverInfo; 401/403 → still reachable, surface an auth hint so
    // the board shows "mcpx (需鉴权)" instead of bare "online" with no version.
    let endpointVersion: string | undefined;
    if (info) endpointVersion = `${info.name} ${info.version}`;
    else if (response.status === 401) endpointVersion = "mcpx 需鉴权（401）";
    else if (response.status === 403) endpointVersion = "mcpx 拒绝（403 Host）";
    else endpointVersion = `mcpx · HTTP ${response.status}`;
    return { endpoint, reachable, endpointVersion };
  } catch {
    return { endpoint, reachable: false };
  }
}

export class McpxOverlay implements Component, Focusable {
  focused = false;
  private mode: OverlayMode = "list";
  private selected = 0;
  /** Selection index inside the workspace-management sub-mode. */
  private wsSelected = 0;
  /** SEC-RV-001: ops password reveal state — masked by default, toggled by P. */
  private revealOpsPassword = false;
  private snapshot: McpxSnapshot = {
    refreshing: true, endpoint: "unknown", workspaces: [], cwdRegistered: false, windows: [], thread: [], mcpServers: [],
  };
  private status = "";
  private starting = false; // guards startMcpx against re-entry (orphan spawns)
  private refreshGeneration = 0;
  private closed = false; // set on close() so async refresh/render skip work after close

  private safeRequestRender(): void {
    if (this.closed) return;
    this.params.requestRender();
  }

  constructor(private readonly params: McpxOverlayParams) {
    void this.refresh();
  }

  invalidate(): void {}
  dispose(): void {}

  private pidPath(): string {
    return process.env.MCPX_PID_FILE ?? join(homedir(), ".mcpx", "mcpx-server.pid");
  }

  /** Read the server-written PID file ({home}/mcpx-server.pid). The Go server
   *  owns this file (writes at start, removes on graceful shutdown), so it is
   *  accurate no matter how mcpx was launched. */
  private readPidFile(): number | undefined {
    try {
      const raw = readFileSync(this.pidPath(), "utf8").trim();
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // no pid file
    }
    return undefined;
  }

  private killPid(pid: number): void {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already dead
      }
    }
  }

  private configPath(): string {
    return join(homedir(), ".mcpx", "config.yaml");
  }

  /** Start the mcpx server detached, persist its PID, and wait for the endpoint. */
  private async startMcpx(): Promise<void> {
    if (this.starting) return; // a second "s" while starting would orphan the first spawn
    const binary = locateMcpx();
    if (!binary) {
      this.status = "未找到 mcpx — 设置 MCPX_BIN 或将其加入 PATH";
      this.params.requestRender();
      return;
    }
    if (this.snapshot.endpoint === "online") {
      this.status = "mcpx 已在运行";
      this.params.requestRender();
      return;
    }
    this.starting = true;
    this.status = "正在启动 mcpx…";
    this.params.requestRender();
    try {
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
      child.unref();
      // The Go server owns the PID file (writes at start, removes on shutdown);
      // the TUI never writes it — a shell-wrapped spawn would persist the
      // wrapper's pid, not mcpx's.
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (reachable) {
          online = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      this.status = online ? "mcpx 已启动并监听" : "mcpx 进程已拉起但端点未就绪（检查启动日志）";
    } catch (error) {
      this.status = `启动失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }

  /** Stop the mcpx server (kills the process tree on Windows). */
  private async stopMcpx(): Promise<void> {
    const pid = this.readPidFile();
    this.status = "正在停止 mcpx…";
    this.params.requestRender();
    try {
      if (pid) {
        this.killPid(pid);
        // /F kill skips the Go server's graceful PID-file cleanup — remove it.
        try {
          rmSync(this.pidPath(), { force: true });
        } catch {
          // best-effort
        }
      } else {
        // PID file missing/stale (mcpx started externally) — fall back to
        // killing whatever listens on the mcpx port.
        this.killMcpxByPort();
      }
      this.status = "已发送停止信号";
    } catch (error) {
      this.status = `停止失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.refresh();
  }

  /** R restarts mcpx: stop (tolerant of an already-dead/external process) then
   *  start. Unlike `s`, this bypasses the online guard so a config-reload
   *  restart works even when the endpoint is already up. */
  private async restartMcpx(): Promise<void> {
    if (this.starting) return;
    const binary = locateMcpx();
    if (!binary) {
      this.status = "未找到 mcpx — 设置 MCPX_BIN 或将其加入 PATH";
      this.safeRequestRender();
      return;
    }
    this.starting = true;
    this.status = "正在重启 mcpx…";
    this.safeRequestRender();
    // Stop any existing process. Tolerate a missing PID file — the process may
    // have been started externally or died; then fall back to the port listener.
    const pid = this.readPidFile();
    if (pid) {
      this.killPid(pid);
    } else {
      this.killMcpxByPort();
    }
    // Give the port a moment to release after kill.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Start fresh — bypass the online guard (we just stopped it on purpose).
    try {
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
      child.unref();
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (reachable) { online = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      this.status = online ? "mcpx 已重启并监听" : "mcpx 进程已拉起但端点未就绪（检查启动日志）";
    } catch (error) {
      this.status = `重启失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }

  /** Kill the process listening on 127.0.0.1:9090 (fallback when the PID file
   *  is stale — e.g. mcpx was started by a prior board session or externally). */
  private killMcpxByPort(): void {
    try {
      if (process.platform === "win32") {
        const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
          encoding: "utf8", timeout: 5_000, shell: true,
        });
        // Strict port match: only LISTENING rows whose local-address column
        // ends in :9090 followed by whitespace. Avoids matching :19090 /
        // :90900 / a foreign-address :9090 on a different row.
        const PORT = 9090;
        const portRe = new RegExp("\\s\\d+\\.\\d+\\.\\d+\\.\\d+:" + PORT + "\\s|\\[::\\]?:" + PORT + "\\s");
        for (const line of String(result.stdout || "").split(/\r?\n/)) {
          if (line.includes("LISTENING") && portRe.test(line)) {
            const m = line.match(/\s(\d+)\s*$/);
            if (m) spawnSync("taskkill", ["/pid", String(m[1]), "/T", "/F"], { stdio: "ignore" });
          }
        }
      } else {
        // POSIX: lsof preferred, ss fallback; output is one pid per line.
        const result = spawnSync("sh", ["-c", "lsof -ti tcp:9090 2>/dev/null || ss -ltnp 'sport = :9090' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2"], {
          encoding: "utf8", timeout: 5_000,
        });
        for (const line of String(result.stdout || "").split(/\r?\n/)) {
          const n = Number(line.trim());
          if (Number.isInteger(n) && n > 0) {
            try { process.kill(n, "SIGTERM"); } catch { /* dead */ }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  /** T restarts the Cloudflare quick tunnel, syncs its new URL into config.yaml's
   *  server_url, and restarts mcpx so the OAuth issuer matches the new URL.
   *  One-click refresh for the quick-tunnel-URL-changed scenario. */
  private async refreshTunnelAndMcpx(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.status = "正在重启隧道并同步 mcpx…";
    this.safeRequestRender();
    let newUrl: string | undefined;
    try {
      // 1. Restart the quick tunnel — stops the old one, parses the new URL.
      newUrl = await restartQuickTunnel(9090);
      // 2. Write the new URL into config.yaml so mcpx's OAuth issuer matches.
      updateConfigServerURL(newUrl);
      // 3. Restart mcpx to load the new server_url. Kill by PID file first, then
      //    by port as a fallback (the PID file may point at a stale/external pid).
      stopMcpx();
      this.killMcpxByPort();
      await new Promise((resolve) => setTimeout(resolve, 800)); // port release
      const binary = locateMcpx();
      if (!binary) throw new Error("未找到 mcpx 二进制");
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
      child.unref();
      // 4. Wait for the endpoint to come back (new issuer).
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (reachable) { online = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      this.status = online
        ? `隧道已更新: ${newUrl}/mcp · mcpx 已重启`
        : `隧道已更新: ${newUrl}/mcp · mcpx 端点未就绪（检查启动日志）`;
    } catch (error) {
      // If a new tunnel was started but a later step (config sync / mcpx
      // restart) failed, kill the newly-started tunnel via its PID file to
      // restore pre-operation state — otherwise an orphaned cloudflared keeps
      // holding port 9090 while config.yaml still has the old URL.
      if (newUrl) {
        try {
          const pidFile = process.env.MCPX_TUNNEL_PID_FILE ?? join(homedir(), ".mcpx", "cloudflared.pid");
          const raw = readFileSync(pidFile, "utf8").trim();
          const pid = Number(raw);
          if (Number.isInteger(pid) && pid > 0) {
            if (process.platform === "win32") {
              spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
            } else {
              process.kill(pid, "SIGTERM");
            }
            rmSync(pidFile, { force: true });
          }
        } catch { /* best-effort cleanup */ }
      }
      this.status = `隧道刷新失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.refreshGeneration++;
    const generation = this.refreshGeneration;
    // PERF-RV-004: clear the executable path cache so a manual refresh re-probes,
    // but repeated renders within this refresh reuse cached results.
    executablePathCache.clear();
    this.snapshot = { ...this.snapshot, refreshing: true, error: undefined };
    this.safeRequestRender();
    try {
      const cwd = this.params.cwd;
      const now = Date.now();
      const binary = locateMcpx();
      let version: string | undefined;
      if (binary) {
        const result = spawnSync(binary, ["-version"], { encoding: "utf8", timeout: 10_000, shell: process.platform === "win32" });
        version = result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
      }
      const configPath = join(homedir(), ".mcpx", "config.yaml");
      const workspaces = collectWorkspaces(configPath);
      // Local endpoint probe gates the online/offline badge; the public tunnel
      // health probe is decoupled so a slow/unreachable tunnel never blocks the
      // board or the e/x actions. Seed the tunnel field synchronously (PID + URL
      // from config, health=unknown) and backfill health async.
      const tunnel = readTunnelState();
      const { endpoint, reachable, endpointVersion } = await probeEndpoint(configPath);
      const online = reachable;
      const fork = detectMcpxForPmf();
      // PERF-RV-006: read the ops password ONCE during refresh instead of on
      // every renderList render.
      const opsPassword = readOpsPassword();
      // COR-RV-005: only apply this snapshot if no newer refresh has started.
      // A newer refresh (incremented refreshGeneration) means this result is
      // stale and must be discarded to avoid overwriting fresh data with old.
      if (generation === this.refreshGeneration && !this.closed) {
      this.snapshot = {
        refreshing: false,
        binary: binary ?? undefined,
        version,
        endpoint: online ? "online" : "offline",
        endpointVersion,
        configPath: existsSync(configPath) ? configPath : undefined,
        workspaces,
        ...this.cwdRegistrationState(workspaces, cwd),
        windows: collectWindows(cwd, now),
        thread: collectThread(cwd),
        mcpServers: collectMcpServers(cwd),
        connections: online ? await collectConnections(endpoint) : undefined,
        tunnel,
        tasks: readDelegatedTasks(),
        forkInstalled: fork.installed,
        forkVersion: fork.version,
        opsPassword,
      };
      }
      // Backfill tunnel health without blocking the board: a public probe can
      // take up to the fetch timeout when the tunnel is down. Fire-and-forget;
      // only apply if this refresh is still the latest (no newer refresh raced).
      // Probe whenever there is a URL — the tunnel may be provided by another
      // host/process than the wizard's cloudflared, so a dead PID does not by
      // itself prove the tunnel is down.
      if (tunnel.url) {
        void probeTunnelHealth(tunnel.url).then((health) => {
          if (generation === this.refreshGeneration && this.snapshot.tunnel === tunnel && !this.closed) {
            this.snapshot.tunnel = { ...tunnel, health };
            this.safeRequestRender();
          }
        }).catch(() => { /* probeTunnelHealth never rejects; defensive */ });
      } else if (!tunnel.alive) {
        // No URL and no live process: nothing to probe, mark dead immediately
        // so the board never shows a contradictory "进程已退出" + "探测中" pair.
        tunnel.health = "dead";
      }
    } catch (error) {
      this.snapshot = { ...this.snapshot, refreshing: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.safeRequestRender();
  }

  /** Mark the overlay closed so async refresh/render callbacks skip work. */
  markClosed(): void {
    this.closed = true;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    if (this.mode === "detail") return this.renderDetail(safeWidth);
    if (this.mode === "workspace") return this.renderWorkspace(safeWidth);
    return this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "detail" || this.mode === "workspace") {
        this.mode = "list";
      } else {
        this.params.close();
      }
      this.params.requestRender();
      return;
    }
    if (this.mode === "detail") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.selected = Math.max(0, this.selected - 1);
        this.params.requestRender();
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.selected = Math.min(this.snapshot.thread.length - 1, this.selected + 1);
        this.params.requestRender();
      }
      return;
    }
    if (this.mode === "workspace") {
      const ws = this.snapshot.workspaces;
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.wsSelected = Math.max(0, this.wsSelected - 1);
        this.params.requestRender();
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.wsSelected = Math.min(Math.max(0, ws.length - 1), this.wsSelected + 1);
        this.params.requestRender();
      } else if (data === "d" || data === "D") {
        void this.removeSelectedWorkspace();
      }
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selected = Math.min(this.snapshot.thread.length - 1, this.selected + 1);
      this.params.requestRender();
      return;
    }
    if (isEnter(data) && this.snapshot.thread.length > 0) {
      this.mode = "detail";
      this.params.requestRender();
      return;
    }
    if (data === "p" || data === "P") {
      this.revealOpsPassword = !this.revealOpsPassword;
      this.params.requestRender();
      return;
    }
    if (data === "r") {
      void this.refresh();
      return;
    }
    if (data === "e" || data === "E") {
      void this.toggleWorkspaceRegistration();
      return;
    }
    if (data === "c" || data === "C") {
      if (this.params.onOpenWizard) this.params.onOpenWizard();
      return;
    }
    if (data === "s" || data === "S") {
      void this.startMcpx();
      return;
    }
    if (data === "x" || data === "X") {
      void this.stopMcpx();
      return;
    }
    if (data === "R") {
      void this.restartMcpx();
      return;
    }
    if (data === "t" || data === "T") {
      void this.refreshTunnelAndMcpx();
      return;
    }
    if (data === "w" || data === "W") {
      this.wsSelected = 0;
      this.mode = "workspace";
      this.params.requestRender();
      return;
    }
  }

  /** e toggles registration of the current window: expose it to MCPX, or close it again. */
  private async toggleWorkspaceRegistration(): Promise<void> {
    if (this.snapshot.refreshing) return;
    const registered = this.snapshot.cwdRegistered;
    this.status = registered ? "unregistering…" : "registering…";
    this.params.requestRender();
    const binary = locateMcpx();
    if (!binary) {
      this.status = "mcpx binary not found — set MCPX_BIN or add mcpx to PATH";
      return;
    }
    try {
      if (registered && this.params.onUnregisterWorkspace) {
        const message = await this.params.onUnregisterWorkspace(this.params.cwd);
        this.status = message;
      } else if (!registered && this.params.onRegisterWorkspace) {
        // Lease-based registration (TTL + heartbeat) — never fall back to a
        // static `workspace register` while the extension provides a lease.
        const message = await this.params.onRegisterWorkspace(this.params.cwd);
        this.status = message;
      } else {
        const command = registered ? "remove" : "register";
        const result = spawnSync(binary, ["workspace", command, this.params.cwd], {
          encoding: "utf8", timeout: 15_000, shell: process.platform === "win32",
        });
        this.status = result.status === 0
          ? (registered ? `unregistered: ${this.params.cwd}` : `registered: ${this.params.cwd}`)
          : `${registered ? "remove" : "register"} failed (${result.status ?? "spawn error"}): ${String(result.stderr || result.stdout || "").trim()}`;
      }
    } catch (error) {
      this.status = `${registered ? "remove" : "register"} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.refresh();
  }

  private renderCompact(width: number): string {
    const endpoint = this.snapshot.endpoint === "online" ? "mcpx online" : this.snapshot.endpoint === "offline" ? "mcpx offline" : "mcpx …";
    const content = `${endpoint} · ${this.snapshot.windows.length} windows · Esc close`;
    return truncateToWidth(content, width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine("MCPX 连接监控 · mcpx for pmf", inner), rule(inner)];
    rows.push(...this.renderForkRows(inner));
    rows.push(this.renderConnectionRow(inner));
    rows.push(rule(inner));
    rows.push(fitLine(`MCP 服务器（${this.snapshot.mcpServers.length}）`, inner));
    if (this.snapshot.mcpServers.length === 0) {
      rows.push(fitLine("  ○ 未配置上游 MCP 服务器（.mcp.json）", inner));
    } else {
      for (const server of this.snapshot.mcpServers.slice(0, 4)) {
        const mark = server.executable ? fg("32", "✓") : fg("31", "✗");
        const extra = this.snapshot.mcpServers.length > 4 ? "…" : "";
        rows.push(fitLine(`  ${mark} ${server.name} · ${server.type} · ${server.command}${server.description ? ` · ${server.description}` : ""}${extra}`, inner));
      }
    }
    rows.push(rule(inner));
    rows.push(fitLine(`客户端连接（${this.snapshot.connections?.length ?? "—"}）`, inner));
    if (this.snapshot.endpoint === "offline" || this.snapshot.endpoint === "unknown") {
      rows.push(fitLine("  ○ mcpx 未运行 — 按 s 启动，启动后显示 Remote Session 连接", inner));
    } else if (!this.snapshot.connections || this.snapshot.connections.length === 0) {
      rows.push(fitLine("  ○ 无活跃 Remote Session 连接（按 x 停止 mcpx）", inner));
    } else {
      for (const connection of this.snapshot.connections.slice(0, 3)) {
        rows.push(fitLine(`  ${connection.workspace || "?"} · ${connection.status}${connection.label ? ` · ${connection.label}` : ""} · ${connection.sessionId.slice(0, 8)}`, inner));
      }
    }
    rows.push(rule(inner));
    rows.push(...this.renderTunnelRows(inner));
    rows.push(...this.renderOpsPasswordRows(inner));
    rows.push(...this.renderDelegatedTaskRows(inner));
    rows.push(rule(inner));
    rows.push(fitLine(`Pi 窗口（${this.snapshot.windows.length} fresh）`, inner));
    if (this.snapshot.windows.length === 0) {
      rows.push(fitLine("  ○ 无活跃窗口 — 在对应工作区启动 pi 后可见（e 键注册当前窗口）", inner));
    } else {
      for (const window of this.snapshot.windows.slice(0, 6)) {
        const pressure = window.contextPressure === undefined ? "" : ` ctx:${window.contextPressure}%`;
        rows.push(fitLine(`  ${window.displayName} · ${window.ownerId.slice(0, 8)} · pid ${window.pid} · agents ${window.agentCount}${pressure}`, inner));
      }
    }
    rows.push(rule(inner));
    rows.push(fitLine(`消息历史（${this.snapshot.thread.length}）`, inner));
    if (this.snapshot.thread.length === 0) {
      rows.push(fitLine("  ○ 暂无跨窗口消息", inner));
    } else {
      const start = Math.max(0, Math.min(this.selected - 3, this.snapshot.thread.length - 7));
      for (let index = start; index < Math.min(this.snapshot.thread.length, start + 7); index++) {
        rows.push(this.renderThreadRow(this.snapshot.thread[index], index === this.selected, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    if (this.snapshot.error) rows.push(fitLine(fg("31", `! ${this.snapshot.error}`), inner));
    rows.push(...fitSegments(inner, ["Enter detail", "r refresh", this.snapshot.endpoint === "online" ? "x stop" : "s start", "R restart", "T tunnel", "W workspaces", "e register cwd", "c wizard", "P password", "Esc close"]));
    return frame(rows, width);
  }

  /** Classify the cwd's registration: present in config.yaml, and if so whether
   *  its lease is still live or already expired (waiting for mcpx's sweep). */
  private cwdRegistrationState(workspaces: McpxWorkspaceInfo[], cwd: string): { cwdRegistered: boolean; cwdLeaseStale?: boolean } {
    const normalized = cwd.replace(/\\/g, "/").toLowerCase();
    const match = workspaces.find((workspace) => workspace.path.replace(/\\/g, "/").toLowerCase() === normalized);
    if (!match) return { cwdRegistered: false };
    // A permanent entry (no expires_at) is always live; a TTL entry whose
    // expires_at has passed is stale until mcpx's lease sweeper reclaims it.
    const stale = match.expiresAt !== undefined && match.expiresAt <= Date.now();
    return { cwdRegistered: true, cwdLeaseStale: stale };
  }

  /** mcpx-for-pmf fork 安装提醒 — 标题行下方。fork 未以 npm 全局包安装时提示
   *  用户安装(若 mcpx 二进制也缺失,提示是上游/未装)。 */
  private renderForkRows(width: number): string[] {
    if (this.snapshot.forkInstalled) {
      return [fitLine(fg("32", `mcpx-for-pmf 已安装${this.snapshot.forkVersion ? ` · v${this.snapshot.forkVersion}` : ""}`), width)];
    }
    if (!this.snapshot.binary) {
      // mcpx 二进制本身都没找到 — 看板的 s/R/T 都会报错;这里给出安装指引。
      return [fitLine(fg("31", "未安装 mcpx — 运行 `npm i -g mcpx-for-pmf` 后按 s 启动"), width)];
    }
    // 二进制在(可能从源码编译或上游 mcpx),但 mcpx-for-pmf npm 包未装。
    return [fitLine(fg("33", "未检测到 mcpx-for-pmf 包 — 建议运行 `npm i -g mcpx-for-pmf` 获取 pmf 专属工具（pi_window 等）"), width)];
  }

  private renderConnectionRow(width: number): string {
    const binary = this.snapshot.binary ?? "未找到 mcpx";
    const version = this.snapshot.version ? ` · ${this.snapshot.version}` : "";
    const endpoint = this.snapshot.endpoint === "online"
      ? fg("32", `● ${this.snapshot.endpointVersion ?? "online"}`)
      : this.snapshot.endpoint === "offline"
        ? fg("31", "● offline")
        : fg("33", "● …");
    // "已注册" is green only when the lease is live; a stale-but-unswept entry
    // is yellow so the user knows mcpx will reclaim it (config.yaml still lists
    // it until the next ~5min sweep).
    const registered = this.snapshot.cwdRegistered
      ? (this.snapshot.cwdLeaseStale ? fg("33", "租约过期·待清理") : fg("32", "已注册"))
      : fg("33", "未注册");
    // mcpx's registry is rebuilt only at startup and every ~5min (lease sweep);
    // a freshly-registered window is recognized by the runtime after that delay.
    const sweepHint = this.snapshot.cwdRegistered && !this.snapshot.cwdLeaseStale ? " · mcpx ≤5min 内加载" : "";
    return fitLine(`binary: ${binary}${version} · endpoint: ${endpoint} · 工作区 ${this.snapshot.workspaces.length} · 当前目录 ${registered}${sweepHint}`, width);
  }

  private renderTunnelRows(width: number): string[] {
    const tunnel = this.snapshot.tunnel;
    const header = "公网隧道（Cloudflare）";
    if (!tunnel || (!tunnel.pid && !tunnel.url)) {
      return [fitLine(`${header}：未配置 — 在向导（c）启动快速隧道获取公网 URL`, width)];
    }
    const healthLabel: Record<TunnelState["health"], string> = {
      ok: fg("33", "健康·无鉴权"),
      auth: fg("32", "健康·鉴权正常"),
      dead: fg("31", "异常"),
      unknown: fg("33", "探测中"),
    };
    const proc = tunnel.alive ? fg("32", `进程存活·pid ${tunnel.pid}`) : fg("31", "进程已退出");
    const rows = [fitLine(`${header} · ${proc} · ${healthLabel[tunnel.health]}`, width)];
    if (tunnel.url) rows.push(fitLine(`  URL: ${tunnel.url}/mcp  ${fg("2", "← MCP 客户端填这个")}`, width));
    if (tunnel.health === "ok") {
      rows.push(fitLine(fg("33", "  ! 200 无鉴权 — 仅限本机 open 模式；公网暴露请用向导升级为 oauth"), width));
    } else if (tunnel.health === "auth") {
      // auth (401 + WWW-Authenticate) proves the tunnel and OAuth discovery are
      // reachable, but a probe carries no credentials so it cannot reach the
      // go-sdk Host guard that sits *after* auth. If mcpx was not restarted to
      // load disable_localhost_protection, a real client gets 403 *after* auth.
      rows.push(fitLine(fg("2", "  i 若客户端鉴权后仍 403：检查 server.disable_localhost_protection 并重启 mcpx"), width));
    } else if (tunnel.health === "dead") {
      // quick-tunnel URL is ephemeral: a dead tunnel usually means the edge
      // connection dropped and the URL can no longer be reached at all. T
      // restarts the tunnel, writes the new URL into config, and restarts mcpx.
      const hint = this.snapshot.endpoint === "online"
        ? "按 R 重启 mcpx 加载新配置，或按 T 重启隧道并自动同步新 URL"
        : "按 s 启动 mcpx，或按 T 重启隧道并自动同步新 URL";
      rows.push(fitLine(fg("31", `  ! 隧道异常：mcpx 可能未重启加载新配置（403 Host/404 OAuth 路由）或隧道已断 — ${hint}`), width));
    }
    return rows;
  }

  /** 运维口令 (OAuth authorize 页面所需) — 展示在隧道区块下方。 */
  private renderOpsPasswordRows(width: number): string[] {
    // PERF-RV-006: read from the snapshot (populated once during refresh)
    // instead of calling readOpsPassword() on every render.
    // SEC-RV-001: mask the password by default (last 4 chars only); the full
    // value is revealed only when the user presses P (revealOpsPassword).
    // Full reveal is also available directly from ~/.mcpx/config.yaml.
    const pw = this.snapshot.opsPassword;
    if (!pw) {
      // config.yaml 未设 password — mcpx 启动时会在内存生成一个并打印到启动日志。
      return [fitLine(fg("33", "运维口令：未在 config 持久化（mcpx 启动时自动生成，见启动日志 oauth_password）"), width)];
    }
    const shown = this.revealOpsPassword
      ? pw
      : pw.length > 4
        ? `●●●●${pw.slice(-4)}`
        : "●●●●";
    return [
      fitLine(`运维口令（OAuth 授权页填写）: ${fg("36", shown)}`, width),
      fitLine(fg("2", `  按 P 显明/隐藏口令（完整值见 ~/.mcpx/config.yaml）`), width),
    ];
  }

  /** 委派任务区块 — 显示 mcpx 任务注册表里的委派任务及状态/结果。 */
  private renderDelegatedTaskRows(width: number): string[] {
    const tasks = this.snapshot.tasks;
    if (!tasks || tasks.length === 0) return [];
    const rows = [fitLine(`委派任务（${tasks.length}）`, width)];
    const statusColor: Record<string, string> = {
      pending: "33",
      delivered: "36",
      executing: "34",
      completed: "32",
      failed: "31",
    };
    for (const task of tasks.slice(0, 6)) {
      const color = statusColor[task.status] ?? "33";
      const action = task.action === "spawn" ? "spawn" : "delegate";
      const tid = task.task_id.slice(0, 8);
      const purpose = (task.purpose || task.message || "").replace(/\s+/g, " ").slice(0, 32);
      rows.push(fitLine(`  ${fg(color, task.status)} · ${tid} · ${action} · ${task.workspace || "?"} · ${purpose}`, width));
      if (task.status === "completed" && task.result_summary?.length) {
        rows.push(fitLine(fg("2", `      结果: ${task.result_summary.slice(0, 2).join(" · ").slice(0, 60)}`), width));
      } else if (task.status === "failed" && task.error) {
        rows.push(fitLine(fg("31", `      错误: ${task.error.slice(0, 60)}`), width));
      }
    }
    return rows;
  }

  private renderThreadRow(entry: McpxThreadEntry, selected: boolean, width: number): string {
    const marker = selected ? "›" : " ";
    const time = new Date(entry.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
    if (entry.kind === "command") {
      const from = entry.fromOwnerId.slice(0, 8);
      const to = entry.toOwnerId.slice(0, 8);
      const body = entry.message ? entry.message.replace(/\s+/g, " ").slice(0, 40) : "";
      return fitLine(`${marker} ${time} cmd ${entry.action ?? "?"} ${from}→${to} · ${body}`, width);
    }
    const from = entry.fromOwnerId.slice(0, 8);
    const to = entry.toOwnerId.slice(0, 8);
    return fitLine(`${marker} ${time} rsp ${entry.status ?? "?"} ${from}→${to} · ${entry.commandId.slice(0, 8)}`, width);
  }

  private renderDetail(width: number): string[] {
    const inner = width - 2;
    const entry = this.snapshot.thread[this.selected];
    const rows = [fitLine("消息详情 · ↑↓ 切换 · Esc 返回", inner), rule(inner)];
    if (!entry) {
      rows.push(fitLine("○ 无消息", inner));
    } else {
      rows.push(fitLine(`command_id: ${entry.commandId}`, inner));
      rows.push(fitLine(`kind: ${entry.kind} · from: ${entry.fromOwnerId} → to: ${entry.toOwnerId}`, inner));
      rows.push(fitLine(`time: ${new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}`, inner));
      if (entry.action) rows.push(fitLine(`action: ${entry.action}`, inner));
      if (entry.status) rows.push(fitLine(`status: ${entry.status}`, inner));
      if (entry.message) {
        rows.push(rule(inner));
        for (const line of entry.message.split(/\r?\n/).slice(0, 12)) {
          rows.push(fitLine(line || " ", inner));
        }
      }
    }
    rows.push(...fitSegments(inner, ["Esc back"]));
    return frame(rows, width);
  }

  /** W 子模式：列出所有已注册 workspace，↑↓ 选中，d 删除选中。删除调
   *  `mcpx workspace remove`（只写 config，运行时 ≤5min lease sweep 后清理）。 */
  private renderWorkspace(width: number): string[] {
    const inner = width - 2;
    const ws = this.snapshot.workspaces;
    const rows = [fitLine("Workspace 管理 · ↑↓ 选中 · d 删除 · Esc 返回", inner), rule(inner)];
    if (ws.length === 0) {
      rows.push(fitLine("○ 无已注册 workspace（按 e 注册当前目录）", inner));
    } else {
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        const marker = i === this.wsSelected ? fg("36", "▶") : " ";
        const lease = w.expiresAt ? fg("33", "租约·待清理") : fg("32", "永久");
        rows.push(fitLine(`${marker} ${w.name} · ${w.path} · ${lease}`, inner));
      }
      rows.push(rule(inner));
      rows.push(fitLine(fg("31", "  d 删除选中 workspace（mcpx ≤5min 内从运行时清理）"), inner));
    }
    rows.push(...fitSegments(inner, ["d delete", "Esc back"]));
    return frame(rows, width);
  }

  private async removeSelectedWorkspace(): Promise<void> {
    const ws = this.snapshot.workspaces[this.wsSelected];
    if (!ws) return;
    const { ok, message } = removeWorkspaceByPath(ws.path);
    this.status = ok ? `已移除 ${ws.name} — ${message}` : `移除失败: ${message}`;
    this.safeRequestRender();
    await this.refresh();
  }
}

// --- private TUI helpers (same pattern as sibling overlays) ---

function fitLine(value: string, width: number): string {
  // pad=true pads by *visible* width (CJK chars count 2), keeping the right
  // border aligned — padEnd() padded by code units and jagged CJK rows.
  return truncateToWidth(value, width, "…", true);
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number): string[] {
  // width is the OUTER width; content rows are │+inner+│, so the horizontal
  // rules must span inner = width-2 to keep all rows the same width.
  const inner = Math.max(0, width - 2);
  return [`┌${"─".repeat(inner)}┐`, ...rows.map((row) => `│${row}│`), `└${"─".repeat(inner)}┘`];
}

function fitSegments(width: number, segments: readonly string[]): string[] {
  // Greedy-wrap the hint segments so no shortcut is hidden by truncation on
  // narrow terminals.
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current ? `${current} · ${segment}` : segment;
    if (current && visibleWidth(candidate) > width) {
      lines.push(fitLine(current, width));
      current = segment;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(fitLine(current, width));
  return lines;
}

function fg(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

export const _mcpxTuiInternals = {
  normalizeWorkspacePath,
  workspaceIdForCwd,
  collectWorkspaces,
  collectWindows,
  collectThread,
  displayNameOf,
};
