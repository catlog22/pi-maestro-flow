/**
 * MCPX workspace auto-registration bridge.
 *
 * On pi startup, registers the current project root with the local MCPX
 * runtime (`mcpx workspace register <path>`, idempotent) so remote MCP
 * clients can immediately bind sessions to the project. Registration writes
 * the global MCPX config, so it must run before the MCPX runtime starts or
 * before its next restart (the workspace registry is loaded at startup).
 *
 * Opt out with PI_MCPX_BRIDGE=0. Override the binary with MCPX_BIN.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const bridgeDisabled = () => process.env.PI_MCPX_BRIDGE === "0";
const registeredPaths = new Set<string>();

export function locateMcpx(): string | undefined {
  const configured = process.env.MCPX_BIN;
  if (configured && existsSync(configured)) return configured;
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

/**
 * Register `root` (defaults to process.cwd()) with the local MCPX runtime.
 * Fire-and-forget: never throws, never blocks startup.
 */
export function ensureMcpxWorkspace(root?: string): void {
  if (bridgeDisabled()) return;
  const rawRoot = root ?? process.cwd();
  const absRoot = isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(process.cwd(), rawRoot);
  if (registeredPaths.has(absRoot)) return;
  registeredPaths.add(absRoot);

  setImmediate(() => {
    try {
      const mcpx = locateMcpx();
      if (!mcpx) return; // MCPX not installed — nothing to register with.
      const result = spawnSync(mcpx, ["workspace", "register", absRoot], {
        encoding: "utf8",
        timeout: 15_000,
        shell: process.platform === "win32", // npm shims are .cmd wrappers
      });
      if (result.status === 0) {
        console.log(`[pi-maestro-flow] MCPX workspace registered: ${absRoot}`);
      } else {
        const detail = String(result.stderr || result.stdout || "").trim();
        console.warn(`[pi-maestro-flow] MCPX workspace registration failed (${result.status ?? "spawn error"}): ${detail}`);
      }
    } catch (error) {
      console.warn(`[pi-maestro-flow] MCPX workspace registration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Test hook: reset the in-process deduplication state. */
export function _resetMcpxBridgeState(): void {
  registeredPaths.clear();
}
