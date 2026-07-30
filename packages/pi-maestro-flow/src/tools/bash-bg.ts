import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { singleLine, textBlock } from "../tui/components.ts";
import { isQuietMode } from "../quiet-state.ts";
import { quietToolCall, quietToolLine, resultFirstLine } from "../quiet-render.ts";
import { Type } from "typebox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_TAIL_BYTES = 64 * 1024;
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
  child: ChildProcess;
  tail: string;
  tailTruncated: boolean;
  outputBytes: number;
  background: boolean;
  completionNotified: boolean;
  outputFinalized: boolean;
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
    truncated: job.tailTruncated || allLines.length > lines,
  };
}

function jobStatus(job: Job): BashBgJobStatus {
  if (!job.done) return job.stopRequested ? "stopping" : "running";
  if (job.stopRequested) return "killed";
  return job.exitCode === 0 ? "completed" : "failed";
}

function jobSnapshot(job: Job): BashBgJobSnapshot {
  return {
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
  return `log: ${job.outFile}\nview: ${viewLogCommand(job)}`;
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
export function registerBashBg(pi: ExtensionAPI): void {
  const baseDir = path.join(os.tmpdir(), "pi-bash-bg");
  const jobs = new Map<string, Job>();
  let counter = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  fs.mkdirSync(baseDir, { recursive: true });

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
    const id = `bg-${(++counter).toString(36)}-${Date.now().toString(36)}`;
    const outFile = path.join(baseDir, `${id}.log`);
    const shellConfig = getShellConfig();
    const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
      cwd: workdir,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
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
      child,
      tail: "",
      tailTruncated: false,
      outputBytes: 0,
      background,
      completionNotified: false,
      outputFinalized: false,
    };
    jobs.set(id, job);
    publishSnapshot();
    const ws = fs.createWriteStream(outFile);
    const append = (d: Buffer): void => {
      ws.write(d);
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
      publishSnapshot();
      notifyComplete(job);
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
      const deadline = Date.now() + timeoutMs;
      while (!job.done && Date.now() < deadline) {
        if (signal?.aborted) throw new Error("aborted");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
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
    renderCall(args, theme) {
      if (isQuietMode()) {
        const qaction = String(args.action ?? "start");
        const qtarget = (args.action === "start" || args.action === "run") ? String(args.command ?? "").slice(0, 50) : String(args.jobId ?? "");
        return quietToolCall(theme, "bash_bg", qtarget ? `${qaction} ${qtarget}` : qaction);
      }
      const action = String(args.action ?? "start");
      const target = (args.action === "start" || args.action === "run") ? String(args.command ?? "").slice(0, 50) : String(args.jobId ?? "");
      return singleLine(`${theme.fg("toolTitle", theme.bold("bash_bg "))}${action}${target ? ` ${theme.fg("accent", target)}` : ""}`);
    },
    renderResult(result, opts, theme) {
      const details = result.details as BashBgDetails | undefined;
      const isError = (result as { isError?: boolean }).isError === true;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (isQuietMode()) {
        const running = details?.running === true;
        const ok = !isError && !running && (details?.exitCode ?? 0) === 0;
        const glyph = running
          ? theme.fg("warning", "•")
          : ok
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
        return quietToolLine(glyph, theme, "bash_bg", resultFirstLine(result));
      }
      if (opts.expanded) return textBlock(text);
      if (isError) return singleLine(theme.fg("error", `✗ ${text.split("\n")[0]?.slice(0, 120) ?? "bash_bg failed"}`));
      const icon = details?.running === false ? theme.fg("success", "✓") : theme.fg("warning", "•");
      return singleLine(`${icon} ${theme.fg("muted", text.split("\n")[0] ?? "")}`);
    },
  });

  // Cockpit can subscribe after this tool is registered, then request the
  // authoritative in-memory snapshot without importing Flow internals.
  pi.events.on(BASH_BG_QUERY_EVENT, publishSnapshot);

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
    }
  });
}
