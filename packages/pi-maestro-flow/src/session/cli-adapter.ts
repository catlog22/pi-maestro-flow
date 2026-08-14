import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { z } from "zod";
import { parseRunResponse, projectPublicRunResponse } from "./run-response.ts";

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const PI_PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");

function advertisedPiPackageRoot(): string {
  if (existsSync(resolvePath(PI_PACKAGE_ROOT, ".pi", "skills"))) return PI_PACKAGE_ROOT;
  const sourceWorkspaceRoot = resolvePath(PI_PACKAGE_ROOT, "../..");
  return existsSync(resolvePath(sourceWorkspaceRoot, ".pi", "skills"))
    ? sourceWorkspaceRoot
    : PI_PACKAGE_ROOT;
}

export interface RunCliResult {
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCliCapabilityMode = "structured" | "legacy" | "fail-closed";

export interface MaestroCapabilitiesV10 {
  schema_version: "maestro-capabilities/1.0";
  cli_version: string;
  session_schema_writes: string[];
  execution_schema_writes: string[];
  run_response_writes: string[];
  features: {
    execution_generation: boolean;
    core_execution_lease: boolean;
    execution_handoff: boolean;
    session_statusless: boolean;
    legacy_session_aliases: boolean;
    [feature: string]: boolean;
  };
  [field: string]: unknown;
}

export interface RunCliNegotiatedSupport {
  execution_generation: boolean;
  core_execution_lease: boolean;
  "run-response/1.1": boolean;
  "run-response/1.2": boolean;
  artifact_compatibility_v1: boolean;
  atomic_run_complete_seal: boolean;
  generation_scoped_seal_receipts: boolean;
}

/**
 * Session/Run minimal-state (plan B v3) capability flags, negotiated as a unit
 * (docs/session-run-minimal-state-architecture-20260812.md section 15).
 * All values are false unless structured negotiation succeeds.
 */
export interface RunCliV3Support {
  session_run_minimal_v3: boolean;
  entity_revision_cas: boolean;
  participant_identity: boolean;
  request_receipts_v2: boolean;
  /** True only when the core explicitly advertises `execution_lease: false`. */
  execution_lease_retired: boolean;
  /** True only when the core explicitly advertises `operation_registry: false`. */
  operation_registry_retired: boolean;
}

/**
 * Mutation protocol selected from the negotiated capabilities:
 * - `session-run-v3`: Session/Run entity-revision CAS (plan B; adapter pending).
 * - `execution-v2`: current execution-generation + core-lease protocol.
 * - `fail-closed`: neither protocol is complete; mutations must be refused.
 */
export type RunCliProtocol = "session-run-v3" | "execution-v2" | "fail-closed";

export interface RunCliCapabilities {
  commands: ReadonlySet<string>;
  /** Commands parsed from `session --help`; empty when the CLI has no session subcommand. */
  sessionCommands: ReadonlySet<string>;
  /** Commands parsed from `plan --help`; used for approved Plan publication capability detection. */
  planCommands: ReadonlySet<string>;
  /** Source and safety posture of the structured capability negotiation. */
  mode: RunCliCapabilityMode;
  /** Validated structured response; absent for legacy and fail-closed CLIs. */
  structured: MaestroCapabilitiesV10 | null;
  /** Explicit new-protocol support. All values are false unless structured negotiation succeeds. */
  support: Readonly<RunCliNegotiatedSupport>;
  /** Session/Run minimal-state (v3) capability flags. */
  v3: Readonly<RunCliV3Support>;
  /** Mutation protocol derived from support/v3; the v3 branch takes precedence. */
  protocol: RunCliProtocol;
  /** Diagnostic for legacy/fail-closed negotiation without exposing raw command output. */
  diagnostic: string | null;
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
  requestId?: string;
  executionId?: string;
  generation?: number;
  expectedExecutionRevision?: number;
  executionOwner?: string;
  ownerKind?: "pi" | "claude" | "codex" | "agy" | "manual";
  ownerEpoch?: number;
  leaseId?: string;
  actor?: string;
  reason?: string;
  evidence?: readonly string[];
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
    const negotiated = await this.probeStructuredCapabilities();
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
    this.detected = { commands, sessionCommands, planCommands, ...negotiated };
    return this.detected;
  }

  async supportsExecutionGeneration(): Promise<boolean> {
    return (await this.capabilities()).support.execution_generation;
  }

  async supportsCoreExecutionLease(): Promise<boolean> {
    return (await this.capabilities()).support.core_execution_lease;
  }

  async supportsRunResponseV11(): Promise<boolean> {
    return (await this.capabilities()).support["run-response/1.1"];
  }

  async supportsRunResponseV12(): Promise<boolean> {
    return (await this.capabilities()).support["run-response/1.2"];
  }

  async supportsArtifactCompatibility(): Promise<boolean> {
    const support = (await this.capabilities()).support;
    return support["run-response/1.2"] && support.artifact_compatibility_v1;
  }

  async supportsNewMutations(): Promise<boolean> {
    const support = (await this.capabilities()).support;
    return support.execution_generation
      && support.core_execution_lease
      && support["run-response/1.1"];
  }

  /**
   * Whether the core advertises the complete Session/Run minimal-state (v3)
   * capability set. The Pi v3 adapter is delivered in phase 2 of
   * docs/session-run-v3-action-plan-20260812.md; until then callers must
   * fail closed on v3-only cores instead of speaking the v2 lease protocol.
   */
  async supportsSessionRunMinimalV3(): Promise<boolean> {
    return (await this.capabilities()).protocol === "session-run-v3";
  }

  async protocol(): Promise<RunCliProtocol> {
    return (await this.capabilities()).protocol;
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
      ...(options.requestId ? ["--request-id", options.requestId] : []),
      ...(options.executionId ? ["--execution", options.executionId] : []),
      ...(options.generation !== undefined ? ["--generation", String(options.generation)] : []),
      ...(options.expectedExecutionRevision !== undefined
        ? ["--expected-execution-revision", String(options.expectedExecutionRevision)]
        : []),
      ...(options.executionOwner ? ["--execution-owner", options.executionOwner] : []),
      ...(options.ownerKind ? ["--owner-kind", options.ownerKind] : []),
      ...(options.ownerEpoch !== undefined ? ["--owner-epoch", String(options.ownerEpoch)] : []),
      ...(options.leaseId ? ["--lease-id", options.leaseId] : []),
      ...(options.actor ? ["--actor", options.actor] : []),
      ...(options.reason ? ["--reason", options.reason] : []),
      ...(options.evidence ?? []).flatMap((reference) => ["--evidence", reference]),
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
   * Raw argv passthrough for the run-control shell. The runner already uses the
   * canonical workflow root as cwd; only lifecycle command families also accept
   * an explicit --workflow-root option.
   */
  async exec(argv: readonly string[]): Promise<RunCliResult> {
    const family = argv[0];
    const acceptsWorkflowRoot = family === "run" || family === "session" || family === "execution"
      || family === "plan" || family === "artifact";
    const args = acceptsWorkflowRoot && !argv.some((argument) => argument === "--workflow-root")
      ? [...argv, "--workflow-root", this.workflowRoot]
      : [...argv];
    return argv.includes("--json") ? this.invokeRunResponse(args) : this.invoke(args);
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

  private async probeStructuredCapabilities(): Promise<Pick<
    RunCliCapabilities,
    "mode" | "structured" | "support" | "v3" | "protocol" | "diagnostic"
  >> {
    let result: RunCliResult;
    try {
      result = await this.runner(["capabilities", "--json"], this.workflowRoot);
    } catch (error) {
      return failClosedCapabilities(`capability probe failed: ${redactSensitiveText(errorMessage(error))}`);
    }
    if (result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (isMissingCapabilitiesCommand(output)) {
        return {
          mode: "legacy",
          structured: null,
          support: NO_NEW_PROTOCOL_SUPPORT,
          v3: NO_V3_SUPPORT,
          protocol: "fail-closed",
          diagnostic: "Installed Maestro CLI has no capabilities command; legacy read compatibility only",
        };
      }
      return failClosedCapabilities(`capability probe exited with code ${result.exitCode}`);
    }
    let input: unknown;
    try {
      input = JSON.parse(result.stdout) as unknown;
    } catch {
      return failClosedCapabilities("capability probe returned invalid JSON");
    }
    const parsed = maestroCapabilitiesV10Schema.safeParse(input);
    if (!parsed.success) {
      return failClosedCapabilities(
        `capability probe returned an unsupported or malformed response: ${parsed.error.issues.map(issueText).join("; ")}`,
      );
    }
    const structured = parsed.data as MaestroCapabilitiesV10;
    const writesExecutionV10 = structured.execution_schema_writes.includes("execution/1.0");
    const support = Object.freeze({
      execution_generation: writesExecutionV10 && structured.features.execution_generation,
      core_execution_lease: writesExecutionV10 && structured.features.core_execution_lease,
      "run-response/1.1": structured.run_response_writes.includes("run-response/1.1"),
      "run-response/1.2": structured.run_response_writes.includes("run-response/1.2"),
      artifact_compatibility_v1: structured.features.artifact_compatibility_v1 === true,
      atomic_run_complete_seal: structured.features.atomic_run_complete_seal === true,
      generation_scoped_seal_receipts: structured.features.generation_scoped_seal_receipts === true,
    });
    const v3 = negotiateV3Support(structured.features);
    return {
      mode: "structured",
      structured,
      support,
      v3,
      protocol: selectProtocol(support, v3),
      diagnostic: null,
    };
  }

  private async invoke(args: readonly string[]): Promise<RunCliResult> {
    let result: RunCliResult;
    try {
      result = await this.runner(args, this.workflowRoot);
    } catch (error) {
      throw commandFailure(args, null, errorMessage(error));
    }
    if (result.exitCode !== 0) {
      throw commandFailure(args, result.exitCode, result.stderr || result.stdout);
    }
    return result;
  }

  private async invokeRunResponse(args: readonly string[]): Promise<RunCliResult> {
    let result: RunCliResult;
    try {
      result = await this.runner(args, this.workflowRoot);
    } catch (error) {
      throw commandFailure(args, null, errorMessage(error));
    }
    if (result.exitCode === 0) return result;

    try {
      const envelope = parseRunResponse(result.stdout);
      if (envelope.ok || envelope.exit_code !== result.exitCode) {
        throw new Error("run-response exit parity mismatch");
      }
      const publicEnvelope = JSON.stringify(projectPublicRunResponse(envelope));
      return {
        ...result,
        argv: redactPrivateArgv(result.argv),
        stdout: redactPrivateArgvValues(publicEnvelope, args),
        stderr: redactPrivateArgvValues(redactSensitiveText(result.stderr), args),
      };
    } catch {
      throw commandFailure(args, result.exitCode, result.stderr || result.stdout);
    }
  }
}

const semver = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  "must be a semantic version",
);
const schemaVersionList = z.array(z.string().min(1));
const maestroCapabilitiesV10Schema = z.object({
  schema_version: z.literal("maestro-capabilities/1.0"),
  cli_version: semver,
  session_schema_writes: schemaVersionList,
  execution_schema_writes: schemaVersionList,
  run_response_writes: schemaVersionList,
  features: z.object({
    execution_generation: z.boolean(),
    core_execution_lease: z.boolean(),
    execution_handoff: z.boolean(),
    session_statusless: z.boolean(),
    legacy_session_aliases: z.boolean(),
  }).catchall(z.boolean()),
}).passthrough();

const NO_NEW_PROTOCOL_SUPPORT: Readonly<RunCliNegotiatedSupport> = Object.freeze({
  execution_generation: false,
  core_execution_lease: false,
  "run-response/1.1": false,
  "run-response/1.2": false,
  artifact_compatibility_v1: false,
  atomic_run_complete_seal: false,
  generation_scoped_seal_receipts: false,
});

const NO_V3_SUPPORT: Readonly<RunCliV3Support> = Object.freeze({
  session_run_minimal_v3: false,
  entity_revision_cas: false,
  participant_identity: false,
  request_receipts_v2: false,
  execution_lease_retired: false,
  operation_registry_retired: false,
});

function negotiateV3Support(features: MaestroCapabilitiesV10["features"]): Readonly<RunCliV3Support> {
  return Object.freeze({
    session_run_minimal_v3: features.session_run_minimal_v3 === true,
    entity_revision_cas: features.entity_revision_cas === true,
    participant_identity: features.participant_identity === true,
    request_receipts_v2: features.request_receipts_v2 === true,
    // Plan B section 15 requires v3 cores to advertise these as explicitly
    // false; an absent key means the core predates the v3 contract.
    execution_lease_retired: features.execution_lease === false,
    operation_registry_retired: features.operation_registry === false,
  });
}

function hasCompleteV3Support(v3: Readonly<RunCliV3Support>): boolean {
  return v3.session_run_minimal_v3
    && v3.entity_revision_cas
    && v3.participant_identity
    && v3.request_receipts_v2
    && v3.execution_lease_retired
    && v3.operation_registry_retired;
}

function selectProtocol(
  support: Readonly<RunCliNegotiatedSupport>,
  v3: Readonly<RunCliV3Support>,
): RunCliProtocol {
  if (hasCompleteV3Support(v3)) return "session-run-v3";
  if (support.execution_generation && support.core_execution_lease && support["run-response/1.1"]) {
    return "execution-v2";
  }
  return "fail-closed";
}

function failClosedCapabilities(diagnostic: string): Pick<
  RunCliCapabilities,
  "mode" | "structured" | "support" | "v3" | "protocol" | "diagnostic"
> {
  return {
    mode: "fail-closed",
    structured: null,
    support: NO_NEW_PROTOCOL_SUPPORT,
    v3: NO_V3_SUPPORT,
    protocol: "fail-closed",
    diagnostic,
  };
}

function isMissingCapabilitiesCommand(output: string): boolean {
  return /(?:unknown|unrecognized|invalid)\s+(?:command|subcommand)[^\r\n]*["'`]?capabilities["'`]?/i.test(output)
    || /(?:command|subcommand)[^\r\n]*["'`]?capabilities["'`]?(?:[^\r\n]*)not found/i.test(output);
}

function issueText(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "response";
  return `${path}: ${issue.message}`;
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
      env: {
        ...process.env,
        MAESTRO_PI_PACKAGE_ROOT: process.env.MAESTRO_PI_PACKAGE_ROOT ?? advertisedPiPackageRoot(),
      },
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

function commandFailure(args: readonly string[], exitCode: number | null, output: string): Error {
  const code = exitCode === null ? "" : ` (${exitCode})`;
  const diagnostic = redactPrivateArgvValues(redactSensitiveText(output), args);
  return new Error(`maestro ${redactPrivateArgv(args).join(" ")} failed${code}${diagnostic ? `: ${diagnostic}` : ""}`);
}

function redactPrivateArgv(argv: readonly string[]): string[] {
  let redactNext = false;
  const positionalHandoffToken = argv[0] === "execution" && argv[1] === "handoff" && argv[2] === "accept";
  return argv.map((argument, index) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (positionalHandoffToken && index === 3 && !argument.startsWith("-")) return "<redacted>";
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
    if (isPrivateFlag(flag)) {
      if (equalsAt >= 0) return `${flag}=<redacted>`;
      redactNext = true;
      return argument;
    }
    return redactSensitiveText(argument);
  });
}

function isPrivateFlag(flag: string): boolean {
  return flag === "--lease-id" || flag === "--handoff-key" || /^--[a-z0-9-]*token[a-z0-9-]*$/i.test(flag);
}

function redactPrivateArgvValues(text: string, argv: readonly string[]): string {
  let redacted = text;
  for (const secret of privateArgvValues(argv).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("<redacted>");
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    if (jsonEscaped !== secret) redacted = redacted.split(jsonEscaped).join("<redacted>");
  }
  return redacted;
}

function privateArgvValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  const positionalHandoffToken = argv[0] === "execution" && argv[1] === "handoff" && argv[2] === "accept";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (positionalHandoffToken && index === 3 && !argument.startsWith("-")) values.push(argument);
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
    if (!isPrivateFlag(flag)) continue;
    const value = equalsAt >= 0 ? argument.slice(equalsAt + 1) : argv[index + 1];
    if (value) values.push(value);
  }
  return [...new Set(values.filter((value) => value.length > 0))];
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\blease_claim\s*[:=]\s*\{[^\r\n}]*\}/gi, "lease_claim=<redacted>")
    .replace(/("(?:lease_id|[^"\\]*(?:token|handoff[_-]?key)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi, "$1\"<redacted>\"")
    .replace(/\b(lease_id|[a-z0-9_-]*(?:token|handoff[_-]?key)[a-z0-9_-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1=<redacted>")
    .replace(/(--(?:lease-id|handoff-key|[a-z0-9-]*token[a-z0-9-]*)(?:=|\s+))\S+/gi, "$1<redacted>");
}
