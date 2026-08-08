import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { FlowToolResult } from "./tool-result.ts";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_RUNS = 10;
const MAX_RUNS = 1_000;
const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60_000;
const MAX_SHELL_TIMEOUT_MS = 60 * 60_000;
const MAX_LOOPS = 32;
const OUTPUT_LIMIT = 1_000;

const LOOP_BASE_DIR = path.join(os.tmpdir(), "pi-loops");
const REGISTRY_PATH = path.join(LOOP_BASE_DIR, "registry.json");

function loopLogDir(loopId: string): string {
  return path.join(LOOP_BASE_DIR, loopId);
}

interface RegistryEntry {
  id: string;
  task: string;
  intervalMs: number;
  maxRuns: number;
  runCount: number;
  cwd: string;
  pid: number;
  startedAt: number;
}

function readRegistry(): RegistryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  fs.mkdirSync(LOOP_BASE_DIR, { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const LOOP_UPDATE_EVENT = "loop:update";
export const LOOP_QUERY_EVENT = "loop:query";

export type LoopKind = "prompt" | "shell";
export type LoopStatus = "scheduled" | "running" | "completed" | "failed" | "cancelled";

export interface LoopRunResult {
  ok: boolean;
  summary: string;
}

export interface LoopJobSnapshot {
  id: string;
  kind: LoopKind;
  task: string;
  intervalMs: number;
  maxRuns: number;
  runCount: number;
  status: LoopStatus;
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: string;
  cwd?: string;
  timeoutMs?: number;
  logDir?: string;
}

interface LoopJob extends LoopJobSnapshot {
  timer?: ReturnType<typeof setTimeout>;
}

export interface CreateLoopInput {
  kind: LoopKind;
  task: string;
  intervalMs: number;
  maxRuns?: number;
  cwd?: string;
  timeoutMs?: number;
}

export interface LoopSchedulerOptions {
  execute(job: LoopJobSnapshot): Promise<LoopRunResult>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Called after every state change (create, cancel, run completion). */
  onUpdate?: (jobs: LoopJobSnapshot[]) => void;
}

export class LoopScheduler {
  private readonly jobs = new Map<string, LoopJob>();
  private readonly executeJob: LoopSchedulerOptions["execute"];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LoopSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LoopSchedulerOptions["clearTimer"]>;
  private readonly onUpdate?: LoopSchedulerOptions["onUpdate"];
  private counter = 0;

  constructor(options: LoopSchedulerOptions) {
    this.executeJob = options.execute;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onUpdate = options.onUpdate;
  }

  create(input: CreateLoopInput): LoopJobSnapshot {
    if (!input.task.trim()) throw new Error("task is required.");
    if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS || input.intervalMs > MAX_INTERVAL_MS) {
      throw new Error(`intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}.`);
    }
    const maxRuns = input.maxRuns ?? DEFAULT_MAX_RUNS;
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS) {
      throw new Error(`maxRuns must be an integer between 1 and ${MAX_RUNS}.`);
    }
    const timeoutMs = input.kind === "shell" ? (input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_SHELL_TIMEOUT_MS)) {
      throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_SHELL_TIMEOUT_MS}.`);
    }
    const activeCount = [...this.jobs.values()].filter((job) => job.status === "scheduled" || job.status === "running").length;
    if (activeCount >= MAX_LOOPS) throw new Error(`At most ${MAX_LOOPS} loops may be active.`);

    const createdAt = this.now();
    const job: LoopJob = {
      id: `loop-${(++this.counter).toString(36)}-${createdAt.toString(36)}`,
      kind: input.kind,
      task: input.task.trim(),
      intervalMs: input.intervalMs,
      maxRuns,
      runCount: 0,
      status: "scheduled",
      createdAt,
      cwd: input.cwd,
      timeoutMs,
      logDir: input.kind === "shell" ? loopLogDir(`loop-${this.counter.toString(36)}-${createdAt.toString(36)}`) : undefined,
    };
    this.jobs.set(job.id, job);
    this.schedule(job);
    this.emitUpdate();
    return this.snapshot(job);
  }

  list(): LoopJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => this.snapshot(job));
  }

  cancel(id: string): LoopJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.timer !== undefined) {
      this.clearTimer(job.timer);
      job.timer = undefined;
    }
    if (job.status === "scheduled" || job.status === "running") {
      job.status = "cancelled";
      job.nextRunAt = undefined;
    }
    this.emitUpdate();
    return this.snapshot(job);
  }

  /**
   * Restore a job from a persisted snapshot, preserving runCount and id.
   * The job is rescheduled immediately if it has remaining runs.
   */
  restore(snapshot: LoopJobSnapshot): LoopJobSnapshot {
    if (snapshot.runCount >= snapshot.maxRuns) return snapshot;
    if (snapshot.status === "cancelled" || snapshot.status === "failed") return snapshot;
    const job: LoopJob = {
      id: snapshot.id,
      kind: snapshot.kind,
      task: snapshot.task,
      intervalMs: snapshot.intervalMs,
      maxRuns: snapshot.maxRuns,
      runCount: snapshot.runCount,
      status: "scheduled",
      createdAt: snapshot.createdAt,
      lastRunAt: snapshot.lastRunAt,
      lastResult: snapshot.lastResult,
      cwd: snapshot.cwd,
      timeoutMs: snapshot.timeoutMs,
      logDir: snapshot.kind === "shell" ? loopLogDir(snapshot.id) : undefined,
    };
    this.jobs.set(job.id, job);
    this.schedule(job);
    this.emitUpdate();
    return this.snapshot(job);
  }

  /** Clear all timers but keep jobs in the map (for reload teardown). */
  pause(): void {
    for (const job of this.jobs.values()) {
      if (job.timer !== undefined) {
        this.clearTimer(job.timer);
        job.timer = undefined;
      }
      job.nextRunAt = undefined;
    }
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      job.status = "cancelled";
      job.nextRunAt = undefined;
      if (job.timer !== undefined) this.clearTimer(job.timer);
    }
    this.jobs.clear();
  }

  private schedule(job: LoopJob): void {
    if (job.status === "cancelled" || job.runCount >= job.maxRuns) return;
    job.status = "scheduled";
    job.nextRunAt = this.now() + job.intervalMs;
    job.timer = this.setTimer(() => {
      job.timer = undefined;
      void this.run(job);
    }, job.intervalMs);
    job.timer.unref?.();
  }

  private async run(job: LoopJob): Promise<void> {
    if (job.status === "cancelled") return;
    job.status = "running";
    job.nextRunAt = undefined;
    job.lastRunAt = this.now();

    let result: LoopRunResult;
    try {
      result = await this.executeJob(this.snapshot(job));
    } catch (error) {
      result = { ok: false, summary: error instanceof Error ? error.message : String(error) };
    }

    if (this.isCancelled(job)) return;
    job.runCount++;
    job.lastResult = result.summary.slice(0, OUTPUT_LIMIT);
    if (!result.ok) {
      job.status = "failed";
      this.emitUpdate();
      return;
    }
    if (job.runCount >= job.maxRuns) {
      job.status = "completed";
      this.emitUpdate();
      return;
    }
    this.schedule(job);
    this.emitUpdate();
  }

  private isCancelled(job: LoopJob): boolean {
    return job.status === "cancelled";
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.list());
  }

  private snapshot(job: LoopJob): LoopJobSnapshot {
    const { timer: _timer, ...snapshot } = job;
    return { ...snapshot };
  }
}

export const LoopParams = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")]),
  kind: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("shell")], { description: "Loop execution kind; required for create." })),
  task: Type.Optional(Type.String({ minLength: 1, description: "Prompt text or shell command; required for create." })),
  intervalMs: Type.Optional(Type.Integer({ minimum: MIN_INTERVAL_MS, maximum: MAX_INTERVAL_MS, description: "Fixed delay between runs in milliseconds; required for create." })),
  maxRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RUNS, default: DEFAULT_MAX_RUNS })),
  loopId: Type.Optional(Type.String({ minLength: 1, description: "Loop ID; required for cancel." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for shell loops." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_SHELL_TIMEOUT_MS, default: DEFAULT_SHELL_TIMEOUT_MS, description: "Per-run timeout for shell loops in milliseconds." })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "create" } }, required: ["action"] },
      then: { required: ["kind", "task", "intervalMs"] },
    },
    {
      if: { properties: { action: { const: "cancel" } }, required: ["action"] },
      then: { required: ["loopId"] },
    },
  ],
});

export interface LoopParamsInput {
  action: "create" | "list" | "cancel";
  kind?: LoopKind;
  task?: string;
  intervalMs?: number;
  maxRuns?: number;
  loopId?: string;
  cwd?: string;
  timeoutMs?: number;
}

function formatDuration(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

function formatJob(job: LoopJobSnapshot): string {
  const progress = `${job.runCount}/${job.maxRuns}`;
  const next = job.nextRunAt ? ` next=${new Date(job.nextRunAt).toISOString()}` : "";
  const result = job.lastResult ? ` result=${job.lastResult.replace(/\s+/g, " ").slice(0, 120)}` : "";
  const log = job.logDir ? ` log=${job.logDir}` : "";
  return `${job.id} ${job.status} ${job.kind} every=${formatDuration(job.intervalMs)} runs=${progress}${next}${result}${log}`;
}

export function parseLoopDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const result = amount * multiplier;
  return Number.isInteger(result) ? result : undefined;
}

export function registerLoop(pi: ExtensionAPI): void {
  const shell = getShellConfig();

  const publishSnapshot = (jobs: LoopJobSnapshot[]): void => {
    pi.events.emit(LOOP_UPDATE_EVENT, { jobs });
  };

  const persistLoopState = (jobs: LoopJobSnapshot[]): void => {
    pi.appendEntry("loop-state", {
      loops: jobs.map((j) => ({
        id: j.id, kind: j.kind, task: j.task,
        intervalMs: j.intervalMs, maxRuns: j.maxRuns,
        runCount: j.runCount, status: j.status,
        createdAt: j.createdAt, cwd: j.cwd, timeoutMs: j.timeoutMs,
      })),
      updatedAt: Date.now(),
    });
  };

  const scheduler = new LoopScheduler({
    onUpdate(jobs) {
      publishSnapshot(jobs);
      persistLoopState(jobs);
    },
    async execute(job) {
      if (job.kind === "prompt") {
        pi.sendMessage(
          {
            customType: "loop-tick",
            content: `[loop ${job.id}] tick ${job.runCount + 1}/${job.maxRuns}\n${job.task}`,
            display: true,
            details: { loopId: job.id, kind: job.kind, run: job.runCount + 1, maxRuns: job.maxRuns },
          },
          { triggerTurn: true },
        );
        return { ok: true, summary: "prompt queued" };
      }
      const result = await pi.exec(shell.shell, [...shell.args, job.task], {
        cwd: job.cwd || process.cwd(),
        timeout: job.timeoutMs,
      });
      const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
      // Write run output to log file.
      if (job.logDir) {
        try {
          fs.mkdirSync(job.logDir, { recursive: true });
          fs.writeFileSync(
            path.join(job.logDir, `run-${job.runCount + 1}.log`),
            `${new Date().toISOString()} exit=${result.code}\n${output}\n`,
          );
        } catch { /* best-effort logging */ }
      }
      return {
        ok: result.code === 0,
        summary: output || `exit ${result.code}`,
      };
    },
  });

  pi.registerTool({
    name: "loop",
    label: "Loop",
    description:
      "Create, list, or cancel session-scoped recurring tasks. Create requires kind, task, and intervalMs (milliseconds); cancel requires loopId. A loop runs a prompt or shell command after each fixed delay, never overlaps shell runs, stops after maxRuns, and is cancelled on session shutdown.",
    promptSnippet: "Schedule bounded recurring prompt or shell tasks for the current session.",
    promptGuidelines: [
      "Use action=create only when the user explicitly asks for recurring or delayed work.",
      "Prefer prompt loops for recurring agent work and shell loops only for commands the user has authorized.",
      "Loops are session-scoped and default to 10 runs; use list to inspect and cancel to stop one early.",
    ],
    parameters: LoopParams,
    async execute(_id, params: LoopParamsInput): Promise<FlowToolResult<{ jobs: LoopJobSnapshot[] }>> {
      try {
        if (params.action === "list") {
          const jobs = scheduler.list();
          return {
            content: [{ type: "text", text: jobs.length ? jobs.map(formatJob).join("\n") : "No loops." }],
            details: { jobs },
          };
        }
        if (params.action === "cancel") {
          if (!params.loopId) throw new Error("loopId is required for cancel.");
          const job = scheduler.cancel(params.loopId);
          if (!job) throw new Error(`Unknown loopId: ${params.loopId}`);
          return { content: [{ type: "text", text: `Cancelled ${job.id}.` }], details: { jobs: [job] } };
        }
        if (!params.kind || !params.task || params.intervalMs === undefined) {
          throw new Error("kind, task, and intervalMs are required for create.");
        }
        const job = scheduler.create({
          kind: params.kind,
          task: params.task,
          intervalMs: params.intervalMs,
          maxRuns: params.maxRuns,
          cwd: params.cwd,
          timeoutMs: params.timeoutMs,
        });
        return {
          content: [{ type: "text", text: `Created ${formatJob(job)}` }],
          details: { jobs: [job] },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { jobs: [] } };
      }
    },
  });

  pi.registerCommand("loop", {
    description: "Recurring session task: /loop prompt|shell <interval> [--max=N] <task> | /loop list | /loop cancel <id>",
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase();
      if (!action || action === "list") {
        const jobs = scheduler.list();
        ctx.ui.notify(jobs.length ? jobs.map(formatJob).join("\n") : "No loops.", "info");
        return;
      }
      if (action === "cancel") {
        const id = tokens[1];
        const job = id ? scheduler.cancel(id) : undefined;
        ctx.ui.notify(job ? `Cancelled ${job.id}.` : id ? `Unknown loopId: ${id}` : "Usage: /loop cancel <id>", job ? "info" : "warning");
        return;
      }
      if (action !== "prompt" && action !== "shell") {
        ctx.ui.notify("Usage: /loop prompt|shell <interval> [--max=N] <task> | /loop list | /loop cancel <id>", "warning");
        return;
      }
      const intervalMs = parseLoopDuration(tokens[1] ?? "");
      let taskStart = 2;
      let maxRuns: number | undefined;
      const maxMatch = /^--max=(\d+)$/.exec(tokens[taskStart] ?? "");
      if (maxMatch) {
        maxRuns = Number(maxMatch[1]);
        taskStart++;
      }
      const task = tokens.slice(taskStart).join(" ");
      try {
        if (intervalMs === undefined) throw new Error("Interval must use ms, s, m, or h, for example 30s or 5m.");
        const job = scheduler.create({ kind: action, task, intervalMs, maxRuns });
        ctx.ui.notify(`Created ${formatJob(job)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  // Cockpit can subscribe after this tool is registered, then request the
  // authoritative in-memory snapshot without importing Flow internals.
  pi.events.on(LOOP_QUERY_EVENT, () => publishSnapshot(scheduler.list()));

  pi.registerMessageRenderer("loop-tick", (msg, _opts, theme) => {
    const details = msg.details as { loopId?: string; run?: number; maxRuns?: number } | undefined;
    const label = details?.loopId ?? "loop";
    const progress = details?.run !== undefined && details?.maxRuns !== undefined
      ? ` ${details.run}/${details.maxRuns}`
      : "";
    const content = typeof msg.content === "string" ? msg.content.split("\n").slice(1).join(" ") : "";
    const summary = content.length > 80 ? `${content.slice(0, 77)}…` : content;
    return new Text(`${theme.fg("muted", "⟳")} ${theme.fg("dim", label)}${theme.fg("dim", progress)} ${summary}`, 0, 0);
  });

  // Restore persisted loops on session resume/reload; discover independent
  // shell loops on fresh startup.
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "startup") {
      // Check for independent shell loops still running from a previous session.
      const entries = readRegistry().filter((e) => isPidAlive(e.pid));
      if (entries.length > 0) {
        const lines = entries.map((e) => `- ${e.id} (pid ${e.pid}): ${e.task} [${e.runCount}/${e.maxRuns}]`);
        ctx.ui.notify(`${entries.length} independent loop(s) still running:\n${lines.join("\n")}`, "info");
      }
      // Prune dead entries.
      const all = readRegistry();
      const alive = all.filter((e) => isPidAlive(e.pid));
      if (alive.length !== all.length) writeRegistry(alive);
      return;
    }
    if (event.reason !== "resume" && event.reason !== "reload") return;
    const entries = ctx.sessionManager.getEntries();
    let latest: { loops?: LoopJobSnapshot[] } | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && (entry as { customType?: string }).customType === "loop-state") {
        latest = (entry as { data?: { loops?: LoopJobSnapshot[] } }).data;
      }
    }
    if (!latest?.loops?.length) return;
    let restored = 0;
    for (const def of latest.loops) {
      if (def.runCount < def.maxRuns && def.status !== "cancelled" && def.status !== "failed") {
        scheduler.restore(def);
        restored++;
      }
    }
    if (restored > 0) {
      ctx.ui.notify(`Restored ${restored} loop(s) from previous session.`, "info");
    }
  });

  // Re-announce active loops after compaction so the agent retains awareness.
  pi.on("session_compact", () => {
    const active = scheduler.list().filter((j) => j.status === "scheduled" || j.status === "running");
    if (active.length === 0) return;
    const lines = active.map((j) => `- ${formatJob(j)}`);
    pi.sendMessage(
      {
        customType: "loop-active",
        content: `${active.length} loop(s) still active after compaction:\n${lines.join("\n")}`,
        display: true,
        details: { loops: active.map((j) => j.id) },
      },
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_shutdown", (event) => {
    // Persist current state before teardown.
    const jobs = scheduler.list();
    persistLoopState(jobs);

    if (event.reason === "reload") {
      scheduler.pause();
      return;
    }

    // On quit, spawn detached schedulers for shell loops with remaining runs.
    if (event.reason === "quit") {
      const shellJobs = jobs.filter(
        (j) => j.kind === "shell" && j.runCount < j.maxRuns
          && (j.status === "scheduled" || j.status === "running"),
      );
      for (const job of shellJobs) {
        spawnDetachedScheduler(shell, job);
      }
    }

    scheduler.shutdown();
  });
}

/**
 * Generate and spawn a self-contained Node.js script that continues a shell
 * loop independently of the pi session. The script uses only Node builtins.
 */
function spawnDetachedScheduler(
  shell: { shell: string; args: string[] },
  job: LoopJobSnapshot,
): void {
  const logDir = loopLogDir(job.id);
  fs.mkdirSync(logDir, { recursive: true });
  const scriptPath = path.join(logDir, "scheduler.mjs");

  const script = `#!/usr/bin/env node
// Auto-generated detached loop scheduler for ${job.id}
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const CONFIG = ${JSON.stringify({
    id: job.id,
    task: job.task,
    intervalMs: job.intervalMs,
    maxRuns: job.maxRuns,
    runCount: job.runCount,
    cwd: job.cwd || process.cwd(),
    shell: shell.shell,
    shellArgs: shell.args,
    logDir,
    registryPath: REGISTRY_PATH,
  }, null, 2)};

const registryEntry = {
  id: CONFIG.id, task: CONFIG.task, intervalMs: CONFIG.intervalMs,
  maxRuns: CONFIG.maxRuns, runCount: CONFIG.runCount,
  cwd: CONFIG.cwd, pid: process.pid, startedAt: Date.now(),
};

function updateRegistry(entry, remove) {
  let entries = [];
  try { entries = JSON.parse(readFileSync(CONFIG.registryPath, "utf8")); } catch {}
  entries = entries.filter(e => e.id !== entry.id);
  if (!remove) entries.push(entry);
  const tmp = CONFIG.registryPath + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, CONFIG.registryPath);
}

updateRegistry(registryEntry, false);

let run = CONFIG.runCount;
function tick() {
  if (run >= CONFIG.maxRuns) {
    updateRegistry(registryEntry, true);
    process.exit(0);
  }
  run++;
  registryEntry.runCount = run;
  let output = "";
  let code = 0;
  try {
    output = execFileSync(CONFIG.shell, [...CONFIG.shellArgs, CONFIG.task], {
      cwd: CONFIG.cwd, timeout: ${DEFAULT_SHELL_TIMEOUT_MS}, encoding: "utf8",
    });
  } catch (e) {
    code = e.status ?? 1;
    output = (e.stdout || "") + (e.stderr || "");
  }
  writeFileSync(
    join(CONFIG.logDir, "run-" + run + ".log"),
    new Date().toISOString() + " exit=" + code + "\\n" + output + "\\n",
  );
  updateRegistry(registryEntry, run >= CONFIG.maxRuns);
  if (run < CONFIG.maxRuns) setTimeout(tick, CONFIG.intervalMs).unref?.();
}

setTimeout(tick, CONFIG.intervalMs).unref?.();
`;

  fs.writeFileSync(scriptPath, script);

  const child = spawn("node", [scriptPath], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
