/** PID-reuse-safe tunnel process identity and ownership verification. */
import { createHash } from "node:crypto";
import { readFile, readlink, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type { GatewayTunnelProcessIdentity } from "./contracts.ts";

export interface GatewayTunnelProcessObservation {
  alive: boolean;
  executableRealpath?: string;
  processStartIdentity?: string;
  invocationDigest?: string;
}

export type GatewayTunnelProcessInspector = (pid: number) => Promise<GatewayTunnelProcessObservation>;

export interface GatewayTunnelOwnershipResult {
  owned: boolean;
  alive: boolean;
  reason?: "not_alive" | "generation_mismatch" | "executable_mismatch" | "invocation_mismatch" | "start_identity_mismatch" | "identity_unavailable";
  observed?: GatewayTunnelProcessObservation;
}

export class GatewayTunnelOwnershipError extends Error {
  readonly code = "tunnel_ownership_denied";
  constructor(readonly result: GatewayTunnelOwnershipResult) {
    super(`Refused tunnel process operation: ${result.reason ?? "ownership could not be verified"}`);
    this.name = "GatewayTunnelOwnershipError";
  }
}

export function gatewayTunnelInvocationDigest(executableRealpath: string, args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({ executableRealpath, args }), "utf8").digest("hex");
}

export async function canonicalTunnelExecutable(path: string): Promise<string> {
  const canonical = await realpath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export interface GatewayTunnelProcessOwnerOptions {
  inspect?: GatewayTunnelProcessInspector;
}

export class GatewayTunnelProcessOwner {
  private readonly inspectProcess: GatewayTunnelProcessInspector;
  constructor(options: GatewayTunnelProcessOwnerOptions = {}) {
    this.inspectProcess = options.inspect ?? inspectGatewayTunnelProcess;
  }

  inspect(pid: number): Promise<GatewayTunnelProcessObservation> { return this.inspectProcess(pid); }

  async verify(identity: GatewayTunnelProcessIdentity, expectedGeneration = identity.generation): Promise<GatewayTunnelOwnershipResult> {
    if (identity.generation !== expectedGeneration) return { owned: false, alive: false, reason: "generation_mismatch" };
    const observed = await this.inspectProcess(identity.pid);
    if (!observed.alive) return { owned: false, alive: false, reason: "not_alive", observed };
    if (!observed.executableRealpath || !observed.processStartIdentity || !observed.invocationDigest) {
      return { owned: false, alive: true, reason: "identity_unavailable", observed };
    }
    if (observed.executableRealpath !== identity.executableRealpath) return { owned: false, alive: true, reason: "executable_mismatch", observed };
    if (observed.invocationDigest !== identity.invocationDigest) return { owned: false, alive: true, reason: "invocation_mismatch", observed };
    if (observed.processStartIdentity !== identity.processStartIdentity) return { owned: false, alive: true, reason: "start_identity_mismatch", observed };
    return { owned: true, alive: true, observed };
  }

  async assertOwned(identity: GatewayTunnelProcessIdentity, expectedGeneration = identity.generation): Promise<void> {
    const result = await this.verify(identity, expectedGeneration);
    if (!result.owned) throw new GatewayTunnelOwnershipError(result);
  }
}

/** Best-effort platform inspection. Unsupported/ambiguous platforms fail closed. */
export async function inspectGatewayTunnelProcess(pid: number): Promise<GatewayTunnelProcessObservation> {
  if (!Number.isSafeInteger(pid) || pid < 1) return { alive: false };
  if (!processAlive(pid)) return { alive: false };
  if (process.platform === "linux") {
    try {
      const [link, cmdline, stat, bootId] = await Promise.all([
        readlink(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/cmdline`, "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "unknown-boot"),
      ]);
      const executableRealpath = await realpath(link);
      const argv = cmdline.split("\0").filter(Boolean);
      const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      const startTicks = afterName[19];
      if (!argv[0] || !startTicks) return { alive: true };
      return {
        alive: true,
        executableRealpath,
        processStartIdentity: `${bootId.trim()}:${startTicks}`,
        invocationDigest: gatewayTunnelInvocationDigest(executableRealpath, argv.slice(1)),
      };
    } catch {
      return processAlive(pid) ? { alive: true } : { alive: false };
    }
  }
  if (process.platform === "win32") {
    const escaped = String(pid);
    const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${escaped}\";if($p){$o=@{ExecutablePath=$p.ExecutablePath;CreationDate=$p.CreationDate;CommandLine=$p.CommandLine};$o|ConvertTo-Json -Compress}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(String(result.stdout)) as { ExecutablePath?: string; CreationDate?: string; CommandLine?: string };
        const executableRealpath = parsed.ExecutablePath?.toLowerCase();
        const argv = parsed.CommandLine ? parseWindowsCommandLine(parsed.CommandLine) : [];
        return {
          alive: true,
          ...(executableRealpath ? { executableRealpath } : {}),
          ...(parsed.CreationDate ? { processStartIdentity: parsed.CreationDate } : {}),
          ...(executableRealpath && argv.length > 0 ? { invocationDigest: gatewayTunnelInvocationDigest(executableRealpath, argv.slice(1)) } : {}),
        };
      } catch { /* fail closed below */ }
    }
  }
  return { alive: processAlive(pid) };
}

/** CommandLineToArgvW-compatible parsing for the simple external process boundary. */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let backslashes = 0;
  const flushSlashes = (): void => { current += "\\".repeat(backslashes); backslashes = 0; };
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    if (char === "\\") { backslashes += 1; continue; }
    if (char === '"') {
      current += "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) current += '"';
      else quoted = !quoted;
      backslashes = 0;
      continue;
    }
    flushSlashes();
    if (!quoted && /\s/u.test(char)) {
      if (current) { args.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  flushSlashes();
  if (current) args.push(current);
  return args;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
