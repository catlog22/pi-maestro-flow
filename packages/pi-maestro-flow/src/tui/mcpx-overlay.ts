/**
 * McpxOverlay — configure and monitor the mcpx (mcpx for pmf) connection:
 * binary/endpoint status, registered workspaces, discoverable Pi windows and
 * cross-window message history (workspace-peer file protocol).
 *
 * Keys: ↑↓/jk select history · Enter details · r refresh · e register cwd · Esc close
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { locateMcpx } from "../mcpx-bridge.ts";

const MCPX_DEFAULT_ENDPOINT = "http://127.0.0.1:9090/mcp";
const PEER_STALE_MS = 20_000;

export interface McpxWorkspaceInfo {
  name: string;
  path: string;
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

export interface McpxSnapshot {
  refreshing: boolean;
  binary?: string;
  version?: string;
  endpoint: "unknown" | "online" | "offline";
  endpointVersion?: string;
  configPath?: string;
  workspaces: McpxWorkspaceInfo[];
  cwdRegistered: boolean;
  windows: McpxWindowInfo[];
  thread: McpxThreadEntry[];
  error?: string;
}

export interface McpxOverlayParams {
  cwd: string;
  requestRender: () => void;
  close: () => void;
  onRegisterWorkspace?: (path: string) => Promise<string>;
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
    }
  }
  return workspaces;
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
    refreshing: true, endpoint: "unknown", workspaces: [], cwdRegistered: false, windows: [], thread: [],
  };
  private status = "";

  constructor(private readonly params: McpxOverlayParams) {
    void this.refresh();
  }

  invalidate(): void {}
  dispose(): void {}

  async refresh(): Promise<void> {
    this.snapshot = { ...this.snapshot, refreshing: true, error: undefined };
    this.params.requestRender();
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
      const { endpoint, endpointVersion } = await probeEndpoint(configPath);
      this.snapshot = {
        refreshing: false,
        binary: binary ?? undefined,
        version,
        endpoint: endpointVersion ? "online" : "offline",
        endpointVersion,
        configPath: existsSync(configPath) ? configPath : undefined,
        workspaces,
        cwdRegistered: workspaces.some((workspace) => workspace.path.replace(/\\/g, "/").toLowerCase() === cwd.replace(/\\/g, "/").toLowerCase()),
        windows: collectWindows(cwd, now),
        thread: collectThread(cwd),
      };
    } catch (error) {
      this.snapshot = { ...this.snapshot, refreshing: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.params.requestRender();
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
      void this.registerWorkspace();
    }
  }

  private async registerWorkspace(): Promise<void> {
    if (this.snapshot.refreshing) return;
    this.status = "registering…";
    this.params.requestRender();
    try {
      if (this.params.onRegisterWorkspace) {
        const message = await this.params.onRegisterWorkspace(this.params.cwd);
        this.status = message;
      } else {
        const binary = locateMcpx();
        if (!binary) {
          this.status = "mcpx binary not found — set MCPX_BIN or add mcpx to PATH";
        } else {
          const result = spawnSync(binary, ["workspace", "register", this.params.cwd], {
            encoding: "utf8", timeout: 15_000, shell: process.platform === "win32",
          });
          this.status = result.status === 0
            ? `registered: ${this.params.cwd}`
            : `register failed (${result.status ?? "spawn error"}): ${String(result.stderr || result.stdout || "").trim()}`;
        }
      }
    } catch (error) {
      this.status = `register failed: ${error instanceof Error ? error.message : String(error)}`;
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
    rows.push(fitLine(`Pi 窗口（${this.snapshot.windows.length} fresh）`, inner));
    if (this.snapshot.windows.length === 0) {
      rows.push(fitLine("  ○ 无活跃窗口 — 在对应工作区启动 pi 后自动注册", inner));
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
    rows.push(fitSegments(inner, ["Enter detail", "r refresh", "e register cwd", "Esc close"]));
    return frame(rows, width);
  }

  private renderConnectionRow(width: number): string {
    const binary = this.snapshot.binary ?? "未找到 mcpx";
    const version = this.snapshot.version ? ` · ${this.snapshot.version}` : "";
    const endpoint = this.snapshot.endpoint === "online"
      ? fg("32", `● ${this.snapshot.endpointVersion ?? "online"}`)
      : this.snapshot.endpoint === "offline"
        ? fg("31", "● offline")
        : fg("33", "● …");
    const registered = this.snapshot.cwdRegistered ? fg("32", "已注册") : fg("33", "未注册");
    return fitLine(`binary: ${binary}${version} · endpoint: ${endpoint} · 工作区 ${this.snapshot.workspaces.length} · 当前目录 ${registered}`, width);
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
