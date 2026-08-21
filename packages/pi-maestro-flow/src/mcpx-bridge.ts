/**
 * MCPX workspace registration bridge.
 *
 * Registration is dynamic (lease-based): `ensureMcpxWorkspace` registers the
 * current project root with a TTL lease (`mcpx workspace register --ttl …`).
 * While a window is alive it renews the lease every minute
 * (`startWorkspaceLease`); when the window goes offline the heartbeat stops
 * and MCPX drops the workspace once the lease expires. Registration is
 * opt-in: the /mcpx panel's e key toggles the lease for the current window
 * (default: not registered).
 *
 * Opt out with PI_MCPX_BRIDGE=0. Override the binary with MCPX_BIN.
 */

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const bridgeDisabled = () => process.env.PI_MCPX_BRIDGE === "0";
const registeredPaths = new Set<string>();
const workspaceRegistrationPromises = new Map<string, Promise<boolean>>();

export const LEASE_TTL_SECONDS = 300; // lease length; heartbeat renews every minute
const HEARTBEAT_MS = 60_000;

let leaseTimer: NodeJS.Timeout | undefined;
let leaseCwd: string | undefined;
let leaseGeneration = 0;

// PERF-RV-003: cache locateMcpx() result across calls within a process. null =
// not-yet-probed; string = resolved path; undefined = probed-but-not-found.
let cachedMcpx: string | undefined | null = null;
// PERF-RV-003: cache detectMcpxForPmf() result across calls within a process.
// null = not-yet-probed.
let cachedMcpxForPmf: { installed: boolean; version?: string } | null = null;

export function locateMcpx(): string | undefined {
  // PERF-RV-003: return the cached result if we have already probed.
  if (cachedMcpx !== null) return cachedMcpx ?? undefined;
  const configured = process.env.MCPX_BIN;
  if (configured && existsSync(configured)) { cachedMcpx = configured; return configured; }
  // Default install location: ~/.mcpx/bin/mcpx(.exe) — the panel's s/x
  // controls and the startup bridge find it here without PATH changes.
  const homeBin = join(homedir(), ".mcpx", "bin", process.platform === "win32" ? "mcpx.exe" : "mcpx");
  if (existsSync(homeBin)) { cachedMcpx = homeBin; return homeBin; }
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["mcpx"], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  if (probe.status === 0) {
    const line = String(probe.stdout || "").split(/\r?\n/).find(Boolean);
    if (line) { cachedMcpx = line; return line; }
  }
  cachedMcpx = undefined;
  return undefined;
}

function absoluteRoot(root: string | undefined): string {
  const rawRoot = root ?? process.cwd();
  return isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(process.cwd(), rawRoot);
}

function resolveMcpxSpawn(args: string[]): { binary: string; useShell: boolean } | { error: string } {
  const mcpx = locateMcpx();
  if (!mcpx) return { error: "mcpx binary not found" };
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(mcpx);
  // npm shims require cmd.exe, but never pass shell metacharacters through a
  // shim. The normal installed mcpx.exe path uses shell:false and accepts all
  // valid Windows paths.
  if (useShell && args.some((arg) => /[\u0000\r\n&|<>^%!()]/.test(arg))) {
    return { error: "unsafe Windows command argument" };
  }
  return { binary: mcpx, useShell };
}

function runMcpx(args: string[]): { status: number | null; stderr: string } {
  const plan = resolveMcpxSpawn(args);
  if ("error" in plan) return { status: null, stderr: plan.error };
  const result = spawnSync(plan.binary, args, {
    encoding: "utf8",
    timeout: 15_000,
    shell: plan.useShell,
  });
  return { status: result.status, stderr: String(result.stderr || result.stdout || "").trim() };
}

/** Async variant for the lease heartbeat: spawnSync would block the TUI event
 *  loop for up to 15s whenever the mcpx binary hangs or responds slowly. */
function runMcpxAsync(args: string[]): Promise<{ status: number | null; stderr: string }> {
  const plan = resolveMcpxSpawn(args);
  if ("error" in plan) return Promise.resolve({ status: null, stderr: plan.error });
  return new Promise((resolve) => {
    const child = spawn(plan.binary, args, {
      shell: plan.useShell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } }, 15_000);
    const finish = (status: number | null) => {
      clearTimeout(timer);
      resolve({ status, stderr: output.trim() });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Register `root` (defaults to process.cwd()) with the local MCPX runtime
 * under a lease. The CLI call is deferred by one event-loop turn, but the
 * returned promise settles after the config write completes. Deduplicated per
 * path so bursty callers only spawn one registration.
 */
export async function ensureMcpxWorkspace(
  root?: string,
  ttlSeconds: number = LEASE_TTL_SECONDS,
  generation?: number,
): Promise<boolean> {
  if (bridgeDisabled()) return false;
  const absRoot = absoluteRoot(root);
  if (generation !== undefined && generation !== leaseGeneration) return false;
  if (registeredPaths.has(absRoot)) return true;
  const existing = workspaceRegistrationPromises.get(absRoot);
  if (existing) return existing;
  const registration = (async () => {
    registeredPaths.add(absRoot);
    const registered = await renewWorkspaceLease(absRoot, ttlSeconds, generation);
    if (!registered) registeredPaths.delete(absRoot);
    return registered;
  })();
  workspaceRegistrationPromises.set(absRoot, registration);
  try {
    return await registration;
  } finally {
    if (workspaceRegistrationPromises.get(absRoot) === registration) {
      workspaceRegistrationPromises.delete(absRoot);
    }
  }
}

/**
 * Renew the lease for an already-registered root. This bypasses the
 * per-path dedupe set: the heartbeat must actually re-register so the
 * TTL is extended while the window stays alive.
 */
function renewWorkspaceLease(absRoot: string, ttlSeconds: number, generation?: number): Promise<boolean> {
  return new Promise((resolve) => {
    setImmediate(async () => {
      // A heartbeat renewal enqueued before stop() must not fire after stop.
      // generation is only supplied by the lease heartbeat; an explicit
      // ensureMcpxWorkspace call (no generation) always runs.
      if (generation !== undefined && generation !== leaseGeneration) {
        resolve(false);
        return;
      }
      try {
        const args = ttlSeconds > 0
          ? ["workspace", "register", "--ttl", `${ttlSeconds}s`, absRoot]
          : ["workspace", "register", absRoot];
        const { status, stderr } = await runMcpxAsync(args);
        const registered = status === 0;
        if (!registered) {
          console.warn(`[pi-maestro-flow] MCPX workspace registration failed (${status ?? "spawn error"}): ${stderr}`);
        }
        resolve(registered);
      } catch (error) {
        console.warn(`[pi-maestro-flow] MCPX workspace registration skipped: ${error instanceof Error ? error.message : String(error)}`);
        resolve(false);
      }
    });
  });
}

/** Unregister `root` (defaults to process.cwd()) from the local MCPX runtime. */
export function removeMcpxWorkspace(root?: string): void {
  if (bridgeDisabled()) return;
  const absRoot = absoluteRoot(root);
  registeredPaths.delete(absRoot);
  try {
    const { status, stderr } = runMcpx(["workspace", "remove", absRoot]);
    if (status !== 0) {
      console.warn(`[pi-maestro-flow] MCPX workspace removal failed (${status ?? "spawn error"}): ${stderr}`);
    }
  } catch (error) {
    console.warn(`[pi-maestro-flow] MCPX workspace removal skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Start a lease for `cwd`: register immediately, then renew every minute so
 * the workspace stays alive while this window is running. When the window
 * goes offline the heartbeat stops and MCPX drops the workspace at expiry.
 * Resolves after the initial registration command has completed.
 */
export async function startWorkspaceLease(cwd: string, ttlSeconds: number = LEASE_TTL_SECONDS): Promise<boolean> {
  stopWorkspaceLease();
  leaseCwd = cwd;
  leaseGeneration++;
  const generation = leaseGeneration;
  const absRoot = absoluteRoot(cwd);
  registeredPaths.delete(absRoot);
  const registered = await ensureMcpxWorkspace(cwd, ttlSeconds, generation);
  if (generation === leaseGeneration && !bridgeDisabled()) {
    leaseTimer = setInterval(() => { void renewWorkspaceLease(absoluteRoot(cwd), ttlSeconds, generation); }, HEARTBEAT_MS);
    leaseTimer.unref?.(); // never keep the process alive on shutdown
    console.log(`[pi-maestro-flow] MCPX workspace lease started (ttl ${ttlSeconds}s, heartbeat ${HEARTBEAT_MS / 1000}s): ${cwd}`);
  }
  return registered;
}

/** Stop the lease heartbeat (used when the window is unregistered or closed). */
export function stopWorkspaceLease(): void {
  leaseGeneration++; // invalidate any heartbeat renewal already enqueued via setImmediate
  if (leaseTimer) {
    clearInterval(leaseTimer);
    leaseTimer = undefined;
  }
  leaseCwd = undefined;
}

/**
 * Register `cwd` permanently (no TTL lease): the entry has no expires_at and
 * survives window close until explicitly removed. Any active lease heartbeat
 * for the previous registration is stopped first. Resolves after the register
 * command completes.
 */
export async function registerMcpxWorkspacePermanent(cwd: string): Promise<boolean> {
  stopWorkspaceLease();
  const absRoot = absoluteRoot(cwd);
  registeredPaths.delete(absRoot); // force a real re-register even if a lease entry exists
  return ensureMcpxWorkspace(cwd, 0);
}

/** Test hook: reset the in-process deduplication state. */
export function _resetMcpxBridgeState(): void {
  registeredPaths.clear();
  workspaceRegistrationPromises.clear();
  stopWorkspaceLease();
  // Also reset the caches so tests that set up a fresh MCPX_BIN in a temp dir
  // re-probe instead of reusing a stale cached path from a prior test.
  cachedMcpx = null;
  cachedMcpxForPmf = null;
}

/** Test hook: reset the locateMcpx cache (PERF-RV-003). */
export function _resetMcpxCache(): void {
  cachedMcpx = null;
}

/** Test hook: reset the detectMcpxForPmf cache (PERF-RV-003). */
export function _resetMcpxForPmfCache(): void {
  cachedMcpxForPmf = null;
}

// --- Tunnel health & config detection (shared by overlay + wizard + extension) ---

const MCPX_PID_FILE = () => process.env.MCPX_PID_FILE ?? join(homedir(), ".mcpx", "mcpx-server.pid");
const MCPX_TUNNEL_PID_FILE = () => process.env.MCPX_TUNNEL_PID_FILE ?? join(homedir(), ".mcpx", "cloudflared.pid");
const MCPX_CONFIG_PATH = () => join(homedir(), ".mcpx", "config.yaml");

export type TunnelHealth = "ok" | "auth" | "dead" | "unknown";

const CLOUDFLARE_1033_ATTEMPTS = 3;
const CLOUDFLARE_1033_RETRY_MS = 1_000;

function parseProbeURL(raw: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata.google.internal") {
    return undefined;
  }
  // Plain HTTP is only accepted for the loopback development endpoint used by
  // local MCPX instances. Public tunnel URLs must use HTTPS.
  if (parsed.protocol === "http:" && hostname !== "127.0.0.1") return undefined;
  const addressType = isIP(hostname);
  if (addressType === 4) {
    const octets = hostname.split(".").map(Number);
    const privateAddress = octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 169 && octets[1] === 254;
    const loopbackAddress = octets[0] === 127;
    if ((privateAddress || loopbackAddress) && hostname !== "127.0.0.1") return undefined;
  } else if (addressType === 6 && (/^(::1|fc|fd|fe8|fe9|fea|feb)/i.test(hostname))) {
    return undefined;
  }
  return parsed;
}

export interface TunnelState {
  pid?: number;
  url?: string;
  alive: boolean;
  health: TunnelHealth;
}

function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status !== 0) return false;
      // SEC-RV-008: parse the CSV output and compare the PID column exactly,
      // avoiding substring matches (PID 5 matching PID 50). The CSV format is
      // "Image Name","PID","Session Name","Session#","Mem Usage" — the PID is
      // column 1, but compare every column for exact equality so a locale or
      // column-order change cannot silently break liveness detection. If no
      // column matches, return false (do NOT fall back to a substring match).
      const pidStr = String(pid);
      for (const line of String(result.stdout || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        for (const col of line.split(",")) {
          if (col.trim().replace(/^["']|["']$/g, "") === pidStr) return true;
        }
      }
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is owned by another user — report alive.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/** Parse the public tunnel URL (auth.oauth.server_url) from ~/.mcpx/config.yaml. */
function readConfigServerURL(): string | undefined {
  try {
    const raw = readFileSync(MCPX_CONFIG_PATH(), "utf8");
    // Match `server_url:` under auth.oauth. mcpx's yaml.v3 output and the wizard
    // both indent it at 8 spaces, but a hand-edited file may use 2+; accept any
    // indentation. Tolerate an optional trailing comment by excluding `#` from
    // the value capture (a URL never contains a bare `#`).
    const match = raw.match(/^\s{2,}server_url:\s*"?([^"\n#]+)"?/m);
    const url = match?.[1]?.trim();
    return url && /^https?:\/\//.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the tunnel state from the PID file (written by the wizard) + config.
 * `health` is "unknown" until {@link probeTunnelHealth} fills it in; the
 * overlay calls them together so the board shows a complete row per refresh.
 */
export function readTunnelState(): TunnelState {
  let pid: number | undefined;
  try {
    const raw = readFileSync(MCPX_TUNNEL_PID_FILE(), "utf8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // no PID file — tunnel was never started via the wizard in this profile
  }
  const url = readConfigServerURL();
  const alive = pid !== undefined && isProcessAlive(pid);
  return { pid, url, alive, health: "unknown" };
}

/**
 * Probe the public tunnel URL end-to-end via an MCP `initialize` over HTTPS.
 * Mirrors the overlay's probeEndpoint judgment:
 *   200            → "ok"    (open mode; public exposure should not use this)
 *   401 + WWW-Authenticate → "auth" (OAuth handshake reachable — healthy)
 *   403 / 404       → "dead"  (tunnel up but mcpx config not reloaded, e.g. the
 *                            "invalid Host header" / missing OAuth routes case)
 *   530 + Cloudflare Error 1033 → retry while the edge connector registers,
 *                                  then "dead" if the outage persists
 *   timeout/refuse → "dead"  (tunnel broken or mcpx down)
 */
export async function probeTunnelHealth(url: string): Promise<TunnelHealth> {
  const parsed = parseProbeURL(url);
  if (!parsed) return "dead";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/mcp`;
  const endpoint = parsed.href;
  for (let attempt = 0; attempt < CLOUDFLARE_1033_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mcpx-tui", version: "1.0.0" },
          },
        }),
        signal: AbortSignal.timeout(4_000),
        redirect: "manual",
      });
      if (response.status === 200) return "ok";
      if (response.status === 401) {
        // mcpx's wrapMCP always sets WWW-Authenticate with resource_metadata on 401
        // (http_gateway.go). A 401 without it is not mcpx's OAuth handshake start —
        // treat as dead (e.g. an upstream proxy's own 401, not the tunnel to mcpx).
        const wwwAuth = response.headers.get("WWW-Authenticate") ?? "";
        return wwwAuth.toLowerCase().includes("resource_metadata") ? "auth" : "dead";
      }
      if (response.status === 530) {
        const body = (await response.text().catch(() => "")).slice(0, 32_768);
        const edgeConnectorPending = /\b1033\b/.test(body);
        if (edgeConnectorPending && attempt + 1 < CLOUDFLARE_1033_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, CLOUDFLARE_1033_RETRY_MS));
          continue;
        }
      }
      return "dead";
    } catch {
      return "dead";
    }
  }
  return "dead";
}

/**
 * Whether the initial wizard configuration has been completed: ~/.mcpx/config.yaml
 * exists with a concrete auth.mode (bearer/oauth/dual). Used by the overlay's
 * register-window action to decide whether to auto-open the wizard.
 *
 * Mirrors mcpx's EffectiveAuthMode: an empty mode with a non-empty token is
 * bearer (a valid, usable configuration), so accept that as configured too.
 * `open` is intentionally excluded — it is not safe for window registration on
 * a runtime that may be exposed, so an open-mode user is still routed to the
 * wizard to pick bearer/oauth.
 */
export function isMcpxConfigured(): boolean {
  let raw: string;
  try {
    raw = readFileSync(MCPX_CONFIG_PATH(), "utf8");
  } catch {
    return false;
  }
  // Accept 2+ spaces of indentation for hand-edited YAML (mcpx/wizard use 4).
  const modeMatch = raw.match(/^\s{2,}mode:\s*([A-Za-z]+)/m);
  const mode = modeMatch?.[1]?.trim().toLowerCase();
  if (mode === "bearer" || mode === "dual") return true;
  if (mode === "oauth") return Boolean(readConfigServerURL());
  if (mode === "open") return false;
  // No explicit mode: mcpx treats a non-empty token as bearer (EffectiveAuthMode).
  const tokenMatch = raw.match(/^\s{2,}token:\s*"?([^"\n#]+)"?/m);
  const token = tokenMatch?.[1]?.trim();
  return Boolean(token);
}

/**
 * Read the OAuth ops password (运维口令) from ~/.mcpx/config.yaml.
 * mcpx auto-generates one at startup when this is empty (kept in memory + the
 * startup log only). Persisting it here makes it stable across restarts and
 * lets the board show it for the authorize page.
 * Returns undefined when not set in config (the runtime still has an in-memory one).
 */
export function readOpsPassword(): string | undefined {
  try {
    const raw = readFileSync(MCPX_CONFIG_PATH(), "utf8");
    const match = raw.match(/^\s{2,}password:\s*"?([^"\n#]+)"?/m);
    const pw = match?.[1]?.trim();
    return pw || undefined;
  } catch {
    return undefined;
  }
}

/** Read a configured bearer token for local Runtime calls. OAuth passwords are not tokens. */
export function readMcpxBearerToken(): string | undefined {
  try {
    const raw = readFileSync(MCPX_CONFIG_PATH(), "utf8");
    const mode = raw.match(/^\s{2,}mode:\s*([A-Za-z]+)/m)?.[1]?.toLowerCase();
    if (mode && mode !== "bearer" && mode !== "dual") return undefined;
    const token = raw.match(/^\s{2,}token:\s*"?([^"\n#]+)"?/m)?.[1]?.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether the `mcpx-for-pmf` fork is installed as a global npm package.
 * The fork's postinstall drops the platform binary at ~/.mcpx/bin; the npm
 * package name is the reliable signal that distinguishes the fork from the
 * upstream `mcpx` package. Returns { installed, version }.
 */
export function detectMcpxForPmf(): { installed: boolean; version?: string } {
  // PERF-RV-003: return the cached result if we have already probed.
  if (cachedMcpxForPmf !== null) return cachedMcpxForPmf;
  try {
    // Resolve the global node_modules root: `npm root -g` prints the path.
    const probe = spawnSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 8_000,
      shell: process.platform === "win32",
    });
    if (probe.status !== 0) { cachedMcpxForPmf = { installed: false }; return cachedMcpxForPmf; }
    const root = String(probe.stdout || "").split(/\r?\n/).find((l) => l.trim());
    if (!root) { cachedMcpxForPmf = { installed: false }; return cachedMcpxForPmf; }
    const pkgPath = join(root.trim(), "mcpx-for-pmf", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    if (pkg.name === "mcpx-for-pmf") { cachedMcpxForPmf = { installed: true, version: pkg.version }; return cachedMcpxForPmf; }
    cachedMcpxForPmf = { installed: false };
    return cachedMcpxForPmf;
  } catch {
    cachedMcpxForPmf = { installed: false };
    return cachedMcpxForPmf;
  }
}

/**
 * Remove a registered workspace via `mcpx workspace remove <path>`.
 * Writes config.yaml only — the running mcpx rebuilds its in-memory registry
 * at the next ~5min lease sweep, so the removed workspace stays live until
 * then. Returns { ok, message }.
 */
export function removeWorkspaceByPath(path: string): { ok: boolean; message: string } {
  const mcpx = locateMcpx();
  if (!mcpx) return { ok: false, message: "未找到 mcpx 二进制" };
  const { status, stderr } = runMcpx(["workspace", "remove", path]);
  if (status === 0) return { ok: true, message: "已移除（mcpx ≤5min 内清理）" };
  return { ok: false, message: stderr || "workspace remove 失败" };
}

// --- Delegated task registry (Phase 4: board display) ---

/** Mirrors mcpx internal/tasks DelegatedTask JSON ({taskID}.json registry entry). */
export interface DelegatedTask {
  task_id: string;
  remote_session_id: string;
  workspace: string;
  target_owner_id?: string;
  spawn_pid?: number;
  action: string;
  message: string;
  purpose: string;
  status: string;
  result?: string;
  result_summary?: string[];
  created_at: string;
  delivered_at?: string;
  completed_at?: string;
  error?: string;
}

/** Shape of the {taskID}.result.json companion file pi writes on completion. */
interface DelegatedTaskResult {
  task_id: string;
  status?: string;
  result?: string;
  result_summary?: string[];
  completed_at?: string;
  error?: string;
}

/** Root of the delegated-task registry: {home}/.mcpx/tasks/delegated/{sessionID}/. */
function delegatedTaskDir(sessionId: string): string {
  return join(homedir(), ".mcpx", "tasks", "delegated", sessionId);
}/**
 * Read delegated tasks from the mcpx file registry.
 * Each {taskID}.json is a registry entry; a {taskID}.result.json companion (written
 * by the pi agent after the task settles) is merged in, promoting status to
 * the result's status and folding in result/result_summary.
 * Pass sessionId to scope to one Remote Session; omit to scan all sessions.
 * Returns undefined when no registry dir exists.
 */
export function readDelegatedTasks(sessionId?: string): DelegatedTask[] | undefined {
  const root = join(homedir(), ".mcpx", "tasks", "delegated");
  let sessionDirs: string[];
  try {
    if (sessionId) {
      sessionDirs = [join(root, sessionId)];
    } else {
      // scan all session subdirs
      sessionDirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name));
    }
  } catch {
    return undefined;
  }
  const tasks: DelegatedTask[] = [];
  for (const dir of sessionDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // registry entries are {taskID}.json; skip companion result files.
      if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
      try {
        const task = JSON.parse(readFileSync(join(dir, name), "utf8")) as DelegatedTask;
        // merge companion result file if present
        const resultPath = join(dir, task.task_id + ".result.json");
        if (existsSync(resultPath)) {
          try {
            const res = JSON.parse(readFileSync(resultPath, "utf8")) as DelegatedTaskResult;
            if (res.status) task.status = res.status;
            if (typeof res.result === "string") task.result = res.result;
            if (Array.isArray(res.result_summary)) task.result_summary = res.result_summary;
            if (res.completed_at) task.completed_at = res.completed_at;
            if (res.error) task.error = res.error;
          } catch {
            // malformed result file — keep registry entry as-is
          }
        }
        tasks.push(task);
      } catch {
        // malformed registry entry — skip
      }
    }
  }
  // newest first
  tasks.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return tasks;
}

// --- Quick tunnel restart + config sync (one-click URL refresh) ---

/** Resolve the cloudflared executable path (mirrors the wizard's logic). */
function resolveCloudflared(): string | undefined {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"], {
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
  });
  if (probe.status === 0) {
    const line = String(probe.stdout || "").split(/\r?\n/).find(Boolean);
    if (line) return line.trim();
  }
  return undefined;
}

/** A process whose command line is an exact Cloudflare Quick Tunnel command. */
export interface QuickTunnelProcess {
  pid: number;
  commandLine: string;
}

type QuickTunnelDiscovery = (localPort: number) => QuickTunnelProcess[] | undefined;
let quickTunnelDiscoveryOverride: QuickTunnelDiscovery | undefined;

/** Test hook for exercising adoption/start guards without touching real processes. */
export function setQuickTunnelDiscoveryForTest(discovery: QuickTunnelDiscovery | undefined): () => void {
  const previous = quickTunnelDiscoveryOverride;
  quickTunnelDiscoveryOverride = discovery;
  return () => { quickTunnelDiscoveryOverride = previous; };
}

/** Keep tunnel discovery and spawning bounded to a valid TCP port. */
export function isValidTunnelPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

const WINDOWS_QUICK_TUNNEL_QUERY =
  "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Select-Object Name,ProcessId,CommandLine) | ConvertTo-Json -Compress";

function quickTunnelCommandMatches(argv: string[], port: number): boolean {
  if (argv.length !== 4) return false;
  const executable = argv[0]!.split(/[\\/]/).pop()!.toLowerCase();
  return (executable === "cloudflared" || executable === "cloudflared.exe")
    && argv[1] === "tunnel"
    && argv[2] === "--url"
    && argv[3] === `http://127.0.0.1:${port}`;
}

function quickTunnelCommandLine(argv: string[]): string {
  return argv.join(" ");
}

/** Return whether a command line is exactly a Quick Tunnel for `port`. */
export function isQuickTunnelCommandLine(commandLine: string, port: number): boolean {
  const trimmed = commandLine.trim();
  const executableMatch = trimmed.match(/^(?:"([^"]+)"|(\S+))(?:\s+)(.*)$/);
  if (!executableMatch) return false;
  const executable = executableMatch[1] ?? executableMatch[2];
  const args = executableMatch[3]!.trim().split(/\s+/);
  return quickTunnelCommandMatches([executable!, ...args], port);
}

function parseWindowsProcessOutput(raw: string, port: number): QuickTunnelProcess[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null) return [];
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const matches: QuickTunnelProcess[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as { Name?: unknown; ProcessId?: unknown; CommandLine?: unknown };
    if (typeof record.Name !== "string") return undefined;
    if (record.Name.toLowerCase() !== "cloudflared.exe") continue;
    if (typeof record.ProcessId !== "number") return undefined;
    // A cloudflared process with no readable command line cannot be confirmed
    // as this Quick Tunnel, so refuse to continue rather than spawn another.
    if (record.CommandLine === null || record.CommandLine === undefined) return undefined;
    if (typeof record.CommandLine !== "string") return undefined;
    if (!isQuickTunnelCommandLine(record.CommandLine, port)) continue;
    if (Number.isInteger(record.ProcessId) && record.ProcessId > 0) {
      matches.push({ pid: record.ProcessId, commandLine: record.CommandLine });
    }
  }
  return matches;
}

function discoverWindowsQuickTunnels(port: number): QuickTunnelProcess[] | undefined {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUICK_TUNNEL_QUERY], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  return parseWindowsProcessOutput(String(result.stdout || "[]"), port);
}

function discoverProcQuickTunnels(port: number): QuickTunnelProcess[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const matches: QuickTunnelProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch (error) {
      // A process can disappear between readdir and read; other errors mean
      // discovery is incomplete and must not be followed by a spawn.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return undefined;
    }
    if (!raw) continue;
    const argv = raw.split("\0").filter((arg) => arg.length > 0);
    if (quickTunnelCommandMatches(argv, port)) {
      matches.push({ pid: Number(entry), commandLine: quickTunnelCommandLine(argv) });
    }
  }
  return matches;
}

function discoverPsQuickTunnels(port: number): QuickTunnelProcess[] | undefined {
  const result = spawnSync("ps", ["-wwaxo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
  });
  if (result.status !== 0 || result.error) return undefined;
  const matches: QuickTunnelProcess[] = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2]!;
    if (Number.isInteger(pid) && pid > 0 && isQuickTunnelCommandLine(commandLine, port)) {
      matches.push({ pid, commandLine });
    }
  }
  return matches;
}

/**
 * Discover exact Quick Tunnel processes. `undefined` means the process query
 * failed or was incomplete; callers must fail closed and never spawn then.
 */
export function discoverQuickTunnelProcesses(localPort: number): QuickTunnelProcess[] | undefined {
  if (quickTunnelDiscoveryOverride) return quickTunnelDiscoveryOverride(localPort);
  if (!isValidTunnelPort(localPort)) return undefined;
  return process.platform === "win32"
    ? discoverWindowsQuickTunnels(localPort)
    : process.platform === "darwin"
      ? discoverPsQuickTunnels(localPort)
      : discoverProcQuickTunnels(localPort);
}

/** Strict identity check used before adopting or stopping a Quick Tunnel PID. */
export function isQuickTunnelProcess(pid: number, localPort: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || !isValidTunnelPort(localPort)) return false;
  const processes = discoverQuickTunnelProcesses(localPort);
  if (!processes) return undefined;
  return processes.some((process) => process.pid === pid);
}

/**
 * SEC-RV-006: verify the process at `pid` matches `expectedName` before
 * killing it, so a stale PID file cannot point at an unrelated process that
 * was later reused. `expectedName` is a lowercase substring to match against
 * the process command line / image name (e.g. "cloudflared", "mcpx").
 *
 * - POSIX: read `/proc/<pid>/cmdline` and check it contains `expectedName`
 *   (case-insensitive). ENOENT or any read error → false (process gone or not
 *   ours).
 * - Windows: `tasklist /FI "PID eq <pid>"` and compare the image name column;
 *   match if it ends with `<expectedName>.exe`. If tasklist is unavailable or
 *   returns nothing parseable, fail closed and refuse the kill.
 */
export function isProcessOwnedBy(pid: number, expectedName: string): boolean {
  return processMatches(pid, expectedName);
}

function processMatches(pid: number, expectedName: string): boolean {
  const needle = expectedName.toLowerCase();
  try {
    if (process.platform !== "win32") {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // Exact argv[0] basename identity. A substring match over the whole
      // command line would also pass for unrelated processes (e.g. an editor
      // or pager holding ~/.mcpx/config.yaml) when a PID was reused.
      const argv0 = cmdline.split("\0").find((arg) => arg.length > 0) ?? "";
      const base = argv0.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
      return base === needle || base.startsWith(`${needle}-`) || base.startsWith(`${needle}_`);
    }
    // Windows: tasklist CSV, image name is the first column.
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const stdout = String(result.stdout || "");
    if (result.status !== 0 || !stdout.trim()) return false;

    const expected = `${needle}.exe`;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const first = (line.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (!first) continue;
      return first.endsWith(expected);
    }
    return false; // no parseable image name — fail closed

  } catch {
    return false; // POSIX /proc unreadable (ENOENT) — process gone or not ours
  }
}

const TERM_GRACE_MS = 2_000;
const TERM_POLL_MS = 100;

/**
 * POSIX kill with SIGKILL escalation: SIGTERM first, then poll until the
 * process is gone within the grace window, else SIGKILL. Without escalation a
 * process that ignores SIGTERM would survive its own PID-file cleanup as an
 * untracked orphan.
 */
export async function killProcessWithEscalation(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; } // ESRCH — already dead
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, TERM_POLL_MS));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
}

/** Kill a cloudflared tunnel process by PID (process tree on Windows). */
async function killTunnel(pid: number): Promise<void> {
  // SEC-RV-006: verify identity before killing so a reused PID cannot target an
  // unrelated process. On mismatch, just clean the stale PID file and return.
  if (pid && !processMatches(pid, "cloudflared")) {
    try { rmSync(MCPX_TUNNEL_PID_FILE(), { force: true }); } catch { /* best-effort */ }
    return;
  }
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      await killProcessWithEscalation(pid);
    }
  } catch {
    // already dead
  }
}

/** Stop a Cloudflare quick tunnel tracked by the PID file (best-effort). */
export async function stopQuickTunnel(): Promise<void> {
  let pid: number | undefined;
  try {
    const raw = readFileSync(MCPX_TUNNEL_PID_FILE(), "utf8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch { /* no PID file */ }
  if (pid) await killTunnel(pid);
  try { rmSync(MCPX_TUNNEL_PID_FILE(), { force: true }); } catch { /* best-effort */ }
}

/**
 * Restart the Cloudflare quick tunnel bound to 127.0.0.1:<port> and parse the
 * freshly generated trycloudflare.com URL. Every exact Quick Tunnel currently
 * bound to this port is stopped first, including processes with no PID file.
 */
export async function restartQuickTunnel(localPort: number, timeoutMs = 30_000): Promise<string> {
  if (!isValidTunnelPort(localPort)) throw new Error("无效的隧道端口（必须为 1-65535）");
  const binary = resolveCloudflared();
  if (!binary) throw new Error("未找到 cloudflared — 安装后重试");
  const existing = discoverQuickTunnelProcesses(localPort);
  if (!existing) throw new Error("无法确认现有 Quick Tunnel 进程，已停止启动以避免重复");
  const oldPids = new Set(existing.map((process) => process.pid));
  for (const process of existing) await killTunnel(process.pid);
  try {
    const pidFile = readFileSync(MCPX_TUNNEL_PID_FILE(), "utf8").trim();
    const pid = Number(pidFile);
    if (Number.isInteger(pid) && oldPids.has(pid)) rmSync(MCPX_TUNNEL_PID_FILE(), { force: true });
  } catch { /* no PID file */ }
  if (existing.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const remaining = discoverQuickTunnelProcesses(localPort);
    if (!remaining) throw new Error("无法确认 Quick Tunnel 已停止，已停止启动以避免重复");
    if (remaining.length > 0) throw new Error(`仍有 ${remaining.length} 个 Quick Tunnel 进程未停止，已停止启动`);
  }
  const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  // Redirect child output to a log file instead of pipes: the tunnel is meant
  // to outlive this process (detached + unref). Held pipes would kill it via
  // SIGPIPE/EPIPE once this process exits and would leak the unbounded capture
  // buffer; the child owns its inherited fd, so closing ours is safe.
  const logPath = `${MCPX_TUNNEL_PID_FILE()}.log`;
  let logFd: number | undefined;
  try { logFd = openSync(logPath, "w"); } catch { /* no capture — URL parse will time out */ }
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
    detached: !isShim,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    shell: isShim,
    windowsHide: true,
  });
  child.unref();
  try { writeFileSync(MCPX_TUNNEL_PID_FILE(), String(child.pid ?? ""), "utf8"); } catch { /* best-effort */ }
  const readLog = (): string => {
    if (logFd === undefined) return "";
    try { return readFileSync(logPath, "utf8"); } catch { return ""; }
  };
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const match = readLog().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) return match[0];
      // Any child exit without a URL match is a hard failure — a clean exit
      // (code 0) without a URL also means cloudflared is gone and the loop must
      // not keep polling for the full timeout.
      if (child.exitCode !== null) {
        throw new Error(`cloudflared 退出未取得 URL (exit=${child.exitCode}): ${readLog().slice(-400)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`cloudflared 启动超时未取得 URL: ${readLog().slice(-400)}`);
  } catch (error) {
    // Failure: kill the orphaned child and clean the PID file before throwing.
    try { child.kill(); } catch { /* already dead */ }
    try { rmSync(MCPX_TUNNEL_PID_FILE(), { force: true }); } catch { /* best-effort */ }
    throw error;
  } finally {
    if (logFd !== undefined) { try { closeSync(logFd); } catch { /* best-effort */ } }
  }
}

function replaceConfigAtomically(next: string): void {
  const path = MCPX_CONFIG_PATH();
  const temp = `${path}.mcpx-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best-effort */ }
  }
}

/** Restore a previously-read config snapshot after a failed tunnel transaction. */
export function restoreMcpxConfig(raw: string): void {
  if (!raw) throw new Error("config.yaml 快照为空");
  replaceConfigAtomically(raw);
}

/** Update auth.oauth.server_url in ~/.mcpx/config.yaml (in place, section-preserving). */
export function updateConfigServerURL(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("无效的隧道 URL: " + url); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("隧道 URL 必须是 http/https: " + url);
  const path = MCPX_CONFIG_PATH();
  const raw = readFileSync(path, "utf8");
  const pattern = /^(\s{2,}server_url:\s*).*/m;
  if (!pattern.test(raw)) throw new Error("config.yaml 无 server_url 字段");
  const next = raw.replace(pattern, (_match, prefix: string) => `${prefix}${parsed.href.replace(/\/$/, "")}`);
  replaceConfigAtomically(next);
}

/** Stop the mcpx process tracked by ~/.mcpx/mcpx-server.pid (best-effort). */
export async function stopMcpx(): Promise<void> {
  let pid: number | undefined;
  const pidFile = MCPX_PID_FILE();
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch { /* no pid file */ }
  if (!pid) return;
  // SEC-RV-006: verify identity before killing so a reused PID cannot target an
  // unrelated process. On mismatch, just clean the stale PID file and return.
  if (pid && !processMatches(pid, "mcpx")) {
    try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
    return;
  }
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      await killProcessWithEscalation(pid);
    }
  } catch { /* already dead */ }
  try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
}

