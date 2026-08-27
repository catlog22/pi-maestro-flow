/**
 * Self-evolve extension entry — dry-run candidate signals (Phase 2A) +
 * auto-deposit (Phase 2B).
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 *
 * Behavior (default DISABLED — zero behavior impact):
 *   1. disabled until `PI_SELF_EVOLVE=1` (env), `.pi/self-evolve.json`
 *      `{ "enabled": true }` (config), or `/self-evolve on` (writes config).
 *   2. when enabled, listens to `agent_end` (count + cooldown) and
 *      `session_compact` (compaction summary) and produces *dry-run* candidate
 *      signals: trace-hash dedup, bounded evidence reference collection, and
 *      append-only JSONL under the global output root's suggestions dir
 *      (`~/.maestro/self-evolve/suggestions/<date>.jsonl`; env `SELF_EVOLVE_OUTPUT_DIR` overrides)
 *      (bounded to the most recent N daily files).
 *   3. `mode=dry-run` (default): suggestions only — the `suggestion` field is
 *      a command template for a human/Phase 2B consumer; never executed.
 *   4. `mode=auto-deposit`: after `/self-evolve review`, gate-passing signals
 *      are automatically staged via the explicit `maestro knowledge stage`
 *      CLI (cross-spawn, bounded output, process-tree termination on timeout),
 *      with a full audit ledger under `~/.maestro/self-evolve/deposits/`.
 *      Promotion stays manual (governance discipline) — auto-deposit only
 *      creates pending candidates.
 */

import { copyFile, access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { serializeTranscriptTail } from "../advisor/runtime.ts";
import { SelfEvolveOverlay, type SelfEvolveOverlayView } from "../tui/self-evolve-overlay.ts";
import {
  buildEvidenceFromFileOps,
  buildEvidenceFromMessages,
  buildReviewPrompt,
  buildSignal,
  buildStageCommandArgs,
  buildSuggestion,
  buildKnowledgeTitle,
  buildToolCallEvidence,
  classifyCandidateType,
  compactDigest,
  dailySuggestionFileName,
  DEDUP_CAPACITY,
  DEDUP_SEED_DAYS,
  DEFAULT_SELF_EVOLVE_CONFIG,
  depositFileName,
  depositsDirPath,
  envOverrideForSelfEvolve,
  filterSignalLines,
  formatConfigSummary,
  formatDepositSummary,
  formatReviewSummary,
  formatSignalLine,
  formatStageCommandLine,
  formatStatusText,
  isKnowledgeMoment,
  isNoiseTitle,
  isPathInside,
  isValidSignalId,
  lastAssistantLine,
  makeTitle,
  modeDescription,
  normalizeReviewVerdicts,
  normalizeSelfEvolveConfig,
  parseReviewVerdicts,
  parseSignalLines,
  parseStagedId,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  projectNameFor,
  reviewFileName,
  reviewsDirPath,
  REVIEW_OUTPUT_SCHEMA,
  SEED_FILE_MAX_BYTES,
  selfEvolveConfigPath,
  selfEvolveOutputRoot,
  setConfigValue,
  sha256Hex,
  signalEvidenceContent,
  signalIsActionable,
  staleSuggestionFiles,
  suggestionsDirPath,
  summarizeText,
  SELF_EVOLVE_ENV_FLAG,
  SELF_EVOLVE_OUTPUT_DIR_FLAG,
  SELF_EVOLVE_SKILL_FLAG,
  type CandidateType,
  type DepositRecord,
  type EvidenceRef,
  type FileOpsLike,
  type ToolCallEvidence,
  type ReviewVerdict,
  type SelfEvolveConfig,
  type SelfEvolveCounters,
  type SelfEvolveReview,
  type SelfEvolveSignal,
  type SelfEvolveSource,
  type StageExecutionResult,
} from "./runtime.ts";
import {
  buildEnrichmentInput,
  buildEnrichmentPrompt,
  canEnrich,
  DEFAULT_ENRICHMENT_BUDGET,
  ENRICHMENT_OUTPUT_SCHEMA,
  evidenceIdFor,
  formatEnrichmentLine,
  freshBudgetState,
  markSubmitted,
  parseEnrichmentRecord,
  parseEnrichmentResults,
  recordAttempt,
  resolveSignalCorpus,
  resultToRecord,
  selectEnrichment,
  type EnrichmentBudget,
  type EnrichmentBudgetState,
  type EnrichmentRecord,
  type EnrichmentResult,
  type ResolvedSignal,
} from "./enrichment.ts";
import { buildTrajectoryEpisodes, collectToolCallTimeline, type TrajectoryEpisode } from "./trajectory.ts";
import {
  buildSessionSummary,
  formatSessionSummaryLedgerLine as formatSummaryLedgerLine,
  formatSessionSummaryLine as formatSummaryLine,
  type SessionAccumulator,
  type SessionSummary,
  type ShutdownReason,
  shouldNudgeReview,
  reviewNudgeMessage,
} from "./session-summary.ts";
import crossSpawn from "cross-spawn";
import { reclaimOwnedProcessTree } from "../process/owned-process-tree.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Parse `signals [N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project p]`
 * arguments into a filter object. Unknown flags are ignored (non-fatal).
 */
function parseSignalFlags(args: readonly string[]): {
  limit?: number;
  since?: string;
  until?: string;
  project?: string;
} {
  const result: { limit?: number; since?: string; until?: string; project?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--since" || arg === "--until" || arg === "--project" || arg === "--limit") {
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        if (arg === "--since") result.since = value;
        else if (arg === "--until") result.until = value;
        else if (arg === "--project") result.project = value;
        else if (arg === "--limit") result.limit = Number.parseInt(value, 10) || undefined;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  const firstNumber = positional.find((p) => /^\d+$/.test(p));
  if (firstNumber && result.limit === undefined) {
    result.limit = Math.max(1, Math.min(50, Number.parseInt(firstNumber, 10) || 10));
  }
  return result;
}

interface SelfEvolveRuntimeState {
  /** Candidate signals written to suggestion files. */
  signals: number;
  /** Signals skipped by trace-hash dedup. */
  deduped: number;
  /** Signals skipped by cooldown or the per-session budget. */
  suppressed: number;
  /** Auto-deposited candidates in `auto-deposit` mode (deposit ledger writes). */
  deposits: number;
  /** Failed signal attempts (fs errors, path escape, …). */
  failures: number;
  lastError?: string;
  lastSource?: SelfEvolveSource;
}

function createSelfEvolveRuntimeState(): SelfEvolveRuntimeState {
  return { signals: 0, deduped: 0, suppressed: 0, deposits: 0, failures: 0 };
}

interface PendingCompactPrep {
  generation: number;
  fileOps: FileOpsLike | undefined;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

/** Status-bar segment key for the self-evolve indicator. */
const SELF_EVOLVE_STATUS_KEY = "self-evolve";

// ---------------------------------------------------------------------------
// Dry-run review: lazy teammate runtime (mirrors advisor's pattern)
// ---------------------------------------------------------------------------

const REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_DEADLINE_MS = 120_000;

interface SingleResultLike {
  agent: string;
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  model?: string;
  structuredOutput?: unknown;
  terminalStatus?: string;
}

interface RunTeammateParamsLike {
  tasks: Array<{
    agent?: string;
    prompt: string;
    taskType?: string;
    model?: string;
    fallbackModels?: string[];
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    timeoutMs?: number;
    outputSchema?: Record<string, unknown>;
  }>;
}

interface RunTeammateOptionsLike {
  baseCwd: string;
  signal?: AbortSignal;
}

type RunTeammateFn = (
  params: RunTeammateParamsLike,
  options: RunTeammateOptionsLike,
) => Promise<SingleResultLike[] | SingleResultLike>;

interface ReviewSupervisionApi {
  runSupervisedEvaluation: <T>(
    dispatch: (ctx: { task: string; signal?: AbortSignal; timeoutMs?: number; outputSchema?: Record<string, unknown> }) => Promise<SingleResultLike>,
    params: {
      task: string;
      timeoutMs?: number;
      deadlineMs?: number;
      outputSchema?: Record<string, unknown>;
      fallbackTextParser?: (text: string) => unknown;
      beforeVerdict?: (result: SingleResultLike) => string | undefined;
      maxFailures?: number;
      signal?: AbortSignal;
    },
  ) => Promise<{ ok: boolean; verdict?: T; reason?: string }>;
}

interface ReviewTeammateRuntime {
  supervision: ReviewSupervisionApi;
  runTeammate: RunTeammateFn;
}

let _reviewRuntime: ReviewTeammateRuntime | undefined;
let _reviewRuntimeResolved = false;

/** @internal Test seam for the dry-run review teammate runtime. */
export function setSelfEvolveReviewRuntimeForTest(
  runtime: ReviewTeammateRuntime | undefined,
): void {
  _reviewRuntime = runtime;
  _reviewRuntimeResolved = runtime !== undefined;
}

async function loadReviewTeammate(): Promise<ReviewTeammateRuntime | undefined> {
  if (_reviewRuntimeResolved) return _reviewRuntime;
  try {
    const supervision = await import("pi-maestro-teammate/v1/supervision") as unknown as ReviewSupervisionApi;
    const execution = await import("pi-maestro-teammate/v1/execution") as unknown as { runTeammate: RunTeammateFn };
    _reviewRuntime = { supervision, runTeammate: execution.runTeammate };
    _reviewRuntimeResolved = true;
    return _reviewRuntime;
  } catch {
    _reviewRuntimeResolved = true;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Auto-deposit stage executor (Phase 2B): spawns the maestro CLI per deposit.
// ---------------------------------------------------------------------------

const STAGE_TIMEOUT_MS = 60_000;
const STAGE_MAX_OUTPUT_BYTES = 1_000_000;

/** Executes `maestro knowledge stage <args>` and returns the raw result. */
type DepositExecutor = (
  args: readonly string[],
  opts: { cwd: string },
) => Promise<StageExecutionResult>;

let _depositExecutor: DepositExecutor | undefined;

/** @internal Test seam for the auto-deposit stage executor (mirrors the review runtime seam). */
export function setSelfEvolveDepositExecutorForTest(
  executor: DepositExecutor | undefined,
): void {
  _depositExecutor = executor;
}

/**
 * Real executor: repo-standard CLI semantics (same as `defaultRunner` in
 * `session/cli-adapter.ts`) — cross-spawn (safe `.cmd` handling on Windows),
 * bounded stdout/stderr buffers, process-tree termination on timeout, and
 * stdout/stderr error handlers. Kept local to self-evolve because the e2e
 * suite runs under `--experimental-strip-types` (cli-adapter uses parameter
 * properties, which strip-only mode rejects). Never rejects; failures surface
 * as a non-zero exitCode with the diagnostic in stderr.
 */
function defaultStageExecutor(
  args: readonly string[],
  opts: { cwd: string },
): Promise<StageExecutionResult> {
  return executeStageProcess(args, opts);
}

function executeStageProcess(
  args: readonly string[],
  opts: { cwd: string; executable?: string; timeoutMs?: number },
): Promise<StageExecutionResult> {
  const timeoutMs = opts.timeoutMs ?? STAGE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = crossSpawn(
      opts.executable ?? (process.platform === "win32" ? "maestro.cmd" : "maestro"),
      [...args],
      {
        cwd: opts.cwd,
        // POSIX group isolation only: stage remains owned and the group is
        // reclaimed before success or failure is reported.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: string | undefined;
    let reclamationStarted = false;
    let closeSeen = false;
    let normalExitCode: number | null = null;
    let normalReclamationComplete = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      child.stdout?.removeListener("error", onStreamError);
      child.stderr?.removeListener("data", onStderr);
      child.stderr?.removeListener("error", onStreamError);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    };
    const finish = (exitCode: number, message?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const capturedStderr = Buffer.concat(stderr).toString("utf8");
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: message ? `${message}${capturedStderr ? `\n${capturedStderr}` : ""}` : capturedStderr,
      });
    };
    const stopWith = (message: string): void => {
      if (failure !== undefined || settled || reclamationStarted) return;
      failure = message;
      reclamationStarted = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      void reclaimOwnedProcessTree(child, { label: "self-evolve stage CLI" }).then(
        () => finish(1, message),
        (error) => finish(1, `${message}; stage process-tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    };
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (failure !== undefined || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (outputBytes + buffer.byteLength > STAGE_MAX_OUTPUT_BYTES) {
        stopWith(`stage output exceeded ${STAGE_MAX_OUTPUT_BYTES} bytes`);
        return;
      }
      outputBytes += buffer.byteLength;
      target.push(buffer);
    };
    const finishNormalClose = (): void => {
      if (!closeSeen || !normalReclamationComplete || failure !== undefined || settled) return;
      finish(normalExitCode ?? 1);
    };
    const startNormalReclamation = (code: number | null): void => {
      if (failure !== undefined || settled || reclamationStarted) return;
      reclamationStarted = true;
      normalExitCode = code;
      clearTimeout(timer);
      void reclaimOwnedProcessTree(child, { label: "self-evolve stage CLI" }).then(
        () => {
          normalReclamationComplete = true;
          finishNormalClose();
        },
        (error) => finish(1, `stage command exited but process-tree cleanup was unconfirmed: ${error instanceof Error ? error.message : String(error)}`),
      );
    };
    const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
    const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
    const onStreamError = (error: Error): void => stopWith(`stage stream failed: ${error.message}`);
    const onError = (error: Error): void => {
      if (child.pid) stopWith(error.message);
      else finish(1, error.message);
    };
    const onExit = (code: number | null): void => startNormalReclamation(code);
    const onClose = (code: number | null): void => {
      closeSeen = true;
      startNormalReclamation(code);
      finishNormalClose();
    };
    const timer = setTimeout(
      () => stopWith(`stage command timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
    timer.unref?.();

    child.stdout?.on("data", onStdout);
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", onStreamError);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** @internal Focused process-lifecycle seam; production deposits use the same executor. */
export function executeSelfEvolveStageProcessForTest(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<StageExecutionResult> {
  return executeStageProcess(args, { ...options, executable });
}

function resolveDepositExecutor(): DepositExecutor {
  return _depositExecutor ?? defaultStageExecutor;
}

export default function registerSelfEvolve(pi: ExtensionAPI): void {
  let config: SelfEvolveConfig = { ...DEFAULT_SELF_EVOLVE_CONFIG };
  const state = createSelfEvolveRuntimeState();
  // Env flag force-override; takes precedence over the config file.
  const envOverride = envOverrideForSelfEvolve(process.env[SELF_EVOLVE_ENV_FLAG]);

  let configCwd: string | undefined;
  let configGeneration = 0;
  let configLoadPromise: Promise<void> | undefined;
  /** Global output root resolved once per session (env override or ~/.maestro). */
  let outputDir: string | undefined;

  // Bounded per-process trace-hash dedup (recency-refreshed LRU).
  const seenHashes = new Map<string, number>();
  // Session-scoped budget/cooldown state. Cooldown is per-source: agent_end
  // fires every turn, session_compact is inherently low-frequency, and a shared
  // cooldown would starve compact signals whenever a turn precedes a compaction.
  let agentEndCount = 0;
  let sessionSignals = 0;
  let lastSignalBySource: Partial<Record<SelfEvolveSource, number>> = {};
  let compactPrepCount = 0;
  let pendingCompact: PendingCompactPrep | undefined;
  // Phase 2: semantic enrichment budget state (per-session). Reset on reload.
  let enrichmentBudget: EnrichmentBudget = DEFAULT_ENRICHMENT_BUDGET;
  let enrichmentState: EnrichmentBudgetState = freshBudgetState();
  // Phase 4: session wrap/nudge flags (per-session). Reset on reload.
  let sessionWrapped = false;
  let reviewNudgedThisSession = false;

  function effectiveEnabled(): boolean {
    return envOverride ?? config.enabled;
  }

  function resetSessionState(): void {
    agentEndCount = 0;
    sessionSignals = 0;
    lastSignalBySource = {};
    compactPrepCount = 0;
    pendingCompact = undefined;
    enrichmentState = freshBudgetState();
    sessionWrapped = false;
    reviewNudgedThisSession = false;
  }

  /** Build a session accumulator from in-memory counters. */
  function currentSessionAccumulator(ctx: ExtensionContext): SessionAccumulator {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      project: projectNameFor(ctx.cwd),
      agentEndCount,
      signalsWritten: sessionSignals,
      deduped: state.deduped,
      suppressed: state.suppressed,
      failures: state.failures,
      enrichmentCallsUsed: enrichmentState.callsUsed,
      enrichmentCandidatesEnriched: enrichmentState.candidatesEnriched,
      enrichmentRescued: 0, // populated lazily when enrichments are loaded
    };
  }

  /** Write a session summary to the session-summaries ledger. */
  async function writeSessionSummary(summary: SessionSummary): Promise<void> {
    const outputRoot = resolvedOutputRoot();
    const dir = resolve(outputRoot, "session-summaries");
    if (!isPathInside(outputRoot, dir)) {
      throw new Error(`Self-evolve session-summaries dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, dailySuggestionFileName());
    await writeFile(filePath, `${formatSummaryLedgerLine(summary)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
  }

  /**
   * Phase 4: informational pending-review nudge. Counts this session's
   * unreviewed resolved signals and notifies once per session when the count
   * crosses the threshold. Never starts a review.
   */
  async function maybeNudgeReview(ctx: ExtensionContext): Promise<void> {
    if (reviewNudgedThisSession) return;
    const currentSessionId = ctx.sessionManager.getSessionId();
    const currentProject = projectNameFor(ctx.cwd);
    const resolved = await loadResolvedSignals();
    const reviewedIds = new Set<string>();
    for (const review of (await loadRecentReviews(config.maxReviewFiles))) {
      if (review.sessionId === currentSessionId && review.signalIds) {
        for (const id of review.signalIds) reviewedIds.add(id);
      }
    }
    const pending = resolved
      .filter((s) => s.sessionId === currentSessionId && s.project === currentProject)
      .filter(resolvedIsActionable)
      .filter((s) => !reviewedIds.has(s.id))
      .length;
    if (shouldNudgeReview(pending)) {
      reviewNudgedThisSession = true;
      try {
        ctx.ui.notify(reviewNudgeMessage(pending), "info");
      } catch {
        // best-effort
      }
    }
  }

  function recordFailure(error: unknown, ctx?: ExtensionContext): void {
    const firstFailure = state.failures === 0;
    state.failures++;
    state.lastError = error instanceof Error ? error.message : String(error);
    if (ctx) {
      // Surface the first failure immediately (status bar + one-shot notify),
      // so a silently failing collector is not mistaken for a healthy one.
      updateStatusBar(ctx);
      if (firstFailure) {
        try {
          ctx.ui.notify(`Self-evolve: signal collection failed — ${state.lastError.slice(0, 240)}`, "warning");
        } catch {
          // Notification is best-effort.
        }
      }
    }
  }

  /** Snapshot of runtime counters for the status bar, command, and panel. */
  function buildCounters(): SelfEvolveCounters {
    return {
      signals: state.signals,
      deduped: state.deduped,
      suppressed: state.suppressed,
      deposits: state.deposits,
      failures: state.failures,
      lastError: state.lastError,
      lastSource: state.lastSource,
      lastSignalAt: state.lastSource ? lastSignalBySource[state.lastSource] : undefined,
    };
  }

  /** Config source label for display (`config` vs `env(...)`). */
  function configSourceLabel(): string {
    return envOverride === undefined
      ? "config"
      : `env(${SELF_EVOLVE_ENV_FLAG}=${envOverride ? "1" : "0"})`;
  }

  /**
   * Resolve the Phase 2B model: explicit `config.model`, else the active
   * main-session model (`provider/id`). Mirrors advisor's resolveAdvisorModel.
   */
  function resolveSelfEvolveModel(ctx: ExtensionContext): string | undefined {
    if (config.model) return config.model;
    const current = ctx.model as { provider?: string; id?: string } | undefined;
    return current?.provider && current?.id ? `${current.provider}/${current.id}` : undefined;
  }

  /** Refresh the status-bar segment; never breaks event handlers on failure. */
  function updateStatusBar(ctx: ExtensionContext): void {
    try {
      ctx.ui.setStatus(SELF_EVOLVE_STATUS_KEY, formatStatusText(effectiveEnabled(), buildCounters()));
    } catch {
      // Status bar is cosmetic — never propagate.
    }
  }

  /** Resolved suggestions output dir (env override or ~/.maestro/self-evolve). */
  function resolvedSuggestionsDir(): string {
    return suggestionsDirPath(outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]));
  }

  /** Resolved global output root. */
  function resolvedOutputRoot(): string {
    return outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]);
  }

  /** Tail the most recent suggestion files and parse the last N signals. */
  async function loadRecentSignals(limit: number): Promise<SelfEvolveSignal[]> {
    return loadSignals({ limit });
  }

  /** Load all enrichment ledger records across the retention window. */
  async function loadEnrichmentRecords(): Promise<EnrichmentRecord[]> {
    try {
      const dir = resolve(resolvedOutputRoot(), "enrichments");
      const names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .slice(-config.maxFiles);
      const lines: string[] = [];
      for (const name of names) {
        lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
      }
      return parseEnrichmentLedgerLines(lines);
    } catch {
      return [];
    }
  }

  /** Parse enrichment ledger lines (newline-delimited JSON) into records. */
  function parseEnrichmentLedgerLines(lines: readonly string[]): EnrichmentRecord[] {
    const records: EnrichmentRecord[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = (JSON.parse(trimmed) as unknown);
        const parsed = parseEnrichmentRecord(rec);
        if (parsed) records.push(parsed);
      } catch {
        // skip malformed
      }
    }
    return records;
  }

  /**
   * Load raw signals and project them against the enrichment ledger into
   * resolved signals. Collisions (same id, different traceHash/sessionId) are
   * forced to heuristic_fallback. Resolved signals that were rescued from
   * `unknown` by a semantic enrichment become actionable (the enrichment
   * supplied a candidateType + title + summary).
   */
  async function loadResolvedSignals(limit?: number): Promise<ResolvedSignal[]> {
    const raw = await loadSignals({ limit });
    const records = await loadEnrichmentRecords();
    const selection = selectEnrichment(records);
    return resolveSignalCorpus(raw, selection);
  }

  /**
   * Load signals across daily suggestion files with optional range/project
   * filters. Without an explicit range the last `maxFiles` files are read
   * (the retention window); `since`/`until` extend to any date within retention.
   */
  async function loadSignals(opts: {
    limit?: number;
    since?: string;
    until?: string;
    project?: string;
  }): Promise<SelfEvolveSignal[]> {
    try {
      const dir = resolvedSuggestionsDir();
      const names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
      const inRange = names.filter((name) => {
        const day = name.slice(0, 10);
        if (opts.since && day < opts.since) return false;
        if (opts.until && day > opts.until) return false;
        return true;
      });
      const selected = opts.since || opts.until
        ? inRange
        : inRange.slice(-config.maxFiles);
      const lines: string[] = [];
      for (const name of selected) {
        lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
      }
      let signals = parseSignalLines(lines);
      if (opts.project) signals = signals.filter((s) => s.project === opts.project);
      if (opts.limit !== undefined) signals = signals.slice(-opts.limit);
      return signals;
    } catch {
      return [];
    }
  }

  /**
   * True when a resolved signal is actionable: either it has a stage template
   * (heuristic knowhow/spec) OR a semantic enrichment rescued it from
   * `unknown` by supplying a candidateType + title + summary.
   */
  function resolvedIsActionable(signal: ResolvedSignal): boolean {
    if (typeof signal.suggestion === "string" && signal.suggestion.length > 0) return true;
    if (signal.enrichmentStatus === "semantic" && signal.candidateType !== "unknown") return true;
    return false;
  }

  /**
   * Build a stage-command argv for a resolved signal. For semantically
   * rescued signals (no heuristic suggestion), synthesize the template from
   * the resolved fields so the governance pipeline can stage them.
   */
  function resolvedStageArgs(
    signal: ResolvedSignal,
    evidenceFile: string,
  ): string[] | undefined {
    if (signal.candidateType === "unknown") return undefined;
    // Reuse the existing heuristic suggestion when present.
    if (typeof signal.suggestion === "string" && signal.suggestion.length > 0) {
      return buildStageCommandArgs(signal, evidenceFile);
    }
    // Synthesize for rescued signals.
    if (signal.enrichmentStatus !== "semantic") return undefined;
    const type = signal.candidateType === "spec" ? "spec" : "knowhow";
    const refs = (signal.evidence ?? []).map((e) => e.ref).slice(0, 8).join(", ");
    const args = ["knowledge", "stage", type, signal.title, "--content-file", evidenceFile];
    args.push("--session", signal.sessionId);
    if (refs) args.push("--evidence", refs);
    return args;
  }

  /** Load the most recent review records (reverse chronological). */
  async function loadRecentReviews(limit: number): Promise<SelfEvolveReview[]> {
    try {
      const dir = reviewsDirPath(resolvedOutputRoot());
      const names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .slice(-config.maxReviewFiles);
      const lines: string[] = [];
      for (const name of names) {
        lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
      }
      const reviews: SelfEvolveReview[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<SelfEvolveReview>;
          if (parsed && parsed.kind === "review") reviews.push(parsed as SelfEvolveReview);
        } catch {
          // skip malformed lines
        }
      }
      return reviews.slice(-limit);
    } catch {
      return [];
    }
  }

  /** Shared panel view builder. */
  async function buildPanelView(ctx: ExtensionContext): Promise<SelfEvolveOverlayView> {
    return {
      source: configSourceLabel(),
      config,
      counters: buildCounters(),
      recentSignals: await loadRecentSignals(8),
      resolvedModel: resolveSelfEvolveModel(ctx),
      suggestionsDir: resolvedSuggestionsDir(),
    };
  }

  function isSeenHash(hash: string): boolean {
    if (seenHashes.has(hash)) {
      const seenAt = seenHashes.get(hash)!;
      seenHashes.delete(hash);
      seenHashes.set(hash, seenAt); // refresh recency
      return true;
    }
    seenHashes.set(hash, Date.now());
    if (seenHashes.size > DEDUP_CAPACITY) {
      const oldest = seenHashes.keys().next().value;
      if (oldest !== undefined) seenHashes.delete(oldest);
    }
    return false;
  }

  function signalDue(source: SelfEvolveSource): boolean {
    const last = lastSignalBySource[source];
    if (last === undefined) return true;
    return Date.now() - last >= config.cooldownMs;
  }

  // -------------------------------------------------------------------------
  // Config persistence
  // -------------------------------------------------------------------------

  function loadWorkspaceConfig(ctx: ExtensionContext): void {
    const generation = ++configGeneration;
    let cwd: string;
    try {
      // ctx.cwd asserts the extension context is still active; after a session
      // replacement the captured ctx is stale and the getter throws. Skip this
      // load — the next session_start re-runs it.
      cwd = ctx.cwd;
    } catch {
      return;
    }
    configCwd = cwd;
    outputDir = selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]);
    config = { ...DEFAULT_SELF_EVOLVE_CONFIG };
    const load = loadConfig(cwd).then((loaded) => {
      if (generation !== configGeneration || configCwd !== cwd) return;
      config = loaded;
      // Config load is async; session_start already rendered the default
      // (disabled) state. Refresh now so an enabled config shows EV● instead
      // of a stale EVOL off until the first agent_end.
      updateStatusBar(ctx);
    }).finally(() => {
      if (configLoadPromise === load) configLoadPromise = undefined;
    });
    configLoadPromise = load;
  }

  async function ensureWorkspaceConfig(ctx: ExtensionContext): Promise<void> {
    if (configCwd !== ctx.cwd) loadWorkspaceConfig(ctx);
    await configLoadPromise;
  }

  async function loadConfig(cwd: string): Promise<SelfEvolveConfig> {
    try {
      const raw = JSON.parse(await readFile(selfEvolveConfigPath(cwd), "utf8")) as
        | Partial<SelfEvolveConfig>
        | undefined;
      return normalizeSelfEvolveConfig(raw);
    } catch {
      return { ...DEFAULT_SELF_EVOLVE_CONFIG };
    }
  }

  async function saveConfig(value: SelfEvolveConfig, cwd: string): Promise<void> {
    const path = selfEvolveConfigPath(cwd);
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
  }

  // -------------------------------------------------------------------------
  // Suggestion writes
  // -------------------------------------------------------------------------

  async function writeSignal(params: {
    source: SelfEvolveSource;
    ctx: ExtensionContext;
    traceHash: string;
    title: string;
    summary: string;
    evidence: EvidenceRef[];
    candidateType: CandidateType;
    toolCalls?: ToolCallEvidence[];
    trigger?: { reason?: string; turnIndex?: number };
    /** Redacted digest used for enrichment input (Phase 2). */
    digest?: string;
    /** Trajectory episodes for enrichment input (Phase 2). */
    episodes?: TrajectoryEpisode[];
  }): Promise<void> {
    if (sessionSignals >= config.maxSignalsPerSession) {
      state.suppressed++;
      return;
    }
    const record: SelfEvolveSignal = buildSignal({
      source: params.source,
      sessionId: params.ctx.sessionManager.getSessionId(),
      traceHash: params.traceHash,
      title: params.title,
      summary: params.summary,
      evidence: params.evidence,
      candidateType: params.candidateType,
      project: projectNameFor(params.ctx.cwd),
      skill: process.env[SELF_EVOLVE_SKILL_FLAG]?.trim() || "general",
      model: resolveSelfEvolveModel(params.ctx),
      ...(params.toolCalls && params.toolCalls.length > 0 ? { toolCalls: params.toolCalls } : {}),
      ...(params.episodes && params.episodes.length > 0 ? { episodes: params.episodes } : {}),
      trigger: params.trigger,
    });
    // Persist the evidence file first so the stage template below is
    // copy-paste executable (no dead `<evidence-file>` placeholder).
    const suggestion = await writeSignalEvidence(record);
    const withSuggestion: SelfEvolveSignal = suggestion
      ? { ...record, suggestion }
      : record;
    const outputRoot = resolvedOutputRoot();
    const dir = suggestionsDirPath(outputRoot);
    // Defense-in-depth: the output root is global (env or ~/.maestro), but a
    // misconfigured env override must never redirect writes outside of it.
    if (!isPathInside(outputRoot, dir)) {
      throw new Error(`Self-evolve suggestions dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, dailySuggestionFileName());
    await writeFile(filePath, `${JSON.stringify(withSuggestion)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
    sessionSignals++;
    state.signals++;
    lastSignalBySource[params.source] = Date.now();
    state.lastSource = params.source;
    await pruneSignalFiles(dir);
    updateStatusBar(params.ctx);
    notifySignalWritten(params.ctx, params.title, params.candidateType, params.toolCalls);
    // Phase 2: in hybrid mode, fire-and-forget semantic enrichment. The
    // enrichment never blocks the signal write — it runs async and appends a
    // terminal record to the enrichment ledger. On any failure it writes a
    // `heuristic_fallback` so the raw signal stays usable.
    if (canEnrich(record, enrichmentBudget, enrichmentState)) {
      void enrichSignalAsync(record, params.digest, params.episodes, params.ctx).catch((error) =>
        recordFailure(error, params.ctx),
      );
    }
  }

  /**
   * Lightweight notify on every newly-written signal so the user sees what
   * self-evolve captured from the just-finished agent loop. One notify per
   * signal (no cross-signal throttle per the user choice "真写信号才弹");
   * suppressed/deduped/noise-filtered turns stay silent.
   */
  function notifySignalWritten(
    ctx: ExtensionContext,
    title: string,
    candidateType: CandidateType,
    toolCalls: ToolCallEvidence[] | undefined,
  ): void {
    try {
      const typeTag = candidateType === "unknown" ? "signal" : candidateType;
      const toolSummary = (toolCalls ?? [])
        .filter((call) => call.outcome !== "ok")
        .slice(0, 3)
        .map((call) => `${call.tool}:${call.outcome}${call.topic ? `(${call.topic})` : ""}`)
        .join(" ");
      const tail = toolSummary ? ` · ${toolSummary}` : "";
      const truncated = title.length > 80 ? `${title.slice(0, 77)}...` : title;
      ctx.ui.notify(`Self-evolve ${typeTag}: ${truncated}${tail} · /self-evolve signals`, "info");
    } catch {
      // Notification is best-effort — never fail the signal write path.
    }
  }

  /**
   * Phase 2: append an enrichment record (terminal) to the enrichment ledger.
   * The ledger lives at `{outputRoot}/enrichments/<date>.jsonl`, separate from
   * the suggestions JSONL so raw signals stay untouched.
   */
  async function appendEnrichmentRecord(record: EnrichmentRecord): Promise<void> {
    const outputRoot = resolvedOutputRoot();
    const dir = resolve(outputRoot, "enrichments");
    if (!isPathInside(outputRoot, dir)) {
      throw new Error(`Self-evolve enrichments dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, dailySuggestionFileName());
    await writeFile(filePath, `${formatEnrichmentLine(record)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
  }

  /**
   * Phase 2: fire-and-forget semantic enrichment of a freshly-written signal.
   * Runs the LLM via the same teammate supervision path as review, bounded by
   * the per-session enrichment budget and a hard timeout. On ANY failure
   * (model unavailable / timeout / budget / invalid output / unknown
   * evidence id) a `heuristic_fallback` record is appended so the raw signal
   * remains usable.
   */
  async function enrichSignalAsync(
    signal: SelfEvolveSignal,
    digest: string | undefined,
    episodes: Array<{ kind: string; tool: string; operation: string; outcomes: string[] }> | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    markSubmitted(signal.id, enrichmentState);
    const model = resolveSelfEvolveModel(ctx);
    const availableModels = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
    const fallback = (error: string): EnrichmentRecord => ({
      schemaVersion: 1,
      kind: "enrichment",
      signalId: signal.id,
      traceHash: signal.traceHash,
      sessionId: signal.sessionId,
      attempt: enrichmentState.callsUsed + 1,
      status: "heuristic_fallback",
      model,
      error,
      completedAt: new Date().toISOString(),
    });
    let record: EnrichmentRecord;
    if (!model || !availableModels.includes(model)) {
      record = fallback("enrichment model unavailable");
    } else {
      const runtime = await loadReviewTeammate();
      if (!runtime) {
        record = fallback("teammate runtime unavailable");
      } else {
        try {
          const input = buildEnrichmentInput(
            signal,
            digest ?? "",
            episodes ?? [],
          );
          const prompt = buildEnrichmentPrompt([input]);
          const availableIds = new Set(input.evidence.map((e) => e.id));
          const { supervision, runTeammate } = runtime;
          const evaluation = await supervision.runSupervisedEvaluation<EnrichmentResult[]>(
            async (dispatchContext) => {
              const results = await runTeammate(
                {
                  tasks: [{
                    agent: "analyst",
                    prompt: dispatchContext.task,
                    taskType: "analysis",
                    model,
                    fallbackModels: [],
                    thinking: "low",
                    timeoutMs: dispatchContext.timeoutMs ?? enrichmentBudget.semanticTimeoutMs,
                    outputSchema: dispatchContext.outputSchema,
                  }],
                },
                { baseCwd: ctx.cwd, signal: dispatchContext.signal },
              );
              const single = Array.isArray(results) ? results[0] : results;
              if (!single) throw new Error("enrichment returned no teammate result");
              return single;
            },
            {
              task: prompt,
              timeoutMs: enrichmentBudget.semanticTimeoutMs,
              deadlineMs: enrichmentBudget.semanticTimeoutMs * 2,
              outputSchema: ENRICHMENT_OUTPUT_SCHEMA,
              fallbackTextParser: (text) => ({ results: parseEnrichmentResults(text) } as { results: EnrichmentResult[] }),
              maxFailures: 0,
            },
          );
          if (!evaluation.ok || !evaluation.verdict || evaluation.verdict.length === 0) {
            record = fallback(evaluation.reason ?? "enrichment produced no result");
          } else {
            const result = evaluation.verdict[0];
            record = resultToRecord(result, signal, enrichmentState.callsUsed + 1, model, availableIds);
          }
        } catch (error) {
          record = fallback(
            error instanceof Error ? error.message : "enrichment failed",
          );
        }
      }
    }
    await appendEnrichmentRecord(record);
    recordAttempt(1, enrichmentState);
    // If the enrichment rescued an unknown signal, surface one aggregate notify
    // so the user knows a hybrid-mode capture happened.
    if (record.status === "semantic" && signal.candidateType === "unknown") {
      try {
        ctx.ui.notify(
          `Self-evolve hybrid: rescued ${record.candidateType ?? "signal"} · ${record.title?.slice(0, 80) ?? ""} · /self-evolve review`,
          "info",
        );
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Write the signal's markdown evidence file under `{outputRoot}/evidence/`
   * and build the executable stage template. Returns undefined for
   * non-actionable signals (unknown type → no stage suggestion).
   */
  async function writeSignalEvidence(signal: SelfEvolveSignal): Promise<string | undefined> {
    if (signal.candidateType === "unknown") return undefined;
    const outputRoot = resolvedOutputRoot();
    const evidenceDir = join(outputRoot, "evidence");
    if (!isPathInside(outputRoot, evidenceDir)) {
      throw new Error(`Self-evolve evidence dir escaped the output root: ${evidenceDir}`);
    }
    await mkdir(evidenceDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(evidenceDir, `${signal.id}.md`);
    await writeFile(filePath, `${signalEvidenceContent(signal)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    return buildSuggestion(signal.candidateType, signal.title, {
      evidenceFile: filePath,
      sessionId: signal.sessionId,
      runId: signal.runId,
      evidenceRefs: signal.evidence.map((entry) => entry.ref),
    });
  }

  /**
   * Best-effort retention: keep only the most recent N daily files. Instead of
   * deleting, stale files are moved into `{outputRoot}/archive/` (with a
   * timestamp suffix to avoid collisions) so collected signal corpus is never
   * silently destroyed — the review finding was that pruning deleted data
   * with no backup and no notification.
   */
  async function pruneSignalFiles(dir: string, maxFiles: number = config.maxFiles): Promise<void> {
    try {
      const names = await readdir(dir);
      const stale = staleSuggestionFiles(names, maxFiles);
      if (stale.length === 0) return;
      const archiveDir = join(resolvedOutputRoot(), "archive");
      await mkdir(archiveDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      for (const name of stale) {
        const from = join(dir, name);
        const to = join(archiveDir, `${name}.${Date.now()}.archived`);
        await rename(from, to).catch(async () => {
          // rename across devices — fall back to copy+remove.
          const { copyFile } = await import("node:fs/promises");
          await copyFile(from, to);
          await rm(from, { force: true });
        }).catch(() => undefined);
      }
    } catch {
      // Pruning must never fail the write that triggered it.
    }
  }

  /** Append a dry-run review record to the global reviews dir (never stages). */
  async function writeReview(review: SelfEvolveReview): Promise<string> {
    const root = outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]);
    const dir = reviewsDirPath(root);
    if (!isPathInside(root, dir)) {
      throw new Error(`Self-evolve reviews dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, reviewFileName());
    await writeFile(filePath, `${JSON.stringify(review)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
    // Reviews retention is independent of suggestions (longer by default).
    await pruneSignalFiles(dir, config.maxReviewFiles);
    return filePath;
  }

  /** Append a deposit audit record to the global deposits dir (auto-deposit mode). */
  async function writeDeposit(record: DepositRecord, ctx: ExtensionContext): Promise<string> {
    const root = outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]);
    const dir = depositsDirPath(root);
    if (!isPathInside(root, dir)) {
      throw new Error(`Self-evolve deposits dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, depositFileName());
    await writeFile(filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
    state.deposits++;
    updateStatusBar(ctx);
    // Deposit retention mirrors review retention (independent of suggestions).
    await pruneSignalFiles(dir, config.maxReviewFiles);
    return filePath;
  }

  /**
   * Auto-deposit one gate-passing signal: rebuild the stage argv (mirrors the
   * human-facing `suggestion` template), revalidate the signal id (path
   * safety), verify the evidence file exists, and execute
   * `maestro knowledge stage --json`. Every attempt writes a deposit ledger
   * record — success and failure alike (audit trail, never silent). Signals
   * already successfully deposited are skipped (idempotency). Returns
   * `{ path, exitCode }`, or undefined when skipped (non-actionable / dup).
   */
  async function depositSignal(
    signal: SelfEvolveSignal,
    ctx: ExtensionContext,
  ): Promise<{ path: string; exitCode: number } | undefined> {
    return depositResolvedSignal(signal as ResolvedSignal, ctx);
  }

  /**
   * Deposit a resolved signal. For semantically rescued signals (no heuristic
   * evidence file because the raw type was `unknown`), write the evidence file
   * from the resolved fields before staging.
   */
  async function depositResolvedSignal(
    signal: ResolvedSignal,
    ctx: ExtensionContext,
  ): Promise<{ path: string; exitCode: number } | undefined> {
    // Idempotency: never re-stage a signal that already deposited successfully.
    if ((await seedDepositedSignalIds()).has(signal.id)) return undefined;
    if (!isValidSignalId(signal.id)) {
      return writeDeposit(buildDepositRecord(signal, ctx, { exitCode: -1, error: `invalid signal id: ${signal.id}` }), ctx)
        .then((path) => ({ path, exitCode: -1 }));
    }
    const outputRoot = resolvedOutputRoot();
    const evidenceFile = join(outputRoot, "evidence", `${signal.id}.md`);
    // For semantically rescued signals (raw candidateType was unknown), the
    // heuristic collector never wrote an evidence file — write one now from
    // the resolved projection so `maestro knowledge stage --content-file` has
    // a real file to read.
    let evidenceMissing = false;
    try {
      await access(evidenceFile);
    } catch {
      evidenceMissing = true;
    }
    if (evidenceMissing && signal.enrichmentStatus === "semantic" && signal.candidateType !== "unknown") {
      try {
        await writeSignalEvidence(signal as SelfEvolveSignal);
        await access(evidenceFile);
        evidenceMissing = false;
      } catch {
        // leave evidenceMissing=true to fail-closed below
      }
    }
    const args = resolvedStageArgs(signal, evidenceFile);
    if (!args) return undefined;
    // `--json` gives a reliable `candidate_id` for the audit record; the
    // human-facing `suggestion` template stays as-is (execution detail only).
    const execArgs = [...args, "--json"];
    let exitCode: number;
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    if (evidenceMissing) {
      exitCode = -1;
      error = `evidence file missing: ${evidenceFile}`;
    } else {
      try {
        const result = await resolveDepositExecutor()(execArgs, { cwd: ctx.cwd });
        exitCode = result.exitCode;
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (execError) {
        exitCode = -1;
        error = execError instanceof Error ? execError.message : String(execError);
      }
    }
    const record = buildDepositRecord(signal, ctx, { exitCode, stdout, stderr, error });
    const path = await writeDeposit(record, ctx);
    if (exitCode === 0) (await seedDepositedSignalIds()).add(signal.id);
    return { path, exitCode };
  }

  /** Build the deposit audit record for one attempt (all outcomes). */
  function buildDepositRecord(
    signal: SelfEvolveSignal,
    ctx: ExtensionContext,
    outcome: { exitCode: number; stdout?: string; stderr?: string; error?: string },
  ): DepositRecord {
    const stdout = outcome.stdout ?? "";
    const stderr = outcome.stderr ?? "";
    const command = formatStageCommandLine([
      ...(buildStageCommandArgs(signal, join(resolvedOutputRoot(), "evidence", `${signal.id}.md`)) ?? []),
      "--json",
    ]);
    return {
      schemaVersion: 1,
      kind: "deposit",
      createdAt: new Date().toISOString(),
      project: signal.project ?? projectNameFor(ctx.cwd),
      mode: config.mode,
      signalId: signal.id,
      title: signal.title,
      candidateType: signal.candidateType,
      source: signal.source,
      ...(signal.sessionId ? { sessionId: signal.sessionId } : {}),
      ...(signal.runId ? { runId: signal.runId } : {}),
      command,
      exitCode: outcome.exitCode,
      ...(outcome.exitCode === 0 ? { stagedId: parseStagedId(stdout || stderr) } : {}),
      ...(outcome.error || (outcome.exitCode !== 0 && stderr.trim())
        ? { error: outcome.error ?? stderr.trim().slice(0, 300) }
        : {}),
    };
  }

  /**
   * Lazy seed of already-successfully-deposited signal ids from the ledger
   * (cross-restart idempotency; mirrors `seedSeenHashes`).
   */
  let _depositedSignalIds: Set<string> | undefined;
  async function seedDepositedSignalIds(): Promise<Set<string>> {
    if (_depositedSignalIds) return _depositedSignalIds;
    const ids = new Set<string>();
    for (const record of await loadRecentDeposits(200)) {
      if (record.exitCode === 0 && record.signalId) ids.add(record.signalId);
    }
    _depositedSignalIds = ids;
    return ids;
  }

  /** Load recent deposit records (oldest→newest within the retention window). */
  async function loadRecentDeposits(limit: number): Promise<DepositRecord[]> {
    try {
      const dir = depositsDirPath(resolvedOutputRoot());
      const names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .slice(-config.maxReviewFiles);
      const lines: string[] = [];
      for (const name of names) {
        lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
      }
      const records: DepositRecord[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<DepositRecord>;
          if (parsed && parsed.kind === "deposit") records.push(parsed as DepositRecord);
        } catch {
          // skip malformed lines
        }
      }
      return records.slice(-limit);
    } catch {
      return [];
    }
  }

  /** Seed dedup from the most recent daily files so a restart doesn't duplicate candidates. */
  async function seedSeenHashes(): Promise<void> {
    const dir = resolvedSuggestionsDir();
    let names: string[];
    try {
      names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .slice(-DEDUP_SEED_DAYS);
    } catch {
      return; // no suggestions yet
    }
    let bytes = 0;
    for (const name of names) {
      if (bytes > SEED_FILE_MAX_BYTES) break;
      let raw: string;
      try {
        raw = await readFile(join(dir, name), "utf8");
      } catch {
        continue;
      }
      bytes += raw.length;
      for (const line of raw.split("\n").filter(Boolean).slice(-128)) {
        try {
          const parsed = JSON.parse(line) as { traceHash?: unknown };
          if (typeof parsed.traceHash === "string") seenHashes.set(parsed.traceHash, Date.now());
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers (observation only — never cancel, mutate, or block)
  // -------------------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    loadWorkspaceConfig(ctx);
    resetSessionState();
    void seedSeenHashes().catch(() => undefined);
    updateStatusBar(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    if (!effectiveEnabled() || configCwd !== ctx.cwd) return;
    try {
      agentEndCount++;
      const agentEnd = event as AgentEndEvent;
      const digest = serializeTranscriptTail(
        agentEnd.messages,
        config.maxTraceMessages,
        config.maxTraceChars,
      );
      if (!digest.trim()) return;
      const hash = sha256Hex(digest);
      // Dedup before cooldown: an identical trace is a duplicate regardless of
      // timing; cooldown only gates genuinely new content. This keeps the
      // deduped/suppressed counters semantically accurate.
      if (isSeenHash(hash)) {
        state.deduped++;
        updateStatusBar(ctx);
        return;
      }
      if (!signalDue("agent_end")) {
        state.suppressed++;
        updateStatusBar(ctx);
        return;
      }
      const evidence = buildEvidenceFromMessages(agentEnd.messages, config.maxEvidence, (ref) => {
        // Conservative cross-project filter: drop only absolute paths outside cwd.
        // Relative paths are kept (cannot reliably distinguish a deep in-project
        // path like `packages/x/test/y.ts` from a foreign `routing.py` by shape
        // alone — existence checks over-aggress and lose 29% of in-project refs
        // in a monorepo). Review/stage remains the authoritative scope gate.
        const path = ref.replace(/:\d+$/, "");
        if (!isAbsolute(path)) return true;
        return !relative(ctx.cwd, resolve(path)).startsWith("..");
      });
      const toolCalls = buildToolCallEvidence(agentEnd.messages, config.maxEvidence);
      const assistantText = lastAssistantLine(digest);
      // Phase 1+2: tool trajectory (generic timeline + episodes) is computed up
      // front so the knowledge-focused title and the classifier both see it.
      const timeline = collectToolCallTimeline(agentEnd.messages, config.maxEvidence);
      const episodes = buildTrajectoryEpisodes(timeline);
      const summary = summarizeText(assistantText || digest);
      const title = buildKnowledgeTitle(toolCalls, episodes, assistantText, summary);
      // Collection-side quality filter: trace fragments / progress reports are
      // never candidates — drop at the source and count as suppressed.
      if (isNoiseTitle(title)) {
        state.suppressed++;
        updateStatusBar(ctx);
        return;
      }
      // Phase 2C: tool trajectory feeds the classifier so a browser/computer_use
      // failure mode biases toward knowhow (pitfall) and carries a tools hint.
      const toolCallHint = toolCalls
        .filter((call) => call.outcome !== "ok")
        .map((call) => `${call.tool} ${call.outcome} ${call.action ?? ""} ${call.topic ?? ""}`)
        .join(" ");
      const episodeHint = episodes
        .filter((ep) => ep.kind !== "success")
        .map((ep) => `${ep.tool} ${ep.kind} ${ep.operation}`)
        .join(" ");
      const toolHint = [toolCallHint, episodeHint].filter(Boolean).join(" ");
      const candidateType = classifyCandidateType(`${summary}\n${title}${toolHint ? `\n${toolHint}` : ""}`);
      // Knowledge-moment gate: drop turns with no knowledge signal (no failure,
      // no reflective lexicon, no classifier hit) at the source. Replaces the
      // prior unknown+failure gate with the lexicon-aware isKnowledgeMoment.
      if (!isKnowledgeMoment(toolCalls, episodes, assistantText, candidateType)) {
        state.suppressed++;
        updateStatusBar(ctx);
        return;
      }
      void writeSignal({
        source: "agent_end",
        ctx,
        traceHash: hash,
        title,
        summary,
        evidence,
        candidateType,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        digest,
        episodes,
        trigger: { turnIndex: agentEndCount },
      }).catch((error) => recordFailure(error, ctx));
    } catch (error) {
      recordFailure(error, ctx);
    }
  });

  // Stash the compaction's file operations for evidence at session_compact.
  // Never returns a value, so this handler can never cancel the compaction.
  pi.on("session_before_compact", (event) => {
    if (!effectiveEnabled()) return;
    try {
      const before = event as SessionBeforeCompactEvent;
      compactPrepCount++;
      pendingCompact = {
        generation: compactPrepCount,
        fileOps: before.preparation.fileOps,
        reason: before.reason,
      };
    } catch {
      // Observation only — never break the compaction path.
    }
  });

  pi.on("session_compact", (event, ctx) => {
    if (!effectiveEnabled() || configCwd !== ctx.cwd) return;
    try {
      const compact = event as SessionCompactEvent;
      const summary = compact.compactionEntry.summary ?? "";
      // Consume only the stash produced by the immediately preceding
      // session_before_compact; anything older is stale.
      const fileOps = pendingCompact?.generation === compactPrepCount
        ? pendingCompact.fileOps
        : undefined;
      pendingCompact = undefined;
      const digest = compactDigest(summary, fileOps, config.maxTraceChars);
      if (!digest.trim()) return;
      const hash = sha256Hex(digest);
      if (isSeenHash(hash)) {
        state.deduped++;
        updateStatusBar(ctx);
        return;
      }
      if (!signalDue("session_compact")) {
        state.suppressed++;
        updateStatusBar(ctx);
        return;
      }
      const evidence = buildEvidenceFromFileOps(fileOps, config.maxEvidence);
      const title = makeTitle(summary);
      if (isNoiseTitle(title)) {
        state.suppressed++;
        updateStatusBar(ctx);
        return;
      }
      const candidateType = classifyCandidateType(summary);
      void writeSignal({
        source: "session_compact",
        ctx,
        traceHash: hash,
        title,
        summary: summarizeText(summary),
        evidence,
        candidateType,
        trigger: { reason: compact.reason },
      }).catch((error) => recordFailure(error, ctx));
      // Phase 4: low-frequency pending-review nudge (informational — never
      // auto-runs a review).
      void maybeNudgeReview(ctx).catch(() => undefined);
    } catch (error) {
      recordFailure(error, ctx);
    }
  });

  // Phase 4: session shutdown — reason-aware state-only receipt. Never
  // starts an LLM, review, or stage; only snapshots counters, writes a
  // session summary (or checkpoint for reload), and best-effort notifies.
  pi.on("session_shutdown", (event, ctx) => {
    if (!effectiveEnabled() || configCwd !== ctx.cwd) return;
    try {
      const shutdown = event as { type: string; reason: ShutdownReason };
      if (shutdown.type !== "session_shutdown") return;
      const reason = shutdown.reason;
      const acc = currentSessionAccumulator(ctx);
      const summary = buildSessionSummary(acc, reason, {
        wrapped: sessionWrapped,
      });
      void writeSessionSummary(summary).catch(() => undefined);
      sessionWrapped = true;
      try {
        ctx.ui.notify(formatSummaryLine(summary), "info");
      } catch {
        // best-effort
      }
    } catch (error) {
      recordFailure(error, ctx);
    }
  });

  pi.registerCommand("self-evolve", {
    description: "Self-evolve: /self-evolve (editable panel, default) | status | on | off | config [k=v ...|reset] | signals [N|delete <id>|clear|export] | review [N] | reviews [N] | deposits [N]",
    async handler(args: string, ctx) {
      await ensureWorkspaceConfig(ctx);
      const trimmed = args.trim();
      const [head, ...rest] = trimmed.split(/\s+/);
      const cmd = (head ?? "").toLowerCase();
      const source = configSourceLabel();

      if (cmd === "on") {
        const next = { ...config, enabled: true };
        try {
          await saveConfig(next, ctx.cwd);
        } catch (error) {
          ctx.ui.notify(`Self-evolve: config 保存失败 — ${error instanceof Error ? error.message : String(error)}`, "warning");
          return;
        }
        config = next;
        resetSessionState();
        updateStatusBar(ctx);
        ctx.ui.notify(
          config.mode === "auto-deposit"
            ? "Self-evolve enabled (auto-deposit): review gate-passing candidates are auto-staged into the pending pool — promotion stays manual."
            : "Self-evolve enabled: dry-run candidate signals only — nothing is staged or promoted automatically.",
          "info",
        );
        return;
      }

      if (cmd === "off") {
        const next = { ...config, enabled: false };
        try {
          await saveConfig(next, ctx.cwd);
        } catch (error) {
          ctx.ui.notify(`Self-evolve: config 保存失败 — ${error instanceof Error ? error.message : String(error)}`, "warning");
          return;
        }
        config = next;
        resetSessionState();
        updateStatusBar(ctx);
        ctx.ui.notify("Self-evolve disabled.", "info");
        return;
      }

      if (cmd === "config") {
        if (rest.length === 0) {
          ctx.ui.notify(formatConfigSummary(config, source, { resolvedModel: resolveSelfEvolveModel(ctx), enabled: effectiveEnabled(), suggestionsDir: resolvedSuggestionsDir() }), "info");
          return;
        }
        if (rest.length === 1 && rest[0].toLowerCase() === "reset") {
          const next = { ...DEFAULT_SELF_EVOLVE_CONFIG, enabled: config.enabled };
          try {
            await saveConfig(next, ctx.cwd);
          } catch (error) {
            ctx.ui.notify(`Self-evolve: config 保存失败 — ${error instanceof Error ? error.message : String(error)}`, "warning");
            return;
          }
          config = next;
          resetSessionState();
          updateStatusBar(ctx);
          ctx.ui.notify(formatConfigSummary(config, source, { resolvedModel: resolveSelfEvolveModel(ctx), enabled: effectiveEnabled(), suggestionsDir: resolvedSuggestionsDir() }), "info");
          return;
        }
        // Set one or more key=value pairs (all-or-nothing on validation).
        let next = config;
        const errors: string[] = [];
        let nextCaptureMode = enrichmentBudget.captureMode;
        for (const pair of rest) {
          const eq = pair.indexOf("=");
          if (eq <= 0) {
            errors.push(`"${pair}" (expected key=value)`);
            continue;
          }
          const key = pair.slice(0, eq);
          const value = pair.slice(eq + 1);
          // captureMode is an enrichment-budget setting (not persisted in
          // SelfEvolveConfig) — handle it here so users toggle hybrid mode.
          if (key === "captureMode") {
            if (value !== "heuristic" && value !== "hybrid") {
              errors.push(`captureMode must be "heuristic" or "hybrid" (got "${value}")`);
            } else {
              nextCaptureMode = value;
            }
            continue;
          }
          const result = setConfigValue(next, key, value);
          if (result.error) errors.push(result.error);
          else next = result.config;
        }
        if (errors.length > 0) {
          ctx.ui.notify(`Self-evolve config rejected: ${errors.join("; ")}`, "warning");
          return;
        }
        try {
          await saveConfig(next, ctx.cwd);
        } catch (error) {
          ctx.ui.notify(`Self-evolve: config 保存失败 — ${error instanceof Error ? error.message : String(error)}`, "warning");
          return;
        }
        config = next;
        if (nextCaptureMode !== enrichmentBudget.captureMode) {
          enrichmentBudget = { ...enrichmentBudget, captureMode: nextCaptureMode };
          // Resetting the enrichment budget state on a mode switch gives a
          // clean budget window for the new mode.
          enrichmentState = freshBudgetState();
        }
        resetSessionState();
        updateStatusBar(ctx);
        ctx.ui.notify(formatConfigSummary(config, source, { resolvedModel: resolveSelfEvolveModel(ctx), enabled: effectiveEnabled(), suggestionsDir: resolvedSuggestionsDir() }), "info");
        return;
      }

      if (cmd === "signals") {
        const sub = rest[0]?.toLowerCase();
        const signalsDir = resolvedSuggestionsDir();
        if (sub === "delete") {
          const prefixes = rest.slice(1).filter((prefix) => prefix.trim().length > 0);
          if (prefixes.length === 0) {
            ctx.ui.notify(
              "Usage: /self-evolve signals delete <se-id-prefix...> (e.g. se-3f2a1b9c0d4e; ids shown by /self-evolve signals)",
              "info",
            );
            return;
          }
          let total = 0;
          let touched = 0;
          try {
            const names = (await readdir(signalsDir))
              .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
              .sort();
            for (const name of names) {
              const path = join(signalsDir, name);
              const lines = (await readFile(path, "utf8")).split("\n");
              const { kept, deleted } = filterSignalLines(lines, prefixes);
              if (deleted === 0) continue;
              await writeFile(path, kept.join("\n"), "utf8");
              total += deleted;
              touched += 1;
            }
          } catch {
            // Directory may not exist yet — treated as zero matches.
          }
          ctx.ui.notify(
            total > 0
              ? `Self-evolve: deleted ${total} signal(s) across ${touched} file(s).`
              : `Self-evolve: no signals matched ${prefixes.join(", ")}.`,
            total > 0 ? "info" : "warning",
          );
          return;
        }
        if (sub === "clear") {
          let total = 0;
          let touched = 0;
          try {
            const names = (await readdir(signalsDir))
              .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
              .sort();
            for (const name of names) {
              const path = join(signalsDir, name);
              const lines = (await readFile(path, "utf8")).split("\n");
              const kept = lines.filter((line) => !line.trim());
              if (kept.length === lines.length) continue;
              await writeFile(path, kept.join("\n"), "utf8");
              total += lines.length - kept.length;
              touched += 1;
            }
          } catch {
            // Directory may not exist yet — nothing to clear.
          }
          ctx.ui.notify(
            total > 0
              ? `Self-evolve: cleared ${total} signal(s) across ${touched} file(s).`
              : "Self-evolve: no signals to clear.",
            total > 0 ? "info" : "warning",
          );
          return;
        }
        if (sub === "export") {
          const args2 = parseSignalFlags(rest.slice(1));
          const signals = await loadSignals({
            limit: args2.limit,
            since: args2.since,
            until: args2.until,
            project: args2.project,
          });
          if (signals.length === 0) {
            ctx.ui.notify("Self-evolve: no signals to export.", "warning");
            return;
          }
          const exportDir = join(resolvedOutputRoot(), "exports");
          await mkdir(exportDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
          const exportPath = join(exportDir, `signals-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
          await writeFile(exportPath, signals.map((s) => JSON.stringify(s)).join("\n") + "\n", {
            encoding: "utf8",
            mode: PRIVATE_FILE_MODE,
          });
          ctx.ui.notify(`Self-evolve: exported ${signals.length} signal(s) → ${exportPath}`, "info");
          return;
        }
        // `signals [N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <p>]`
        const flags = parseSignalFlags(rest);
        const signals = await loadSignals({
          limit: flags.limit,
          since: flags.since,
          until: flags.until,
          project: flags.project,
        });
        if (signals.length === 0) {
          ctx.ui.notify(
            "Self-evolve: no signals yet. Enable with /self-evolve on, then signals appear at agent_end / session_compact boundaries.",
            "info",
          );
          return;
        }
        const windowNote = flags.since || flags.until ? "" : ` (last ${config.maxFiles} daily files)`;
        ctx.ui.notify(
          `Self-evolve signals (${signals.length}${windowNote}):\n${signals.map(formatSignalLine).join("\n")}`,
          "info",
        );
        return;
      }

      if (cmd === "review") {
        // `/self-evolve review pending [N]` — session-scoped review of signals
        // not yet reviewed in the current session. Falls back to the global
        // `/self-evolve review [N]` behavior when `pending` is absent.
        const pending = rest[0]?.toLowerCase() === "pending";
        const limitNum = pending
          ? (rest[1] ? Math.max(1, Math.min(10, Number.parseInt(rest[1], 10) || 5)) : 5)
          : (rest[0] ? Math.max(1, Math.min(10, Number.parseInt(rest[0], 10) || 5)) : 5);
        const allResolved = await loadResolvedSignals(limitNum * 3);
        // Non-actionable signals (no stage template AND not semantically
        // rescued) are excluded from the review set.
        let signals = allResolved.filter(resolvedIsActionable);
        let nonActionableSkipped = allResolved.length - signals.length;
        const currentSessionId = ctx.sessionManager.getSessionId();
        const currentProject = projectNameFor(ctx.cwd);
        if (pending) {
          // Exclude signals already covered by a prior review in this session.
          const reviewedIds = new Set<string>();
          for (const review of (await loadRecentReviews(config.maxReviewFiles))) {
            if (review.sessionId === currentSessionId && review.signalIds) {
              for (const id of review.signalIds) reviewedIds.add(id);
            }
          }
          signals = signals
            .filter((s) => s.sessionId === currentSessionId && s.project === currentProject)
            .filter((s) => !reviewedIds.has(s.id));
          nonActionableSkipped = allResolved.length - signals.length;
        }
        const reviewSignals = signals.slice(-limitNum);
        if (signals.length === 0) {
          ctx.ui.notify(
            nonActionableSkipped > 0
              ? `Self-evolve: no actionable signals to review (${nonActionableSkipped} non-actionable skipped).`
              : "Self-evolve: no signals to review yet.",
            "info",
          );
          return;
        }
        const selectedModel = resolveSelfEvolveModel(ctx);
        const availableModels = ctx.modelRegistry.getAvailable()
          .map((model) => `${model.provider}/${model.id}`);
        if (!selectedModel || !availableModels.includes(selectedModel)) {
          ctx.ui.notify(
            `Self-evolve review: model unavailable: ${selectedModel ?? "auto (no main-session model)"}. Configure with /self-evolve config model=<provider>/<model>.`,
            "warning",
          );
          return;
        }
        const runtime = await loadReviewTeammate();
        if (!runtime) {
          ctx.ui.notify("Self-evolve review: teammate runtime unavailable (pi-maestro-teammate not installed).", "warning");
          return;
        }
        const { supervision, runTeammate } = runtime;
        try {
          const evaluation = await supervision.runSupervisedEvaluation<{ verdicts: ReviewVerdict[] }>(
            async (dispatchContext) => {
              const results = await runTeammate(
                {
                  tasks: [{
                    agent: "analyst",
                    prompt: dispatchContext.task,
                    taskType: "analysis",
                    model: selectedModel,
                    fallbackModels: [],
                    thinking: "low",
                    timeoutMs: dispatchContext.timeoutMs ?? REVIEW_TIMEOUT_MS,
                    outputSchema: dispatchContext.outputSchema,
                  }],
                },
                { baseCwd: ctx.cwd, signal: dispatchContext.signal },
              );
              const single = Array.isArray(results) ? results[0] : results;
              if (!single) throw new Error("Self-evolve review returned no teammate result");
              return single;
            },
            {
              task: buildReviewPrompt(reviewSignals, config.reviewScoreThreshold),
              timeoutMs: REVIEW_TIMEOUT_MS,
              deadlineMs: REVIEW_DEADLINE_MS,
              outputSchema: REVIEW_OUTPUT_SCHEMA,
              fallbackTextParser: (text) => parseReviewVerdicts(text),
              beforeVerdict: (result) => {
                if (result.exitCode !== 0) return `Review model exited with code ${result.exitCode}.`;
                if (result.terminalStatus === "failed" || result.terminalStatus === "terminated") {
                  return `Review model ${result.terminalStatus}.`;
                }
                return undefined;
              },
              maxFailures: 2,
            },
          );
          if (!evaluation.ok || !evaluation.verdict) {
            ctx.ui.notify(`Self-evolve review failed: ${evaluation.reason ?? "unknown"}`, "warning");
            return;
          }
          // Review-gate hardening: hallucinated ids dropped, low-score stages
          // downgraded to uncertain, non-actionable stages downgraded too.
          const actionableIds = new Set(reviewSignals.map((s) => s.id));
          const gate = normalizeReviewVerdicts(
            evaluation.verdict.verdicts,
            reviewSignals.map((s) => s.id),
            config.reviewScoreThreshold,
            actionableIds,
          );
          const review: SelfEvolveReview = {
            schemaVersion: 1,
            kind: "review",
            dryRun: config.mode === "dry-run",
            mode: config.mode,
            createdAt: new Date().toISOString(),
            project: projectNameFor(ctx.cwd),
            model: selectedModel,
            signals: reviewSignals.length,
            verdicts: gate.verdicts,
            droppedInvalid: gate.droppedInvalid,
            downgraded: gate.downgraded,
            nonActionableSkipped,
            sessionId: currentSessionId,
            signalIds: reviewSignals.map((s) => s.id),
          };
          // Phase 2B auto-deposit: in auto-deposit mode, stage every signal
          // that survived the review gate (`stage` verdict). Promotion stays
          // manual — auto-deposit only creates pending candidates. Cross-project
          // signals (from the global suggestions dir) are never deposited into
          // the current project's knowledge base; already-deposited signals are
          // skipped (idempotent).
          const depositedPaths: string[] = [];
          let depositAttempts = 0;
          let depositedCount = 0;
          if (config.mode === "auto-deposit") {
            const stageVerdicts = gate.verdicts.filter((v) => v.action === "stage");
            const staged = new Set(stageVerdicts.map((v) => v.id));
            const currentProject = projectNameFor(ctx.cwd);
            for (const signal of reviewSignals) {
              if (!staged.has(signal.id)) continue;
              if (signal.project !== currentProject) continue; // cross-project guard
              try {
                const result = await depositSignal(signal, ctx);
                if (result) {
                  depositAttempts += 1;
                  if (result.exitCode === 0) {
                    depositedPaths.push(result.path);
                    depositedCount += 1;
                  }
                }
              } catch (error) {
                recordFailure(error, ctx);
              }
            }
            review.deposited = depositedCount;
          }
          const path = await writeReview(review);
          const gateNote = [
            gate.droppedInvalid > 0 ? `${gate.droppedInvalid} invalid verdict id(s) dropped` : "",
            gate.downgraded > 0 ? `${gate.downgraded} low-score stage(s) downgraded` : "",
            nonActionableSkipped > 0 ? `${nonActionableSkipped} non-actionable skipped` : "",
          ].filter(Boolean).join(" · ");
          const depositNote = depositAttempts > 0
            ? `\n  deposit: ${depositedCount} staged · ${depositAttempts - depositedCount} failed (auto-deposit mode)`
            : "";
          ctx.ui.notify(
            `${formatReviewSummary(review)}${gateNote ? `\n  gate: ${gateNote}` : ""}${depositNote}\n  → saved: ${path}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `Self-evolve review failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }

      if (cmd === "reviews") {
        const limit = rest[0]
          ? Math.max(1, Math.min(30, Number.parseInt(rest[0], 10) || 5))
          : 5;
        const reviews = await loadRecentReviews(limit);
        if (reviews.length === 0) {
          ctx.ui.notify(
            "Self-evolve: no review records yet. Run /self-evolve review first.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          `Self-evolve review history (${reviews.length}):\n${reviews.map(formatReviewSummary).join("\n\n")}`,
          "info",
        );
        return;
      }

      if (cmd === "deposits") {
        const limit = rest[0]
          ? Math.max(1, Math.min(30, Number.parseInt(rest[0], 10) || 10))
          : 10;
        const records = await loadRecentDeposits(limit);
        if (records.length === 0) {
          ctx.ui.notify(
            "Self-evolve: no deposit records yet. Switch with /self-evolve config mode=auto-deposit, then run /self-evolve review.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          `Self-evolve deposit history (${records.length}):\n${records.map(formatDepositSummary).join("\n")}`,
          "info",
        );
        return;
      }

      if (cmd === "panel" || cmd === "") {
        const panelView = await buildPanelView(ctx);
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const overlay = new SelfEvolveOverlay({
            view: panelView,
            requestRender: () => tui.requestRender(),
            close: () => done(undefined),
            theme,
            onAction: async (action) => {
              if (action.type === "close") {
                done(undefined);
                return;
              }
              if (action.type === "refresh") {
                overlay.update(await buildPanelView(ctx));
                return;
              }
              if (action.type === "save") {
                // Persist first, then adopt the new config: a failed write must
                // leave the in-memory config and the panel untouched.
                await saveConfig(action.config, ctx.cwd);
                config = action.config;
                resetSessionState();
                updateStatusBar(ctx);
              }
            },
          });
          return overlay;
        }, {
          overlay: true,
          overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
        });
        return;
      }

      if (cmd === "wrap") {
        // `/self-evolve wrap` — manual session summary. Idempotent: a second
        // call in the same session refreshes the summary but stays marked
        // `wrapped`. Never starts an LLM/review/stage.
        const acc = currentSessionAccumulator(ctx);
        const summary = buildSessionSummary(acc, "quit", { wrapped: sessionWrapped });
        try {
          await writeSessionSummary(summary);
        } catch (error) {
          ctx.ui.notify(`Self-evolve wrap failed — ${error instanceof Error ? error.message : String(error)}`, "warning");
          return;
        }
        sessionWrapped = true;
        ctx.ui.notify(formatSummaryLine(summary), "info");
        return;
      }

      if (cmd === "status") {
        const model = resolveSelfEvolveModel(ctx);
        const lines = [
        `SELF-EVOLVE ${effectiveEnabled() ? "on" : "off"} (${source})`,
        `  mode: ${config.mode} — ${modeDescription(config.mode)}`,
        `  model: ${config.model ?? "auto"}${model && model !== config.model ? ` → ${model}` : ""} (Phase 2B LLM steps)`,
        `  cooldown: ${config.cooldownMs}ms · max ${config.maxSignalsPerSession} signals/session`,
        `  evidence: ${config.maxEvidence} refs · trace: ${config.maxTraceMessages} msgs / ${config.maxTraceChars} chars`,
        `  review gate: stage below score ${config.reviewScoreThreshold} downgraded to uncertain`,
        `  retention: keep ${config.maxFiles} daily signal files · ${config.maxReviewFiles} daily review files (stale archived)`,
        `  output: ${resolvedSuggestionsDir()}`,
        `  capture mode: ${enrichmentBudget.captureMode} · enrich budget: ${enrichmentState.callsUsed}/${enrichmentBudget.maxSemanticCallsPerSession} calls · ${enrichmentState.candidatesEnriched}/${enrichmentBudget.maxSemanticCandidatesPerSession} candidates`,
        `  signals: ${state.signals} written · deduped: ${state.deduped} · suppressed: ${state.suppressed} · deposits: ${state.deposits}`,
        `  failures: ${state.failures}${state.lastError ? ` · last: ${state.lastError.slice(0, 200)}` : ""}`,
        state.lastSource
          ? `  last: ${state.lastSource}${lastSignalBySource[state.lastSource] ? ` · ${new Date(lastSignalBySource[state.lastSource]!).toLocaleTimeString()}` : ""}`
          : "  last: (none yet)",
        `  usage: /self-evolve panel (editable: ↑↓ Enter Ctrl+S) · config <key>=<value> (enabled, mode, model, reviewScoreThreshold, cooldownMs, maxSignalsPerSession, maxTraceChars, maxTraceMessages, maxEvidence, maxFiles, maxReviewFiles, captureMode) · signals [N|--since d|--until d|--project p|delete <id>|clear|export] · review [N|pending [N]] · reviews [N] · deposits [N] · wrap`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

      // Unknown subcommand — surface usage instead of silently opening the panel.
      ctx.ui.notify(
        "Usage: /self-evolve [panel (default)|status|on|off|config [k=v ...|reset]|signals [N|delete <id>|clear|export|--since d --until d --project p]|review [N|pending [N]]|reviews [N]|deposits [N]|wrap]",
        "info",
      );
    },
  });
}
