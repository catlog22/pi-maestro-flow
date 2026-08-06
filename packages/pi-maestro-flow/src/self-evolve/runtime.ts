/**
 * Self-evolve runtime — pure logic for Phase 2A dry-run candidate signals.
 *
 * The self-evolve extension turns runtime traces into *suggestion* records
 * only. It never stages, promotes, or writes knowledge: every signal is a
 * dry-run candidate appended to `.pi/self-evolve/suggestions/<date>.jsonl`
 * for a human/Phase 2B governance step to review (see
 * `docs/self-evolution-plugin-design.md` §9, Phase 2A).
 *
 * This module is host-free and unit-testable; host wiring (events, config
 * persistence, filesystem writes) lives in `extension.ts`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redactAdvisorText } from "../advisor/runtime.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SELF_EVOLVE_SCHEMA_VERSION = 1;
/** Env flag that force-enables the extension (`PI_SELF_EVOLVE=1`). */
export const SELF_EVOLVE_ENV_FLAG = "PI_SELF_EVOLVE";
/** Env override for the global output root (absolute dir; default ~/.maestro/self-evolve). */
export const SELF_EVOLVE_OUTPUT_DIR_FLAG = "SELF_EVOLVE_OUTPUT_DIR";
/** Optional env hint for the active skill layer (per-skill bucketing in records). */
export const SELF_EVOLVE_SKILL_FLAG = "SELF_EVOLVE_SKILL";
export const SIGNAL_ID_PREFIX = "se-";
/** Bounded per-process dedup capacity for trace hashes. */
export const DEDUP_CAPACITY = 256;
/** Max bytes of a suggestion file we will seed dedup state from. */
export const SEED_FILE_MAX_BYTES = 1_000_000;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SelfEvolveConfig {
  /** Master switch; the extension only observes events while enabled. */
  enabled: boolean;
  /**
   * Model for Phase 2B LLM steps (candidate synthesis / review gate).
   * `provider/model` id, or `auto` / unset to inherit the main-session model.
   * Phase 2A itself is local-only and never calls a model.
   */
  model?: string;
  /** Minimum interval between candidate signals (ms). Default 5 min. */
  cooldownMs: number;
  /** Max candidate signals per session (per-session evaluation budget). */
  maxSignalsPerSession: number;
  /** Max serialized trace characters used for hashing/digests. */
  maxTraceChars: number;
  /** Max transcript tail messages included in the digest. */
  maxTraceMessages: number;
  /** Max evidence references collected per candidate. */
  maxEvidence: number;
  /** How many recent daily suggestion files to keep. Default 14 (2 weeks). */
  maxFiles: number;
}

export const DEFAULT_SELF_EVOLVE_CONFIG: SelfEvolveConfig = {
  enabled: false,
  cooldownMs: 300_000,
  maxSignalsPerSession: 20,
  maxTraceChars: 8_000,
  maxTraceMessages: 12,
  maxEvidence: 8,
  maxFiles: 14,
};

/** Model id shape `provider/model` (mirrors teammate model ids). */
export function isValidModelId(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim());
}

/** Merge persisted settings while preserving defaults and legacy files. */
export function normalizeSelfEvolveConfig(raw: Partial<SelfEvolveConfig> | undefined): SelfEvolveConfig {
  const defaults = DEFAULT_SELF_EVOLVE_CONFIG;
  const model = typeof raw?.model === "string" && raw.model.trim().length > 0
    ? raw.model.trim()
    : defaults.model;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : defaults.enabled,
    ...(model ? { model } : {}),
    cooldownMs: typeof raw?.cooldownMs === "number" && raw.cooldownMs >= 0
      ? raw.cooldownMs
      : defaults.cooldownMs,
    maxSignalsPerSession: typeof raw?.maxSignalsPerSession === "number"
      && Number.isInteger(raw.maxSignalsPerSession)
      && raw.maxSignalsPerSession > 0
      ? raw.maxSignalsPerSession
      : defaults.maxSignalsPerSession,
    maxTraceChars: typeof raw?.maxTraceChars === "number" && raw.maxTraceChars > 0
      ? raw.maxTraceChars
      : defaults.maxTraceChars,
    maxTraceMessages: typeof raw?.maxTraceMessages === "number"
      && Number.isInteger(raw.maxTraceMessages)
      && raw.maxTraceMessages > 0
      ? raw.maxTraceMessages
      : defaults.maxTraceMessages,
    maxEvidence: typeof raw?.maxEvidence === "number"
      && Number.isInteger(raw.maxEvidence)
      && raw.maxEvidence > 0
      ? raw.maxEvidence
      : defaults.maxEvidence,
    maxFiles: typeof raw?.maxFiles === "number"
      && Number.isInteger(raw.maxFiles)
      && raw.maxFiles > 0
      ? raw.maxFiles
      : defaults.maxFiles,
  };
}

/** Parse the `PI_SELF_EVOLVE` env flag; undefined when unset. */
export function envOverrideForSelfEvolve(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// ---------------------------------------------------------------------------
// Paths & hashing
// ---------------------------------------------------------------------------

/** Project-scoped config path (`.pi/self-evolve.json`), mirroring advisor. */
export function selfEvolveConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".pi", "self-evolve.json");
}

/**
 * Global output root for self-evolution artifacts (config stays project-scoped).
 *
 * Keeps daily suggestion files OUT of the project so runtime output never
 * pollutes git: `~/.maestro/self-evolve/` by default, overridable with the
 * `SELF_EVOLVE_OUTPUT_DIR` env var (absolute path).
 */
export function selfEvolveOutputRoot(
  envOutputDir: string | undefined = process.env[SELF_EVOLVE_OUTPUT_DIR_FLAG],
): string {
  const raw = envOutputDir?.trim();
  if (raw) return resolve(raw);
  return resolve(homedir(), ".maestro", "self-evolve");
}

/** Suggestions output dir under the global output root. */
export function suggestionsDirPath(outputRoot: string): string {
  return resolve(outputRoot, "suggestions");
}

/** Short project name for cross-project signal records (`basename(cwd)`). */
export function projectNameFor(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Local-time `YYYY-MM-DD` suggestion file name. */
export function dailySuggestionFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}.jsonl`;
}

/** Sort a directory listing of daily files and return the names to prune. */
export function staleSuggestionFiles(fileNames: readonly string[], maxFiles: number): string[] {
  const candidates = [...fileNames]
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  return candidates.slice(0, Math.max(0, candidates.length - maxFiles));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Trace digests & evidence
// ---------------------------------------------------------------------------

export type SelfEvolveSource = "agent_end" | "session_compact";
export type CandidateType = "knowhow" | "spec" | "unknown";

export interface EvidenceRef {
  type: "file" | "tool";
  ref: string;
  /** File evidence only: modified (written/edited) vs read. */
  role?: "read" | "modified";
}

/** Structural subset of the host's `FileOperations` (Set-based). */
export interface FileOpsLike {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
}

const FILE_REFERENCE_PATTERN = /\b([\w./-]+\.(?:ts|tsx|mjs|cjs|js|jsx|json|md|mdx|py|go|rs|css|scss|html|sh|yml|yaml|toml|txt|sql|java|kt|c|cpp|h|hpp|rb|php|vue|svelte|graphql|lock))(?::(\d+))?\b/gi;

/** Extract plausible file references (`path` or `path:line`) from text. */
export function extractFileReferences(text: string, max = 8): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    if (refs.length >= max) break;
    const path = match[1];
    if (!path) continue;
    const line = match[2];
    const ref = line ? `${path}:${line}` : path;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/** Collect bounded tool/file evidence from the transcript tail. */
export function buildEvidenceFromMessages(messages: AgentMessage[], max = 8): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  const seen = new Set<string>();
  const push = (ref: EvidenceRef): void => {
    const key = `${ref.type}:${ref.ref}`;
    if (evidence.length >= max || seen.has(key)) return;
    seen.add(key);
    evidence.push(ref);
  };
  for (const message of messages.slice(-64)) {
    const record = message as unknown as {
      role?: string;
      content?: unknown;
      name?: string;
      toolName?: string;
    };
    if (record.role === "tool" || record.role === "toolResult") {
      const toolName = record.name ?? record.toolName;
      if (toolName) push({ type: "tool", ref: toolName });
      const text = advisorMessageText(record);
      for (const ref of extractFileReferences(text, max)) push({ type: "file", ref });
    }
  }
  return evidence;
}

/** Collect bounded file evidence from a compaction's file operations. */
export function buildEvidenceFromFileOps(fileOps: FileOpsLike | undefined, max = 8): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  const seen = new Set<string>();
  const push = (ref: EvidenceRef): void => {
    const key = `${ref.type}:${ref.ref}`;
    if (evidence.length >= max || seen.has(key)) return;
    seen.add(key);
    evidence.push(ref);
  };
  if (!fileOps) return evidence;
  for (const path of fileOps.written ?? []) push({ type: "file", ref: path, role: "modified" });
  for (const path of fileOps.edited ?? []) push({ type: "file", ref: path, role: "modified" });
  for (const path of fileOps.read ?? []) push({ type: "file", ref: path, role: "read" });
  return evidence;
}

/** Render file operations as stable digest lines for trace hashing. */
export function fileOpsToLines(fileOps: FileOpsLike | undefined): string[] {
  if (!fileOps) return [];
  const lines: string[] = [];
  for (const path of fileOps.written ?? []) lines.push(`WRITTEN ${path}`);
  for (const path of fileOps.edited ?? []) lines.push(`EDITED ${path}`);
  for (const path of fileOps.read ?? []) lines.push(`READ ${path}`);
  return lines;
}

/** Bounded, redacted digest combining a compaction summary and file ops. */
export function compactDigest(summary: string, fileOps: FileOpsLike | undefined, maxChars: number): string {
  const parts: string[] = [];
  if (summary.trim()) parts.push(summary.trim());
  parts.push(...fileOpsToLines(fileOps));
  const joined = parts.join("\n");
  return joined.length <= maxChars
    ? redactAdvisorText(joined)
    : redactAdvisorText(joined.slice(0, maxChars));
}

/** Redact + collapse whitespace + truncate for human-readable summaries. */
export function summarizeText(text: string, max = 600): string {
  const clean = redactAdvisorText(text.replace(/\s+/g, " ").trim());
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** First non-empty digest line, truncated, for a candidate title. */
export function makeTitle(text: string, max = 120): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, Math.max(0, max - 1))}…`;
}

/** Last `ASSISTANT: ...` line of a serialized digest (used as a title source). */
export function lastAssistantLine(digest: string): string {
  const prefix = "ASSISTANT: ";
  for (const line of [...digest.split("\n")].reverse()) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return "";
}

/** Heuristic candidate type: knowhow (pitfalls/lessons) vs spec (decisions). */
export function classifyCandidateType(text: string): CandidateType {
  const lower = text.toLowerCase();
  const score = (hints: readonly string[]): number =>
    hints.reduce((total, hint) => total + (lower.includes(hint) ? 1 : 0), 0);
  const knowhow = score([
    "pitfall", "gotcha", "workaround", "trick", "lesson", "learned", "debug",
    "bug", "error", "failed", "failure", "issue", "fix", "root cause",
    "unexpected", "caused by",
  ]);
  const spec = score([
    "decision", "decided", "architecture", "architectural", "contract",
    "protocol", "design", "constraint", "requirement", "workflow", "schema",
    "interface", "api", "policy", "rule", "standard",
  ]);
  if (knowhow > spec) return "knowhow";
  if (spec > knowhow) return "spec";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Signal records
// ---------------------------------------------------------------------------

export interface SelfEvolveSignal {
  schemaVersion: number;
  /** `se-` + first 12 hex chars of the trace hash. */
  id: string;
  kind: "candidate";
  source: SelfEvolveSource;
  /** Phase 2A is dry-run only — never auto-applied. */
  dryRun: true;
  createdAt: string;
  sessionId: string;
  /** Project the signal was collected in (`basename(cwd)`). */
  project?: string;
  /** Skill layer hint (default `general`; env `SELF_EVOLVE_SKILL` overrides). */
  skill?: string;
  /** Resolved model at write time (Phase 3 independent-evidence checks). */
  model?: string;
  /** sha256 of the redacted trace digest; the cross-run dedup key. */
  traceHash: string;
  candidateType: CandidateType;
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  /** Stage-command template for a human/Phase 2B consumer. Never executed. */
  suggestion?: string;
  trigger?: { reason?: string; turnIndex?: number };
}

export function buildSignal(params: {
  source: SelfEvolveSource;
  sessionId: string;
  traceHash: string;
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  candidateType: CandidateType;
  project?: string;
  skill?: string;
  model?: string;
  suggestion?: string;
  trigger?: { reason?: string; turnIndex?: number };
}): SelfEvolveSignal {
  return {
    schemaVersion: SELF_EVOLVE_SCHEMA_VERSION,
    id: `${SIGNAL_ID_PREFIX}${params.traceHash.slice(0, 12)}`,
    kind: "candidate",
    source: params.source,
    dryRun: true,
    createdAt: new Date().toISOString(),
    sessionId: params.sessionId,
    ...(params.project ? { project: params.project } : {}),
    ...(params.skill && params.skill !== "general" ? { skill: params.skill } : {}),
    ...(params.model ? { model: params.model } : {}),
    traceHash: params.traceHash,
    candidateType: params.candidateType,
    title: params.title,
    summary: params.summary,
    evidence: params.evidence,
    ...(params.suggestion ? { suggestion: params.suggestion } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
  };
}

/** Stage-command template hinting the Phase 2B ingestion path. */
export function buildSuggestion(candidateType: CandidateType, title: string): string {
  const type = candidateType === "spec" ? "spec" : "knowhow";
  const escapedTitle = title.replace(/"/g, "\\\"");
  return `maestro knowledge stage ${type} "${escapedTitle}" --content-file <evidence-file> --run <run-id>`;
}

// ---------------------------------------------------------------------------
// TUI / command display helpers (pure, host-free)
// ---------------------------------------------------------------------------

/** Runtime counters surfaced to the status bar, command output, and panel. */
export interface SelfEvolveCounters {
  signals: number;
  deduped: number;
  suppressed: number;
  failures: number;
  lastError?: string;
  lastSource?: SelfEvolveSource;
  lastSignalAt?: number;
}

/** Config keys settable through `/self-evolve config <key>=<value>`. */
export const EDITABLE_CONFIG_KEYS = [
  "cooldownMs",
  "maxSignalsPerSession",
  "maxTraceChars",
  "maxTraceMessages",
  "maxEvidence",
  "maxFiles",
] as const;
export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];

const UNIT_SUFFIXES: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** Parse `<value>` with optional unit suffixes (`10m`, `5s`, `300000`). */
export function parseDurationMs(raw: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
  if (!match) return undefined;
  const number = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(number) || number < 0) return undefined;
  if (unit === "") return number;
  const multiplier = UNIT_SUFFIXES[unit];
  if (multiplier === undefined) return undefined;
  return number * multiplier;
}

/** Parse an integer config value; undefined when invalid. */
export function parseIntegerValue(raw: string): number | undefined {
  const match = /^\s*(\d+)\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Apply one editable config key from a raw string. Returns the new config
 * and an error when the key is unknown or the value is invalid.
 */
export function setConfigValue(
  config: SelfEvolveConfig,
  key: string,
  raw: string,
): { config: SelfEvolveConfig; error?: string } {
  const normalizedKey = key.trim();
  if (normalizedKey === "enabled") {
    const value = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(value)) {
      return { config: { ...config, enabled: true } };
    }
    if (["false", "0", "no", "off"].includes(value)) {
      return { config: { ...config, enabled: false } };
    }
    return { config, error: `enabled expects true/false (got "${raw.trim()}")` };
  }
  if (normalizedKey === "cooldownMs") {
    const parsed = parseDurationMs(raw);
    if (parsed === undefined) return { config, error: `cooldownMs expects a duration (e.g. 300000, 5m, 30s), got "${raw}"` };
    return { config: { ...config, cooldownMs: parsed } };
  }
  if (normalizedKey === "model") {
    const value = raw.trim();
    if (value === "" || ["auto", "inherit"].includes(value.toLowerCase())) {
      const { model: _drop, ...rest } = config;
      return { config: rest };
    }
    if (!isValidModelId(value)) {
      return { config, error: `model expects "provider/model" (e.g. maestro-qwen/qwen3.8-max-preview) or auto, got "${raw}"` };
    }
    return { config: { ...config, model: value } };
  }
  if ((EDITABLE_CONFIG_KEYS as readonly string[]).includes(normalizedKey)) {
    const parsed = parseIntegerValue(raw);
    if (parsed === undefined) return { config, error: `${normalizedKey} expects a positive integer, got "${raw}"` };
    return { config: { ...config, [normalizedKey]: parsed } as SelfEvolveConfig };
  }
  return {
    config,
    error: `unknown key "${normalizedKey}" (editable: ${[...EDITABLE_CONFIG_KEYS, "enabled"].join(", ")})`,
  };
}

/** Human-readable duration (e.g. 300000 → "5m", 1500 → "1.5s"). */
export function formatDurationMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Multi-line config dump for `/self-evolve config` and the panel. */
export function formatConfigSummary(config: SelfEvolveConfig, source: string, resolvedModel?: string): string {
  const lines = [
    `SELF-EVOLVE ${config.enabled ? "on" : "off"} (${source})`,
    "  mode: dry-run — candidate signals only, never stages or promotes knowledge",
    `  model: ${config.model ?? "auto"}${resolvedModel && resolvedModel !== config.model ? ` → ${resolvedModel}` : ""} (Phase 2B LLM steps)`,
    `  cooldown: ${formatDurationMs(config.cooldownMs)} (${config.cooldownMs}ms)`,
    `  budget: ${config.maxSignalsPerSession} signals/session`,
    `  trace: ${config.maxTraceMessages} msgs / ${config.maxTraceChars} chars`,
    `  evidence: ${config.maxEvidence} refs/candidate`,
    `  retention: ${config.maxFiles} daily files in ~/.maestro/self-evolve/suggestions/`,
  ];
  return lines.join("\n");
}

/** One-line status-bar text; undefined when the indicator should be hidden. */
export function formatStatusText(config: SelfEvolveConfig, counters: SelfEvolveCounters): string | undefined {
  if (!config.enabled) return "EVOL off";
  const compact = `${counters.signals}·${counters.deduped}·${counters.suppressed}`;
  return `EVOL ● ${compact}${counters.failures > 0 ? ` !${counters.failures}` : ""}`;
}

/** Parse JSONL signal lines, skipping malformed entries. */
export function parseSignalLines(lines: readonly string[]): SelfEvolveSignal[] {
  const signals: SelfEvolveSignal[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SelfEvolveSignal>;
      if (parsed && parsed.kind === "candidate" && typeof parsed.title === "string") {
        signals.push(parsed as SelfEvolveSignal);
      }
    } catch {
      // skip malformed lines
    }
  }
  return signals;
}

/** Render a signal for a listing (panel / `/self-evolve signals`). */
export function formatSignalLine(signal: SelfEvolveSignal): string {
  const time = new Date(signal.createdAt).toLocaleTimeString();
  const evidenceCount = signal.evidence?.length ?? 0;
  return `[${time}] ${signal.source} · ${signal.candidateType} · ${evidenceCount} ev: ${signal.title}`;
}

// ---------------------------------------------------------------------------
// Dry-run review (`/self-evolve review` — Phase 2B minimal validation)
// ---------------------------------------------------------------------------

export type ReviewAction = "stage" | "skip" | "uncertain";

export interface ReviewVerdict {
  /** Matches a signal id (`se-…`). */
  id: string;
  action: ReviewAction;
  candidateType: CandidateType;
  /** 0..1 quality confidence. */
  score: number;
  reason: string;
}

/** Structured review record, appended to the global reviews dir (dry-run). */
export interface SelfEvolveReview {
  schemaVersion: number;
  kind: "review";
  /** Phase 2B validation is dry-run only — never stages or promotes. */
  dryRun: true;
  createdAt: string;
  project?: string;
  model?: string;
  signals: number;
  verdicts: ReviewVerdict[];
}

/** JSON schema for the review model output (per-signal verdicts). */
export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["stage", "skip", "uncertain"] },
          candidateType: { type: "string", enum: ["knowhow", "spec", "unknown"] },
          score: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
        required: ["id", "action", "candidateType", "score", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

/** Build the reviewer prompt from recent signals. */
export function buildReviewPrompt(signals: readonly SelfEvolveSignal[]): string {
  const header = [
    "You are the self-evolution dry-run reviewer. Assess whether each candidate signal is worth staging into the knowledge base (via `maestro knowledge stage`).",
    "Judge: (1) evidence grounding — file:line anchors real and specific; (2) reusability — the lesson/decision generalizes beyond this session; (3) novelty — not already obvious or session-specific noise.",
    "Return JSON only with one verdict per signal id.",
    "",
    "Signals:",
  ];
  const body = signals.map((signal) => {
    const evidence = (signal.evidence ?? [])
      .map((entry) => `${entry.type}${entry.role ? `:${entry.role}` : ""} ${entry.ref}`)
      .join(", ");
    return [
      `- id: ${signal.id}`,
      `  source: ${signal.source} · type: ${signal.candidateType} · project: ${signal.project ?? "?"}`,
      `  title: ${signal.title}`,
      `  summary: ${signal.summary}`,
      `  evidence: ${evidence || "(none)"}`,
    ].join("\n");
  });
  return [...header, ...body].join("\n");
}

/** Extract `{ verdicts: [...] }` from model text (JSON object fallback). */
export function parseReviewVerdicts(text: string): { verdicts: ReviewVerdict[] } {
  const extract = (raw: string): { verdicts: ReviewVerdict[] } => {
    const parsed = JSON.parse(raw) as { verdicts?: unknown };
    if (parsed && Array.isArray(parsed.verdicts)) {
      const verdicts = parsed.verdicts.filter(
        (entry): entry is ReviewVerdict =>
          typeof entry === "object"
          && entry !== null
          && typeof (entry as ReviewVerdict).id === "string"
          && ["stage", "skip", "uncertain"].includes((entry as ReviewVerdict).action),
      );
      return { verdicts };
    }
    return { verdicts: [] };
  };
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  try {
    return extract(fenced ? fenced[1] : trimmed);
  } catch {
    // Last resort: find the first balanced object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return extract(trimmed.slice(start, end + 1));
      } catch {
        return { verdicts: [] };
      }
    }
    return { verdicts: [] };
  }
}

/** Human-readable review summary for the command output. */
export function formatReviewSummary(review: SelfEvolveReview): string {
  const byAction = (action: ReviewAction): ReviewVerdict[] => review.verdicts.filter((v) => v.action === action);
  const stage = byAction("stage");
  const skip = byAction("skip");
  const uncertain = byAction("uncertain");
  const lines = [
    `SELF-EVOLVE REVIEW (dry-run) — ${review.signals} signals · model ${review.model ?? "auto"}`,
    `  stage: ${stage.length} · skip: ${skip.length} · uncertain: ${uncertain.length}`,
    ...stage.map((v) => `  → stage ${v.id} (${v.candidateType}, ${v.score}): ${v.reason}`),
    ...uncertain.map((v) => `  ? uncertain ${v.id}: ${v.reason}`),
  ];
  return lines.join("\n");
}

/** Reviews output dir under the global output root. */
export function reviewsDirPath(outputRoot: string): string {
  return resolve(outputRoot, "reviews");
}

/** Local-time `YYYY-MM-DD` review file name. */
export function reviewFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}.jsonl`;
}



// ---------------------------------------------------------------------------
// Message text helper (structural, mirrors advisor/runtime.ts internals)
// ---------------------------------------------------------------------------

function advisorMessageText(message: {
  content?: unknown;
}): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      const blockText = (block as { text?: unknown } | null)?.text;
      if (typeof blockText === "string") text += blockText;
    }
    return text;
  }
  return "";
}
