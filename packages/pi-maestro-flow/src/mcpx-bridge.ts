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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
