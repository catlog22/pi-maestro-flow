import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import {
  observeTargets,
  registerObservationProvider,
  type ObservationProvider,
  type ObservationSnapshot,
  type ObservationWaitOptions,
} from "pi-maestro-teammate/v1/observation";
import { toolCallLine, toolResultLine, resultFirstLine } from "../quiet-render.ts";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_TAIL_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 16;
const MAX_RETAINED_COMPLETED_JOBS = 64;
const MAX_SNAPSHOT_TAIL_LINES = 200;
const SNAPSHOT_THROTTLE_MS = 100;
const OUTPUT_DRAIN_GRACE_MS = 100;
const TERMINATION_GRACE_MS = 1_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const TERMINATION_POLL_MS = 25;

export const BASH_BG_UPDATE_EVENT = "bash-bg:update";
export const BASH_BG_QUERY_EVENT = "bash-bg:query";

export type BashBgJobStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface BashBgJobSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  status: BashBgJobStatus;
  /** False only while action=run still owns the foreground tool call. */
  background: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  outputTail: string;
  outputBytes: number;
  logPath: string;
}

export interface BashBgSnapshotPayload {
  jobs: BashBgJobSnapshot[];
}

export const BashBgParams = Type.Object({
  action: Type.Union(
    [Type.Literal("run"), Type.Literal("start"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
    { description: "run: block up to timeout then auto-background (recommended for uncertain-duration commands); start: background immediately; status: snapshot; wait: block until done/timeout; kill: terminate; list: all jobs" },
  ),
  command: Type.Optional(Type.String({ minLength: 1, description: "Shell command (required for run/start)" })),
  jobId: Type.Optional(Type.String({ description: "Job id returned by run/start (required for status/wait/kill)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for run/start (default: session cwd)" })),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "run: foreground seconds before auto-backgrounding; wait: max seconds to block (default 30)" })),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "output lines to include (default 20)" })),
});

export interface BashBgDetails {
  action: string;
  jobId?: string;
  pid?: number;
  running?: boolean;
  exitCode?: number | null;
  command?: string;
  logPath?: string;
  viewCommand?: string;
}

interface Job {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  child: ChildProcess;
  outFile: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  done: boolean;
  stopRequested: boolean;
  tail: string;
  tailTruncated: boolean;
  outputBytes: number;
  logBytes: number;
  logLimitBytes: number;
  logTruncated: boolean;
  background: boolean;
  completionNotified: boolean;
  outputFinalized: boolean;
  terminationInProgress: boolean;
  terminationFailure?: string;
  termination?: Promise<void>;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  cachedSnapshot?: BashBgJobSnapshot;
  releaseProcess?: () => void;
  finishTermination?: (error?: Error) => void;
  outputDrainTimer?: ReturnType<typeof setTimeout>;
}

interface TailOutput {
  text: string;
  truncated: boolean;
}

function tailOutput(job: Job, lines: number): TailOutput {
  let content = job.tail;
  if (!content) {
    try {
      content = fs.readFileSync(job.outFile, "utf8");
    } catch {
      return { text: "", truncated: false };
    }
  }
  content = content.replace(/\r?\n$/, "");
  if (!content) return { text: "", truncated: false };
  const allLines = content.split("\n");
  return {
    text: allLines.slice(-lines).join("\n"),
    truncated: job.tailTruncated || job.logTruncated || allLines.length > lines,
  };
}

function jobStatus(job: Job): BashBgJobStatus {
  if (job.terminationFailure) return "failed";
  if (job.terminationInProgress) return "stopping";
  if (!job.done) return job.stopRequested ? "stopping" : "running";
  if (job.stopRequested) return "killed";
  return job.exitCode === 0 ? "completed" : "failed";
}

function jobSnapshot(job: Job): BashBgJobSnapshot {
  if (job.outputFinalized && job.cachedSnapshot) return job.cachedSnapshot;
  const snapshot: BashBgJobSnapshot = {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    pid: job.pid,
    status: jobStatus(job),
    background: job.background,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    exitCode: job.exitCode,
    outputTail: tailOutput(job, MAX_SNAPSHOT_TAIL_LINES).text,
    outputBytes: job.outputBytes,
    logPath: job.outFile,
  };
  if (job.outputFinalized) job.cachedSnapshot = snapshot;
  return snapshot;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function viewLogCommand(job: Job): string {
  const file = shellQuote(job.outFile);
  if (process.platform === "win32") {
    return `Get-Content -LiteralPath ${file} -Tail 200${job.done ? "" : " -Wait"}`;
  }
  return `tail -n 200${job.done ? "" : " -f"} -- ${file}`;
}

function logAccess(job: Job): string {
  return [
    `log: ${job.outFile}`,
    ...(job.logTruncated ? [`log retention: truncated at ${job.logLimitBytes} bytes`] : []),
    `view: ${viewLogCommand(job)}`,
  ].join("\n");
}

function appendLogAccess(text: string, job: Job, truncated: boolean): string {
  return truncated ? `${text}\n${logAccess(job)}` : text;
}

function jobDetails(job: Job, action: string, truncated = false): BashBgDetails {
  return {
    action,
    jobId: job.id,
    pid: job.pid,
    running: jobIsActive(job),
    exitCode: job.exitCode,
    command: job.command,
    ...(truncated ? { logPath: job.outFile, viewCommand: viewLogCommand(job) } : {}),
  };
}

function signalProcessTree(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  if (pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when it has already left its process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function processGroupRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function jobOwnsLiveProcessGroup(job: Job): boolean {
  return process.platform !== "win32" && job.done && processGroupRunning(job.pid);
}

function jobIsActive(job: Job): boolean {
  return !job.done || job.terminationInProgress || jobOwnsLiveProcessGroup(job);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Background shell jobs with teammate-style async semantics: `start` returns a
 * jobId immediately, and completion injects a `bash-bg-complete` message with
 * triggerTurn so the agent wakes exactly like a background teammate notification.
 *
 * Output is captured via pipes (inherited-fd stdio breaks under pi's jiti loader).
 */
export interface RegisterBashBgOptions {
  maxActiveJobs?: number;
  maxRetainedCompletedJobs?: number;
  maxLogBytes?: number;
}

export function registerBashBg(pi: ExtensionAPI, options: RegisterBashBgOptions = {}): void {
  const maxActiveJobs = options.maxActiveJobs ?? MAX_ACTIVE_JOBS;
  const maxRetainedCompletedJobs = options.maxRetainedCompletedJobs ?? MAX_RETAINED_COMPLETED_JOBS;
  const maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
  let baseDir = "";
  const jobs = new Map<string, Job>();
  const observationWaiters = new Map<string, Set<() => void>>();
  const observationCapabilities = { inspect: true, wait: true, cancel: true } as const;

  const observationSnapshot = (
    id: string,
    detail: "summary" | "tail" | "full",
    lines: number,
    waitStatus?: "timeout" | "aborted",
  ): ObservationSnapshot => {
    const job = jobs.get(id);
    if (!job) {
      return {
        target: { kind: "bash_bg", id },
        found: false,
        nativeStatus: "not-found",
        phase: "unknown",
        outcome: "failure",
        waitStatus: "not-found",
        summary: `Unknown jobId: ${id}`,
        updatedAt: Date.now(),
        capabilities: observationCapabilities,
        error: `Unknown jobId: ${id}`,
      };
    }
    const status = jobStatus(job);
    const terminal = !jobIsActive(job);
    const output = tailOutput(job, lines).text;
    return {
      target: { kind: "bash_bg", id },
      found: true,
      nativeStatus: status,
      phase: terminal ? "settled" : "active",
      ...(terminal ? { outcome: status === "completed" ? "success" as const : "failure" as const } : {}),
      ...(terminal ? { waitStatus: status === "completed" ? "completed" as const : "failed" as const } : waitStatus ? { waitStatus } : {}),
      summary: `${job.command} (${status}${job.exitCode === null ? "" : `, exit ${job.exitCode}`})`,
      ...(detail === "summary" ? {} : { detail: [
        `command: ${job.command}`,
        `cwd: ${job.cwd}`,
        ...(output ? output.split("\n") : ["(empty)"]),
      ] }),
      updatedAt: job.updatedAt,
      capabilities: observationCapabilities,
      ...(job.terminationFailure ? { error: job.terminationFailure } : {}),
    };
  };

  const waitForObservation = (id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot> => {
    const current = observationSnapshot(id, options.detail, options.lines);
    if (!current.found || current.phase === "settled") return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ownershipPoll: ReturnType<typeof setInterval> | undefined;
      const waiters = observationWaiters.get(id) ?? new Set<() => void>();
      observationWaiters.set(id, waiters);
      const finish = (waitStatus?: "timeout" | "aborted"): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (ownershipPoll) clearInterval(ownershipPoll);
        options.signal.removeEventListener("abort", onAbort);
        waiters.delete(onDone);
        if (waiters.size === 0) observationWaiters.delete(id);
        resolve(observationSnapshot(id, options.detail, options.lines, waitStatus));
      };
      const onDone = () => {
        const snapshot = observationSnapshot(id, options.detail, options.lines);
        if (!snapshot.found || snapshot.phase === "settled") finish();
      };
      const onAbort = () => finish("aborted");
      waiters.add(onDone);
      options.signal.addEventListener("abort", onAbort, { once: true });
      ownershipPoll = setInterval(onDone, TERMINATION_POLL_MS);
      ownershipPoll.unref?.();
      timer = setTimeout(() => finish("timeout"), Math.max(1, options.deadline - Date.now()));
    });
  };

  const bashObservationProvider: ObservationProvider = {
    kind: "bash_bg",
    capabilities: observationCapabilities,
    snapshot: (id, options) => observationSnapshot(id, options.detail, options.lines),
    wait: waitForObservation,
  };
  let counter = 0;
  let runtimeGeneration = 0;
  let disposed = true;
  let disposeObservationProvider: (() => void) | undefined;
  let disposeQueryListener: (() => void) | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const pruneCompletedJobs = (): void => {
    const completed = [...jobs.values()]
      .filter((job) => job.done && job.outputFinalized && !jobIsActive(job))
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt));
    while (completed.length > maxRetainedCompletedJobs) {
      const evicted = completed.shift();
      if (!evicted) continue;
      jobs.delete(evicted.id);
      try { fs.rmSync(evicted.outFile, { force: true }); } catch { /* best effort for externally held log handles */ }
    }
  };

  const publishSnapshot = (): void => {
    if (disposed) return;
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    const payload: BashBgSnapshotPayload = {
      jobs: [...jobs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(jobSnapshot),
    };
    pi.events.emit(BASH_BG_UPDATE_EVENT, payload);
  };
  const publishSnapshotSoon = (): void => {
    if (disposed || snapshotTimer) return;
    snapshotTimer = setTimeout(publishSnapshot, SNAPSHOT_THROTTLE_MS);
    snapshotTimer.unref?.();
  };

  const initializeRuntime = (): void => {
    if (!disposed) return;
    runtimeGeneration += 1;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-bg-"));
    if (process.platform !== "win32") fs.chmodSync(baseDir, 0o700);
    disposed = false;
    disposeObservationProvider = registerObservationProvider(bashObservationProvider);
    const queryDisposer = pi.events.on(BASH_BG_QUERY_EVENT, publishSnapshot);
    disposeQueryListener = typeof queryDisposer === "function" ? queryDisposer : undefined;
  };

  const notifyComplete = (job: Job): void => {
    if (disposed || !job.background || job.completionNotified) return;
    job.completionNotified = true;
    const tail = tailOutput(job, 20);
    const status = jobStatus(job);
    const body = [
      `Background bash job ${job.id} ${status} (exit ${job.exitCode}).`,
      `command: ${job.command}`,
      tail.text ? `output (tail):\n${tail.text}` : "output: (empty)",
      ...(tail.truncated ? [logAccess(job)] : []),
    ].join("\n");
    pi.sendMessage(
      {
        customType: "bash-bg-complete",
        content: body,
        display: true,
        details: {
          jobId: job.id,
          exitCode: job.exitCode,
          ...(tail.truncated ? { logPath: job.outFile, viewCommand: viewLogCommand(job) } : {}),
        },
      },
      { triggerTurn: true },
    );
  };

  const waitForTerminationBoundary = async (job: Job, includeProcessGroup: boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (job.done && (!includeProcessGroup || !processGroupRunning(job.pid))) return true;
      await delay(Math.min(TERMINATION_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    return job.done && (!includeProcessGroup || !processGroupRunning(job.pid));
  };

  const terminateJob = (job: Job): Promise<void> => {
    if (job.termination) return job.termination;
    const includeProcessGroup = process.platform !== "win32";
    const boundaryReached = job.done && (!includeProcessGroup || !processGroupRunning(job.pid));
    if (boundaryReached) {
      if (job.stopRequested) job.finishTermination?.();
      return Promise.resolve();
    }

    job.stopRequested = true;
    job.terminationInProgress = true;
    job.terminationFailure = undefined;
    job.cachedSnapshot = undefined;
    job.updatedAt = Date.now();
    publishSnapshot();

    const termination = (async () => {
      let terminated = false;
      let taskkillTimedOut = false;
      if (process.platform === "win32") {
        // spawnSync: async spawn of taskkill silently fails to complete under pi's jiti loader on Windows.
        if (job.pid > 0) {
          const result = spawnSync("taskkill", ["/pid", String(job.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
            killSignal: "SIGKILL",
          });
          taskkillTimedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
        }
        terminated = await waitForTerminationBoundary(job, false, TERMINATION_GRACE_MS);
      } else {
        signalProcessTree(job.child, job.pid, "SIGTERM");
        terminated = await waitForTerminationBoundary(job, true, TERMINATION_GRACE_MS);
        if (!terminated) {
          signalProcessTree(job.child, job.pid, "SIGKILL");
          terminated = await waitForTerminationBoundary(job, true, TERMINATION_GRACE_MS);
        }
      }

      if (!terminated) {
        const boundary = includeProcessGroup ? `POSIX process group ${job.pid}` : `process ${job.pid}`;
        const timeout = taskkillTimedOut ? " (taskkill timed out)" : "";
        throw new Error(`Failed to terminate bash job ${job.id}: ${boundary} is still alive${timeout}.`);
      }
      job.finishTermination?.();
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      job.finishTermination?.(failure);
      throw failure;
    });
    job.termination = termination;
    void termination.then(
      () => { if (job.termination === termination) job.termination = undefined; },
      () => { if (job.termination === termination) job.termination = undefined; },
    );
    return termination;
  };

  const startJob = (command: string, workdir: string, background: boolean): Job => {
    if (disposed) throw new Error("bash_bg is unavailable outside an active session runtime.");
    const generation = runtimeGeneration;
    const activeJobs = [...jobs.values()].filter(jobIsActive).length;
    if (activeJobs >= maxActiveJobs) {
      throw new Error(`Too many active background jobs (${activeJobs}/${maxActiveJobs}). Wait for or stop an existing job.`);
    }
    const id = `bg-${(++counter).toString(36)}-${Date.now().toString(36)}`;
    const outFile = path.join(baseDir, `${id}.log`);
    const logFd = fs.openSync(outFile, "wx", 0o600);
    const ws = fs.createWriteStream(outFile, { fd: logFd, autoClose: true });
    const shellConfig = getShellConfig();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shellConfig.shell, [...shellConfig.args, command], {
        cwd: workdir,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      ws.destroy();
      fs.rmSync(outFile, { force: true });
      throw error;
    }
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const job: Job = {
      id,
      command,
      cwd: workdir,
      pid: child.pid ?? -1,
      child,
      outFile,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      exitCode: null,
      done: false,
      stopRequested: false,
      tail: "",
      tailTruncated: false,
      outputBytes: 0,
      logBytes: 0,
      logLimitBytes: maxLogBytes,
      logTruncated: false,
      background,
      completionNotified: false,
      outputFinalized: false,
      terminationInProgress: false,
      terminal,
      resolveTerminal,
    };
    jobs.set(id, job);
    publishSnapshot();
    const append = (d: Buffer): void => {
      if (disposed || generation !== runtimeGeneration) return;
      const remainingLogBytes = Math.max(0, maxLogBytes - job.logBytes);
      if (remainingLogBytes > 0) {
        const retained = d.byteLength <= remainingLogBytes ? d : d.subarray(0, remainingLogBytes);
        ws.write(retained);
        job.logBytes += retained.byteLength;
      }
      if (d.byteLength > remainingLogBytes) job.logTruncated = true;
      job.tail += d.toString("utf8");
      if (job.tail.length > MAX_TAIL_BYTES) {
        job.tail = job.tail.slice(-MAX_TAIL_BYTES);
        job.tailTruncated = true;
      }
      job.outputBytes += d.byteLength;
      job.updatedAt = Date.now();
      publishSnapshotSoon();
    };
    let exitCode: number | null = null;
    let processReleased = false;
    let onExit: (code: number | null) => void;
    let onClose: (code: number | null) => void;
    let onError: (error: Error) => void;
    const releaseProcess = (): void => {
      if (processReleased) return;
      processReleased = true;
      child.stdout?.off("data", append);
      child.stderr?.off("data", append);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      child.stdout?.destroy();
      child.stderr?.destroy();
      ws.end();
      job.releaseProcess = undefined;
    };
    job.releaseProcess = releaseProcess;
    const markDone = (code: number | null): void => {
      if (job.done) return;
      job.done = true;
      job.exitCode = code;
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      job.resolveTerminal();
      if (disposed || generation !== runtimeGeneration) return;
      publishSnapshot();
      if (!job.terminationInProgress) {
        for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
      }
    };
    const finalizeOutput = (): void => {
      if (job.outputFinalized) return;
      job.outputFinalized = true;
      if (job.outputDrainTimer) {
        clearTimeout(job.outputDrainTimer);
        job.outputDrainTimer = undefined;
      }
      releaseProcess();
      if (disposed || generation !== runtimeGeneration) return;
      notifyComplete(job);
      pruneCompletedJobs();
      publishSnapshot();
    };
    job.finishTermination = (error) => {
      job.cachedSnapshot = undefined;
      job.updatedAt = Date.now();
      if (error) {
        job.terminationInProgress = false;
        job.terminationFailure = error.message;
        job.finishedAt ??= job.updatedAt;
        publishSnapshot();
        for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
        return;
      }
      job.terminationInProgress = false;
      job.terminationFailure = undefined;
      const outputWasFinalized = job.outputFinalized;
      markDone(job.exitCode);
      finalizeOutput();
      if (outputWasFinalized && !disposed && generation === runtimeGeneration) publishSnapshot();
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
    };
    onExit = (code) => {
      exitCode = code;
      // Process exit is the lifecycle boundary. Waiting indefinitely for close
      // misclassifies a finished shell as running when a descendant inherited
      // its stdout/stderr pipes.
      markDone(code);
      if (job.terminationInProgress) return;
      if (disposed || generation !== runtimeGeneration) {
        finalizeOutput();
        return;
      }
      job.outputDrainTimer = setTimeout(finalizeOutput, OUTPUT_DRAIN_GRACE_MS);
      job.outputDrainTimer.unref?.();
    };
    onClose = (code) => {
      markDone(code ?? exitCode);
      if (!job.terminationInProgress) finalizeOutput();
    };
    onError = (error) => {
      append(Buffer.from(`\n${error.message}\n`));
      markDone(exitCode ?? -1);
      if (!job.terminationInProgress) finalizeOutput();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);
    // Do not let the child keep pi's loop alive; close still fires while pi is interactive.
    child.unref();
    return job;
  };

  const waitForRunBoundary = (
    job: Job,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<"completed" | "timeout" | "aborted"> => {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (job.done) return Promise.resolve("completed");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: "completed" | "timeout" | "aborted"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      void job.terminal.then(() => finish("completed"));
    });
  };

  initializeRuntime();
  pi.on("session_start", initializeRuntime);

  pi.registerTool({
    name: "bash_bg",
    label: "Background Bash",
    description:
      "Run shell commands with adaptive foreground/background execution and job control. " +
      "action=run (recommended) blocks like the bash tool for up to timeout seconds and returns the output inline if the command finishes in time; if it is still running, it automatically moves to the background and returns a jobId, with a bash-bg-complete notification (a new turn) on completion. " +
      "action=start backgrounds immediately (ack now). action=status returns a live snapshot + output tail; action=wait blocks an existing job until done or timeout; action=kill terminates the job's process tree; action=list shows all jobs. " +
      "Example: { action: \"run\", command: \"npm run build\", timeout: 60 }.",
    promptSnippet: "Run shell commands adaptively: action=run blocks like bash then auto-backgrounds on timeout; start/status/wait/kill/list for job control, with a completion notification that triggers a new turn.",
    promptGuidelines: [
      "Default to the bash tool for ordinary commands — blocking for tens of seconds is fine. Reach for bash_bg when a command is unbounded (dev server, watcher, tail -f), expected to run for minutes, or you want to keep working concurrently.",
      "When unsure how long a command will take, use bash_bg action=run: it blocks like bash for up to timeout seconds and returns output inline if fast, otherwise auto-backgrounds and notifies you (bash-bg-complete, a new turn) when done — no up-front guess required.",
      "Use action=start to background immediately without blocking. After a job backgrounds, do not poll; wait for the notification or call action=wait once. action=status peeks at output and action=kill stops a job.",
    ],
    parameters: BashBgParams,
    async execute(_id, params, signal): Promise<AgentToolResult<BashBgDetails>> {
      const tailCount = params.tail ?? 20;

      if (params.action === "start") {
        if (!params.command) throw new Error("bash_bg start requires 'command'.");
        const job = startJob(params.command, params.cwd || process.cwd(), true);
        return {
          content: [{
            type: "text",
            text:
              `Started background job ${job.id} (pid ${job.pid}).\ncommand: ${job.command}\n` +
              `You will receive a bash-bg-complete notification when it finishes. ` +
              `Use bash_bg action=status jobId=${job.id} to peek, or action=wait to block.`,
          }],
          details: jobDetails(job, "start"),
        };
      }

      if (params.action === "run") {
        if (!params.command) throw new Error("bash_bg run requires 'command'.");
        const job = startJob(params.command, params.cwd || process.cwd(), false);
        const windowMs = (params.timeout ?? 30) * 1000;
        const outcome = await waitForRunBoundary(job, windowMs, signal);
        if (outcome === "aborted") {
          job.background = false;
          await terminateJob(job);
          throw new Error("aborted");
        }
        if (outcome === "completed" || job.done) {
          const out = tailOutput(job, params.tail ?? 200);
          return {
            content: [{
              type: "text",
              text: appendLogAccess(`${out.text || "(no output)"}\n(exit ${job.exitCode})`, job, out.truncated),
            }],
            details: jobDetails(job, "run", out.truncated),
          };
        }
        job.background = true;
        job.updatedAt = Date.now();
        job.cachedSnapshot = undefined;
        publishSnapshot();
        return {
          content: [{
            type: "text",
            text:
              `Still running after ${Math.round(windowMs / 1000)}s — moved to background as job ${job.id} (pid ${job.pid}).\ncommand: ${job.command}\n` +
              `You will receive a bash-bg-complete notification when it finishes. ` +
              `Use bash_bg action=status jobId=${job.id} to peek, or action=wait to block.`,
          }],
          details: jobDetails(job, "run"),
        };
      }

      if (params.action === "list") {
        if (jobs.size === 0) return { content: [{ type: "text", text: "No background jobs." }], details: { action: "list" } };
        const lines = [...jobs.values()].map(
          (j) => `${j.id}\t${jobStatus(j)}${j.done ? `(exit ${j.exitCode})` : ""}\tpid ${j.pid}\t${j.command}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "list" } };
      }

      if (!params.jobId) throw new Error(`bash_bg ${params.action} requires 'jobId'.`);
      const job = jobs.get(params.jobId);
      if (!job) throw new Error(`Unknown jobId: ${params.jobId}`);

      if (params.action === "status") {
        await observeTargets({
          action: "status",
          targets: [{ kind: "bash_bg", id: job.id }],
          detail: "full",
          lines: tailCount,
        }, signal);
        const state = job.done ? `${jobStatus(job)} (exit ${job.exitCode})` : jobStatus(job);
        const out = tailOutput(job, tailCount);
        const text = `job ${job.id}: ${state}\ncommand: ${job.command}\noutput (tail):\n${out.text || "(empty)"}`;
        return {
          content: [{ type: "text", text: appendLogAccess(text, job, out.truncated) }],
          details: jobDetails(job, "status", out.truncated),
        };
      }

      if (params.action === "kill") {
        const alreadyFinished = job.done
          && !job.terminationFailure
          && (process.platform === "win32" || !processGroupRunning(job.pid));
        await terminateJob(job);
        return {
          content: [{ type: "text", text: `${alreadyFinished ? "Job already finished" : job.done ? "Stopped job" : "Stopping job"} ${job.id} (pid ${job.pid}).` }],
          details: jobDetails(job, "kill"),
        };
      }

      const timeoutMs = (params.timeout ?? 30) * 1000;
      const observed = await observeTargets({
        action: "wait",
        targets: [{ kind: "bash_bg", id: job.id }],
        detail: "full",
        lines: tailCount,
        timeoutMs,
      }, signal);
      if (observed.reason === "aborted") throw new Error("aborted");
      const state = job.done
        ? `${jobStatus(job)} (exit ${job.exitCode})`
        : `${jobStatus(job)} after ${Math.round(timeoutMs / 1000)}s`;
      const out = tailOutput(job, tailCount);
      const text = `job ${job.id}: ${state}\ncommand: ${job.command}\noutput (tail):\n${out.text || "(empty)"}`;
      return {
        content: [{ type: "text", text: appendLogAccess(text, job, out.truncated) }],
        details: jobDetails(job, "wait", out.truncated),
      };
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "start");
      const target = (args.action === "start" || args.action === "run") ? String(args.command ?? "").slice(0, 50) : String(args.jobId ?? "");
      return toolCallLine(theme, "bash_bg", target ? `${action} ${target}` : action);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as BashBgDetails | undefined;
      const isError = (result as { isError?: boolean }).isError === true;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const running = details?.running === true;
      const mark = running
        ? theme.fg("warning", "•")
        : (!isError && (details?.exitCode ?? 0) === 0
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗"));
      return toolResultLine(theme, {
        name: "bash_bg",
        mark,
        summary: resultFirstLine(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });

  // Cockpit can subscribe after this tool is registered, then request the
  // authoritative in-memory snapshot without importing Flow internals.

  // Re-announce running jobs after compaction: the in-memory registry survives in-process compaction, but the compacted summary may drop pending-job awareness.
  pi.on("session_compact", () => {
    const running = [...jobs.values()].filter(jobIsActive);
    if (running.length === 0) return;
    const lines = running.map((job) => `- ${job.id} (pid ${job.pid}): ${job.command}`);
    const body = [
      `${running.length} background bash job${running.length === 1 ? " is" : "s are"} still running after compaction:`,
      ...lines,
      "Each sends a bash-bg-complete notification when finished. Use bash_bg action=status jobId=<id> to peek or action=kill jobId=<id> to stop one.",
    ].join("\n");
    pi.sendMessage(
      { customType: "bash-bg-running", content: body, display: true, details: { jobs: running.map((job) => job.id) } },
      { deliverAs: "nextTurn" },
    );
  });

  // Session end terminates background jobs (no orphans); completed results already persist as session messages, so resume keeps their history and output.
  pi.on("session_shutdown", async () => {
    if (disposed) return;
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    const retiringBaseDir = baseDir;
    const retiringJobs = [...jobs.values()];
    for (const job of retiringJobs) job.background = false;
    await Promise.all(retiringJobs.map((job) => terminateJob(job)));

    for (const job of retiringJobs) {
      if (job.outputDrainTimer) {
        clearTimeout(job.outputDrainTimer);
        job.outputDrainTimer = undefined;
      }
      job.releaseProcess?.();
      job.releaseProcess = undefined;
      job.finishTermination = undefined;
      job.outputFinalized = true;
      job.cachedSnapshot = undefined;
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
    }
    publishSnapshot();

    disposed = true;
    runtimeGeneration += 1;
    if (typeof disposeQueryListener === "function") disposeQueryListener();
    if (typeof disposeObservationProvider === "function") disposeObservationProvider();
    disposeQueryListener = undefined;
    disposeObservationProvider = undefined;
    jobs.clear();
    observationWaiters.clear();
    baseDir = "";
    try { fs.rmSync(retiringBaseDir, { recursive: true, force: true }); } catch { /* open Windows handles may finish after shutdown */ }
  });
}
