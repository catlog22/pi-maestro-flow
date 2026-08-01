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

export const BASH_BG_UPDATE_EVENT = "bash-bg:update";
export const BASH_BG_QUERY_EVENT = "bash-bg:query";

export type BashBgJobStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface BashBgJobSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  status: BashBgJobStatus;
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
    { description: "run: block up to timeout then auto-background (recommended default); start: background immediately; status: snapshot; wait: block until done/timeout; kill: terminate; list: all jobs" },
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
  cachedSnapshot?: BashBgJobSnapshot;
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
    running: !job.done,
    exitCode: job.exitCode,
    command: job.command,
    ...(truncated ? { logPath: job.outFile, viewCommand: viewLogCommand(job) } : {}),
  };
}

function killTree(pid: number): void {
  if (pid <= 0) return;
  if (process.platform === "win32") {
    // spawnSync: async spawn of taskkill silently fails to complete under pi's jiti loader on Windows.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
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
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-bg-"));
  if (process.platform !== "win32") fs.chmodSync(baseDir, 0o700);
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
    const terminal = job.done;
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
    };
  };

  const waitForObservation = (id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot> => {
    const current = observationSnapshot(id, options.detail, options.lines);
    if (!current.found || current.phase === "settled") return Promise.resolve(current);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = observationWaiters.get(id) ?? new Set<() => void>();
      observationWaiters.set(id, waiters);
      const finish = (waitStatus?: "timeout" | "aborted"): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        waiters.delete(onDone);
        if (waiters.size === 0) observationWaiters.delete(id);
        resolve(observationSnapshot(id, options.detail, options.lines, waitStatus));
      };
      const onDone = () => finish();
      const onAbort = () => finish("aborted");
      waiters.add(onDone);
      options.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), Math.max(1, options.deadline - Date.now()));
    });
  };

  const bashObservationProvider: ObservationProvider = {
    kind: "bash_bg",
    capabilities: observationCapabilities,
    snapshot: (id, options) => observationSnapshot(id, options.detail, options.lines),
    wait: waitForObservation,
  };
  const disposeObservationProvider = registerObservationProvider(bashObservationProvider);

  let counter = 0;
  let disposed = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const pruneCompletedJobs = (): void => {
    const completed = [...jobs.values()]
      .filter((job) => job.done && job.outputFinalized)
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt));
    while (completed.length > maxRetainedCompletedJobs) {
      const evicted = completed.shift();
      if (!evicted) continue;
      jobs.delete(evicted.id);
      try { fs.rmSync(evicted.outFile, { force: true }); } catch { /* best effort for externally held log handles */ }
    }
  };

  const publishSnapshot = (): void => {
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
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(publishSnapshot, SNAPSHOT_THROTTLE_MS);
    snapshotTimer.unref?.();
  };

  const notifyComplete = (job: Job): void => {
    if (!job.background || job.completionNotified) return;
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

  const startJob = (command: string, workdir: string, background: boolean): Job => {
    if (disposed) throw new Error("bash_bg is unavailable after session shutdown.");
    const activeJobs = [...jobs.values()].filter((job) => !job.done).length;
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
    const job: Job = {
      id,
      command,
      cwd: workdir,
      pid: child.pid ?? -1,
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
    };
    jobs.set(id, job);
    publishSnapshot();
    const append = (d: Buffer): void => {
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
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let exitCode: number | null = null;
    const markDone = (code: number | null): void => {
      if (job.done) return;
      job.done = true;
      job.exitCode = code;
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      publishSnapshot();
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
    };
    const finalizeOutput = (): void => {
      if (job.outputFinalized) return;
      job.outputFinalized = true;
      if (job.outputDrainTimer) {
        clearTimeout(job.outputDrainTimer);
        job.outputDrainTimer = undefined;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      ws.end();
      notifyComplete(job);
      pruneCompletedJobs();
      publishSnapshot();
    };
    child.on("exit", (code) => {
      exitCode = code;
      // Process exit is the lifecycle boundary. Waiting indefinitely for close
      // misclassifies a finished shell as running when a descendant inherited
      // its stdout/stderr pipes.
      markDone(code);
      job.outputDrainTimer = setTimeout(finalizeOutput, OUTPUT_DRAIN_GRACE_MS);
      job.outputDrainTimer.unref?.();
    });
    // Prefer the natural close event when the pipes drain promptly.
    child.on("close", (code) => {
      markDone(code ?? exitCode);
      finalizeOutput();
    });
    child.on("error", (error) => {
      append(Buffer.from(`\n${error.message}\n`));
      markDone(exitCode ?? -1);
      finalizeOutput();
    });
    // Do not let the child keep pi's loop alive; close still fires while pi is interactive.
    child.unref();
    return job;
  };

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
        const deadline = Date.now() + windowMs;
        while (!job.done && Date.now() < deadline) {
          if (signal?.aborted) {
            job.background = true;
            throw new Error("aborted");
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (job.done) {
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
        if (!job.done) {
          job.stopRequested = true;
          job.updatedAt = Date.now();
          publishSnapshot();
          killTree(job.pid);
        }
        return {
          content: [{ type: "text", text: `${job.done ? "Job already finished" : "Stopping job"} ${job.id} (pid ${job.pid}).` }],
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
  const disposeQueryListener = pi.events.on(BASH_BG_QUERY_EVENT, publishSnapshot);

  // Re-announce running jobs after compaction: the in-memory registry survives in-process compaction, but the compacted summary may drop pending-job awareness.
  pi.on("session_compact", () => {
    const running = [...jobs.values()].filter((job) => !job.done);
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
  pi.on("session_shutdown", () => {
    if (disposed) return;
    disposed = true;
    if (typeof disposeQueryListener === "function") disposeQueryListener();
    if (typeof disposeObservationProvider === "function") disposeObservationProvider();
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
    }
    for (const job of jobs.values()) {
      job.background = false;
      if (job.done) continue;
      job.done = true; // suppress the kill-triggered 'close' notification
      job.stopRequested = true;
      job.exitCode = null;
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      killTree(job.pid);
      for (const settle of [...(observationWaiters.get(job.id) ?? [])]) settle();
    }
    publishSnapshot();
    jobs.clear();
    observationWaiters.clear();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* open Windows handles may finish after shutdown */ }
  });
}
