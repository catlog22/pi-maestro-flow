import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunCliResult {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliCapabilities {
  commands: ReadonlySet<string>;
  retryViaParentRun: boolean;
  cancel: boolean;
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
    const help = await this.invoke(["run", "--help"]);
    const commands = new Set<string>();
    for (const match of help.stdout.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)) commands.add(match[1]);
    let retryViaParentRun = false;
    if (commands.has("create")) {
      const createHelp = await this.invoke(["run", "create", "--help"]);
      retryViaParentRun = /--parent-run\b/.test(createHelp.stdout);
    }
    this.detected = {
      commands,
      retryViaParentRun,
      cancel: commands.has("cancel"),
    };
    return this.detected;
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

  async create(
    command: string,
    args: readonly string[] = [],
    options: { sessionId?: string; intent?: string; parentRunId?: string } = {},
  ): Promise<RunCliResult> {
    const capabilities = await this.capabilities();
    if (!capabilities.commands.has("create")) throw new UnsupportedRunCapabilityError("create");
    if (options.parentRunId && !capabilities.retryViaParentRun) {
      throw new UnsupportedRunCapabilityError("retry via create --parent-run");
    }
    return this.invoke([
      "run", "create", required(command, "command"),
      ...(options.sessionId ? ["--session", options.sessionId] : []),
      ...(options.intent ? ["--intent", options.intent] : []),
      ...(options.parentRunId ? ["--parent-run", options.parentRunId] : []),
      ...args.flatMap((arg) => ["--arg", arg]),
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async complete(runId: string, sessionId?: string): Promise<RunCliResult> {
    await this.requireCommand("complete");
    return this.invoke([
      "run", "complete", required(runId, "runId"),
      ...(sessionId ? ["--session", sessionId] : []),
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async cancel(runId: string, sessionId?: string): Promise<RunCliResult> {
    const capabilities = await this.capabilities();
    if (!capabilities.cancel) throw new UnsupportedRunCapabilityError("cancel");
    return this.invoke([
      "run", "cancel", required(runId, "runId"),
      ...(sessionId ? ["--session", sessionId] : []),
      "--workflow-root", this.workflowRoot,
    ]);
  }

  private async requireCommand(command: string): Promise<void> {
    if (!(await this.capabilities()).commands.has(command)) throw new UnsupportedRunCapabilityError(command);
  }

  private async invoke(args: readonly string[]): Promise<RunCliResult> {
    const result = await this.runner(args, this.workflowRoot);
    if (result.exitCode !== 0) {
      throw new Error(`maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

async function defaultRunner(args: readonly string[], cwd: string): Promise<RunCliResult> {
  const executable = process.platform === "win32" ? "maestro.cmd" : "maestro";
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { argv: [...args], stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    return {
      argv: [...args],
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? errorMessage(error),
      exitCode: typeof value.code === "number" ? value.code : 1,
    };
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
