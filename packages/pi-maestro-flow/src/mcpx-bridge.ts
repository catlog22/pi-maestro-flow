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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const bridgeDisabled = () => process.env.PI_MCPX_BRIDGE === "0";
const registeredPaths = new Set<string>();

export const LEASE_TTL_SECONDS = 300; // lease length; heartbeat renews every minute
const HEARTBEAT_MS = 60_000;

let leaseTimer: NodeJS.Timeout | undefined;
let leaseCwd: string | undefined;
let leaseGeneration = 0;

export function locateMcpx(): string | undefined {
  const configured = process.env.MCPX_BIN;
  if (configured && existsSync(configured)) return configured;
  // Default install location: ~/.mcpx/bin/mcpx(.exe) — the panel's s/x
  // controls and the startup bridge find it here without PATH changes.
  const homeBin = join(homedir(), ".mcpx", "bin", process.platform === "win32" ? "mcpx.exe" : "mcpx");
  if (existsSync(homeBin)) return homeBin;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["mcpx"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 10_000,
  });
  if (probe.status === 0) {
    const line = String(probe.stdout || "").split(/\r?\n/).find(Boolean);
    if (line) return line;
  }
  return undefined;
}

function absoluteRoot(root: string | undefined): string {
  const rawRoot = root ?? process.cwd();
  return isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(process.cwd(), rawRoot);
}

function runMcpx(args: string[]): { status: number | null; stderr: string } {
  const mcpx = locateMcpx();
  if (!mcpx) return { status: null, stderr: "mcpx binary not found" };
  const result = spawnSync(mcpx, args, {
    encoding: "utf8",
    timeout: 15_000,
    shell: process.platform === "win32", // npm shims are .cmd wrappers
  });
  return { status: result.status, stderr: String(result.stderr || result.stdout || "").trim() };
}

/**
 * Register `root` (defaults to process.cwd()) with the local MCPX runtime
 * under a lease. Fire-and-forget: never throws, never blocks startup.
 * Deduplicated per path so bursty callers only spawn one registration.
 */
export function ensureMcpxWorkspace(root?: string, ttlSeconds: number = LEASE_TTL_SECONDS): void {
  if (bridgeDisabled()) return;
  const absRoot = absoluteRoot(root);
  if (registeredPaths.has(absRoot)) return;
  registeredPaths.add(absRoot);
  renewWorkspaceLease(absRoot, ttlSeconds);
}

/**
 * Renew the lease for an already-registered root. This bypasses the
 * per-path dedupe set: the heartbeat must actually re-register so the
 * TTL is extended while the window stays alive.
 */
function renewWorkspaceLease(absRoot: string, ttlSeconds: number, generation?: number): void {
  setImmediate(() => {
    // A heartbeat renewal enqueued before stop() must not fire after stop.
    // generation is only supplied by the lease heartbeat; an explicit
    // ensureMcpxWorkspace call (no generation) always runs.
    if (generation !== undefined && generation !== leaseGeneration) return;
    try {
      const args = ttlSeconds > 0
        ? ["workspace", "register", "--ttl", `${ttlSeconds}s`, absRoot]
        : ["workspace", "register", absRoot];
      const { status, stderr } = runMcpx(args);
      if (status === 0) {
        console.log(`[pi-maestro-flow] MCPX workspace registered (lease ${ttlSeconds}s): ${absRoot}`);
      } else {
        console.warn(`[pi-maestro-flow] MCPX workspace registration failed (${status ?? "spawn error"}): ${stderr}`);
      }
    } catch (error) {
      console.warn(`[pi-maestro-flow] MCPX workspace registration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
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
 */
export function startWorkspaceLease(cwd: string, ttlSeconds: number = LEASE_TTL_SECONDS): void {
  stopWorkspaceLease();
  leaseCwd = cwd;
  leaseGeneration++;
  const generation = leaseGeneration;
  ensureMcpxWorkspace(cwd, ttlSeconds);
  leaseTimer = setInterval(() => renewWorkspaceLease(absoluteRoot(cwd), ttlSeconds, generation), HEARTBEAT_MS);
  leaseTimer.unref?.(); // never keep the process alive on shutdown
  console.log(`[pi-maestro-flow] MCPX workspace lease started (ttl ${ttlSeconds}s, heartbeat ${HEARTBEAT_MS / 1000}s): ${cwd}`);
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

/** Test hook: reset the in-process deduplication state. */
export function _resetMcpxBridgeState(): void {
  registeredPaths.clear();
  stopWorkspaceLease();
}

// --- Tunnel health & config detection (shared by overlay + wizard + extension) ---

const MCPX_TUNNEL_PID_FILE = () => join(homedir(), ".mcpx", "cloudflared.pid");
const MCPX_CONFIG_PATH = () => join(homedir(), ".mcpx", "config.yaml");

export type TunnelHealth = "ok" | "auth" | "dead" | "unknown";

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
      return result.status === 0 && String(result.stdout || "").includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
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
 *   timeout/refuse → "dead"  (tunnel broken or mcpx down)
 */
export async function probeTunnelHealth(url: string): Promise<TunnelHealth> {
  const endpoint = url.replace(/\/$/, "") + "/mcp";
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
    });
    if (response.status === 200) return "ok";
    if (response.status === 401) {
      // mcpx's wrapMCP always sets WWW-Authenticate with resource_metadata on 401
      // (http_gateway.go). A 401 without it is not mcpx's OAuth handshake start —
      // treat as dead (e.g. an upstream proxy's own 401, not the tunnel to mcpx).
      const wwwAuth = response.headers.get("WWW-Authenticate") ?? "";
      return wwwAuth.toLowerCase().includes("resource_metadata") ? "auth" : "dead";
    }
    return "dead";
  } catch {
    return "dead";
  }
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

// --- Quick tunnel restart + config sync (one-click URL refresh) ---

/** Resolve the cloudflared executable path (mirrors the wizard's logic). */
function resolveCloudflared(): string | undefined {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], {
    encoding: "utf8",
    timeout: 10_000,
    shell: process.platform === "win32",
  });
  if (probe.status === 0) {
    const line = String(probe.stdout || "").split(/\r?\n/).find(Boolean);
    if (line) return line.trim();
  }
  return undefined;
}

/** Kill a cloudflared tunnel process by PID (process tree on Windows). */
function killTunnel(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already dead
  }
}

/**
 * Restart the Cloudflare quick tunnel bound to 127.0.0.1:<port> and parse the
 * freshly generated trycloudflare.com URL. Stops any tunnel tracked by the PID
 * file first. Returns the new URL, or throws if cloudflared is missing / the
 * URL does not arrive within the timeout.
 */
export async function restartQuickTunnel(localPort: number, timeoutMs = 30_000): Promise<string> {
  const binary = resolveCloudflared();
  if (!binary) throw new Error("未找到 cloudflared — 安装后重试");
  // Stop any existing tunnel tracked by the PID file.
  let oldPid: number | undefined;
  try {
    const raw = readFileSync(MCPX_TUNNEL_PID_FILE(), "utf8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) oldPid = parsed;
  } catch { /* no pid file */ }
  if (oldPid) {
    killTunnel(oldPid);
    try { rmSync(MCPX_TUNNEL_PID_FILE(), { force: true }); } catch { /* best-effort */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], {
    detached: !isShim,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isShim,
    windowsHide: true,
  });
  child.unref();
  let output = "";
  const capture = (chunk: Buffer) => { output += chunk.toString(); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  try { writeFileSync(MCPX_TUNNEL_PID_FILE(), String(child.pid ?? ""), "utf8"); } catch { /* best-effort */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return match[0];
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`cloudflared 退出（代码 ${child.exitCode}）: ${output.slice(-400)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`cloudflared 启动超时未取得 URL: ${output.slice(-400)}`);
}

/** Update auth.oauth.server_url in ~/.mcpx/config.yaml (in place, section-preserving). */
export function updateConfigServerURL(url: string): void {
  const path = MCPX_CONFIG_PATH();
  const raw = readFileSync(path, "utf8");
  const pattern = /^(\s{2,}server_url:\s*).*/m;
  if (!pattern.test(raw)) throw new Error("config.yaml 无 server_url 字段");
  const next = raw.replace(pattern, `$1${url}`);
  writeFileSync(path, next, "utf8");
}

/** Stop the mcpx process tracked by ~/.mcpx/mcpx-server.pid (best-effort). */
export function stopMcpx(): void {
  let pid: number | undefined;
  try {
    const raw = readFileSync(join(homedir(), ".mcpx", "mcpx-server.pid"), "utf8").trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch { /* no pid file */ }
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch { /* already dead */ }
  try { rmSync(join(homedir(), ".mcpx", "mcpx-server.pid"), { force: true }); } catch { /* best-effort */ }
}

