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
/** Max daily suggestion files seeded for cross-day dedup (bounded read). */
export const DEDUP_SEED_DAYS = 14;
/** Default review-gate score threshold: stage verdicts below it are downgraded. */
export const REVIEW_SCORE_THRESHOLD_DEFAULT = 0.6;
/** Default retention for daily review files (independent of suggestion pruning). */
export const MAX_REVIEW_FILES_DEFAULT = 28;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Evolution modes. Phase 2A has a single safe mode: dry-run (candidate
 * signals only, never stages/promotes knowledge). Future phases may extend
 * this enum (e.g. auto-deposit); validation stays in `setConfigValue`. */
export type SelfEvolveMode = "dry-run";

/** All currently legal evolution modes, in display order. */
export const SELF_EVOLVE_MODES: readonly SelfEvolveMode[] = ["dry-run"];

export interface SelfEvolveConfig {
  /** Master switch; the extension only observes events while enabled. */
  enabled: boolean;
  /**
   * Evolution mode. Phase 2A ships only `dry-run` (collect candidate signals,
   * never stage/promote knowledge); the field is explicit so the panel/status
   * show the real value instead of a hardcoded label, and so future phases
   * can add modes without changing the config shape.
   */
  mode: SelfEvolveMode;
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
  /**
   * Review-gate score threshold (0..1): a `stage` verdict scoring below it is
   * downgraded to `uncertain` so low-confidence stages never reach the
   * stage-candidate pipeline. Default 0.6.
   */
  reviewScoreThreshold: number;
  /** How many recent daily review files to keep (independent of suggestion pruning). Default 28. */
  maxReviewFiles: number;
}

export const DEFAULT_SELF_EVOLVE_CONFIG: SelfEvolveConfig = {
  enabled: false,
  mode: "dry-run",
  cooldownMs: 300_000,
  maxSignalsPerSession: 20,
  maxTraceChars: 8_000,
  maxTraceMessages: 12,
  maxEvidence: 8,
  maxFiles: 14,
  reviewScoreThreshold: REVIEW_SCORE_THRESHOLD_DEFAULT,
  maxReviewFiles: MAX_REVIEW_FILES_DEFAULT,
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
  const mode: SelfEvolveMode =
    typeof raw?.mode === "string" && (SELF_EVOLVE_MODES as readonly string[]).includes(raw.mode)
      ? (raw.mode as SelfEvolveMode)
      : defaults.mode;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : defaults.enabled,
    mode,
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
    reviewScoreThreshold: typeof raw?.reviewScoreThreshold === "number"
      && Number.isFinite(raw.reviewScoreThreshold)
      && raw.reviewScoreThreshold >= 0
      && raw.reviewScoreThreshold <= 1
      ? raw.reviewScoreThreshold
      : defaults.reviewScoreThreshold,
    maxReviewFiles: typeof raw?.maxReviewFiles === "number"
      && Number.isInteger(raw.maxReviewFiles)
      && raw.maxReviewFiles > 0
      ? raw.maxReviewFiles
      : defaults.maxReviewFiles,
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
// Collection-side noise filter
// ---------------------------------------------------------------------------

/**
 * Trace-fragment / progress-report shapes that are never candidates. The
 * pipeline's own lessons (see SKILL.md 信号沉淀流水线) are that raw tool-trace
 * fragments (`ASSISTANT: TOOL bash: 28: ??`, `grep: No matches`) and pure
 * progress headings must not reach the suggestion file — drop at the source.
 */
const NOISE_TITLE_PATTERNS: readonly RegExp[] = [
  /^ASSISTANT:/i,
  /\bTOOL\s+[A-Za-z][\w.-]*\s*:/,
  /^[A-Za-z][\w.-]*\s*:\s*\d+\s*:\s*\?+/,
  /^\s*(?:grep|rg|find|ls|cat|head|tail|git|node|npm|npx)\b[^\n]{0,80}\bNo\s+matches?\b/i,
  /No\s+matches?\s+found/i,
  /^#+\s+[^\n]*$/,          // pure markdown heading
  /^(ok|done|finished|complete|progress|updated|wip|todo|n\/a|n\.a\.)$/i,
  /^#+\s*[✅✓✔️]/,            // pure progress checkmark heading
];

/** True when a candidate title is a trace fragment / progress report (never a candidate). */
export function isNoiseTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
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
  /** Active maestro run id when resolvable at write time (run-source stage template). */
  runId?: string;
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
  runId?: string;
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
    ...(params.runId ? { runId: params.runId } : {}),
    traceHash: params.traceHash,
    candidateType: params.candidateType,
    title: params.title,
    summary: params.summary,
    evidence: params.evidence,
    ...(params.suggestion ? { suggestion: params.suggestion } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
  };
}

/** True when a signal carries an executable stage-command template. */
export function signalIsActionable(signal: SelfEvolveSignal): boolean {
  return typeof signal.suggestion === "string" && signal.suggestion.length > 0;
}

/**
 * Markdown body backing the `--content-file` of a signal's stage template.
 * The extension writes this file at signal-write time so the suggestion
 * command is copy-paste executable instead of carrying a dead placeholder.
 */
export function signalEvidenceContent(signal: SelfEvolveSignal): string {
  const evidence = (signal.evidence ?? [])
    .map((entry) => `- ${entry.type}${entry.role ? `:${entry.role}` : ""} ${entry.ref}`)
    .join("\n");
  const lines = [
    `# ${signal.title}`,
    "",
    signal.summary,
    "",
    `source: ${signal.source} · project: ${signal.project ?? "?"} · session: ${signal.sessionId}${signal.runId ? ` · run: ${signal.runId}` : ""}`,
    ...(signal.candidateType !== "unknown" ? [`candidateType: ${signal.candidateType}`] : []),
    "evidence:",
    evidence || "- (none)",
  ];
  return lines.join("\n");
}

/**
 * Executable stage-command template (never executed by the extension).
 *
 * Phase 2A review finding: the old template carried literal `<run-id>` /
 * `<evidence-file>` placeholders with no backing artifact, so copy-paste
 * always failed. The extension now writes a real evidence file at write time
 * and prefers the fully-executable session-source form
 * (`--session <sid> --evidence <refs>`); the run-source form is used only
 * when a run id is actually known. `unknown` candidate types produce no
 * suggestion (they are not actionable).
 */
export function buildSuggestion(
  candidateType: CandidateType,
  title: string,
  opts: { evidenceFile?: string; sessionId?: string; runId?: string; evidenceRefs?: readonly string[] } = {},
): string | undefined {
  if (candidateType === "unknown") return undefined;
  const type = candidateType === "spec" ? "spec" : "knowhow";
  const escapedTitle = title.replace(/"/g, "\\\"");
  const refs = (opts.evidenceRefs ?? []).slice(0, 8).join(", ");
  const evidenceFile = opts.evidenceFile ?? "<evidence-file>";
  const evidenceArg = refs ? ` --evidence "${refs}"` : "";
  if (opts.sessionId) {
    return `maestro knowledge stage ${type} "${escapedTitle}" --content-file ${evidenceFile} --session ${opts.sessionId}${evidenceArg}`;
  }
  if (opts.runId) {
    return `maestro knowledge stage ${type} "${escapedTitle}" --content-file ${evidenceFile} --run ${opts.runId}${evidenceArg}`;
  }
  // No identity resolvable at write time — keep the template explicit about
  // what a human/agent must supply (session-source is the documented fallback).
  return `maestro knowledge stage ${type} "${escapedTitle}" --content-file ${evidenceFile} --session <session-id>${evidenceArg}`;
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
  "maxReviewFiles",
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

/** Parse a 0..1 score value; undefined when invalid. */
export function parseScoreValue(raw: string): number | undefined {
  const match = /^\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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
  if (normalizedKey === "mode") {
    const value = raw.trim();
    if ((SELF_EVOLVE_MODES as readonly string[]).includes(value)) {
      return { config: { ...config, mode: value as SelfEvolveMode } };
    }
    return {
      config,
      error: `mode expects one of ${SELF_EVOLVE_MODES.join(" | ")} (Phase 2A ships dry-run only; auto-deposit arrives with Phase 2B), got "${raw}"`,
    };
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
      return { config, error: `model expects "provider/model" (e.g. maestro-qwen/qwen3.8-max) or auto, got "${raw}"` };
    }
    return { config: { ...config, model: value } };
  }
  if (normalizedKey === "reviewScoreThreshold") {
    const parsed = parseScoreValue(raw);
    if (parsed === undefined) {
      return { config, error: `reviewScoreThreshold expects a number in [0,1] (e.g. 0.6), got "${raw}"` };
    }
    return { config: { ...config, reviewScoreThreshold: parsed } };
  }
  if ((EDITABLE_CONFIG_KEYS as readonly string[]).includes(normalizedKey)) {
    const parsed = parseIntegerValue(raw);
    if (parsed === undefined) return { config, error: `${normalizedKey} expects a positive integer, got "${raw}"` };
    return { config: { ...config, [normalizedKey]: parsed } as SelfEvolveConfig };
  }
  return {
    config,
    error: `unknown key "${normalizedKey}" (editable: ${[...EDITABLE_CONFIG_KEYS, "enabled", "mode", "model"].join(", ")})`,
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
export function formatConfigSummary(
  config: SelfEvolveConfig,
  source: string,
  opts: { resolvedModel?: string; enabled?: boolean; suggestionsDir?: string } = {},
): string {
  const enabled = opts.enabled ?? config.enabled;
  const lines = [
    `SELF-EVOLVE ${enabled ? "on" : "off"} (${source})`,
    `  mode: ${config.mode} — candidate signals only, never stages or promotes knowledge`,
    `  model: ${config.model ?? "auto"}${opts.resolvedModel && opts.resolvedModel !== config.model ? ` → ${opts.resolvedModel}` : ""} (Phase 2B LLM steps)`,
    `  cooldown: ${formatDurationMs(config.cooldownMs)} (${config.cooldownMs}ms)`,
    `  budget: ${config.maxSignalsPerSession} signals/session`,
    `  trace: ${config.maxTraceMessages} msgs / ${config.maxTraceChars} chars`,
    `  evidence: ${config.maxEvidence} refs/candidate`,
    `  review gate: stage below score ${config.reviewScoreThreshold} downgraded to uncertain`,
    `  retention: ${config.maxFiles} daily suggestion files · ${config.maxReviewFiles} daily review files`,
    ...(opts.suggestionsDir ? [`  output: ${opts.suggestionsDir}`] : []),
  ];
  return lines.join("\n");
}

/** One-line status-bar text; undefined when the indicator should be hidden. */
export function formatStatusText(
  enabled: boolean,
  counters: SelfEvolveCounters,
): string | undefined {
  if (!enabled) return "EVOL off";
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
  const createdAt = new Date(signal.createdAt);
  const sameDay = createdAt.toDateString() === new Date().toDateString();
  const time = sameDay
    ? createdAt.toLocaleTimeString()
    : createdAt.toLocaleString();
  const evidenceCount = signal.evidence?.length ?? 0;
  const project = signal.project ? ` · ${signal.project}` : "";
  const actionable = signalIsActionable(signal) ? "" : " · not-actionable";
  return `[${time}] ${signal.id}${project} · ${signal.source} · ${signal.candidateType} · ${evidenceCount} ev${actionable}: ${signal.title}`;
}

// ---------------------------------------------------------------------------
// Signal record management (delete / clear helpers)
// ---------------------------------------------------------------------------

/** True when a signal line's id starts with any given prefix (id or prefix). */
export function signalLineMatchesPrefix(line: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return false;
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    const id = parsed.id;
    return typeof id === "string"
      && prefixes.some((prefix) => prefix.length > 0 && id.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Filter signal lines, dropping any whose id matches one of the prefixes.
 * Keeps blank and non-signal lines untouched so rewriting stays lossless.
 */
export function filterSignalLines(
  lines: readonly string[],
  prefixes: readonly string[],
): { kept: string[]; deleted: number } {
  const kept: string[] = [];
  let deleted = 0;
  for (const line of lines) {
    if (line.trim() && signalLineMatchesPrefix(line, prefixes)) {
      deleted += 1;
    } else {
      kept.push(line);
    }
  }
  return { kept, deleted };
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
  /** Review-gate stats: hallucinated verdict ids dropped at parse time. */
  droppedInvalid?: number;
  /** Review-gate stats: stage verdicts downgraded to uncertain (score/actionable). */
  downgraded?: number;
  /** Signals excluded from review because they carry no stage template. */
  nonActionableSkipped?: number;
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
export function buildReviewPrompt(
  signals: readonly SelfEvolveSignal[],
  scoreThreshold = REVIEW_SCORE_THRESHOLD_DEFAULT,
): string {
  const header = [
    "You are the self-evolution dry-run reviewer. Assess whether each candidate signal is worth staging into the knowledge base (via `maestro knowledge stage`).",
    "Judge: (1) evidence grounding — file:line anchors real and specific; (2) reusability — the lesson/decision generalizes beyond this session; (3) novelty — not already obvious or session-specific noise.",
    "",
    "Staging Quality Bar — a signal is stage-worthy only when it is one of:",
    "  ① pitfall warning (doing X you must watch Y because Z — non-obvious failure mode + prevention)",
    "  ② failure lesson (what failed, root cause, what worked instead)",
    "  ③ non-trivial trade-off (why A over B, with constraints and context)",
    "  ④ newly established prescriptive constraint (a rule future work must follow)",
    "And it must NOT be: a process note (what was done), a restatement of existing patterns, a trivial/obvious operation, or a raw trace fragment (tool output / log / error excerpt / transcript).",
    "For each verdict, set score to your confidence that the signal passes the bar; reason must name which of ①-④ applies (or which prohibition it violates).",
    `A stage verdict scoring below ${scoreThreshold} is automatically downgraded to uncertain — be honest, do not inflate scores.`,
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
  const missing = Math.max(0, review.signals - review.verdicts.length);
  const lines = [
    `SELF-EVOLVE REVIEW (dry-run) — ${review.signals} signals · model ${review.model ?? "auto"}`,
    `  stage: ${stage.length} · skip: ${skip.length} · uncertain: ${uncertain.length}${missing > 0 ? ` · missing verdicts: ${missing}` : ""}`,
    ...stage.map((v) => `  → stage ${v.id} (${v.candidateType}, ${v.score}): ${v.reason}`),
    ...uncertain.map((v) => `  ? uncertain ${v.id} (${v.score}): ${v.reason}`),
    ...skip.map((v) => `  – skip ${v.id}: ${v.reason}`),
  ];
  return lines.join("\n");
}

/**
 * Hard review-gate normalization (Phase 2A review finding: the score was
 * decorative and verdict ids were never validated):
 *   - verdicts whose id is not in the reviewed signal set are dropped (hallucinated ids);
 *   - `stage` verdicts scoring below the threshold are downgraded to `uncertain`;
 *   - `stage` verdicts on non-actionable signals (no suggestion) are downgraded too.
 * Returns the surviving verdicts plus dropped/downgraded counters for the record.
 */
export function normalizeReviewVerdicts(
  verdicts: readonly ReviewVerdict[],
  signalIds: readonly string[],
  scoreThreshold: number,
  actionableIds: ReadonlySet<string> = new Set(signalIds),
): { verdicts: ReviewVerdict[]; droppedInvalid: number; downgraded: number } {
  const idSet = new Set(signalIds);
  const normalized: ReviewVerdict[] = [];
  let droppedInvalid = 0;
  let downgraded = 0;
  for (const verdict of verdicts) {
    if (!idSet.has(verdict.id)) {
      droppedInvalid += 1;
      continue;
    }
    if (verdict.action === "stage" && (verdict.score < scoreThreshold || !actionableIds.has(verdict.id))) {
      normalized.push({ ...verdict, action: "uncertain", reason: `${verdict.reason} (auto-downgraded: score ${verdict.score} < ${scoreThreshold} or not actionable)` });
      downgraded += 1;
      continue;
    }
    normalized.push(verdict);
  }
  return { verdicts: normalized, droppedInvalid, downgraded };
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
