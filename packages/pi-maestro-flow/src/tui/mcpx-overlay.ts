/**
 * McpxOverlay — configure and monitor the Pi Maestro Gateway:
 * daemon/HTTP status, registered workspaces, Gateway tasks, discoverable Pi
 * windows, and cross-window message history.
 *
 * Keys: ↑↓/jk select history · Enter details · r refresh · R restart · e register/unregister cwd (lease) · E register/unregister cwd (permanent) · s start · x stop · t tunnel refresh · w workspaces · c wizard · p password · Esc close
 */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, opendirSync, readdirSync, readFileSync, existsSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { locateMcpx, readMcpxBearerToken, readTunnelState, probeTunnelHealth, restartQuickTunnel, stopQuickTunnel, updateConfigServerURL, restoreMcpxConfig, stopMcpx as stopGateway, startMcpx as startGateway, restartMcpx as restartGateway, readGatewayControlStatus, listGatewayWorkspaces, startWorkspaceLease, registerMcpxWorkspacePermanent, readOpsPassword, detectMcpxForPmf, removeGatewayWorkspaceByPath, readGatewayDelegatedTasks, readGatewayCollaborativeSessions, readMcpxConfigView, writeMcpxConfigChanges, type TunnelState, type DelegatedTask, type McpxConfigView } from "../mcpx-bridge.ts";
import type { CollaborativeSessionStateV1, GatewayTodoTaskV1 } from "../gateway/session-contracts.ts";
import type { McpxConfigChanges } from "./mcpx-wizard.ts";
import {
  McpxClientError,
  McpxStreamableHttpClient,
  type McpxGatewayMonitor,
  type McpxGatewayMonitorObservation,
  type McpxRemoteSession,
  type McpxRuntimeWindow,
  type McpxWindowEvent,
  type McpxWindowObservation,
} from "./mcpx-client.ts";

const MCPX_DEFAULT_ENDPOINT = "http://127.0.0.1:9090/mcp";
const PEER_STALE_MS = 20_000;
const MAX_PEER_RUNTIME_ROOTS = 8;
const MAX_PEER_OWNERS_PER_ROOT = 16;
const MAX_PEER_FILES_PER_OWNER = 64;
const MAX_PEER_FILE_METADATA = 128;

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
  /** normalizedCwd of the owning workspace (multi-workspace discovery). */
  workspace?: string;
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
  /** normalizedCwd of the workspace this entry belongs to. */
  workspace?: string;
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
  /** Gateway journal tasks followed by optional legacy read-only history. */
  tasks?: DelegatedTask[];
  /** Workspace-local collaboration authority. It is independent from Pi Todo. */
  collaborativeSessions?: CollaborativeSessionStateV1[];
  collaborationMonitors?: Record<string, McpxGatewayMonitor[]>;
  collaborationMemberIds?: Record<string, string>;
  collaborationError?: string;
  /** Compatibility field names for verified built-in Gateway availability. */
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
  /** E key: register cwd without a TTL lease (survives window close). */
  onRegisterWorkspacePermanent?: (path: string) => Promise<string>;
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

type OverlayMode = "list" | "detail" | "workspace" | "window-list" | "window-detail" | "config" | "collaboration" | "collaboration-detail" | "monitor-detail";

function normalizeWorkspacePath(value: string): string {
  let normalized = value.replace(/\\/g, "/");
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

/** Root of all peer workspaces (test seam: PI_PEER_WORKSPACES_ROOT). */
function peerWorkspacesRoot(): string {
  return process.env.PI_PEER_WORKSPACES_ROOT ?? join(homedir(), ".pi", "teammate", "workspaces");
}

function workspaceIdForCwd(cwd: string): string {
  return createHash("sha256").update(normalizeWorkspacePath(cwd), "utf8").digest("hex");
}

/** Read at most `limit` entries without materializing an unbounded directory. */
function boundedDirectoryEntries(path: string, limit: number): Dirent[] {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(path);
    const entries: Dirent[] = [];
    while (entries.length < limit) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  } finally {
    try { directory?.closeSync(); } catch { /* directory may already be closed */ }
  }
}

/** Runtime dirs of a bounded workspace sample, prioritizing the current cwd. */
function peerRuntimeRoots(preferredCwd?: string): string[] {
  const root = peerWorkspacesRoot();
  const preferredName = preferredCwd ? workspaceIdForCwd(preferredCwd) : undefined;
  const names: string[] = preferredName ? [preferredName] : [];
  for (const entry of boundedDirectoryEntries(root, MAX_PEER_RUNTIME_ROOTS)) {
    if (!entry.isDirectory() || entry.name === preferredName) continue;
    names.push(entry.name);
    if (names.length >= MAX_PEER_RUNTIME_ROOTS) break;
  }
  return names.map((name) => join(root, name, "runtime"));
}

/** Best-effort workspace label (normalizedCwd) from a bounded owner sample. */
function peerWorkspaceLabel(runtime: string): string | undefined {
  const owners = join(runtime, "owners");
  for (const entry of boundedDirectoryEntries(owners, MAX_PEER_OWNERS_PER_ROOT)) {
    if (!entry.name.endsWith(".json")) continue;
    const snapshot = readJson<OwnerSnapshotFile>(join(owners, entry.name));
    if (snapshot?.normalizedCwd) return snapshot.normalizedCwd;
  }
  return undefined;
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
  workspaceId?: string;
  normalizedCwd?: string;
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

function collectWindows(now: number, preferredCwd?: string): McpxWindowInfo[] {
  const windows: McpxWindowInfo[] = [];
  for (const runtime of peerRuntimeRoots(preferredCwd)) {
    const owners = join(runtime, "owners");
    for (const entry of boundedDirectoryEntries(owners, MAX_PEER_OWNERS_PER_ROOT)) {
      if (!entry.name.endsWith(".json")) continue;
      const fullPath = join(owners, entry.name);
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
        workspace: snapshot.normalizedCwd,
      });
    }
  }
  windows.sort((a, b) => b.publishedAt - a.publishedAt);
  return windows;
}

function collectThread(preferredCwd?: string): McpxThreadEntry[] {
  const entries: McpxThreadEntry[] = [];
  // PERF-RV-005: Instead of reading and parsing every JSON file (which grows
  // linearly with history), we stat each file's mtime, sort by mtime desc, and
  // only read+parse the most recent ~60 files. We then slice to 30 as before.
  // This bounds the cost as the commands/responses directories grow large.
  const MAX_READ = 60;

  /** Collect file paths and mtimes from a two-level directory tree. */
  function collectFileMeta(dir: string, limit: number): Array<{ path: string; mtime: number }> {
    const files: Array<{ path: string; mtime: number }> = [];
    for (const owner of boundedDirectoryEntries(dir, MAX_PEER_OWNERS_PER_ROOT)) {
      if (!owner.isDirectory()) continue;
      const ownerDir = join(dir, owner.name);
      for (const file of boundedDirectoryEntries(ownerDir, Math.min(MAX_PEER_FILES_PER_OWNER, limit - files.length))) {
        if (!file.name.endsWith(".json") || file.name.includes(".processing")) continue;
        const fullPath = join(ownerDir, file.name);
        try {
          files.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
        } catch {
          // file vanished — skip
        }
        if (files.length >= limit) return files;
      }
    }
    return files;
  }

  const allFiles: Array<{ path: string; mtime: number; workspace?: string }> = [];
  for (const runtime of peerRuntimeRoots(preferredCwd)) {
    const workspace = peerWorkspaceLabel(runtime);
    for (const kind of ["commands", "responses"] as const) {
      const remaining = MAX_PEER_FILE_METADATA - allFiles.length;
      if (remaining <= 0) break;
      for (const file of collectFileMeta(join(runtime, kind), remaining)) allFiles.push({ ...file, workspace });
    }
    if (allFiles.length >= MAX_PEER_FILE_METADATA) break;
  }
  allFiles.sort((a, b) => b.mtime - a.mtime);
  const toRead = allFiles.slice(0, MAX_READ);

  for (const { path, workspace } of toRead) {
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
        workspace,
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
        workspace,
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
  if (executablePathCache.has(command)) return executablePathCache.get(command)!;
  const canExecute = (path: string): boolean => {
    try { accessSync(path, constants.X_OK); return true; }
    catch { return false; }
  };
  let result: boolean;
  if (command.includes("/") || command.includes("\\")) {
    result = canExecute(command);
  } else {
    const names = process.platform === "win32" && !/\.[^./\\]+$/u.test(command)
      ? [command, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => `${command}${extension.toLowerCase()}`)]
      : [command];
    result = (process.env.PATH ?? "").split(delimiter).some((directory) =>
      names.some((name) => canExecute(join(directory || process.cwd(), name))),
    );
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
    else if (response.status === 401) endpointVersion = "Pi Maestro Gateway 需鉴权（401）";
    else if (response.status === 403) endpointVersion = "Pi Maestro Gateway 拒绝（403 Host）";
    else endpointVersion = `Pi Maestro Gateway · HTTP ${response.status}`;
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
  /** Inline config editor state (C key). `configView` is loaded lazily on
   *  first entry into config mode; edits accumulate in `configChanges` and are
   *  written atomically on save, so a user can change several fields then commit. */
  private configView?: McpxConfigView;
  private configChanges: McpxConfigChanges = {};
  private configSelected = 0;
  private configEditing = false;
  private configDraft = "";
  /** Sub-mode within config mode: top menu, or inside a list editor. */
  private configListKey: "commandsAllow" | "commandsConfirm" | "commandsDeny" | "filesAllow" | "filesConfirm" | "filesDeny" | undefined;
  private configListSelected = 0;
  private snapshot: McpxSnapshot = {
    refreshing: true, endpoint: "unknown", workspaces: [], cwdRegistered: false, windows: [], thread: [], mcpServers: [],
  };
  private status = "";
  private workspaceToggleBusy = false;
  private workspaceToggleQueued = false;
  private workspaceToggleQueuedPermanent = false;
  private starting = false;
  private refreshGeneration = 0;
  private refreshPromise?: Promise<void>;
  private closed = false; // set on close() so async refresh/render skip work after close
  private windowSelected = 0;
  private windowSessionSelected = 0;
  private windowObservation?: McpxWindowObservation;
  private observeTimer?: ReturnType<typeof setInterval>;
  private observeGeneration = 0;
  private observing = false;
  private windowActionBusy = false;
  private collaborationSelected = 0;
  private collaborationItemSelected = 0;
  private collaborationBusy = false;
  private monitorObservation?: McpxGatewayMonitorObservation;
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

  /** Start only the verified packaged Gateway through its authenticated control client. */
  private async startMcpx(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.status = "正在启动 Pi Maestro Gateway…";
    this.safeRequestRender();
    try {
      const status = await startGateway(this.params.cwd);
      this.status = status.online ? "Pi Maestro Gateway 已启动" : "Pi Maestro Gateway 尚未就绪";
    } catch (error) {
      this.status = `启动失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }

  /** Stop through authenticated Gateway IPC; fallback requires exact owner identity. */
  private async stopMcpx(): Promise<void> {
    this.status = "正在停止 Pi Maestro Gateway…";
    this.safeRequestRender();
    try {
      const status = await readGatewayControlStatus(this.params.cwd);
      if (!status.owner) this.status = "Pi Maestro Gateway 未运行";
      else {
        await stopGateway(this.params.cwd);
        this.status = "Pi Maestro Gateway 已停止";
      }
    } catch (error) {
      this.status = `停止失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    await this.refresh();
  }

  /** Restart the built-in daemon so config changes take effect. */
  private async restartMcpx(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.status = "正在重启 Pi Maestro Gateway…";
    this.safeRequestRender();
    try {
      const status = await restartGateway(this.params.cwd);
      this.status = status.online ? "Pi Maestro Gateway 已重启" : "Pi Maestro Gateway 尚未就绪";
    } catch (error) {
      this.status = `重启失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.starting = false;
    }
    await this.refresh();
  }

  /** T restarts the Cloudflare quick tunnel, syncs its new URL into config.yaml's
   *  server_url, and restarts mcpx so the OAuth issuer matches the new URL.
   *  One-click refresh for the quick-tunnel-URL-changed scenario. */
  private async refreshTunnelAndMcpx(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.status = "正在重启隧道并同步 Pi Maestro Gateway…";
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
      // 3. Restart the authenticated built-in daemon to load the new issuer.
      await restartGateway(this.params.cwd);
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { reachable } = await probeEndpoint(this.configPath());
        if (reachable) { online = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!online) throw new Error("Pi Maestro Gateway HTTP /mcp 端点未就绪");
      const publicHealth = await probeTunnelHealth(newUrl);
      const publicReady = publicHealth === "ok" || publicHealth === "auth";
      this.status = publicReady
        ? `隧道已更新: ${newUrl}/mcp · Pi Maestro Gateway 已重启 · 公网端点已就绪`
        : `隧道已更新: ${newUrl}/mcp · Pi Maestro Gateway 已重启，但公网端点仍未就绪（按 r 重试或 T 重启隧道）`;
    } catch (error) {
      let rolledBack = false;
      if (configUpdated) {
        // Stop both sides before restoring the old snapshot. The old tunnel URL
        // cannot be resumed after a Quick Tunnel rotation, so the consistent
        // fallback is the old local config with no tunnel process.
        try { await stopGateway(this.params.cwd); } catch { /* best-effort */ }
      }
      if (newUrl) {
        try { await stopQuickTunnel(); } catch { /* best-effort */ }
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
    if (this.refreshPromise) return this.refreshPromise;
    const operation = this.refreshOnce();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      if (this.refreshPromise === operation) this.refreshPromise = undefined;
    }
  }

  private async refreshOnce(): Promise<void> {
    this.refreshGeneration++;
    const generation = this.refreshGeneration;
    executablePathCache.clear();
    this.snapshot = { ...this.snapshot, refreshing: true, error: undefined };
    this.safeRequestRender();
    try {
      const cwd = this.params.cwd;
      const now = Date.now();
      const binary = locateMcpx();
      const fork = detectMcpxForPmf();
      const version = fork.version ? `pi-maestro-gateway ${fork.version}` : undefined;
      const controlStatus = await readGatewayControlStatus(cwd);
      const configPath = join(homedir(), ".mcpx", "config.yaml");
      const workspaces = (await listGatewayWorkspaces()).map((workspace) => ({
        name: basename(workspace.path),
        path: workspace.path,
        ...(workspace.expiresAt === undefined ? {} : { expiresAt: workspace.expiresAt }),
      }));
      let collaborativeSessions: CollaborativeSessionStateV1[] = [];
      let collaborationError: string | undefined;
      try {
        collaborativeSessions = await readGatewayCollaborativeSessions(cwd);
      } catch (error) {
        collaborationError = error instanceof Error ? error.message : String(error);
      }
      const tunnel = readTunnelState();
      const { endpoint, reachable, endpointVersion } = await probeEndpoint(configPath);
      const online = reachable;
      const opsPassword = readOpsPassword();

      let connections: McpxConnectionInfo[] | undefined;
      let runtimeWindows: McpxRuntimeWindow[] | undefined;
      let runtimeWindowFallback: McpxSnapshot["runtimeWindowFallback"];
      const collaborationMonitors: Record<string, McpxGatewayMonitor[]> = {};
      const collaborationMemberIds: Record<string, string> = {};
      if (online) {
        const client = this.clientForEndpoint(endpoint);
        const memberIds = collaborativeSessions.flatMap((state) => state.members.map((member) => member.id));
        try {
          connections = await client.listRemoteSessions(memberIds);
          const windowGroups = await Promise.all(connections.map((session) => client.listWindows(session)));
          runtimeWindows = windowGroups.flat();
        } catch (error) {
          runtimeWindowFallback = error instanceof McpxClientError && error.kind === "auth"
            ? "auth"
            : error instanceof McpxClientError && error.kind === "unsupported"
              ? "unsupported"
              : "unavailable";
        }
        for (let index = 0; index < collaborativeSessions.length; index++) {
          const localState = collaborativeSessions[index]!;
          const candidates = localState.members
            .filter((member) => member.status === "active" && member.leaseExpiresAt > now)
            .sort((left, right) => left.role === "owner" ? -1 : right.role === "owner" ? 1 : 0);
          for (const member of candidates) {
            try {
              const state = await client.getGatewaySession(localState.session.id, member.id);
              collaborativeSessions[index] = state;
              collaborationMonitors[state.session.id] = await client.listGatewayMonitors(state.session.id, member.id);
              collaborationMemberIds[state.session.id] = member.id;
              break;
            } catch {
              // A local state file may belong to another authenticated principal.
            }
          }
        }
      }

      if (generation === this.refreshGeneration && !this.closed) {
        this.snapshot = {
          refreshing: false,
          binary: binary ?? undefined,
          version,
          endpoint: online ? "online" : "offline",
          endpointVersion: endpointVersion ?? (controlStatus.online ? "Pi Maestro Gateway IPC online" : undefined),
          configPath: existsSync(configPath) ? configPath : undefined,
          workspaces,
          ...this.cwdRegistrationState(workspaces, cwd),
          windows: collectWindows(now, cwd),
          thread: collectThread(cwd),
          mcpServers: collectMcpServers(cwd),
          connections,
          runtimeWindows,
          runtimeWindowFallback,
          tunnel,
          tasks: await readGatewayDelegatedTasks(),
          collaborativeSessions,
          collaborationMonitors,
          collaborationMemberIds,
          ...(collaborationError === undefined ? {} : { collaborationError }),
          forkInstalled: fork.installed,
          forkVersion: fork.version,
          opsPassword,
        };
        this.windowSessionSelected = Math.min(
          this.windowSessionSelected,
          Math.max(0, (connections?.length ?? 1) - 1),
        );
        this.windowSelected = Math.min(this.windowSelected, Math.max(0, this.windowEntries().length - 1));
        this.collaborationSelected = Math.min(this.collaborationSelected, Math.max(0, collaborativeSessions.length - 1));
        this.collaborationItemSelected = Math.min(this.collaborationItemSelected, Math.max(0, this.collaborationItems().length - 1));
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
      void this.toggleWorkspaceRegistration(this.workspaceToggleQueuedPermanent);
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

  private currentCollaborativeSession(): CollaborativeSessionStateV1 | undefined {
    return this.snapshot.collaborativeSessions?.[this.collaborationSelected];
  }

  private collaborationItems(): Array<{ kind: "todo"; todo: GatewayTodoTaskV1 } | { kind: "monitor"; monitor: McpxGatewayMonitor }> {
    const state = this.currentCollaborativeSession();
    if (!state) return [];
    return [
      ...state.todos.map((todo) => ({ kind: "todo" as const, todo })),
      ...(this.snapshot.collaborationMonitors?.[state.session.id] ?? []).map((monitor) => ({ kind: "monitor" as const, monitor })),
    ];
  }

  private async renewCurrentGatewayMember(): Promise<void> {
    if (this.collaborationBusy) return;
    const state = this.currentCollaborativeSession();
    const memberId = state && this.snapshot.collaborationMemberIds?.[state.session.id];
    const member = state?.members.find((candidate) => candidate.id === memberId);
    if (!state || !memberId || !member || !this.client) {
      this.status = "Gateway member renewal unavailable for this authenticated identity";
      this.safeRequestRender();
      return;
    }
    this.collaborationBusy = true;
    try {
      await this.client.renewGatewayMember(state.session.id, memberId, state.session.revision, member.generation);
      this.status = `Renewed member ${memberId} lease`;
      await this.refresh();
    } catch (error) {
      this.status = `Member renewal failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.collaborationBusy = false;
      this.safeRequestRender();
    }
  }

  private async mutateSelectedGatewayTodo(action: "claim" | "release" | "advance", status?: "pending" | "blocked" | "completed" | "cancelled"): Promise<void> {
    if (this.collaborationBusy) return;
    const state = this.currentCollaborativeSession();
    const item = this.collaborationItems()[this.collaborationItemSelected];
    const memberId = state && this.snapshot.collaborationMemberIds?.[state.session.id];
    if (!state || item?.kind !== "todo" || !memberId || !this.client) {
      this.status = "Gateway Todo action unavailable for this authenticated member";
      this.safeRequestRender();
      return;
    }
    this.collaborationBusy = true;
    this.status = `${action} Gateway Todo…`;
    this.safeRequestRender();
    try {
      await this.client.mutateGatewayTodo({ action, sessionId: state.session.id, memberId, expectedSessionRevision: state.session.revision, todoId: item.todo.id, ...(status ? { status } : {}) });
      this.status = `Gateway Todo ${action} completed`;
      await this.refresh();
    } catch (error) {
      this.status = `Gateway Todo action failed: ${error instanceof Error ? error.message : String(error)}`;
      this.safeRequestRender();
    } finally {
      this.collaborationBusy = false;
    }
  }

  private async observeSelectedMonitor(reset = false): Promise<void> {
    if (this.collaborationBusy) return;
    const state = this.currentCollaborativeSession();
    const item = this.collaborationItems()[this.collaborationItemSelected];
    const memberId = state && this.snapshot.collaborationMemberIds?.[state.session.id];
    if (!state || item?.kind !== "monitor" || !memberId || !this.client) return;
    this.collaborationBusy = true;
    try {
      const cursor = reset ? 0 : (this.monitorObservation?.nextCursor ?? 0);
      this.monitorObservation = await this.client.observeGatewayMonitor(state.session.id, memberId, item.monitor.handle, cursor);
      this.status = this.monitorObservation.gap ? "Monitor cursor gap detected; showing retained events" : "";
    } catch (error) {
      this.status = `Monitor observe failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.collaborationBusy = false;
      this.safeRequestRender();
    }
  }

  private async cancelSelectedMonitor(): Promise<void> {
    if (this.collaborationBusy) return;
    const state = this.currentCollaborativeSession();
    const item = this.collaborationItems()[this.collaborationItemSelected];
    const memberId = state && this.snapshot.collaborationMemberIds?.[state.session.id];
    if (!state || item?.kind !== "monitor" || !memberId || !this.client) return;
    this.collaborationBusy = true;
    try {
      await this.client.cancelGatewayMonitor(state.session.id, memberId, item.monitor.handle);
      this.status = "Monitor cancellation requested";
      await this.refresh();
    } catch (error) {
      this.status = `Monitor cancel failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.collaborationBusy = false;
      this.safeRequestRender();
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
    if (this.mode === "config") return this.renderConfig(safeWidth);
    if (this.mode === "collaboration") return this.renderCollaboration(safeWidth);
    if (this.mode === "collaboration-detail") return this.renderCollaborationDetail(safeWidth);
    if (this.mode === "monitor-detail") return this.renderMonitorDetail(safeWidth);
    return this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "window-detail") {
        this.stopWindowObserve();
        this.mode = "window-list";
      } else if (this.mode === "config") {
        if (this.configEditing) {
          this.configEditing = false;
          this.configDraft = "";
        } else if (this.configListKey) {
          this.configListKey = undefined;
          this.configListSelected = 0;
        } else {
          this.mode = "list";
        }
      } else if (this.mode === "monitor-detail") {
        this.mode = "collaboration-detail";
        this.monitorObservation = undefined;
      } else if (this.mode === "collaboration-detail") {
        this.mode = "collaboration";
        this.collaborationItemSelected = 0;
      } else if (this.mode === "detail" || this.mode === "workspace" || this.mode === "window-list" || this.mode === "collaboration") {
        this.mode = "list";
      } else {
        this.markClosed();
        this.params.close();
      }
      this.params.requestRender();
      return;
    }
    if (this.mode === "monitor-detail") {
      if (data === "r") void this.observeSelectedMonitor();
      else if (data === "R") void this.observeSelectedMonitor(true);
      else if (data === "x" || data === "X") void this.cancelSelectedMonitor();
      return;
    }
    if (this.mode === "collaboration-detail") {
      const items = this.collaborationItems();
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.collaborationItemSelected = Math.max(0, this.collaborationItemSelected - 1);
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.collaborationItemSelected = Math.min(Math.max(0, items.length - 1), this.collaborationItemSelected + 1);
      } else if (isEnter(data) && items[this.collaborationItemSelected]?.kind === "monitor") {
        this.monitorObservation = undefined;
        this.mode = "monitor-detail";
        void this.observeSelectedMonitor(true);
      } else if (data === "u") {
        void this.renewCurrentGatewayMember();
      } else if (data === "a") {
        const item = items[this.collaborationItemSelected];
        if (item?.kind === "todo") void this.mutateSelectedGatewayTodo(item.todo.status === "in_progress" ? "release" : "claim");
      } else if (data === "b") {
        const item = items[this.collaborationItemSelected];
        if (item?.kind === "todo") void this.mutateSelectedGatewayTodo("advance", item.todo.status === "blocked" ? "pending" : "blocked");
      } else if (data === "d") {
        void this.mutateSelectedGatewayTodo("advance", "completed");
      } else if (data === "r") {
        void this.refresh();
      }
      this.params.requestRender();
      return;
    }
    if (this.mode === "collaboration") {
      const sessions = this.snapshot.collaborativeSessions ?? [];
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.collaborationSelected = Math.max(0, this.collaborationSelected - 1);
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.collaborationSelected = Math.min(Math.max(0, sessions.length - 1), this.collaborationSelected + 1);
      } else if (isEnter(data) && this.currentCollaborativeSession()) {
        this.collaborationItemSelected = 0;
        this.mode = "collaboration-detail";
      } else if (data === "r") {
        void this.refresh();
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
      } else if (data === "e") {
        void this.toggleWorkspaceRegistration(false);
      } else if (data === "E") {
        void this.toggleWorkspaceRegistration(true);
      }
      return;
    }
    if (this.mode === "config") {
      this.handleConfigInput(data);
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
    if (data === "g" || data === "G") {
      this.collaborationSelected = Math.min(this.collaborationSelected, Math.max(0, (this.snapshot.collaborativeSessions?.length ?? 1) - 1));
      this.mode = "collaboration";
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
    if (data === "e") {
      void this.toggleWorkspaceRegistration(false);
      return;
    }
    if (data === "E") {
      void this.toggleWorkspaceRegistration(true);
      return;
    }
    if (data === "c" || data === "C") {
      if (data === "C") {
        this.enterConfigMode();
      } else if (this.params.onOpenWizard) {
        this.params.onOpenWizard();
      }
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

  /** e/E toggles registration of the current window: lease (e) or permanent (E).
   *  Unregistering is shared — it removes the entry regardless of lease mode. */
  private async toggleWorkspaceRegistration(permanent = false): Promise<void> {
    if (this.workspaceToggleBusy) return;
    if (this.snapshot.refreshing) {
      this.workspaceToggleQueued = true;
      this.workspaceToggleQueuedPermanent = permanent;
      this.status = "正在刷新 workspace，注册操作将在刷新后执行…";
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
      } else if (!registered && permanent && this.params.onRegisterWorkspacePermanent) {
        const message = await this.params.onRegisterWorkspacePermanent(this.params.cwd);
        this.status = message;
      } else if (!registered && !permanent && this.params.onRegisterWorkspace) {
        // Lease-based registration (TTL + heartbeat) — never fall back to a
        // static `workspace register` while the extension provides a lease.
        const message = await this.params.onRegisterWorkspace(this.params.cwd);
        this.status = message;
      } else if (registered) {
        const { ok, message } = await removeGatewayWorkspaceByPath(this.params.cwd);
        this.status = ok ? `unregistered: ${this.params.cwd}` : `remove failed: ${message}`;
      } else {
        const registeredNow = permanent
          ? await registerMcpxWorkspacePermanent(this.params.cwd)
          : await startWorkspaceLease(this.params.cwd);
        this.status = registeredNow
          ? `registered: ${this.params.cwd}`
          : `register failed: ${this.params.cwd}`;
      }
    } catch (error) {
      this.status = `${registered ? "remove" : "register"} failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.workspaceToggleBusy = false;
    }
    await this.refresh();
  }

  // --- Inline config editor (C key) ---
  // A flat, ordered list of editable config entries. Each entry binds a key
  // path (server.host, auth.mode, commands.allow, …) to a renderer + editor.
  // Scalar edits accumulate in configChanges; list edits are applied directly
  // to configChanges so add/delete is immediately visible.
  private configEntries(): ConfigEntry[] {
    const v = this.configView;
    const listLen = (arr: string[] | undefined) => arr?.length ?? 0;
    return [
      { group: "server", key: "server.host", label: "host", kind: "text", value: v?.server.host ?? "127.0.0.1" },
      { group: "server", key: "server.port", label: "port", kind: "number", value: String(v?.server.port ?? 9090) },
      { group: "server", key: "server.disable_localhost_protection", label: "disable_localhost_protection", kind: "bool", value: String(v?.server.disableLocalhostProtection ?? false) },
      { group: "server", key: "server.trust_proxy_headers", label: "trust_proxy_headers", kind: "bool", value: String(v?.server.trustProxyHeaders ?? false) },
      { group: "auth", key: "auth.mode", label: "mode", kind: "cycle", value: v?.auth.mode ?? "open", options: ["open", "bearer", "oauth"] },
      { group: "auth", key: "auth.token", label: "token", kind: "text", value: v?.auth.token ?? "" },
      { group: "auth", key: "auth.oauthPassword", label: "oauth password", kind: "text", value: v?.auth.oauthPassword ?? "" },
      { group: "auth", key: "auth.oauthServerURL", label: "oauth server_url", kind: "text", value: v?.auth.oauthServerURL ?? "" },
      { group: "commands", key: "commands.default", label: "default", kind: "cycle", value: v?.commands.default ?? "allow", options: ["allow", "confirm", "deny"] },
      { group: "commands", key: "commands.autoAllowReadonly", label: "auto_allow_readonly", kind: "cycle", value: String(v?.commands.autoAllowReadonly ?? "null"), options: ["null", "true", "false"] },
      { group: "commands", key: "commandsAllow", label: `allow (${listLen(this.configChanges.commandsAllow)}/${v?.commands.allow.length ?? 0})`, kind: "list", listKey: "commandsAllow" },
      { group: "commands", key: "commandsConfirm", label: `confirm (${listLen(this.configChanges.commandsConfirm)}/${v?.commands.confirm.length ?? 0})`, kind: "list", listKey: "commandsConfirm" },
      { group: "commands", key: "commandsDeny", label: `deny (${listLen(this.configChanges.commandsDeny)}/${v?.commands.deny.length ?? 0})`, kind: "list", listKey: "commandsDeny" },
      { group: "files", key: "files.max_read_bytes", label: "max_read_bytes", kind: "number", value: String(v?.files.maxReadBytes ?? 1048576) },
      { group: "files", key: "files.max_patch_files", label: "max_patch_files", kind: "number", value: String(v?.files.maxPatchFiles ?? 20) },
      { group: "files", key: "filesAllow", label: `allow (${listLen(this.configChanges.filesAllow)}/${v?.files.allow.length ?? 0})`, kind: "list", listKey: "filesAllow" },
      { group: "files", key: "filesConfirm", label: `confirm (${listLen(this.configChanges.filesConfirm)}/${v?.files.confirm.length ?? 0})`, kind: "list", listKey: "filesConfirm" },
      { group: "files", key: "filesDeny", label: `deny (${listLen(this.configChanges.filesDeny)}/${v?.files.deny.length ?? 0})`, kind: "list", listKey: "filesDeny" },
      { group: "write", key: "save", label: "保存写入 config.yaml", kind: "action", action: "save" },
      { group: "write", key: "discard", label: "放弃修改", kind: "action", action: "discard" },
    ];
  }

  private enterConfigMode(): void {
    this.configView = readMcpxConfigView() ?? undefined;
    this.configChanges = {};
    this.configSelected = 0;
    this.configEditing = false;
    this.configDraft = "";
    this.configListKey = undefined;
    this.configListSelected = 0;
    this.mode = "config";
    this.params.requestRender();
  }

  private handleConfigInput(data: string): void {
    // Inside a list editor: ↑↓ move, a add (inline), d delete selected, Esc back.
    if (this.configListKey) {
      const list = this.currentConfigList();
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.configListSelected = Math.max(0, this.configListSelected - 1);
        this.params.requestRender();
      } else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.configListSelected = Math.min(Math.max(0, list.length - 1), this.configListSelected + 1);
        this.params.requestRender();
      } else if ((data === "a" || data === "A") && !this.configEditing) {
        this.configEditing = true;
        this.configDraft = "";
        this.params.requestRender();
      } else if (data === "d" || data === "D") {
        if (!this.configEditing && list.length > 0) {
          list.splice(this.configListSelected, 1);
          this.configListSelected = Math.min(this.configListSelected, Math.max(0, list.length - 1));
          this.params.requestRender();
        }
      } else if (this.configEditing) {
        if (isEnter(data)) {
          const value = this.configDraft.trim();
          if (value) list.push(value);
          this.configEditing = false;
          this.configDraft = "";
          this.params.requestRender();
        } else if (matchesKey(data, Key.backspace)) {
          this.configDraft = this.configDraft.slice(0, -1);
          this.params.requestRender();
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
          this.configDraft = (this.configDraft + data).slice(0, 200);
          this.params.requestRender();
        }
      }
      return;
    }
    const entries = this.configEntries();
    if (this.configEditing) {
      if (isEnter(data)) {
        this.commitConfigDraft();
        this.configEditing = false;
        this.configDraft = "";
        this.params.requestRender();
      } else if (matchesKey(data, Key.backspace)) {
        this.configDraft = this.configDraft.slice(0, -1);
        this.params.requestRender();
      } else if (data.length === 1 && data >= " " && data !== "\x7f") {
        this.configDraft = (this.configDraft + data).slice(0, 200);
        this.params.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.configSelected = Math.max(0, this.configSelected - 1);
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.configSelected = Math.min(entries.length - 1, this.configSelected + 1);
      this.params.requestRender();
      return;
    }
    if (isEnter(data)) {
      this.activateConfigEntry(entries[this.configSelected]);
      return;
    }
    // Space toggles bool/cycle entries without entering edit mode.
    if (data === " ") {
      const entry = entries[this.configSelected];
      if (entry?.kind === "bool") this.setConfigScalar(entry.key, entry.value === "true" ? "false" : "true");
      else if (entry?.kind === "cycle" && entry.options) {
        const idx = entry.options.indexOf(entry.value ?? "");
        this.setConfigScalar(entry.key, entry.options[(idx + 1) % entry.options.length]!);
      }
    }
  }

  private activateConfigEntry(entry: ConfigEntry | undefined): void {
    if (!entry) return;
    if (entry.kind === "list") {
      this.configListKey = entry.listKey;
      this.configListSelected = 0;
      this.params.requestRender();
      return;
    }
    if (entry.kind === "action") {
      if (entry.action === "save") void this.saveConfig();
      else if (entry.action === "discard") {
        this.configChanges = {};
        this.status = "已放弃未保存修改";
        this.params.requestRender();
      }
      return;
    }
    if (entry.kind === "cycle" && entry.options) {
      const idx = entry.options.indexOf(entry.value ?? "");
      this.setConfigScalar(entry.key, entry.options[(idx + 1) % entry.options.length]!);
      this.params.requestRender();
      return;
    }
    if (entry.kind === "bool") {
      this.setConfigScalar(entry.key, entry.value === "true" ? "false" : "true");
      this.params.requestRender();
      return;
    }
    // text / number: enter inline edit. Draft starts empty so the user types a
    // fresh replacement value; the current value stays visible in the row label.
    this.configEditing = true;
    this.configDraft = "";
    this.params.requestRender();
  }

  private commitConfigDraft(): void {
    const entries = this.configEntries();
    const entry = entries[this.configSelected];
    if (!entry) return;
    // An empty draft (Enter without typing) preserves the current value — a
    // no-op edit, not a wipe. The user types a replacement value to change it.
    if (this.configDraft.trim() === "") return;
    this.setConfigScalar(entry.key, this.configDraft);
  }

  /** Apply a scalar change to the configChanges buffer and reflect it in configView
   *  so the rendered value stays in sync before the save commits everything. */
  private setConfigScalar(key: string, value: string): void {
    const num = Number(value);
    switch (key) {
      case "server.host": this.configChanges.host = value; if (this.configView) this.configView.server.host = value; break;
      case "server.port": if (Number.isInteger(num) && num > 0 && num < 65536) { this.configChanges.port = num; if (this.configView) this.configView.server.port = num; } break;
      case "server.disable_localhost_protection": this.configChanges.disableLocalhostProtection = value === "true"; if (this.configView) this.configView.server.disableLocalhostProtection = value === "true"; break;
      case "server.trust_proxy_headers": this.configChanges.trustProxyHeaders = value === "true"; if (this.configView) this.configView.server.trustProxyHeaders = value === "true"; break;
      case "auth.mode": this.configChanges.authMode = value as McpxConfigChanges["authMode"]; if (this.configView) this.configView.auth.mode = value; break;
      case "auth.token": this.configChanges.authToken = value; if (this.configView) this.configView.auth.token = value; break;
      case "auth.oauthPassword": this.configChanges.oauthPassword = value; if (this.configView) this.configView.auth.oauthPassword = value; break;
      case "auth.oauthServerURL": this.configChanges.oauthServerURL = value; if (this.configView) this.configView.auth.oauthServerURL = value; break;
      case "commands.default": this.configChanges.commandsDefault = value as McpxConfigChanges["commandsDefault"]; if (this.configView) this.configView.commands.default = value; break;
      case "commands.autoAllowReadonly": { const ar = value === "null" ? null : value === "true"; this.configChanges.commandsAutoReadonly = ar; if (this.configView) this.configView.commands.autoAllowReadonly = ar; break; }
      case "files.max_read_bytes": if (Number.isInteger(num) && num > 0) { this.configChanges.filesMaxReadBytes = num; if (this.configView) this.configView.files.maxReadBytes = num; } break;
      case "files.max_patch_files": if (Number.isInteger(num) && num > 0) { this.configChanges.filesMaxPatchFiles = num; if (this.configView) this.configView.files.maxPatchFiles = num; } break;
    }
  }

  private currentConfigList(): string[] {
    if (!this.configListKey) return [];
    const existing = this.configView ? this.configListForView(this.configListKey) : [];
    const buf = this.configChanges[this.configListKey];
    // Once the user edits a list, the buffer is the source of truth; otherwise show the view's current list.
    return buf ?? existing;
  }

  private configListForView(key: ConfigListKey): string[] {
    const v = this.configView!;
    switch (key) {
      case "commandsAllow": return v.commands.allow;
      case "commandsConfirm": return v.commands.confirm;
      case "commandsDeny": return v.commands.deny;
      case "filesAllow": return v.files.allow;
      case "filesConfirm": return v.files.confirm;
      case "filesDeny": return v.files.deny;
    }
  }

  private async saveConfig(): Promise<void> {
    if (!this.configView) return;
    // Normalize the list buffers: if a list was opened but never edited, its
    // buffer is undefined — carry the existing view list so the write is a no-op.
    for (const key of ["commandsAllow", "commandsConfirm", "commandsDeny", "filesAllow", "filesConfirm", "filesDeny"] as const) {
      if (this.configChanges[key] === undefined) this.configChanges[key] = this.configListForView(key);
    }
    this.status = "正在写入 config.yaml…";
    this.params.requestRender();
    try {
      const { summary } = writeMcpxConfigChanges(this.configChanges);
      this.status = summary.length > 0
        ? `已写入 ${summary.length} 项 — 重启 Pi Maestro Gateway 后生效（R 重启 · 或 /gateway 重入）`
        : "无修改需写入";
      // Reload the view so the rendered values match what is now on disk.
      this.configView = readMcpxConfigView() ?? undefined;
      this.configChanges = {};
      this.configListKey = undefined;
      this.params.requestRender();
    } catch (error) {
      this.status = `写入失败: ${error instanceof Error ? error.message : String(error)}`;
      this.params.requestRender();
    }
  }

  private renderConfig(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine("Pi Maestro Gateway 配置 · ↑↓ 选择 · Enter/space 编辑 · Esc 返回", inner), rule(inner)];
    if (!this.configView) {
      rows.push(fitLine(fg("33", "未读取到 config.yaml — 可先按 c 走向导生成，或保存后即生成"), inner));
      rows.push(...fitSegments(inner, ["Esc back"]));
      return frame(rows, width);
    }
    if (this.configListKey) {
      rows.push(...this.renderConfigList(inner));
      rows.push(...fitSegments(inner, ["a 添加", "d 删除", "Enter 确认输入", "Esc 返回"]));
      if (this.status) rows.push(fitLine(this.status, inner));
      return frame(rows, width);
    }
    const entries = this.configEntries();
    let currentGroup = "";
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.group !== currentGroup) {
        currentGroup = entry.group;
        rows.push(fitLine(fg("36", `「${groupLabel(currentGroup)}」`), inner));
      }
      const selected = i === this.configSelected && !this.configEditing;
      const marker = selected ? "›" : " ";
      let valueText: string;
      if (entry.kind === "list") {
        valueText = entry.label;
      } else if (this.configEditing && i === this.configSelected) {
        // Show the current value in parens so the user sees what they are replacing,
        // followed by the new draft being typed.
        valueText = `${entry.label} (${entry.value ?? ""}): ${this.configDraft}▌`;
      } else if (entry.kind === "bool") {
        valueText = `${entry.label}: ${entry.value === "true" ? fg("32", "true") : fg("31", "false")}`;
      } else if (entry.kind === "cycle") {
        valueText = `${entry.label}: ${fg("33", entry.value ?? "")}`;
      } else {
        valueText = `${entry.label}: ${entry.value ?? ""}`;
      }
      rows.push(fitLine(`${marker} ${valueText}`, inner));
    }
    rows.push(rule(inner));
    rows.push(fitLine(fg("2", "  Enter/space 编辑标量 · 进入列表后 a 添加 d 删除 · 保存后按 R 重启 Pi Maestro Gateway"), inner));
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["Enter 编辑", "space 切换", "Esc 返回"]));
    return frame(rows, width);
  }

  private renderConfigList(inner: number): string[] {
    const list = this.currentConfigList();
    const label = this.configListKey ? this.configEntries().find((e) => e.listKey === this.configListKey)?.label ?? this.configListKey : "";
    const rows = [fitLine(`列表编辑 · ${label} · ↑↓ 选择 a 添加 d 删除`, inner), rule(inner)];
    if (list.length === 0 && !this.configEditing) {
      rows.push(fitLine("  ○ 空列表（按 a 添加正则/规则）", inner));
    } else {
      for (let i = 0; i < list.length; i++) {
        const marker = i === this.configListSelected ? fg("36", "▶") : " ";
        rows.push(fitLine(`${marker} ${list[i]}`, inner));
      }
    }
    if (this.configEditing) {
      rows.push(fitLine(fg("33", `  + 新增: ${this.configDraft}▌`), inner));
    }
    return rows;
  }

  private renderCompact(width: number): string {
    const endpoint = this.snapshot.endpoint === "online" ? "Gateway HTTP online" : this.snapshot.endpoint === "offline" ? "Gateway HTTP offline" : "Gateway …";
    const windowCount = this.snapshot.runtimeWindows?.length ?? this.snapshot.windows.length;
    const content = `${endpoint} · ${windowCount} windows · Esc close`;
    return truncateToWidth(content, width, "…");
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const rows = [fitLine("Pi Maestro Gateway · 连接监控", inner), rule(inner)];
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
      rows.push(fitLine("  ○ Gateway HTTP 未运行 — 按 s 启动 Pi Maestro Gateway", inner));
    } else if (!this.snapshot.connections || this.snapshot.connections.length === 0) {
      rows.push(fitLine("  ○ 无活跃 Remote Session 连接（按 x 停止 Pi Maestro Gateway）", inner));
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
    rows.push(...this.renderCollaborationSummary(inner));
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
          const ws = window.workspace ? `${basename(window.workspace)} · ` : "";
          rows.push(fitLine(`  local · ${ws}${window.displayName} · ${window.ownerId.slice(0, 8)} · pid ${window.pid} · agents ${window.agentCount}${pressure}`, inner));
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
    rows.push(...fitSegments(inner, ["Enter message detail", "G collaboration", "V windows", "r refresh", this.snapshot.endpoint === "online" ? "x stop" : "s start", "R restart", "T 隧道重建", "W workspaces", "e 注册(租约)", "E 注册(永久)", "c wizard", "C 配置", "P password", "Esc close"]));
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

  private renderForkRows(width: number): string[] {
    if (this.snapshot.forkInstalled) {
      return [fitLine(fg("32", `Pi Maestro Gateway 已安装${this.snapshot.forkVersion ? ` · v${this.snapshot.forkVersion}` : ""}`), width)];
    }
    return [fitLine(fg("31", "未找到 Pi Maestro Gateway — 设置 PI_MAESTRO_GATEWAY_BIN 或重新安装 pi-maestro-flow"), width)];
  }

  private renderConnectionRow(width: number): string {
    const binary = this.snapshot.binary ?? "未找到 Pi Maestro Gateway";
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
    const sweepHint = this.snapshot.cwdRegistered && !this.snapshot.cwdLeaseStale ? " · Gateway workspace 已生效" : "";
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
      rows.push(fitLine(fg("2", "  i 若客户端鉴权后仍 403：检查 server.disable_localhost_protection 并重启 Pi Maestro Gateway"), width));
    } else if (!tunnel.alive) {
      rows.push(fitLine(fg("31", "  ! 隧道进程未运行（PID 文件可能已陈旧）— 按 T 重建隧道并自动同步新 URL"), width));
    } else if (tunnel.health === "dead") {
      // quick-tunnel URL is ephemeral: a dead tunnel usually means the edge
      // connection dropped and the URL can no longer be reached at all. T
      // restarts the tunnel, writes the new URL into config, and restarts mcpx.
      const hint = this.snapshot.endpoint === "online"
        ? "按 R 重启 Pi Maestro Gateway 加载新配置，或按 T 重建隧道并自动同步新 URL"
        : "按 s 启动 Pi Maestro Gateway，或按 T 重建隧道并自动同步新 URL";
      rows.push(fitLine(fg("31", `  ! 隧道异常：Gateway 可能未重启加载新配置（403 Host/404 OAuth 路由）或隧道已断 — ${hint}`), width));
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
      return [fitLine(fg("33", "运维口令：未在 config 持久化（OAuth 授权需要配置 oauth.password）"), width)];
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

  /** 委派任务区块 — Gateway metadata journal first, then legacy history. */
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

  private renderCollaborationSummary(width: number): string[] {
    const sessions = this.snapshot.collaborativeSessions ?? [];
    const todos = sessions.reduce((count, state) => count + state.todos.length, 0);
    const monitors = Object.values(this.snapshot.collaborationMonitors ?? {}).reduce((count, values) => count + values.length, 0);
    const rows = [fitLine(`Gateway 协作（${sessions.length} Session） · Gateway Todo ${todos} · Monitor ${monitors} · G 管理`, width)];
    rows.push(fitLine(fg("33", "  Gateway Todo is independent and is not synchronized with Pi Todo."), width));
    if (this.snapshot.collaborationError) rows.push(fitLine(fg("31", `  collaboration: ${this.snapshot.collaborationError}`), width));
    return rows;
  }

  private renderCollaboration(width: number): string[] {
    const inner = width - 2;
    const sessions = this.snapshot.collaborativeSessions ?? [];
    const rows = [fitLine("Gateway Collaboration · CollaborativeSession ↑↓ · Enter details", inner), rule(inner)];
    rows.push(fitLine(fg("33", "Gateway Todo is independent and is not synchronized with Pi Todo."), inner));
    if (sessions.length === 0) {
      rows.push(fitLine("  ○ No workspace-local CollaborativeSession state", inner));
    } else {
      const start = Math.max(0, Math.min(this.collaborationSelected - 3, sessions.length - 7));
      for (let index = start; index < Math.min(sessions.length, start + 7); index++) {
        const state = sessions[index]!;
        const marker = index === this.collaborationSelected ? fg("36", "▶") : " ";
        const monitorCount = this.snapshot.collaborationMonitors?.[state.session.id]?.length ?? 0;
        rows.push(fitLine(`${marker} ${state.session.id} · ${state.session.status} · revision ${state.session.revision} · members ${state.members.length} · Gateway Todo ${state.todos.length} · Monitor ${monitorCount}`, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["Enter details", "r refresh", "Esc back"]));
    return frame(rows, width);
  }

  private renderCollaborationDetail(width: number): string[] {
    const inner = width - 2;
    const state = this.currentCollaborativeSession();
    const rows = [fitLine("CollaborativeSession · members, Gateway Todo, execution Monitor", inner), rule(inner)];
    if (!state) {
      rows.push(fitLine("  ○ Session is no longer available", inner));
    } else {
      rows.push(fitLine(`${state.session.id} · state ${state.session.status} · revision ${state.session.revision}`, inner));
      rows.push(fitLine(`workspace: ${state.session.workspacePath}`, inner));
      rows.push(rule(inner));
      rows.push(fitLine(`Members (${state.members.length}) · lease generation / expiry`, inner));
      for (const member of state.members.slice(0, 8)) {
        const remaining = member.leaseExpiresAt - Date.now();
        const lease = remaining <= 0 ? fg("31", "expired") : `${Math.ceil(remaining / 1000)}s`;
        rows.push(fitLine(`  ${member.id} · ${member.role}/${member.status} · gen ${member.generation} · lease ${lease}`, inner));
      }
      rows.push(rule(inner));
      rows.push(fitLine(`Gateway Todo (${state.todos.length}) · independent; not synchronized with Pi Todo`, inner));
      const selectedTodo = this.collaborationItemSelected < state.todos.length ? this.collaborationItemSelected : 0;
      const todoStart = Math.max(0, Math.min(selectedTodo - 3, state.todos.length - 8));
      if (state.todos.length === 0) rows.push(fitLine("  ○ No Gateway Todo items", inner));
      for (let index = todoStart; index < Math.min(state.todos.length, todoStart + 8); index++) {
        const todo = state.todos[index]!;
        const marker = index === this.collaborationItemSelected ? fg("36", "▶") : " ";
        const assignee = todo.assigneeId ? ` · @${todo.assigneeId}` : "";
        rows.push(fitLine(`${marker} ${todo.status} · ${todo.id}${assignee} · ${todo.subject}`, inner));
      }
      rows.push(rule(inner));
      const monitors = this.snapshot.collaborationMonitors?.[state.session.id] ?? [];
      rows.push(fitLine(`Execution Monitor (${monitors.length}) · stable cursor`, inner));
      if (monitors.length === 0) rows.push(fitLine("  ○ No session-bound execution handles, or current identity is read-only", inner));
      const selectedMonitor = Math.max(0, this.collaborationItemSelected - state.todos.length);
      const monitorStart = Math.max(0, Math.min(selectedMonitor - 3, monitors.length - 8));
      for (let index = monitorStart; index < Math.min(monitors.length, monitorStart + 8); index++) {
        const monitor = monitors[index]!;
        const marker = state.todos.length + index === this.collaborationItemSelected ? fg("36", "▶") : " ";
        const status = monitor.task.status === "lost" ? fg("31", "lost") : monitor.task.status;
        rows.push(fitLine(`${marker} ${status} · ${monitor.handle} · cursor ${monitor.task.eventCursor} · results ${monitor.task.resultCount}`, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["↑↓ select", "Enter observe Monitor", "u renew my lease", "a claim/release Todo", "b block/unblock Todo", "d complete Todo", "r refresh", "Esc back"]));
    return frame(rows, width);
  }

  private renderMonitorDetail(width: number): string[] {
    const inner = width - 2;
    const observation = this.monitorObservation;
    const rows = [fitLine("Execution Monitor · cursor-addressed observation", inner), rule(inner)];
    if (!observation) {
      rows.push(fitLine(this.collaborationBusy ? "  observing…" : "  ○ No observation available", inner));
    } else {
      const status = observation.task.status === "lost" ? fg("31", "lost") : observation.task.status;
      rows.push(fitLine(`${observation.handle} · ${status} · next cursor ${observation.nextCursor} · oldest ${observation.oldestCursor}${observation.hasMore ? " · more" : ""}`, inner));
      rows.push(fitLine(observation.gap ? fg("31", "! cursor gap: older Monitor events were lost") : fg("32", "cursor continuity retained"), inner));
      rows.push(rule(inner));
      if (observation.events.length === 0) rows.push(fitLine("  ○ No retained events after this cursor", inner));
      for (const event of observation.events.slice(-this.rowBudget(8, 12))) {
        rows.push(fitLine(`  cursor ${event.cursor} · ${event.type} · ${new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}`, inner));
      }
    }
    if (this.status) rows.push(fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["r next", "R replay retained", "x cancel", "Esc back"]));
    return frame(rows, width);
  }

  private renderThreadRow(entry: McpxThreadEntry, selected: boolean, width: number): string {
    const marker = selected ? "›" : " ";
    const time = new Date(entry.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
    const ws = entry.workspace ? `${basename(entry.workspace)} · ` : "";
    if (entry.kind === "command") {
      const from = entry.fromOwnerId.slice(0, 8);
      const to = entry.toOwnerId.slice(0, 8);
      const body = entry.message ? entry.message.replace(/\s+/g, " ").slice(0, 40) : "";
      return fitLine(`${marker} ${time} ${ws}cmd ${entry.action ?? "?"} ${from}→${to} · ${body}`, width);
    }
    const from = entry.fromOwnerId.slice(0, 8);
    const to = entry.toOwnerId.slice(0, 8);
    return fitLine(`${marker} ${time} ${ws}rsp ${entry.status ?? "?"} ${from}→${to} · ${entry.commandId.slice(0, 8)}`, width);
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

  /** W 子模式：列出并更新 built-in Gateway workspace registry。 */
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
        const lease = w.expiresAt
          ? w.expiresAt <= Date.now() ? fg("31", "租约·已过期") : fg("33", "租约")
          : fg("32", "永久");
        rows.push(fitLine(`${marker} ${w.name} · ${w.path} · ${lease}`, inner));
      }
      rows.push(rule(inner));
      rows.push(fitLine(fg("31", "  d 删除选中 workspace（立即从 Gateway registry 清理）"), inner));
    }
    rows.push(...fitSegments(inner, ["d delete", "e 注册(租约)", "E 注册(永久)", "Esc back"]));
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
    const { ok, message } = await removeGatewayWorkspaceByPath(ws.path);
    this.status = ok ? `已移除 ${ws.name} — ${message}` : `移除失败: ${message}`;
    this.safeRequestRender();
    await this.refresh();
  }
}

// --- private TUI helpers (same pattern as sibling overlays) ---

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC 序列(标题等)
    // 非颜色 CSI 序列清掉;SGR 颜色码(以 m 结尾)必须保留以维持 fg()/主题着色
    .replace(/\x1b\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/g, "")
    // C0/C1 控制:保留 ESC(0x1b,SGR 序列的一部分)与 \t\n;只剥除其余控制符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, "")
    .replace(/\r/g, "");
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

type ConfigListKey = "commandsAllow" | "commandsConfirm" | "commandsDeny" | "filesAllow" | "filesConfirm" | "filesDeny";

interface ConfigEntry {
  group: string;
  key: string;
  label: string;
  kind: "text" | "number" | "bool" | "cycle" | "list" | "action";
  value?: string;
  options?: string[];
  listKey?: ConfigListKey;
  action?: "save" | "discard";
}

function groupLabel(group: string): string {
  switch (group) {
    case "server": return "服务器监听";
    case "auth": return "认证";
    case "commands": return "命令权限 security.commands";
    case "files": return "文件权限 security.files";
    case "write": return "写入";
    default: return group;
  }
}

export const _mcpxTuiInternals = {
  normalizeWorkspacePath,
  workspaceIdForCwd,
  collectWorkspaces,
  collectWindows,
  collectThread,
  displayNameOf,
};
