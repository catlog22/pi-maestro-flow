import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export interface RunCliResult {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliCapabilities {
  commands: ReadonlySet<string>;
  /** Commands parsed from `session --help`; empty when the CLI has no session subcommand. */
  sessionCommands: ReadonlySet<string>;
  /** Commands parsed from `plan --help`; used for approved Plan publication capability detection. */
  planCommands: ReadonlySet<string>;
}

export interface RunPlanPublishOptions {
  sourcePath: string;
  sourceRoot: string;
  sessionId?: string;
  intent?: string;
  topic?: string;
  handoffKey: string;
  sourcePiSession: string;
  planRevision: number;
  approvedAt: string;
  expectedIdentityRevision?: number;
  expectedActivityRevision?: number;
}

export type RunCompletionVerdict = "done" | "done-with-concerns" | "needs-retry" | "blocked";

export interface RunDoneOptions {
  verdict?: RunCompletionVerdict;
  summary?: string;
  reason?: string;
  notes?: readonly string[];
  decisions?: readonly string[];
  evidence?: readonly string[];
  artifacts?: readonly string[];
}

export interface RunEditOptions {
  sessionId: string;
  after?: string;
  replace?: string;
  remove?: string;
  args?: string;
  stage?: string;
  goalRef?: string;
  insertedBy?: string;
}

export type RunCliRunner = (args: readonly string[], cwd: string) => Promise<RunCliResult>;

export class UnsupportedRunCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`Installed Maestro CLI does not support run capability: ${capability}`);
    this.name = "UnsupportedRunCapabilityError";
  }
}

export class RunCliAdapter {
  private detected?: RunCliCapabilities;

  constructor(
    readonly workflowRoot: string,
    private readonly runner: RunCliRunner = defaultRunner,
  ) {}

  async capabilities(refresh = false): Promise<RunCliCapabilities> {
    if (this.detected && !refresh) return this.detected;
    const commands = new Set<string>();
    // Detect run-level commands (brief, check, prepare, create, ...)
    const runHelp = await this.invoke(["run", "--help"]);
    for (const match of runHelp.stdout.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)) commands.add(match[1]);
    // Detect session-level commands (next, done, decide, seal, ...). Recorded
    // separately so next/done can route to whichever subcommand family the
    // installed CLI exposes them under (see next/done below).
    const sessionCommands = new Set<string>();
    try {
      const sessionHelp = await this.invoke(["session", "--help"]);
      for (const match of sessionHelp.stdout.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)) {
        sessionCommands.add(match[1]);
        commands.add(match[1]);
      }
    } catch {
      // No session subcommand on this CLI — next/done route via the run family
    }
    const planCommands = new Set<string>();
    try {
      const planHelp = await this.invoke(["plan", "--help"]);
      for (const match of planHelp.stdout.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)) {
        planCommands.add(match[1]);
      }
    } catch {
      // Older CLIs have no approved Plan publisher; the confirmation UI disables Workflow execution.
    }
    this.detected = { commands, sessionCommands, planCommands };
    return this.detected;
  }

  async supportsPlanPublish(): Promise<boolean> {
    return (await this.capabilities()).planCommands.has("publish");
  }

  async publishPlan(options: RunPlanPublishOptions): Promise<RunCliResult> {
    if (!await this.supportsPlanPublish()) throw new UnsupportedRunCapabilityError("plan publish");
    return this.invoke([
      "plan", "publish", required(options.sourcePath, "sourcePath"),
      "--source-root", required(options.sourceRoot, "sourceRoot"),
      ...(options.sessionId ? ["--session", options.sessionId] : []),
      ...(options.intent ? ["--intent", options.intent] : []),
      ...(options.topic ? ["--topic", options.topic] : []),
      "--handoff-key", required(options.handoffKey, "handoffKey"),
      "--source-pi-session", required(options.sourcePiSession, "sourcePiSession"),
      "--plan-revision", String(options.planRevision),
      "--approved-at", required(options.approvedAt, "approvedAt"),
      ...(options.expectedIdentityRevision !== undefined
        ? ["--expected-identity-revision", String(options.expectedIdentityRevision)]
        : []),
      ...(options.expectedActivityRevision !== undefined
        ? ["--expected-activity-revision", String(options.expectedActivityRevision)]
        : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async prepare(step: string): Promise<RunCliResult> {
    await this.requireCommand("prepare");
    return this.invoke(["run", "prepare", required(step, "step"), "--workflow-root", this.workflowRoot]);
  }

  async brief(runId: string, sessionId?: string): Promise<RunCliResult> {
    await this.requireCommand("brief");
    return this.invoke([
      "run", "brief", required(runId, "runId"),
      ...(sessionId ? ["--session", sessionId] : []),
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async check(runId: string, sessionId?: string): Promise<RunCliResult> {
    await this.requireCommand("check");
    return this.invoke([
      "run", "check", required(runId, "runId"),
      ...(sessionId ? ["--session", sessionId] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async next(sessionId: string, pick?: string): Promise<RunCliResult> {
    // Chain advancement is exposed as `session next` on some CLIs and as the
    // run-family `run next` on others; route by what --help actually advertises.
    // --inline-brief inlines the birth brief into the next response (saving a
    // separate `run brief` round-trip) and is declared only on `session next`,
    // so emit it solely on that branch — `run next` rejects the unknown option.
    const useSession = (await this.capabilities()).sessionCommands.has("next");
    await this.requireCommand("next");
    return this.invoke([
      useSession ? "session" : "run", "next",
      "--session", required(sessionId, "sessionId"),
      ...(useSession ? ["--inline-brief"] : []),
      ...(pick ? ["--pick", pick] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async done(runId: string, sessionId: string, options: RunDoneOptions = {}): Promise<RunCliResult> {
    // Run sealing is exposed as `session done` on some CLIs and as the
    // run-family `run complete` on others; route by what --help advertises.
    const useSession = (await this.capabilities()).sessionCommands.has("done");
    await this.requireCommand("done", "complete");
    return this.invoke([
      useSession ? "session" : "run", useSession ? "done" : "complete", required(runId, "runId"),
      "--session", required(sessionId, "sessionId"),
      "--verdict", options.verdict ?? "done",
      ...(options.summary ? ["--summary", options.summary] : []),
      ...(options.reason ? ["--reason", options.reason] : []),
      ...(options.notes ?? []).flatMap((note) => ["--note", note]),
      ...(options.decisions ?? []).flatMap((decision) => ["--decision", decision]),
      ...(options.evidence ?? []).flatMap((path) => ["--evidence", path]),
      ...(options.artifacts ?? []).flatMap((path) => ["--artifact", path]),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  /**
   * Raw argv passthrough for the run-control shell. Appends the canonical
   * --workflow-root unless the caller already pinned it.
   */
  async exec(argv: readonly string[]): Promise<RunCliResult> {
    return this.invoke(
      argv.some((argument) => argument === "--workflow-root")
        ? [...argv]
        : [...argv, "--workflow-root", this.workflowRoot],
    );
  }

  async edit(commands: readonly string[], options: RunEditOptions): Promise<RunCliResult> {
    // run edit is the unified chain-edit interface (insert/skip/replace via flags).
    // session chain insert/skip/replace are the split subcommands but run edit
    // remains the stable machine protocol for programmatic callers.
    await this.requireCommand("edit");
    return this.invoke([
      "run", "edit", ...commands,
      "--session", required(options.sessionId, "sessionId"),
      ...(options.after ? ["--after", options.after] : []),
      ...(options.replace ? ["--replace", options.replace] : []),
      ...(options.remove ? ["--remove", options.remove] : []),
      ...(options.args ? ["--args", options.args] : []),
      ...(options.stage ? ["--stage", options.stage] : []),
      ...(options.goalRef ? ["--goal-ref", options.goalRef] : []),
      ...(options.insertedBy ? ["--inserted-by", options.insertedBy] : []),
      "--workflow-root", this.workflowRoot,
    ]);
  }

  private async requireCommand(command: string, ...fallbacks: string[]): Promise<void> {
    const commands = (await this.capabilities()).commands;
    if (commands.has(command) || fallbacks.some((fallback) => commands.has(fallback))) return;
    throw new UnsupportedRunCapabilityError(command);
  }

  private async invoke(args: readonly string[]): Promise<RunCliResult> {
    const result = await this.runner(args, this.workflowRoot);
    if (result.exitCode !== 0) {
      throw new Error(`maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

export async function defaultRunner(
  args: readonly string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    executable?: string;
    spawnProcess?: typeof crossSpawn;
  } = {},
): Promise<RunCliResult> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, "timeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  const executable = options.executable ?? (process.platform === "win32" ? "maestro.cmd" : "maestro");
  const spawnProcess = options.spawnProcess ?? crossSpawn;
  return new Promise((resolve) => {
    const child = spawnProcess(executable, [...args], {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: string | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stdout?.removeListener("error", onStdoutError);
      child.stderr?.removeListener("data", onStderr);
      child.stderr?.removeListener("error", onStderrError);
    };
    const finish = (exitCode: number, message?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const capturedStderr = Buffer.concat(stderr).toString("utf8");
      resolve({
        argv: [...args],
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: message ? boundedDiagnostic(capturedStderr, message, maxOutputBytes) : capturedStderr,
        exitCode,
      });
    };
    const stopWith = (message: string): void => {
      if (failure !== undefined || settled) return;
      failure = message;
      clearTimeout(timer);
      void terminateProcessTree(child).then(
        () => finish(1, message),
        () => finish(1, message),
      );
    };
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (failure !== undefined || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (outputBytes + buffer.byteLength > maxOutputBytes) {
        stopWith(`maestro CLI output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      outputBytes += buffer.byteLength;
      target.push(buffer);
    };
    const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
    const onStdoutError = (error: Error): void => stopWith(`maestro CLI stdout failed: ${errorMessage(error)}`);
    const onStderrError = (error: Error): void => stopWith(`maestro CLI stderr failed: ${errorMessage(error)}`);
    const onError = (error: Error): void => {
      const message = errorMessage(error);
      if (child.pid) stopWith(message);
      else finish(1, message);
    };
    const onClose = (code: number | null): void => {
      if (failure === undefined) finish(code ?? 1);
    };
    const timer = setTimeout(
      () => stopWith(`maestro CLI timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
    timer.unref?.();

    child.stdout?.on("data", onStdout);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", onStderrError);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  if (process.platform === "win32" && child.pid) {
    const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await waitForExit(killer, TERMINATION_GRACE_MS);
    if (isRunning(child)) {
      try { child.kill("SIGKILL"); } catch {}
      await waitForExit(child, TERMINATION_GRACE_MS);
    }
    return;
  }

  signalProcessGroup(child, "SIGTERM");
  if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(child, "SIGKILL");
  await waitForExit(child, TERMINATION_GRACE_MS);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("close", onExit);
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
    child.once("close", onExit);
    child.once("error", onError);
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function boundedDiagnostic(stderr: string, message: string, maxBytes: number): string {
  const combined = stderr ? `${stderr}\n${message}` : message;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  if (Buffer.byteLength(message, "utf8") <= maxBytes) return message;
  let truncated = "";
  let usedBytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    truncated += character;
    usedBytes += characterBytes;
  }
  return truncated;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
