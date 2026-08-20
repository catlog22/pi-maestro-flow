/**
 * McpxOverlay — configure and monitor the mcpx (mcpx for pmf) connection:
 * binary/endpoint status, registered workspaces, discoverable Pi windows and
 * cross-window message history (workspace-peer file protocol).
 *
 * Keys: ↑↓/jk select history · Enter details · r refresh · e register/unregister cwd · s start · x stop · R restart · Esc close
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { locateMcpx, readTunnelState, probeTunnelHealth, type TunnelState } from "../mcpx-bridge.ts";

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

type OverlayMode = "list" | "detail";

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
    const snapshot = readJson<OwnerSnapshotFile>(join(ownersDir, entry));
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
  const commandsDir = join(root, "commands");
  try {
    for (const ownerDir of readdirSync(commandsDir)) {
      const dir = join(commandsDir, ownerDir);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json") || file.includes(".processing")) continue;
        const command = readJson<{
          kind?: string; commandId?: string; createdAt?: number;
          fromOwnerId?: string; toOwnerId?: string; action?: string; message?: string;
        }>(join(dir, file));
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
      }
    }
  } catch {
    // history is best-effort
  }
  const responsesDir = join(root, "responses");
  try {
    for (const ownerDir of readdirSync(responsesDir)) {
      const dir = join(responsesDir, ownerDir);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const response = readJson<{
          kind?: string; commandId?: string; respondedAt?: number;
          fromOwnerId?: string; toOwnerId?: string; status?: string;
        }>(join(dir, file));
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
  } catch {
    // history is best-effort
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
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    timeout: 5_000,
    shell: process.platform === "win32",
  });
  return probe.status === 0;
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
      let dataText: string | undefined;
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataText = line.slice(5).trim();
      }
      if (!dataText) return undefined;
      payload = JSON.parse(dataText);
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

async function probeEndpoint(configPath: string): Promise<{ endpoint: string; endpointVersion?: string }> {
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
    return { endpoint, endpointVersion: info ? `${info.name} ${info.version}` : undefined };
  } catch {
    return { endpoint };
  }
}

export class McpxOverlay implements Component, Focusable {
  focused = false;
  private mode: OverlayMode = "list";
  private selected = 0;
  private snapshot: McpxSnapshot = {
    refreshing: true, endpoint: "unknown", workspaces: [], cwdRegistered: false, windows: [], thread: [], mcpServers: [],
  };
  private status = "";
  private mcpxProcess: ReturnType<typeof spawn> | undefined;
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
    return join(homedir(), ".mcpx", "mcpx-server.pid");
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
      this.mcpxProcess = child;
      try {
        writeFileSync(this.pidPath(), String(child.pid ?? ""), "utf8");
      } catch {
        // PID persistence is best-effort
      }
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { endpointVersion } = await probeEndpoint(this.configPath());
        if (endpointVersion) {
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

  /** Stop the mcpx server (kills the process tree on Windows) and clear the PID file. */
  private async stopMcpx(): Promise<void> {
    let pid: number | undefined = this.mcpxProcess?.pid;
    if (!pid) {
      try {
        const raw = readFileSync(this.pidPath(), "utf8").trim();
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      } catch {
        // no pid file
      }
    }
    if (!pid) {
      this.status = "未找到 mcpx 进程（PID 文件缺失）";
      this.params.requestRender();
      return;
    }
    this.status = "正在停止 mcpx…";
    this.params.requestRender();
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else if (this.mcpxProcess && !this.mcpxProcess.killed) {
        this.mcpxProcess.kill();
      } else {
        process.kill(pid, "SIGTERM");
      }
      this.status = "已发送停止信号";
    } catch (error) {
      this.status = `停止失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.mcpxProcess = undefined;
    try {
      rmSync(this.pidPath(), { force: true });
    } catch {
      // best-effort
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
    // Stop any existing process (PID file, or a process we spawned). Tolerate a
    // missing PID file — the process may have been started externally or died.
    let pid: number | undefined = this.mcpxProcess?.pid;
    if (!pid) {
      try {
        const raw = readFileSync(this.pidPath(), "utf8").trim();
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      } catch { /* no pid file — nothing to stop */ }
    }
    if (pid) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else if (this.mcpxProcess && !this.mcpxProcess.killed) {
          this.mcpxProcess.kill();
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch { /* already dead — proceed to start */ }
      this.mcpxProcess = undefined;
      try { rmSync(this.pidPath(), { force: true }); } catch { /* best-effort */ }
      // Give the port a moment to release after kill.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Start fresh — bypass the online guard (we just stopped it on purpose).
    try {
      const child = spawn(binary, [], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
      child.unref();
      this.mcpxProcess = child;
      try { writeFileSync(this.pidPath(), String(child.pid ?? ""), "utf8"); } catch { /* best-effort */ }
      const deadline = Date.now() + (this.params.endpointWaitMs ?? 15_000);
      let online = false;
      while (Date.now() < deadline) {
        const { endpointVersion } = await probeEndpoint(this.configPath());
        if (endpointVersion) { online = true; break; }
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
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.refreshGeneration++;
    const generation = this.refreshGeneration;
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
      const { endpoint, endpointVersion } = await probeEndpoint(configPath);
      const online = Boolean(endpointVersion);
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
      };
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
    return this.renderList(safeWidth);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "detail") {
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
    if (data === "r" || data === "R") {
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
    rows.push(fitSegments(inner, ["Enter detail", "r refresh", this.snapshot.endpoint === "online" ? "x stop" : "s start", "R restart", "e register cwd", "c wizard", "Esc close"]));
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
    if (tunnel.url) rows.push(fitLine(`  URL: ${tunnel.url}`, width));
    if (tunnel.health === "ok") {
      rows.push(fitLine(fg("33", "  ! 200 无鉴权 — 仅限本机 open 模式；公网暴露请用向导升级为 oauth"), width));
    } else if (tunnel.health === "auth") {
      // auth (401 + WWW-Authenticate) proves the tunnel and OAuth discovery are
      // reachable, but a probe carries no credentials so it cannot reach the
      // go-sdk Host guard that sits *after* auth. If mcpx was not restarted to
      // load disable_localhost_protection, a real client gets 403 *after* auth.
      rows.push(fitLine(fg("2", "  i 若客户端鉴权后仍 403：检查 server.disable_localhost_protection 并重启 mcpx"), width));
    } else if (tunnel.health === "dead") {
      const hint = this.snapshot.endpoint === "online"
        ? "按 R 重启 mcpx 加载新配置"
        : "按 s 启动 mcpx";
      rows.push(fitLine(fg("31", `  ! 隧道异常：mcpx 可能未重启加载新配置（403 Host/404 OAuth 路由）或隧道已断 — ${hint}`), width));
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
    rows.push(fitSegments(inner, ["Esc back"]));
    return frame(rows, width);
  }
}

// --- private TUI helpers (same pattern as sibling overlays) ---

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, width, "…").padEnd(width, " ");
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number): string[] {
  return [`┌${"─".repeat(Math.max(0, width))}┐`, ...rows.map((row) => `│${row}│`), `└${"─".repeat(Math.max(0, width))}┘`];
}

function fitSegments(width: number, segments: readonly string[]): string {
  const joined = segments.join("  ·  ");
  return fitLine(joined, width);
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
