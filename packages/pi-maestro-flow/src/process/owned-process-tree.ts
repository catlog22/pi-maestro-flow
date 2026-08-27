import { spawnSync, type ChildProcess } from "node:child_process";

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
// A Win32_Process CIM snapshot can take several seconds on a busy host, and
// verified cleanup requires at least one discovery pass plus one recheck.
const DEFAULT_WINDOWS_CLEANUP_TIMEOUT_MS = 20_000;
const WINDOWS_CLEANUP_POLL_MS = 25;

export interface ReclaimOwnedProcessTreeOptions {
  label?: string;
  terminationGraceMs?: number;
  windowsCleanupTimeoutMs?: number;
}

/**
 * Reclaim a short-lived command and every descendant before its owner settles.
 *
 * Callers must spawn the command as a separate process group on POSIX
 * (`detached: true`). Windows has no equivalent Node API, so cleanup uses a
 * bounded PowerShell/CIM walk which retains discovered parent PIDs, force-stops
 * the complete tree, and re-queries until no target remains. Any unavailable,
 * timed-out, or unverified Windows cleanup fails closed.
 */
export async function reclaimOwnedProcessTree(
  child: ChildProcess,
  options: ReclaimOwnedProcessTreeOptions = {},
): Promise<void> {
  const pid = child.pid;
  const label = options.label ?? "owned process";
  const graceMs = positiveInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );
  if (!pid) {
    if (!isChildRunning(child)) return;
    await terminateDirectChild(child, graceMs, label);
    throw new Error(`${label} process-tree cleanup is unconfirmed because the child PID was unavailable`);
  }

  if (process.platform === "win32") {
    reclaimWindowsTree(pid, label, positiveInteger(
      options.windowsCleanupTimeoutMs ?? DEFAULT_WINDOWS_CLEANUP_TIMEOUT_MS,
      "windowsCleanupTimeoutMs",
    ));
    if (isChildRunning(child) && !await waitForChildExit(child, graceMs)) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await waitForChildExit(child, graceMs);
    }
    if (isChildRunning(child)) throw new Error(`${label} ${pid} survived verified Windows cleanup`);
    return;
  }

  if (!isChildRunning(child) && !isPosixProcessGroupRunning(pid)) return;
  signalPosixProcessGroup(child, "SIGTERM");
  if (await waitForPosixTreeExit(child, pid, graceMs)) return;
  signalPosixProcessGroup(child, "SIGKILL");
  if (!await waitForPosixTreeExit(child, pid, graceMs)) {
    throw new Error(`${label} process group ${pid} survived SIGKILL`);
  }
}

function reclaimWindowsTree(pid: number, label: string, timeoutMs: number): void {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", windowsCleanupScript(pid, Math.max(1, timeoutMs - 250)),
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const detail = code === "ETIMEDOUT" ? `timed out after ${timeoutMs}ms` : result.error.message;
    throw new Error(`${label} ${pid} Windows descendant cleanup is unconfirmed: ${detail}`);
  }
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || `exit ${String(result.status)}`).trim();
    throw new Error(`${label} ${pid} Windows descendant cleanup is unconfirmed: ${diagnostic}`);
  }
}

function windowsCleanupScript(rootPid: number, cleanupMs: number): string {
  // Keep every discovered PID in $known. If an intermediate process exits
  // while cleanup is running, its children still remain reachable through the
  // retained parent PID on the next CIM snapshot.
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = [uint32]${rootPid}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${cleanupMs})`,
    "$known = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "[void]$known.Add($rootPid)",
    "do {",
    "  $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    "  do {",
    "    $changed = $false",
    "    foreach ($process in $processes) {",
    "      $parentPid = [uint32]$process.ParentProcessId",
    "      $processPid = [uint32]$process.ProcessId",
    "      if ($known.Contains($parentPid) -and $known.Add($processPid)) { $changed = $true }",
    "    }",
    "  } while ($changed)",
    "  $live = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "  foreach ($process in $processes) { [void]$live.Add([uint32]$process.ProcessId) }",
    "  $targets = @($known | Where-Object { $live.Contains([uint32]$_) })",
    "  if ($targets.Count -eq 0) { exit 0 }",
    "  foreach ($targetPid in ($targets | Sort-Object -Descending -Unique)) {",
    "    Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue",
    "  }",
    `  Start-Sleep -Milliseconds ${WINDOWS_CLEANUP_POLL_MS}`,
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    "do {",
    "  $changed = $false",
    "  foreach ($process in $processes) {",
    "    $parentPid = [uint32]$process.ParentProcessId",
    "    $processPid = [uint32]$process.ProcessId",
    "    if ($known.Contains($parentPid) -and $known.Add($processPid)) { $changed = $true }",
    "  }",
    "} while ($changed)",
    "$live = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "foreach ($process in $processes) { [void]$live.Add([uint32]$process.ProcessId) }",
    "$remaining = @($known | Where-Object { $live.Contains([uint32]$_) })",
    "if ($remaining.Count -eq 0) { exit 0 }",
    "[Console]::Error.Write('remaining PIDs: ' + (($remaining | Sort-Object -Unique) -join ','))",
    "exit 4",
  ].join("; ");
}

async function terminateDirectChild(child: ChildProcess, graceMs: number, label: string): Promise<void> {
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
  if (await waitForChildExit(child, graceMs)) return;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  if (!await waitForChildExit(child, graceMs) && isChildRunning(child)) {
    throw new Error(`${label} direct child survived SIGKILL`);
  }
}

function signalPosixProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* fall back to the direct child */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

async function waitForPosixTreeExit(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isChildRunning(child) || isPosixProcessGroupRunning(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const settle = (exited: boolean): void => {
      cleanup();
      resolve(exited);
    };
    const onExit = (): void => settle(true);
    const onError = (): void => settle(false);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
