import { StringDecoder } from "node:string_decoder";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeCardText, toolCallLine, toolResultCard, toolResultLine } from "pi-cockpit/src/quiet-tools.ts";
import {
  DEFAULT_SSH_TIMEOUT_SECONDS,
  MAX_SSH_COMMAND_BYTES,
  MAX_SSH_TIMEOUT_SECONDS,
  SshExecutor,
  type SshCommandChannel,
  type SshCommandSession,
} from "./executor.ts";
import { SSH_HOST_ID_PATTERN, type SshHost } from "./model.ts";

const MAX_SESSIONS = 16;
const MAX_ACTIVE_JOBS = 32;
const MAX_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;

export const SSH_BG_UPDATE_EVENT = "ssh-bg:update";

const targetId = Type.Optional(Type.String({
  pattern: SSH_HOST_ID_PATTERN.source,
  minLength: 1,
  maxLength: 64,
  description: "Provider-owned SSH target id; omit only when exactly one SSH server is attached",
}));
const sessionId = Type.String({ minLength: 1, maxLength: 128, description: "SSH background session id" });
const jobId = Type.String({ minLength: 1, maxLength: 128, description: "SSH background job id" });
const command = Type.String({ minLength: 1, maxLength: MAX_SSH_COMMAND_BYTES, description: "Command to execute on the remote SSH target" });
const cwd = Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Optional remote working directory" }));
const timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SSH_TIMEOUT_SECONDS, description: "Seconds to wait before run/exec moves to background" }));
const tail = Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Output lines to include" }));

export const SshBgParams = Type.Union([
  Type.Object({ action: Type.Literal("job_start"), targetId, sessionId: Type.Optional(sessionId), command, cwd, timeout }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_run"), targetId, sessionId: Type.Optional(sessionId), command, cwd, timeout, tail }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_exec"), sessionId, command, cwd, timeout, tail }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_status"), jobId, tail }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_wait"), jobId, timeout, tail }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_kill"), jobId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_list") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job_close"), sessionId }, { additionalProperties: false }),
], {
  type: "object",
  description: "Run bounded remote SSH commands with background job control. job_start backgrounds immediately; job_run waits up to timeout then detaches; job_exec appends a command on the same SSH TCP session and backgrounds it immediately; job_status, job_wait, job_kill, job_list, and job_close provide lifecycle control.",
});

export type SshBgInput = Static<typeof SshBgParams>;
export type SshBgJobStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface SshBgDetails {
  action: string;
  sessionId?: string;
  jobId?: string;
  status?: SshBgJobStatus;
  background?: boolean;
  command?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail?: string;
}

export interface SshBgJobSnapshot {
  id: string;
  sessionId: string;
  hostId: string;
  command: string;
  cwd?: string;
  status: SshBgJobStatus;
  background: boolean;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  outputBytes: number;
  tailTruncated: boolean;
}

export interface SshBgSnapshotPayload {
  sessions: Array<{
    id: string;
    hostId: string;
    jobs: SshBgJobSnapshot[];
  }>;
}

export interface SshBgResolvedTarget {
  readonly host: SshHost;
  readonly fence: string;
}

export interface SshBgManagerOptions {
  executor: Pick<SshExecutor, "openSession">;
  resolveTarget(targetId?: string): Promise<SshBgResolvedTarget>;
  onCompletion?: (completion: SshBgCompletion) => void;
  onSnapshot?: (snapshot: SshBgSnapshotPayload) => void;
}

export interface SshBgCompletion {
  jobId: string;
  sessionId: string;
  command: string;
  status: SshBgJobStatus;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  tailTruncated: boolean;
}

interface SshBgSession {
  id: string;
  hostId: string;
  fence: string;
  connection: SshCommandSession;
  jobs: Map<string, SshBgJob>;
  closed: boolean;
}

interface SshBgJob {
  id: string;
  sessionId: string;
  hostId: string;
  command: string;
  cwd?: string;
  channel: SshCommandChannel;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  outputBytes: number;
  tailTruncated: boolean;
  background: boolean;
  stopRequested: boolean;
  done: boolean;
  error?: string;
  terminal: Promise<void>;
  resolveTerminal: () => void;
}

function jobStatus(job: SshBgJob): SshBgJobStatus {
  if (!job.done) return job.stopRequested ? "stopping" : "running";
  if (job.stopRequested) return "killed";
  if (job.error || job.exitCode !== 0) return "failed";
  return "completed";
}

function tailLines(value: string, lines: number): string {
  const normalized = value.replace(/\r?\n$/u, "");
  if (!normalized) return "";
  return normalized.split("\n").slice(-lines).join("\n");
}

function appendOutput(job: SshBgJob, text: string): void {
  job.outputTail += text;
  if (Buffer.byteLength(job.outputTail, "utf8") > MAX_TAIL_BYTES) {
    const bytes = Buffer.from(job.outputTail, "utf8");
    let start = bytes.length - MAX_TAIL_BYTES;
    while ((bytes[start]! & 0xc0) === 0x80) start++;
    job.outputTail = bytes.subarray(start).toString("utf8");
    job.tailTruncated = true;
  }
  job.updatedAt = Date.now();
}

function decodeOutput(job: SshBgJob, decoder: StringDecoder, chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  job.outputBytes += bytes.length;
  appendOutput(job, decoder.write(bytes));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SshBgManager {
  private readonly sessions = new Map<string, SshBgSession>();
  private counter = 0;
  private closed = false;

  constructor(private readonly options: SshBgManagerOptions) {}

  async execute(input: SshBgInput, signal?: AbortSignal): Promise<AgentToolResult<SshBgDetails>> {
    if (this.closed) throw new Error("ssh_bg is unavailable outside an active session runtime");
    if (input.action === "job_list") return this.listResult();
    if (input.action === "job_status") return this.statusResult(input.jobId, input.tail ?? 20);
    if (input.action === "job_wait") return this.waitResult(input.jobId, input.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS, input.tail ?? 20, signal);
    if (input.action === "job_kill") return this.killResult(input.jobId);
    if (input.action === "job_close") return this.closeResult(input.sessionId);
    if (input.action === "job_start") {
      const job = await this.startJob(input.targetId, input.sessionId, input.command, input.cwd, input.timeout, true, signal);
      return this.startedResult(job, "Started background job", input.action);
    }
    if (input.action === "job_exec") {
      const job = await this.startJob(undefined, input.sessionId, input.command, input.cwd, input.timeout, true, signal);
      return this.startedResult(job, "Started appended background job", input.action);
    }
    const job = await this.startJob(
      input.targetId,
      input.sessionId,
      input.command,
      input.cwd,
      input.timeout,
      false,
      signal,
    );
    const outcome = await this.waitForRunBoundary(job, (input.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS) * 1000, signal);
    if (outcome === "aborted") {
      job.stopRequested = true;
      await this.stopJob(job);
      throw new Error("aborted");
    }
    if (outcome === "completed" || job.done) return this.completedResult(job, input.action, input.tail ?? 200);
    job.background = true;
    job.updatedAt = Date.now();
    this.publishSnapshot();
    return this.startedResult(job, outcome === "manual" ? "Detached" : `Still running after ${input.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS}s — moved to background`, input.action);
  }

  initialize(): void {
    this.closed = false;
  }

  invalidateHost(hostId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.hostId === hostId) this.closeSession(session, true);
    }
  }

  invalidateAll(): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions.values()]) this.closeSession(session, true);
    this.sessions.clear();
    this.publishSnapshot();
  }

  private async startJob(
    targetId: string | undefined,
    requestedSessionId: string | undefined,
    command: string,
    requestedCwd: string | undefined,
    requestedTimeout: number | undefined,
    background: boolean,
    signal?: AbortSignal,
  ): Promise<SshBgJob> {
    if (signal?.aborted) throw abortError();
    const activeJobs = [...this.sessions.values()]
      .flatMap((session) => [...session.jobs.values()])
      .filter((job) => !job.done).length;
    if (activeJobs >= MAX_ACTIVE_JOBS) {
      throw new Error(`Too many active SSH background jobs (${activeJobs}/${MAX_ACTIVE_JOBS}). Wait for or stop an existing job.`);
    }
    const acquired = await this.acquireSession(targetId, requestedSessionId, requestedTimeout, signal);
    const session = acquired.session;
    try {
      const channel = await session.connection.openChannel(
        { command, ...(requestedCwd === undefined ? {} : { cwd: requestedCwd }), ...(requestedTimeout === undefined ? {} : { timeout: requestedTimeout }) },
        { signal },
      );
      const deferredTerminal = deferred();
      const job: SshBgJob = {
        id: `ssh-bg-${(++this.counter).toString(36)}-${Date.now().toString(36)}`,
        sessionId: session.id,
        hostId: session.hostId,
        command,
        ...(requestedCwd === undefined ? {} : { cwd: requestedCwd }),
        channel,
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        exitCode: null,
        signal: null,
        outputTail: "",
        outputBytes: 0,
        tailTruncated: false,
        background,
        stopRequested: false,
        done: false,
        terminal: deferredTerminal.promise,
        resolveTerminal: deferredTerminal.resolve,
      };
      session.jobs.set(job.id, job);
      this.bindJob(session, job);
      this.publishSnapshot();
      return job;
    } catch (error) {
      if (acquired.created) this.closeSession(session, true);
      throw error;
    }
  }

  private async acquireSession(
    targetId: string | undefined,
    requestedSessionId: string | undefined,
    requestedTimeout: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ session: SshBgSession; created: boolean }> {
    if (requestedSessionId !== undefined) {
      const session = this.sessions.get(requestedSessionId);
      if (!session || session.closed) throw new Error(`Unknown SSH sessionId: ${requestedSessionId}`);
      if (targetId !== undefined && targetId !== session.hostId) throw new Error("targetId does not match the requested SSH session");
      const current = await this.options.resolveTarget(session.hostId);
      if (current.fence !== session.fence) {
        this.closeSession(session, true);
        throw new Error("SSH target changed; the existing SSH session was closed");
      }
      return { session, created: false };
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`Too many SSH sessions (${MAX_SESSIONS}). Close an existing session first.`);
    const target = await this.options.resolveTarget(targetId);
    const connection = await this.options.executor.openSession(target.host, {
      signal,
      ...(requestedTimeout === undefined ? {} : { timeout: requestedTimeout }),
    });
    const session: SshBgSession = {
      id: `ssh-session-${(++this.counter).toString(36)}-${Date.now().toString(36)}`,
      hostId: target.host.id,
      fence: target.fence,
      connection,
      jobs: new Map(),
      closed: false,
    };
    this.sessions.set(session.id, session);
    this.publishSnapshot();
    return { session, created: true };
  }

  private bindJob(session: SshBgSession, job: SshBgJob): void {
    const stream = job.channel.channel;
    stream.on("data", (chunk: Buffer | string) => {
      if (!job.done) {
        decodeOutput(job, job.stdoutDecoder, chunk);
        this.publishSnapshot();
      }
    });
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (!job.done) {
        decodeOutput(job, job.stderrDecoder, chunk);
        this.publishSnapshot();
      }
    });
    stream.once("exit", (code: number | null, signal?: string) => {
      job.exitCode = code;
      job.signal = signal ?? null;
      job.updatedAt = Date.now();
    });
    stream.once("error", () => {
      if (!job.done) job.error = "SSH command channel failed";
    });
    stream.once("close", () => this.finishJob(session, job));
  }

  private finishJob(session: SshBgSession, job: SshBgJob): void {
    if (job.done) return;
    job.done = true;
    appendOutput(job, job.stdoutDecoder.end());
    appendOutput(job, job.stderrDecoder.end());
    job.finishedAt = Date.now();
    job.updatedAt = job.finishedAt;
    job.resolveTerminal();
    this.publishSnapshot();
    if (job.background && !this.closed && !session.closed) {
      this.options.onCompletion?.({
        jobId: job.id,
        sessionId: job.sessionId,
        command: job.command,
        status: jobStatus(job),
        exitCode: job.exitCode,
        signal: job.signal,
        outputTail: tailLines(job.outputTail, 20),
        tailTruncated: job.tailTruncated,
      });
    }
  }

  private async waitForRunBoundary(
    job: SshBgJob,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"completed" | "timeout" | "manual" | "aborted"> {
    if (signal?.aborted) return "aborted";
    if (job.done) return "completed";
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const finish = (outcome: "completed" | "timeout" | "manual" | "aborted"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      void job.terminal.then(() => finish("completed"));
    });
  }

  private async waitResult(
    id: string,
    timeoutSeconds: number,
    lines: number,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<SshBgDetails>> {
    const job = this.requireJob(id);
    const outcome = await this.waitForRunBoundary(job, timeoutSeconds * 1000, signal);
    if (outcome === "aborted") throw new Error("aborted");
    const state = job.done ? `${jobStatus(job)} (exit ${job.exitCode ?? "unknown"})` : `${jobStatus(job)} after ${timeoutSeconds}s`;
    return this.jobResult(job, "wait", `job ${job.id}: ${state}\n${this.outputText(job, lines)}`);
  }

  private async killResult(id: string): Promise<AgentToolResult<SshBgDetails>> {
    const job = this.requireJob(id);
    const alreadyFinished = job.done;
    if (!job.done) {
      job.stopRequested = true;
      await this.stopJob(job);
    }
    return this.jobResult(job, "kill", `${alreadyFinished ? "Job already finished" : "Stopped job"} ${job.id}.`);
  }

  private async stopJob(job: SshBgJob): Promise<void> {
    if (job.done) return;
    try {
      const signal = job.channel.channel as typeof job.channel.channel & { signal?: (name: string) => void };
      signal.signal?.("SIGTERM");
    } catch {
      // Closing the channel below remains the transport-level fallback.
    }
    await Promise.race([job.terminal, delay(KILL_GRACE_MS)]);
    if (!job.done) {
      job.channel.close();
      const session = this.sessions.get(job.sessionId);
      if (session) this.finishJob(session, job);
    }
  }

  private closeResult(id: string): AgentToolResult<SshBgDetails> {
    const session = this.sessions.get(id);
    if (!session || session.closed) throw new Error(`Unknown SSH sessionId: ${id}`);
    this.closeSession(session, true);
    return {
      content: [{ type: "text", text: `Closed SSH session ${id}.` }],
      details: { action: "job_close", sessionId: id, exitCode: null, signal: null, durationMs: 0 },
    };
  }

  private closeSession(session: SshBgSession, suppressCompletion: boolean): void {
    if (session.closed) return;
    session.closed = true;
    for (const job of session.jobs.values()) {
      if (job.done) continue;
      job.stopRequested = true;
      if (suppressCompletion) job.background = false;
      job.channel.close();
      this.finishJob(session, job);
    }
    session.connection.close();
    this.sessions.delete(session.id);
    this.publishSnapshot();
  }

  private listResult(): AgentToolResult<SshBgDetails> {
    if (this.sessions.size === 0) return { content: [{ type: "text", text: "No SSH background sessions." }], details: { action: "job_list", exitCode: null, signal: null, durationMs: 0 } };
    const lines = [...this.sessions.values()].flatMap((session) => [
      `${session.id}\thost ${session.hostId}\tjobs ${session.jobs.size}`,
      ...[...session.jobs.values()].map((job) => `  ${job.id}\t${jobStatus(job)}${job.done ? `(exit ${job.exitCode ?? "unknown"})` : ""}\t${job.command}`),
    ]);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { action: "job_list", exitCode: null, signal: null, durationMs: 0 } };
  }

  private statusResult(id: string, lines: number): AgentToolResult<SshBgDetails> {
    const job = this.requireJob(id);
    return this.jobResult(job, "status", this.outputText(job, lines));
  }

  private startedResult(job: SshBgJob, prefix = "Started background job", action = "start"): AgentToolResult<SshBgDetails> {
    return {
      content: [{ type: "text", text: `${prefix} ${job.id} on SSH session ${job.sessionId}.\ncommand: ${job.command}\nUse ssh action=job_status jobId=${job.id}, action=job_wait, or action=job_kill.` }],
      details: this.details(job, action),
    };
  }

  private completedResult(job: SshBgJob, action: string, lines: number): AgentToolResult<SshBgDetails> {
    return this.jobResult(job, action, this.outputText(job, lines));
  }

  private jobResult(job: SshBgJob, action: string, text: string): AgentToolResult<SshBgDetails> {
    const status = jobStatus(job);
    return {
      content: [{ type: "text", text: `job ${job.id} (${status})\n${text}` }],
      ...(status === "completed" ? {} : { isError: true }),
      details: this.details(job, action),
    };
  }

  private outputText(job: SshBgJob, lines: number): string {
    return `session: ${job.sessionId}\ncommand: ${job.command}\noutput (tail):\n${tailLines(job.outputTail, lines) || "(empty)"}`;
  }

  private details(job: SshBgJob, action: string): SshBgDetails {
    return {
      action,
      sessionId: job.sessionId,
      jobId: job.id,
      status: jobStatus(job),
      background: job.background,
      command: job.command,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: Date.now() - job.startedAt,
      outputTail: tailLines(job.outputTail, 20),
    };
  }

  private requireJob(id: string): SshBgJob {
    for (const session of this.sessions.values()) {
      const job = session.jobs.get(id);
      if (job) return job;
    }
    throw new Error(`Unknown SSH jobId: ${id}`);
  }

  private publishSnapshot(): void {
    if (this.closed) return;
    this.options.onSnapshot?.({
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        hostId: session.hostId,
        jobs: [...session.jobs.values()].map((job) => ({
          id: job.id,
          sessionId: job.sessionId,
          hostId: job.hostId,
          command: job.command,
          ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
          status: jobStatus(job),
          background: job.background,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
          exitCode: job.exitCode,
          signal: job.signal,
          outputTail: tailLines(job.outputTail, 200),
          outputBytes: job.outputBytes,
          tailTruncated: job.tailTruncated,
        })),
      })),
    });
  }
}

export function registerSshBg(
  pi: ExtensionAPI,
  options: Omit<SshBgManagerOptions, "onCompletion" | "onSnapshot">,
  registerTool = true,
): SshBgManager {
  const manager = new SshBgManager({
    ...options,
    onSnapshot: (snapshot) => pi.events.emit(SSH_BG_UPDATE_EVENT, snapshot),
    onCompletion: (completion) => {
      const status = completion.status;
      const output = completion.outputTail || "(empty)";
      pi.sendMessage({
        customType: "ssh-bg-complete",
        content: [
          `Background SSH job ${completion.jobId} ${status} (exit ${completion.exitCode ?? "unknown"}).`,
          `session: ${completion.sessionId}`,
          `command: ${completion.command}`,
          `output (tail):\n${output}`,
        ].join("\n"),
        display: true,
        details: completion,
      }, { triggerTurn: true });
    },
  });

  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer<SshBgCompletion>("ssh-bg-complete", (message, renderOptions, theme) => {
      const details = message.details;
      const outputLines = (details?.outputTail ?? "")
        .split("\n")
        .map((line) => sanitizeCardText(line))
        .filter(Boolean);
      const groups = outputLines.length > 0 ? [renderOptions.expanded ? outputLines : outputLines.slice(-6)] : [["(empty)"]];
      const status = details?.status ?? "failed";
      return toolResultCard(theme, {
        name: "ssh-bg-complete",
        ok: status === "completed",
        summary: `${sanitizeCardText(details?.jobId ?? "job", 80)} · ${status}`,
        groups,
        maxBodyRows: renderOptions.expanded ? undefined : 8,
      });
    });
  }

  if (registerTool) pi.registerTool({
    name: "ssh_bg",
    label: "Background SSH",
    description: "Run remote SSH commands with background job control. job_start backgrounds immediately; job_run waits up to timeout then detaches; job_exec appends a command on the same SSH TCP session and backgrounds it immediately; job_status, job_wait, job_kill, job_list, and job_close provide lifecycle control.",
    promptSnippet: "Use ssh_bg for remote background commands. job_start creates or reuses a session and returns jobId/sessionId; job_exec appends a background command on that same SSH session; job_run is adaptive; job_status/job_wait/job_kill/job_list/job_close manage jobs.",
    promptGuidelines: [
      "Use ssh for short foreground commands and Gateway actions. Use ssh_bg job_start for long-running remote commands.",
      "Pass the returned sessionId to ssh_bg job_exec or job_start when appending commands on the same SSH TCP connection.",
      "A session shares the SSH connection but not shell cwd/export state between exec channels; include cwd or environment setup in each command.",
      "Use ssh_bg job_wait once or wait for the ssh-bg-complete notification; use job_status only to inspect output and job_kill to stop a job.",
      "SSH background sessions are tied to this Pi process and are closed on session shutdown, host configuration changes, or explicit job_close.",
    ],
    parameters: SshBgParams,
    async execute(_id: string, params: SshBgInput, signal: AbortSignal): Promise<AgentToolResult<SshBgDetails>> {
      return manager.execute(params, signal);
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      if (context?.isPartial === false) return new Text("", 0, 0);
      const record = args as Record<string, unknown>;
      const action = String(record.action ?? "job_start");
      const value = record.action === "job_status" || record.action === "job_wait" || record.action === "job_kill"
        ? String(record.jobId ?? "")
        : record.action === "job_exec" || record.action === "job_close"
          ? String(record.sessionId ?? "")
          : String(record.command ?? "");
      return toolCallLine(theme, "ssh_bg", value ? `${action} ${value.slice(0, 50)}` : action);
    },
    renderResult(result, opts, theme) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as SshBgDetails | undefined;
      const isError = (result as { isError?: boolean }).isError === true;
      const running = details?.status === "running" || details?.status === "stopping";
      const successful = details?.status === "completed" || details?.action === "job_list" || details?.action === "job_close";
      const mark = running
        ? theme.fg("warning", "•")
        : (!isError && successful ? theme.fg("success", "✓") : theme.fg("error", "✗"));
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      return toolResultLine(theme, {
        name: "ssh_bg",
        mark,
        summary: text.split("\n", 1)[0] || "SSH background job",
        expanded: opts.expanded,
        detail: text,
      });
    },
  });
  return manager;
}

function abortError(): Error {
  const error = new Error("SSH background command aborted");
  error.name = "AbortError";
  return error;
}
