/**
 * Self-evolve extension entry — Phase 2A dry-run candidate signal collection.
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 *
 * Behavior (Phase 2A, default DISABLED — zero behavior impact):
 *   1. disabled until `PI_SELF_EVOLVE=1` (env), `.pi/self-evolve.json`
 *      `{ "enabled": true }` (config), or `/self-evolve on` (writes config).
 *   2. when enabled, listens to `agent_end` (count + cooldown) and
 *      `session_compact` (compaction summary) and produces *dry-run* candidate
 *      signals: trace-hash dedup, bounded evidence reference collection, and
 *      append-only JSONL under the global output root's suggestions dir
 *      (`~/.maestro/self-evolve/suggestions/<date>.jsonl`; env `SELF_EVOLVE_OUTPUT_DIR` overrides)
 *      (bounded to the most recent N daily files).
 *   3. NEVER stages, promotes, or writes knowledge — suggestions only.
 *      The `suggestion` field is a command template for a human/Phase 2B
 *      consumer; this extension never executes it.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  buildSuggestion,
  classifyCandidateType,
  compactDigest,
  dailySuggestionFileName,
  DEDUP_CAPACITY,
  DEFAULT_SELF_EVOLVE_CONFIG,
  envOverrideForSelfEvolve,
  formatConfigSummary,
  formatReviewSummary,
  formatSignalLine,
  formatStatusText,
  isPathInside,
  lastAssistantLine,
  makeTitle,
  normalizeSelfEvolveConfig,
  parseReviewVerdicts,
  parseSignalLines,
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
  staleSuggestionFiles,
  suggestionsDirPath,
  summarizeText,
  SELF_EVOLVE_ENV_FLAG,
  SELF_EVOLVE_OUTPUT_DIR_FLAG,
  SELF_EVOLVE_SKILL_FLAG,
  type CandidateType,
  type EvidenceRef,
  type FileOpsLike,
  type ReviewVerdict,
  type SelfEvolveConfig,
  type SelfEvolveCounters,
  type SelfEvolveReview,
  type SelfEvolveSignal,
  type SelfEvolveSource,
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SelfEvolveRuntimeState {
  /** Candidate signals written to suggestion files. */
  signals: number;
  /** Signals skipped by trace-hash dedup. */
  deduped: number;
  /** Signals skipped by cooldown or the per-session budget. */
  suppressed: number;
  /** Failed signal attempts (fs errors, path escape, …). */
  failures: number;
  lastError?: string;
  lastSource?: SelfEvolveSource;
}

function createSelfEvolveRuntimeState(): SelfEvolveRuntimeState {
  return { signals: 0, deduped: 0, suppressed: 0, failures: 0 };
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

  function effectiveEnabled(): boolean {
    return envOverride ?? config.enabled;
  }

  function resetSessionState(): void {
    agentEndCount = 0;
    sessionSignals = 0;
    lastSignalBySource = {};
    compactPrepCount = 0;
    pendingCompact = undefined;
  }

  function recordFailure(error: unknown): void {
    state.failures++;
    state.lastError = error instanceof Error ? error.message : String(error);
  }

  /** Snapshot of runtime counters for the status bar, command, and panel. */
  function buildCounters(): SelfEvolveCounters {
    return {
      signals: state.signals,
      deduped: state.deduped,
      suppressed: state.suppressed,
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
      ctx.ui.setStatus(SELF_EVOLVE_STATUS_KEY, formatStatusText(config, buildCounters()));
    } catch {
      // Status bar is cosmetic — never propagate.
    }
  }

  /** Tail the most recent suggestion files and parse the last N signals. */
  async function loadRecentSignals(limit: number): Promise<SelfEvolveSignal[]> {
    try {
      const dir = suggestionsDirPath(outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]));
      const names = (await readdir(dir))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort();
      const lines: string[] = [];
      for (const name of names.slice(-3)) {
        lines.push(...(await readFile(join(dir, name), "utf8")).split("\n"));
      }
      return parseSignalLines(lines).slice(-limit);
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
      suggestionsDir: suggestionsDirPath(outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG])),
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
    suggestion?: string;
    trigger?: { reason?: string; turnIndex?: number };
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
      suggestion: params.suggestion,
      trigger: params.trigger,
    });
    const outputRoot = outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]);
    const dir = suggestionsDirPath(outputRoot);
    // Defense-in-depth: the output root is global (env or ~/.maestro), but a
    // misconfigured env override must never redirect writes outside of it.
    if (!isPathInside(outputRoot, dir)) {
      throw new Error(`Self-evolve suggestions dir escaped the output root: ${dir}`);
    }
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const filePath = join(dir, dailySuggestionFileName());
    await writeFile(filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: PRIVATE_FILE_MODE,
    });
    sessionSignals++;
    state.signals++;
    lastSignalBySource[params.source] = Date.now();
    state.lastSource = params.source;
    await pruneSuggestionFiles(dir);
    updateStatusBar(params.ctx);
  }

  /** Best-effort retention: keep only the most recent `maxFiles` daily files. */
  async function pruneSuggestionFiles(dir: string): Promise<void> {
    try {
      const names = await readdir(dir);
      const stale = staleSuggestionFiles(names, config.maxFiles);
      await Promise.all(
        stale.map((name) => rm(join(dir, name), { force: true }).catch(() => undefined)),
      );
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
    await pruneSuggestionFiles(dir);
    return filePath;
  }

  /** Seed dedup from today's file so a restart doesn't duplicate candidates. */
  async function seedSeenHashes(): Promise<void> {
    const filePath = join(
      suggestionsDirPath(outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG])),
      dailySuggestionFileName(),
    );
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(filePath);
    } catch {
      return; // no suggestions yet
    }
    if (fileStat.size > SEED_FILE_MAX_BYTES) return;
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split("\n").filter(Boolean).slice(-128)) {
      try {
        const parsed = JSON.parse(line) as { traceHash?: unknown };
        if (typeof parsed.traceHash === "string") seenHashes.set(parsed.traceHash, Date.now());
      } catch {
        // skip malformed lines
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
      const evidence = buildEvidenceFromMessages(agentEnd.messages, config.maxEvidence);
      const assistantText = lastAssistantLine(digest);
      const summary = summarizeText(assistantText || digest);
      const title = makeTitle(summary);
      const candidateType = classifyCandidateType(`${summary}\n${title}`);
      void writeSignal({
        source: "agent_end",
        ctx,
        traceHash: hash,
        title,
        summary,
        evidence,
        candidateType,
        suggestion: buildSuggestion(candidateType, title),
        trigger: { turnIndex: agentEndCount },
      }).catch(recordFailure);
    } catch (error) {
      recordFailure(error);
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
      const candidateType = classifyCandidateType(summary);
      void writeSignal({
        source: "session_compact",
        ctx,
        traceHash: hash,
        title,
        summary: summarizeText(summary),
        evidence,
        candidateType,
        suggestion: buildSuggestion(candidateType, title),
        trigger: { reason: compact.reason },
      }).catch(recordFailure);
    } catch (error) {
      recordFailure(error);
    }
  });

  // -------------------------------------------------------------------------
  // Command
  // -------------------------------------------------------------------------

  pi.registerCommand("self-evolve", {
    description: "Self-evolve: /self-evolve [status|on|off|config [k=v ...|reset]|signals [N]|panel]",
    async handler(args: string, ctx) {
      await ensureWorkspaceConfig(ctx);
      const trimmed = args.trim();
      const [head, ...rest] = trimmed.split(/\s+/);
      const cmd = (head ?? "").toLowerCase();
      const source = configSourceLabel();

      if (cmd === "on") {
        config = { ...config, enabled: true };
        resetSessionState();
        await saveConfig(config, ctx.cwd);
        updateStatusBar(ctx);
        ctx.ui.notify(
          "Self-evolve enabled: dry-run candidate signals only — nothing is staged or promoted automatically.",
          "info",
        );
        return;
      }

      if (cmd === "off") {
        config = { ...config, enabled: false };
        resetSessionState();
        await saveConfig(config, ctx.cwd);
        updateStatusBar(ctx);
        ctx.ui.notify("Self-evolve disabled.", "info");
        return;
      }

      if (cmd === "config") {
        if (rest.length === 0) {
          ctx.ui.notify(formatConfigSummary(config, source, resolveSelfEvolveModel(ctx)), "info");
          return;
        }
        if (rest.length === 1 && rest[0].toLowerCase() === "reset") {
          config = { ...DEFAULT_SELF_EVOLVE_CONFIG, enabled: config.enabled };
          resetSessionState();
          await saveConfig(config, ctx.cwd);
          updateStatusBar(ctx);
          ctx.ui.notify(formatConfigSummary(config, source, resolveSelfEvolveModel(ctx)), "info");
          return;
        }
        // Set one or more key=value pairs (all-or-nothing on validation).
        let next = config;
        const errors: string[] = [];
        for (const pair of rest) {
          const eq = pair.indexOf("=");
          if (eq <= 0) {
            errors.push(`"${pair}" (expected key=value)`);
            continue;
          }
          const result = setConfigValue(next, pair.slice(0, eq), pair.slice(eq + 1));
          if (result.error) errors.push(result.error);
          else next = result.config;
        }
        if (errors.length > 0) {
          ctx.ui.notify(`Self-evolve config rejected: ${errors.join("; ")}`, "warning");
          return;
        }
        config = next;
        resetSessionState();
        await saveConfig(config, ctx.cwd);
        updateStatusBar(ctx);
        ctx.ui.notify(formatConfigSummary(config, source, resolveSelfEvolveModel(ctx)), "info");
        return;
      }

      if (cmd === "signals") {
        const limit = rest[0]
          ? Math.max(1, Math.min(50, Number.parseInt(rest[0], 10) || 10))
          : 10;
        const signals = await loadRecentSignals(limit);
        if (signals.length === 0) {
          ctx.ui.notify(
            "Self-evolve: no signals yet. Enable with /self-evolve on, then signals appear at agent_end / session_compact boundaries.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          `Self-evolve signals (${signals.length}):\n${signals.map(formatSignalLine).join("\n")}`,
          "info",
        );
        return;
      }

      if (cmd === "review") {
        const limit = rest[0]
          ? Math.max(1, Math.min(10, Number.parseInt(rest[0], 10) || 5))
          : 5;
        const signals = await loadRecentSignals(limit);
        if (signals.length === 0) {
          ctx.ui.notify("Self-evolve: no signals to review yet.", "info");
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
              task: buildReviewPrompt(signals),
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
          const review: SelfEvolveReview = {
            schemaVersion: 1,
            kind: "review",
            dryRun: true,
            createdAt: new Date().toISOString(),
            project: projectNameFor(ctx.cwd),
            model: selectedModel,
            signals: signals.length,
            verdicts: evaluation.verdict.verdicts,
          };
          const path = await writeReview(review);
          ctx.ui.notify(
            `${formatReviewSummary(review)}\n  → saved: ${path}`,
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

      if (cmd === "panel") {
        const panelView = await buildPanelView(ctx);
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          const overlay = new SelfEvolveOverlay({
            view: panelView,
            requestRender: () => tui.requestRender(),
            close: () => done(undefined),
            theme,
            onAction: async (action) => {
              if (action === "close") {
                done(undefined);
                return;
              }
              if (action === "refresh") {
                overlay.update(await buildPanelView(ctx));
              }
            },
          });
          return overlay;
        }, {
          overlay: true,
          overlayOptions: { anchor: "center", width: "78%", maxHeight: "85%" },
        });
        return;
      }

      // status (default)
      const lines = [
        `SELF-EVOLVE ${effectiveEnabled() ? "on" : "off"} (${source})`,
        "  mode: dry-run — candidate signals only, never stages or promotes knowledge",
        `  model: ${config.model ?? "auto"}${resolveSelfEvolveModel(ctx) && resolveSelfEvolveModel(ctx) !== config.model ? ` → ${resolveSelfEvolveModel(ctx)}` : ""} (Phase 2B LLM steps)`,
        `  cooldown: ${config.cooldownMs}ms · max ${config.maxSignalsPerSession} signals/session`,
        `  evidence: ${config.maxEvidence} refs · trace: ${config.maxTraceMessages} msgs / ${config.maxTraceChars} chars`,
        `  retention: keep ${config.maxFiles} daily files in ${suggestionsDirPath(outputDir ?? selfEvolveOutputRoot(process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG]))}`,
        `  signals: ${state.signals} written · deduped: ${state.deduped} · suppressed: ${state.suppressed}`,
        `  failures: ${state.failures}${state.lastError ? ` · last: ${state.lastError.slice(0, 200)}` : ""}`,
        state.lastSource
          ? `  last: ${state.lastSource}${lastSignalBySource[state.lastSource] ? ` · ${new Date(lastSignalBySource[state.lastSource]!).toLocaleTimeString()}` : ""}`
          : "  last: (none yet)",
        `  usage: /self-evolve config <key>=<value> (cooldownMs, maxSignalsPerSession, maxTraceChars, maxTraceMessages, maxEvidence, maxFiles, enabled) · signals [N] · panel`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
