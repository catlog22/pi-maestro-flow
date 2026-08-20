/**
 * McpxOverlay — configure and monitor the mcpx (mcpx for pmf) connection:
 * binary/endpoint status, registered workspaces, discoverable Pi windows and
 * cross-window message history (workspace-peer file protocol).
 *
 * Keys: ↑↓/jk select history · Enter details · r refresh · R restart · e register/unregister cwd · s start · x stop · t tunnel refresh · w workspaces · c wizard · p password · Esc close
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { locateMcpx, isProcessOwnedBy, readMcpxBearerToken, readTunnelState, probeTunnelHealth, restartQuickTunnel, stopQuickTunnel, updateConfigServerURL, restoreMcpxConfig, stopMcpx, readOpsPassword, detectMcpxForPmf, removeWorkspaceByPath, readDelegatedTasks, type TunnelState, type DelegatedTask } from "../mcpx-bridge.ts";
import {
  McpxClientError,
  McpxStreamableHttpClient,
  type McpxRemoteSession,
  type McpxRuntimeWindow,
  type McpxWindowEvent,
  type McpxWindowObservation,
} from "./mcpx-client.ts";

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

export interface McpxConnectionInfo extends McpxRemoteSession {}

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
  /** Unified pi_window entries. Undefined means the Runtime is unavailable, auth-blocked, or too old. */
  runtimeWindows?: McpxRuntimeWindow[];
  runtimeWindowFallback?: "auth" | "unsupported" | "unavailable";
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

export interface McpxWindowComposeResult {
  purpose: string;
  message: string;
  name?: string;
  model?: string;
  mode?: "steer" | "follow_up";
}

export interface McpxOverlayParams {
  cwd: string;
  requestRender: () => void;
  close: () => void;
  onRegisterWorkspace?: (path: string) => Promise<string>;
  onUnregisterWorkspace?: (path: string) => Promise<string>;
  onOpenWizard?: () => void;
  /** Host-native text prompts used by m/n window actions. */
  onComposeWindowMessage?: (
    target: McpxRuntimeWindow | undefined,
    session: McpxConnectionInfo,
    targetMode: "existing" | "new",
  ) => Promise<McpxWindowComposeResult | undefined>;
  /** Test hook and transport injection point. */
  createClient?: (endpoint: string) => McpxStreamableHttpClient;
  /** Skip constructor refresh in deterministic overlay tests. */
  initialRefresh?: boolean;
  /** Runtime height for bounded window/event views. */
  getTerminalRows?: () => number;
  /** Endpoint readiness wait for startMcpx (ms); tests shorten this. */
  endpointWaitMs?: number;
}

type OverlayMode = "list" | "detail" | "workspace" | "window-list" | "window-detail";

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
    const nameMatch = line.match(/^\s{2,}-\s+name:\s*(.+)$/);
    if (nameMatch) {
      current = { name: nameMatch[1].trim(), path: "" };
      workspaces.push(current);
      continue;
    }
    const pathMatch = line.match(/^\s{4,}path:\s*(.+)$/);
    if (pathMatch && current) {
      current.path = pathMatch[1].trim().replace(/^"|"$/g, "");
      continue;
    }
    const expMatch = line.match(/^\s{4,}expires_at:\s*(.+)$/);
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
    const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
      encoding: "utf8",
      timeout: 5_000,
      shell: false,
    });
    result = probe.status === 0;
  }
  executablePathCache.set(command, result);
  return result;
}

// collectConnections uses a fully initialized Streamable-HTTP session. It stays
// exported for focused transport tests and callers that only need Remote Sessions.
export async function collectConnections(
  endpoint: string,
  client = new McpxStreamableHttpClient(endpoint, 3_000),
): Promise<McpxConnectionInfo[] | undefined> {
  try {
    return await client.listRemoteSessions();
  } catch {
    return undefined;
  }
}

async function probeEndpoint(configPath: string): Promise<{ endpoint: string; reachable: boolean; endpointVersion?: string }> {
  let endpoint = MCPX_DEFAULT_ENDPOINT;
  try {
    const raw = readFileSync(configPath, "utf8");
    const portMatch = raw.match(/^\s{2,}port:\s*(\d+)/m);
    const port = portMatch ? Number(portMatch[1]) : 0;
    if (port >= 1 && port <= 65_535) endpoint = `http://127.0.0.1:${port}/mcp`;
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
  private workspaceToggleBusy = false;
  private workspaceToggleQueued = false;
  private starting = false; // guards startMcpx against re-entry (orphan spawns)
  private refreshGeneration = 0;
  private closed = false; // set on close() so async refresh/render skip work after close
  private windowSelected = 0;
  private windowSessionSelected = 0;
  private windowObservation?: McpxWindowObservation;
  private observeTimer?: ReturnType<typeof setInterval>;
  private observeGeneration = 0;
  private observing = false;
  private windowActionBusy = false;
  private client?: McpxStreamableHttpClient;
  private clientEndpoint?: string;
  private clientBearerToken?: string;

  private clientForEndpoint(endpoint: string): McpxStreamableHttpClient {
    const bearerToken = readMcpxBearerToken();
    if (!this.client || this.clientEndpoint !== endpoint || this.clientBearerToken !== bearerToken) {
      this.client = this.params.createClient?.(endpoint) ?? new McpxStreamableHttpClient(endpoint, 4_000, fetch, bearerToken);
      this.clientEndpoint = endpoint;
      this.clientBearerToken = bearerToken;
    }
    return this.client;
  }

  private safeRequestRender(): void {
    if (this.closed) return;
    this.params.requestRender();
  }

  constructor(private readonly params: McpxOverlayParams) {
    if (params.initialRefresh !== false) void this.refresh();
  }

  invalidate(): void {}
  dispose(): void {
    this.closed = true;
    this.stopWindowObserve();
  }

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

  private killPid(pid: number): boolean {
    if (!isProcessOwnedBy(pid, "mcpx")) return false;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
      return true;
    } catch {
      return false;
    }
  }

  private configPath(): string {
    return join(homedir(), ".mcpx", "config.yaml");
  }

  private listenPort(): number {
    try {
      const raw = readFileSync(this.configPath(), "utf8");
      const match = raw.match(/^\s{2,}port:\s*(\d+)/m);
      const port = Number(match?.[1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) return port;
    } catch {
      // default listener
    }
    return 9090;
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
      const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: useShell });
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
    if (this.starting) {
      this.status = "已有 mcpx 操作进行中，请等待完成";
      this.safeRequestRender();
      return;
    }
    const pid = this.readPidFile();
    this.status = "正在停止 mcpx…";
    this.params.requestRender();
    try {
      if (pid && this.killPid(pid)) {
        // /F kill skips the Go server's graceful PID-file cleanup — remove it.
        try {
          rmSync(this.pidPath(), { force: true });
        } catch {
          // best-effort
        }
      } else {
        // PID file missing, stale, or owned by another process — only terminate
        // a listener after killMcpxByPort verifies its command identity.
        this.killMcpxByPort();
        try { rmSync(this.pidPath(), { force: true }); } catch { /* best-effort */ }
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
    if (pid && !this.killPid(pid)) {
      this.killMcpxByPort();
    } else if (!pid) {
      this.killMcpxByPort();
    }
    // Give the port a moment to release after kill.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Start fresh — bypass the online guard (we just stopped it on purpose).
    try {
      const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: useShell });
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

  /** Kill the process listening on the configured MCPX port (fallback when the PID file
   *  is stale — e.g. mcpx was started by a prior board session or externally). */
  private killMcpxByPort(port = this.listenPort()): void {
    try {
      if (process.platform === "win32") {
        const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
          encoding: "utf8", timeout: 5_000, shell: false,
        });
        // Strict port match: only LISTENING rows whose local-address column
        // ends in the configured port followed by whitespace. Avoids matching
        // a port with the same digits as a suffix on a different listener.
        const PORT = port;
        const portRe = new RegExp("\\s\\d+\\.\\d+\\.\\d+\\.\\d+:" + PORT + "\\s|\\[::\\]?:" + PORT + "\\s");
        for (const line of String(result.stdout || "").split(/\r?\n/)) {
          if (line.includes("LISTENING") && portRe.test(line)) {
            const m = line.match(/\s(\d+)\s*$/);
            if (m && isProcessOwnedBy(Number(m[1]), "mcpx")) {
              spawnSync("taskkill", ["/pid", m[1], "/T", "/F"], { stdio: "ignore" });
            }
          }
        }
      } else {
        // POSIX: lsof preferred, ss fallback; output is one pid per line.
        const result = spawnSync("sh", ["-c", `lsof -ti tcp:${port} 2>/dev/null || ss -ltnp 'sport = :${port}' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2`], {
          encoding: "utf8", timeout: 5_000,
        });
        for (const line of String(result.stdout || "").split(/\r?\n/)) {
          const n = Number(line.trim());
          if (Number.isInteger(n) && n > 0 && isProcessOwnedBy(n, "mcpx")) {
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
    let configUpdated = false;
    let previousConfig: string | undefined;
    try {
      // Snapshot the complete config before replacing server_url. If the local
      // restart fails, restoring the snapshot avoids leaving an old process
      // paired with the new issuer.
      previousConfig = readFileSync(this.configPath(), "utf8");
      // 1. Restart the quick tunnel — stops the old one, parses the new URL.
      newUrl = await restartQuickTunnel(this.listenPort());
      // 2. Write the new URL into config.yaml so mcpx's OAuth issuer matches.
      updateConfigServerURL(newUrl);
      configUpdated = true;
      // 3. Restart mcpx to load the new server_url. Kill by PID file first, then
      //    by port as a fallback (the PID file may point at a stale/external pid).
      stopMcpx();
      this.killMcpxByPort();
      await new Promise((resolve) => setTimeout(resolve, 800)); // port release
      const stopDeadline = Date.now() + 2_000;
      let oldProcessStillOnline = false;
      while (Date.now() < stopDeadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (!reachable) {
          oldProcessStillOnline = false;
          break;
        }
        oldProcessStillOnline = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (oldProcessStillOnline) throw new Error("旧 mcpx 进程未停止，已取消配置切换");
      const binary = locateMcpx();
      if (!binary) throw new Error("未找到 mcpx 二进制");
      const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: useShell });
      child.unref();
      // 4. Wait for the endpoint to come back (new issuer).
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (reachable) { online = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!online) throw new Error("mcpx 端点未就绪（检查启动日志）");
      const publicHealth = await probeTunnelHealth(newUrl);
      const publicReady = publicHealth === "ok" || publicHealth === "auth";
      this.status = publicReady
        ? `隧道已更新: ${newUrl}/mcp · mcpx 已重启 · 公网端点已就绪`
        : `隧道已更新: ${newUrl}/mcp · mcpx 已重启，但公网端点仍未就绪（按 r 重试或 T 重启隧道）`;
    } catch (error) {
      let rolledBack = false;
      if (configUpdated) {
        // Stop both sides before restoring the old snapshot. The old tunnel URL
        // cannot be resumed after a Quick Tunnel rotation, so the consistent
        // fallback is the old local config with no tunnel process.
        try { stopMcpx(); } catch { /* best-effort */ }
        try { this.killMcpxByPort(); } catch { /* best-effort */ }
      }
      if (newUrl) {
        try { stopQuickTunnel(); } catch { /* best-effort */ }
      }
      if (configUpdated && previousConfig) {
        try {
          restoreMcpxConfig(previousConfig);
          rolledBack = true;
        } catch {
          // Keep the failure visible; do not claim a rollback that did not land.
        }
      }
      this.status = rolledBack
        ? `隧道刷新失败，已回滚到旧配置: ${error instanceof Error ? error.message : String(error)}`
        : `隧道刷新失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.refreshGeneration++;
    const generation = this.refreshGeneration;
    executablePathCache.clear();
    this.snapshot = { ...this.snapshot, refreshing: true, error: undefined };
    this.safeRequestRender();
    try {
      const cwd = this.params.cwd;
      const now = Date.now();
      const binary = locateMcpx();
      let version: string | undefined;
      if (binary) {
        const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
        const result = spawnSync(binary, ["-version"], { encoding: "utf8", timeout: 10_000, shell: useShell });
        version = result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
      }
      const configPath = join(homedir(), ".mcpx", "config.yaml");
      const workspaces = collectWorkspaces(configPath);
      const tunnel = readTunnelState();
      const { endpoint, reachable, endpointVersion } = await probeEndpoint(configPath);
      const online = reachable;
      const fork = detectMcpxForPmf();
      const opsPassword = readOpsPassword();

      let connections: McpxConnectionInfo[] | undefined;
      let runtimeWindows: McpxRuntimeWindow[] | undefined;
      let runtimeWindowFallback: McpxSnapshot["runtimeWindowFallback"];
      if (online) {
        const client = this.clientForEndpoint(endpoint);
        try {
          connections = await client.listRemoteSessions();
          const windowGroups = await Promise.all(connections.map((session) => client.listWindows(session)));
          runtimeWindows = windowGroups.flat();
        } catch (error) {
          runtimeWindowFallback = error instanceof McpxClientError && error.kind === "auth"
            ? "auth"
            : error instanceof McpxClientError && error.kind === "unsupported"
              ? "unsupported"
              : "unavailable";
          // A manual refresh must be able to recover after auth/config/runtime changes.
          if (this.client === client) {
            this.client = undefined;
            this.clientEndpoint = undefined;
            this.clientBearerToken = undefined;
          }
        }
      }

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
          connections,
          runtimeWindows,
          runtimeWindowFallback,
          tunnel,
          tasks: readDelegatedTasks(),
          forkInstalled: fork.installed,
          forkVersion: fork.version,
          opsPassword,
        };
        this.windowSessionSelected = Math.min(
          this.windowSessionSelected,
          Math.max(0, (connections?.length ?? 1) - 1),
        );
        this.windowSelected = Math.min(this.windowSelected, Math.max(0, this.windowEntries().length - 1));
      }
      if (tunnel.url) {
        void probeTunnelHealth(tunnel.url).then((health) => {
          if (generation === this.refreshGeneration && this.snapshot.tunnel === tunnel && !this.closed) {
            this.snapshot.tunnel = { ...tunnel, health };
            this.safeRequestRender();
          }
        }).catch(() => { /* probeTunnelHealth never rejects; defensive */ });
      } else if (!tunnel.alive) {
        tunnel.health = "dead";
      }
    } catch (error) {
      if (generation === this.refreshGeneration && !this.closed) {
        this.snapshot = { ...this.snapshot, refreshing: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (this.workspaceToggleQueued && !this.workspaceToggleBusy && generation === this.refreshGeneration && !this.closed) {
      this.workspaceToggleQueued = false;
      void this.toggleWorkspaceRegistration();
    }
    this.safeRequestRender();
  }

  private currentWindowSession(): McpxConnectionInfo | undefined {
    return this.snapshot.connections?.[this.windowSessionSelected];
  }

  private windowEntries(): McpxRuntimeWindow[] {
    const session = this.currentWindowSession();
    if (!session) return [];
    return (this.snapshot.runtimeWindows ?? []).filter((window) => window.remoteSessionId === session.sessionId);
  }

  private selectedRuntimeWindow(): McpxRuntimeWindow | undefined {
    return this.windowEntries()[this.windowSelected];
  }

  private stopWindowObserve(): void {
    this.observeGeneration++;
    if (this.observeTimer) clearInterval(this.observeTimer);
    this.observeTimer = undefined;
  }

  private startWindowObserve(): void {
    this.stopWindowObserve();
    this.windowObservation = undefined;
    const generation = this.observeGeneration;
    void this.observeSelectedWindow(generation);
    this.observeTimer = setInterval(() => void this.observeSelectedWindow(generation), 1_500);
    this.observeTimer.unref?.();
  }

  private async observeSelectedWindow(generation: number): Promise<void> {
    const window = this.selectedRuntimeWindow();
    const session = this.currentWindowSession();
    const client = this.client;
    if (!window || !session || !client || this.mode !== "window-detail" || this.observing) return;
    this.observing = true;
    const cursor = window.kind === "registered" ? 0 : (this.windowObservation?.nextCursor ?? 0);
    try {
      const next = await client.observeWindow(session, window, cursor, 20);
      if (generation !== this.observeGeneration || this.mode !== "window-detail" || this.selectedRuntimeWindow()?.id !== window.id) return;
      const merged = new Map<string, McpxWindowEvent>();
      for (const event of [...(this.windowObservation?.events ?? []), ...next.events]) {
        merged.set(windowEventKey(event), event);
      }
      this.windowObservation = { ...next, events: [...merged.values()].slice(-20) };
      this.safeRequestRender();
    } catch (error) {
      if (generation !== this.observeGeneration) return;
      this.status = `observe: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof McpxClientError && (error.kind === "auth" || error.kind === "unsupported")) {
        this.stopWindowObserve();
      }
      this.safeRequestRender();
    } finally {
      this.observing = false;
    }
  }

  private rowBudget(reserved: number, fallback: number): number {
    const terminalRows = this.params.getTerminalRows?.();
    if (!Number.isFinite(terminalRows) || !terminalRows || terminalRows <= 0) return fallback;
    return Math.max(3, Math.floor(terminalRows * 0.9) - reserved);
  }

  private async sendWindow(targetMode: "existing" | "new"): Promise<void> {
    if (this.windowActionBusy) return;
    const session = this.currentWindowSession();
    const target = targetMode === "existing" ? this.selectedRuntimeWindow() : undefined;
    const client = this.client;
    if (!session || !client || !this.params.onComposeWindowMessage || (targetMode === "existing" && !target)) {
      this.status = "Runtime window send unavailable";
      this.safeRequestRender();
      return;
    }
    this.windowActionBusy = true;
    try {
      const composed = await this.params.onComposeWindowMessage(target, session, targetMode);
      if (!composed?.message.trim()) return;
      this.status = targetMode === "new" ? "creating managed window…" : `sending to ${target!.displayName}…`;
      this.safeRequestRender();
      const result = await client.sendWindow({
        remoteSessionId: session.sessionId,
        purpose: composed.purpose.trim() || composed.message.trim(),
        message: composed.message.trim(),
        targetMode,
        window: target?.id,
        mode: composed.mode,
        name: composed.name,
        model: composed.model,
        idempotencyKey: targetMode === "new" ? randomUUID() : undefined,
        confirmed: true,
      });
      this.status = targetMode === "new"
        ? `created ${result.windowId?.slice(0, 12) ?? "managed window"}`
        : `sent · ${result.action ?? "accepted"}`;
      await this.refresh();
    } catch (error) {
      this.status = `send: ${error instanceof Error ? error.message : String(error)}`;
      this.safeRequestRender();
    } finally {
      this.windowActionBusy = false;
    }
  }

  /** Mark the overlay closed so async refresh/render callbacks skip work. */
  markClosed(): void {
    this.closed = true;
    this.stopWindowObserve();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    if (this.mode === "detail") return this.renderDetail(safeWidth);
    if (this.mode === "workspace") return this.renderWorkspace(safeWidth);
    if (this.mode === "window-list") return this.renderWindowList(safeWidth);
    if (this.mode === "window-detail") return this.renderWindowDetail(safeWidth);
    return this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "window-detail") {
        this.stopWindowObserve();
        this.mode = "window-list";
      } else if (this.mode === "detail" || this.mode === "workspace" || this.mode === "window-list") {
        this.mode = "list";
      } else {
        this.markClosed();
        this.params.close();
      }
      this.params.requestRender();
      return;
    }
    if (this.mode === "window-detail") {
      if (data === "m" || data === "M") void this.sendWindow("existing");
      else if (data === "n" || data === "N") void this.sendWindow("new");
      else if (data === "r") void this.observeSelectedWindow(this.observeGeneration);
      return;
    }
    if (this.mode === "window-list") {
      const sessions = this.snapshot.connections ?? [];
      if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
        this.windowSessionSelected = Math.max(0, this.windowSessionSelected - 1);
        this.windowSelected = 0;
      } else if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
        this.windowSessionSelected = Math.min(Math.max(0, sessions.length - 1), this.windowSessionSelected + 1);
        this.windowSelected = 0;
      } else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.windowSelected = Math.max(0, this.windowSelected - 1);
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.windowSelected = Math.min(Math.max(0, this.windowEntries().length - 1), this.windowSelected + 1);
      } else if (isEnter(data) && this.selectedRuntimeWindow()) {
        this.mode = "window-detail";
        this.startWindowObserve();
      } else if (data === "m" || data === "M") {
        void this.sendWindow("existing");
      } else if (data === "n" || data === "N") {
        void this.sendWindow("new");
      } else if (data === "r") {
        void this.refresh();
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
      } else if (data === "e" || data === "E") {
        void this.toggleWorkspaceRegistration();
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
    if (data === "v" || data === "V") {
      this.windowSessionSelected = Math.min(this.windowSessionSelected, Math.max(0, (this.snapshot.connections?.length ?? 1) - 1));
      this.windowSelected = 0;
      this.mode = "window-list";
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
    }
  }

  /** e toggles registration of the current window: expose it to MCPX, or close it again. */
  private async toggleWorkspaceRegistration(): Promise<void> {
    if (this.workspaceToggleBusy) return;
    if (this.snapshot.refreshing) {
      this.workspaceToggleQueued = true;
      this.status = "正在刷新 workspace，e 将在刷新后执行…";
      this.safeRequestRender();
      return;
    }
    this.workspaceToggleBusy = true;
    const registered = this.snapshot.cwdRegistered;
    this.status = registered ? "unregistering…" : "registering…";
    this.safeRequestRender();
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
        const binary = locateMcpx();
        if (!binary) {
          this.status = "mcpx binary not found — set MCPX_BIN or add mcpx to PATH";
          return;
        }
        const command = registered ? "remove" : "register";
        const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
        if (useShell && /[\u0000\r\n&|<>^%!()]/.test(this.params.cwd)) {
          this.status = "workspace path contains unsafe Windows shell characters";
          return;
        }
        const result = spawnSync(binary, ["workspace", command, this.params.cwd], {
          encoding: "utf8", timeout: 15_000, shell: useShell,
        });
        this.status = result.status === 0
          ? (registered ? `unregistered: ${this.params.cwd}` : `registered: ${this.params.cwd}`)
          : `${registered ? "remove" : "register"} failed (${result.status ?? "spawn error"}): ${String(result.stderr || result.stdout || "").trim()}`;
      }
    } catch (error) {
      this.status = `${registered ? "remove" : "register"} failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.workspaceToggleBusy = false;
    }
    await this.refresh();
  }

  private renderCompact(width: number): string {
    const endpoint = this.snapshot.endpoint === "online" ? "mcpx online" : this.snapshot.endpoint === "offline" ? "mcpx offline" : "mcpx …";
    const windowCount = this.snapshot.runtimeWindows?.length ?? this.snapshot.windows.length;
    const content = `${endpoint} · ${windowCount} windows · Esc close`;
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
    const runtimeWindows = this.snapshot.runtimeWindows;
    rows.push(fitLine(`Pi 窗口（${runtimeWindows?.length ?? this.snapshot.windows.length}） · V 查看`, inner));
    if (runtimeWindows !== undefined) {
      if (runtimeWindows.length === 0) {
        rows.push(fitLine("  ○ Remote Sessions 当前无 registered/managed 窗口", inner));
      } else {
        for (const window of runtimeWindows.slice(0, 6)) {
          const source = window.kind === "managed" ? "managed" : "registered";
          rows.push(fitLine(`  ${source} · ${window.displayName} · ${window.status} · ${window.workspace || window.remoteSessionId.slice(0, 8)}`, inner));
        }
      }
    } else {
      const reason = this.snapshot.runtimeWindowFallback === "auth"
        ? "Runtime 鉴权阻止 pi_window"
        : this.snapshot.runtimeWindowFallback === "unsupported"
          ? "Runtime 不支持统一 pi_window"
          : "Runtime pi_window 不可用";
      rows.push(fitLine(fg("33", `  ${reason} · local owner/task registry fallback`), inner));
      if (this.snapshot.windows.length === 0) {
        rows.push(fitLine("  ○ 无本地 fresh owner（e 注册当前窗口）", inner));
      } else {
        for (const window of this.snapshot.windows.slice(0, 6)) {
          const pressure = window.contextPressure === undefined ? "" : ` ctx:${window.contextPressure}%`;
          rows.push(fitLine(`  local · ${window.displayName} · ${window.ownerId.slice(0, 8)} · pid ${window.pid} · agents ${window.agentCount}${pressure}`, inner));
        }
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
    rows.push(...fitSegments(inner, ["Enter message detail", "V windows", "r refresh", this.snapshot.endpoint === "online" ? "x stop" : "s start", "R restart", "T tunnel", "W workspaces", "e register cwd", "c wizard", "P password", "Esc close"]));
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

  private renderWindowList(width: number): string[] {
    const inner = width - 2;
    const sessions = this.snapshot.connections ?? [];
    const session = this.currentWindowSession();
    const windows = this.windowEntries();
    const rows = [fitLine("Pi 窗口 · Remote Session ←→ · ↑↓ 选择", inner), rule(inner)];
    if (this.snapshot.runtimeWindows === undefined) {
      const reason = this.snapshot.runtimeWindowFallback === "auth" ? "鉴权阻止 Runtime 调用" : "Runtime 缺少统一 pi_window actions";
      rows.push(fitLine(fg("33", `${reason} · 使用 local registry fallback`), inner));
      const fallbackBudget = this.rowBudget(6, 10);
      const visibleFallback = this.snapshot.windows.length > fallbackBudget
        ? this.snapshot.windows.slice(0, Math.max(1, fallbackBudget - 1))
        : this.snapshot.windows;
      for (const window of visibleFallback) {
        rows.push(fitLine(`  local · ${window.displayName} · ${window.ownerId.slice(0, 8)} · pid ${window.pid}`, inner));
      }
      if (this.snapshot.windows.length > visibleFallback.length) {
        rows.push(fitLine(`  … ${this.snapshot.windows.length - visibleFallback.length} more`, inner));
      }
      if (this.snapshot.windows.length === 0) rows.push(fitLine("  ○ 无本地 fresh owner", inner));
      rows.push(...fitSegments(inner, ["r refresh", "Esc back"]));
      return frame(rows, width);
    }
    if (!session || sessions.length === 0) {
      rows.push(fitLine("○ 无可用 Remote Session", inner));
    } else {
      rows.push(fitLine(`Remote ${this.windowSessionSelected + 1}/${sessions.length} · ${session.workspace || "?"} · ${session.status} · ${session.label || session.sessionId.slice(0, 8)}`, inner));
      rows.push(rule(inner));
      if (windows.length === 0) {
        rows.push(fitLine("  ○ 此 Session 无窗口 · n 新建 managed window", inner));
      } else {
        const budget = this.rowBudget(8, 12);
        const entryBudget = windows.length > budget ? Math.max(1, budget - 1) : budget;
        const start = Math.max(0, Math.min(
          this.windowSelected - Math.floor(entryBudget / 2),
          windows.length - entryBudget,
        ));
        const end = Math.min(windows.length, start + entryBudget);
        for (let index = start; index < end; index++) {
          const window = windows[index];
          const marker = index === this.windowSelected ? fg("36", "▶") : " ";
          const cursor = window.cursor ? ` · cursor ${window.cursor}` : "";
          rows.push(fitLine(`${marker} ${window.kind} · ${window.displayName} · ${window.status}${cursor}`, inner));
        }
        if (windows.length > entryBudget) {
          rows.push(fitLine(`  … ${start} above · ${windows.length - end} below`, inner));
        }
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["Enter observe", "m send", "n new", "r refresh", "Esc back"]));
    return frame(rows, width);
  }

  private renderWindowDetail(width: number): string[] {
    const inner = width - 2;
    const target = this.selectedRuntimeWindow();
    const session = this.currentWindowSession();
    const observation = this.windowObservation;
    const rows = [fitLine("Pi 窗口详情 · incremental observe", inner), rule(inner)];
    if (!target || !session) {
      rows.push(fitLine("○ 窗口已不可用", inner));
    } else {
      const status = observation?.status ?? target.status;
      const cursor = observation?.cursor ?? target.cursor;
      rows.push(fitLine(`${target.displayName} · source ${observation?.source ?? target.kind} · status ${status} · cursor ${cursor}`, inner));
      rows.push(fitLine(`Remote ${session.workspace || "?"} · ${session.label || session.sessionId.slice(0, 8)} · pid ${target.pid || "—"}`, inner));
      rows.push(rule(inner));
      if (!observation) {
        rows.push(fitLine("  observing…", inner));
      } else if (observation.events.length === 0) {
        rows.push(fitLine("  ○ 暂无新 assistant/tool/lifecycle event", inner));
      } else {
        const eventBudget = this.rowBudget(9, 14);
        for (const event of observation.events.slice(-eventBudget)) {
          rows.push(renderWindowEvent(event, inner));
        }
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["m send", "n new", "r observe", "Esc back"]));
    return frame(rows, width);
  }

  /** W 子模式：列出所有已注册 workspace，↑↓ 选中，d 删除选中。删除调
   *  `mcpx workspace remove`（只写 config，运行时 ≤5min lease sweep 后清理）。 */
  private renderWorkspace(width: number): string[] {
    const inner = width - 2;
    const ws = this.snapshot.workspaces;
    const rows = [fitLine("Workspace 管理 · ↑↓ 选中 · d 删除 · e 注册当前目录 · Esc 返回", inner), rule(inner)];
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
    rows.push(...fitSegments(inner, ["d delete", "e register cwd", "Esc back"]));
    return frame(rows, width);
  }

  private async removeSelectedWorkspace(): Promise<void> {
    const ws = this.snapshot.workspaces[this.wsSelected];
    if (!ws) return;
    if (this.params.onUnregisterWorkspace && normalizeWorkspacePath(ws.path) === normalizeWorkspacePath(this.params.cwd)) {
      const message = await this.params.onUnregisterWorkspace(ws.path);
      this.status = message;
      this.safeRequestRender();
      await this.refresh();
      return;
    }
    const { ok, message } = removeWorkspaceByPath(ws.path);
    this.status = ok ? `已移除 ${ws.name} — ${message}` : `移除失败: ${message}`;
    this.safeRequestRender();
    await this.refresh();
  }
}

// --- private TUI helpers (same pattern as sibling overlays) ---

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function windowEventKey(event: McpxWindowEvent): string {
  if (event.kind === "assistant") return `assistant:${event.at}:${event.text}`;
  if (event.kind === "tool") return `tool:${event.at}:${event.toolCallId ?? ""}:${event.toolName}:${event.status ?? ""}`;
  if (event.kind === "lifecycle") return `lifecycle:${event.at}:${event.phase}`;
  return `rpc:${event.cursor}:${event.type}:${event.summary ?? ""}`;
}

function renderWindowEvent(event: McpxWindowEvent, width: number): string {
  const time = Number.isFinite(event.at) && event.at > 0
    ? new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })
    : "--:--:--";
  if (event.kind === "assistant") {
    return fitLine(`  ${time} assistant · ${event.text.replace(/\s+/g, " ")}`, width);
  }
  if (event.kind === "tool") {
    return fitLine(`  ${time} tool · ${event.toolName || "?"}${event.status ? ` · ${event.status}` : ""}`, width);
  }
  if (event.kind === "lifecycle") {
    return fitLine(`  ${time} lifecycle · ${event.phase}`, width);
  }
  const label = event.type.startsWith("tool_execution_")
    ? "tool"
    : event.type === "message_update"
      ? "assistant"
      : "lifecycle";
  return fitLine(`  ${time} ${label} · ${event.type}${event.summary ? ` · ${event.summary.replace(/\s+/g, " ")}` : ""}`, width);
}

function fitLine(value: string, width: number): string {
  // pad=true pads by *visible* width (CJK chars count 2), keeping the right
  // border aligned — padEnd() padded by code units and jagged CJK rows.
  return truncateToWidth(sanitizeTerminalText(value), width, "…", true);
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
