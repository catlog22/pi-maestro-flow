/**
 * Self-evolve runtime — pure logic for candidate signals and Phase 2B
 * auto-deposit.
 *
 * The self-evolve extension turns runtime traces into *suggestion* records
 * (dry-run candidates appended to `~/.maestro/self-evolve/suggestions/<date>.jsonl`)
 * for a governance step to review (see `docs/self-evolution-plugin-design.md`
 * §9, Phase 2A). In `auto-deposit` mode, gate-passing signals are staged via
 * the explicit `maestro knowledge stage` CLI (wiring in `extension.ts`) —
 * this module only builds the argv/records; it never executes anything itself
 * and never promotes.
 *
 * This module is host-free and unit-testable; host wiring (events, config
 * persistence, filesystem writes, CLI execution) lives in `extension.ts`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redactAdvisorText } from "../advisor/runtime.ts";
// type-only import: trajectory.ts runtime-imports SOP_TOOL_NAMES from this module,
// so a value import here would form a runtime cycle. Type-only is erased.
import type { TrajectoryEpisode } from "./trajectory.ts";

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

/**
 * Evolution modes. `dry-run` (default): candidate signals only — review never
 * writes knowledge. `auto-deposit`: signals passing the review gate are
 * automatically staged into the knowledge base (pending candidates only —
 * promotion stays manual per governance discipline). Validation stays in
 * `setConfigValue`.
 */
export type SelfEvolveMode = "dry-run" | "auto-deposit";

/** All currently legal evolution modes, in display order. */
export const SELF_EVOLVE_MODES: readonly SelfEvolveMode[] = ["dry-run", "auto-deposit"];

export interface SelfEvolveConfig {
  /** Master switch; the extension only observes events while enabled. */
  enabled: boolean;
  /**
   * Evolution mode. `dry-run` collects candidate signals and never writes
   * knowledge; `auto-deposit` additionally stages gate-passing candidates
   * (pending pool — never auto-promotes). The field is explicit so the
   * panel/status show the real value instead of a hardcoded label, and so
   * future phases can add modes without changing the config shape.
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

/**
 * Structured evidence of one tool call in the transcript tail. Phase 2C adds
 * this alongside the coarse `EvidenceRef` so self-evolve signals that touch
 * a pi tool (browser / computer_use / ...) carry the call's action, guide
 * topic, and outcome — letting the classifier tag the candidate with a
 * `tools` + `sop_topic` hint for the SOP loader to discover.
 */
export interface ToolCallEvidence {
  /** Pi tool name (`browser`, `computer_use`, ...). */
  readonly tool: string;
  /** Tool action if discernible from the call input (`guide`, `click`, `ocr`, ...). */
  readonly action?: string;
  /** `guide` topic when the call was `action: "guide"` (SOP hit). */
  readonly topic?: string;
  /** Outcome bucketed from the tool result envelope. */
  readonly outcome: "ok" | "error" | "near_zero" | "timeout" | "permission_denied" | "unknown";
  /** Short error code/message when outcome is not ok (truncated). */
  readonly errorMessage?: string;
}

/** Tools whose trajectories Phase 2C classifies for SOP candidate hints. */
export const SOP_TOOL_NAMES = new Set(["browser", "computer_use"]);

/**
 * Common dev tools whose failed calls are worth capturing as ToolCallEvidence
 * (alongside SOP tools). Lets buildKnowledgeTitle produce a precise failure
 * title (e.g. `bash grep 失败:No matches`) for everyday dev tools, not just
 * browser/computer_use. trajectory.ts already covers all tools via adapters;
 * this closes the gap for the coarse ToolCallEvidence path.
 */
export const EVIDENCE_TOOL_NAMES = new Set([
  "bash", "read", "edit", "write", "grep", "find", "ls", "glob", "ffgrep", "fffind",
]);

/** Error fragments mapped to structured outcomes (failure-mode signals). */
const OUTCOME_PATTERNS: ReadonlyArray<{ outcome: ToolCallEvidence["outcome"]; patterns: readonly RegExp[] }> = [
  { outcome: "near_zero", patterns: [/near[-_ ]?zero/i, /NEAR_ZERO/] },
  { outcome: "timeout", patterns: [/\btimeout\b/i, /TIMEOUT/, /aborted/i, /ABORTED/] },
  {
    outcome: "permission_denied",
    patterns: [/permission/i, /denied/i, /EACCES/, /FOREGROUND_NOT_VERIFIED/i, /not permitted/i],
  },
];

function classifyToolOutcome(text: string): ToolCallEvidence["outcome"] {
  if (!text) return "unknown";
  for (const { outcome, patterns } of OUTCOME_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return outcome;
  }
  return "error";
}

/**
 * Extract structured tool-call evidence from the transcript tail. Pairs each
 * assistant `tool_use` block (carrying the call input: action/topic) with the
 * following `tool_result`/`toolResult` message (carrying isError + text) by
 * `toolCallId`. Only tools in {@link SOP_TOOL_NAMES} are kept — generic tool
 * evidence stays on the coarse `EvidenceRef` list. Bounded by `max`.
 */
export function buildToolCallEvidence(messages: AgentMessage[], max = 8): ToolCallEvidence[] {
  const evidence: ToolCallEvidence[] = [];
  const seen = new Set<string>();
  const results = new Map<string, { isError?: boolean; text: string }>();

  for (const message of messages.slice(-64)) {
    const record = message as unknown as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
    };
    if (record.role === "tool" || record.role === "toolResult") {
      const id = record.toolCallId;
      if (typeof id === "string" && id) {
        results.set(id, { isError: record.isError, text: advisorMessageText(record) });
      }
    }
  }

  for (const message of messages.slice(-64)) {
    if (evidence.length >= max) break;
    const record = message as unknown as { role?: string; content?: unknown };
    if (record.role !== "assistant") continue;
    const blocks = Array.isArray(record.content) ? record.content : [record.content];
    for (const block of blocks) {
      if (evidence.length >= max) break;
      const use = block as { type?: string; name?: string; input?: unknown; arguments?: unknown; id?: string; toolCallId?: string } | null;
      if (!use) continue;
      const isToolUse = use.type === "tool_use" || use.type === "toolCall";
      if (!isToolUse) continue;
      const tool = typeof use.name === "string" ? use.name : "";
      if (!tool || (!SOP_TOOL_NAMES.has(tool) && !EVIDENCE_TOOL_NAMES.has(tool))) continue;
      const input = (use.input ?? use.arguments ?? {}) as Record<string, unknown>;
      const action = typeof input.action === "string" ? input.action : undefined;
      const topic = typeof input.topic === "string" ? input.topic : undefined;
      const id = typeof (use.id ?? use.toolCallId) === "string" ? (use.id ?? use.toolCallId) as string : "";
      const result = id ? results.get(id) : undefined;
      const isError = result?.isError === true;
      let outcome: ToolCallEvidence["outcome"] = "ok";
      let errorMessage: string | undefined;
      if (isError) {
        const text = result?.text ?? "";
        outcome = classifyToolOutcome(text);
        errorMessage = text.slice(0, 160) || undefined;
      }
      const key = `${tool}:${action ?? ""}:${topic ?? ""}:${outcome}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ tool, action, topic, outcome, ...(errorMessage ? { errorMessage } : {}) });
    }
  }
  return evidence;
}

const FILE_REFERENCE_PATTERN = /\b((?:[A-Za-z]:)?[\w./-]+\.(?:ts|tsx|mjs|cjs|js|jsx|json|md|mdx|py|go|rs|css|scss|html|sh|yml|yaml|toml|txt|sql|java|kt|c|cpp|h|hpp|rb|php|vue|svelte|graphql|lock))(?::(\d+))?\b/gi;

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
export function buildEvidenceFromMessages(
  messages: AgentMessage[],
  max = 8,
  /** Optional per-file filter (e.g. cwd existence check) to drop cross-project refs. */
  fileFilter?: (ref: string) => boolean,
): EvidenceRef[] {
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
      for (const ref of extractFileReferences(text, max)) {
        if (fileFilter && !fileFilter(ref)) continue;
        push({ type: "file", ref });
      }
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
  // Strong signals: a single hit classifies directly (no tie-break fallback).
  // Chinese process narration rarely hits these; explicit knowledge markers do.
  const KNOWHOW_STRONG = [
    "pitfall", "gotcha", "lesson learned", "root cause",
    "workaround", "mistake", "turns out", "ended up", "got stuck",
    "breaks if", "tripped on", "surprised that",
    "陷阱", "踩坑", "坑：", "坑:", "教训", "根因", "失败原因", "原因在于",
  ];
  const SPEC_STRONG = [
    "design decision", "architectural decision",
    "决策", "架构决定", "约束：", "约束:", "规则：", "规则:", "规范：", "规范:", "约定：", "约定:",
  ];
  if (score(KNOWHOW_STRONG) > 0) return "knowhow";
  if (score(SPEC_STRONG) > 0) return "spec";
  // Weak signals: frequency comparison with Chinese synonyms added.
  const knowhow = score([
    "pitfall", "gotcha", "workaround", "trick", "lesson", "learned", "debug",
    "bug", "error", "failed", "failure", "issue", "fix", "root cause",
    "unexpected", "caused by",
    "失败", "出错", "报错", "重试", "修复", "问题", "异常", "排查", "调试",
  ]);
  const spec = score([
    "decision", "decided", "architecture", "architectural", "contract",
    "protocol", "design", "constraint", "requirement", "workflow", "schema",
    "interface", "api", "policy", "rule", "standard",
    "设计", "架构", "接口", "协议", "流程", "规范", "方案", "约定",
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
  /^No\s+matches?\s+found/i,            // bare "No matches found" title (anchored to avoid killing "bash ... 失败:...No matches found")
  /^#+\s+[^\n]*$/,          // pure markdown heading
  /^(ok|done|finished|complete|progress|updated|wip|todo|n\/a|n\.a\.)$/i,
  /^#+\s*[✅✓✔️]/,            // pure progress checkmark heading
  /^CUSTOM\s+maestro-model-failover\b/i, // model failover log (system noise, not a lesson)
  /^USER:\s*\[?pi-maestro-teammate/i,   // teammate completion/delivery system notice (with or without [)
  /^Error:\s*Completion\b/i,             // raw completion provider error header
];

/** True when a candidate title is a trace fragment / progress report (never a candidate). */
export function isNoiseTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  return NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ---------------------------------------------------------------------------
// Knowledge-moment gate + knowledge-focused title
// ---------------------------------------------------------------------------

/**
 * Reflective/decisional lexicon — when the last assistant line carries one of
 * these, the turn is a knowledge moment (a decision, lesson, or root-cause
 * statement) even without a failed tool call. Chinese + English.
 */
const KNOWLEDGE_MOMENT_LEXICON: readonly string[] = [
  "决定", "决策", "教训", "陷阱", "踩坑", "根因", "因为", "所以", "结论", "坑：", "坑:",
  "pitfall", "gotcha", "lesson", "learned", "decided", "conclusion", "root cause", "because",
];

/**
 * True when a turn carries a knowledge signal worth capturing. Any one of:
 * - a failed tool call (outcome !== "ok") — failure is the strongest knowhow seed;
 * - a non-success trajectory episode (failure_recovery/repeated_failure/...);
 * - the last assistant line carries a reflective/decisional lexicon hit;
 * - the heuristic classifier already tagged it knowhow/spec (non-unknown).
 */
export function isKnowledgeMoment(
  toolCalls: readonly ToolCallEvidence[],
  episodes: readonly TrajectoryEpisode[],
  assistantText: string,
  candidateType: CandidateType,
): boolean {
  if (toolCalls.some((c) => c.outcome !== "ok")) return true;
  if (episodes.some((e) => e.kind !== "success")) return true;
  if (candidateType !== "unknown") return true;
  const lower = assistantText.toLowerCase();
  return KNOWLEDGE_MOMENT_LEXICON.some((word) => lower.includes(word));
}

/**
 * Build a knowledge-focused title. Priority:
 * 1. Failed tool trajectory — `<tool> <operation> 失败:<err first sentence>` — the
 *    strongest knowledge signal; beats process narration.
 * 2. Reflective assistant text (lexicon hit) — the decision/lesson line itself.
 * 3. Fallback — the first digest line (existing makeTitle behavior).
 */
export function buildKnowledgeTitle(
  toolCalls: readonly ToolCallEvidence[],
  episodes: readonly TrajectoryEpisode[],
  assistantText: string,
  fallback: string,
  max = 120,
): string {
  const failedCall = toolCalls.find((c) => c.outcome !== "ok");
  if (failedCall) {
    const parts = [failedCall.tool];
    if (failedCall.action) parts.push(failedCall.action);
    const err = (failedCall.errorMessage ?? "").replace(/\s+/g, " ").trim().split(/[.。\n]/)[0] ?? "";
    const head = parts.join(" ");
    const title = err ? `${head} 失败:${err}` : `${head} 失败`;
    return title.length <= max ? title : `${title.slice(0, Math.max(0, max - 1))}…`;
  }
  const failedEpisode = episodes.find((e) => e.kind !== "success");
  if (failedEpisode) {
    const title = `${failedEpisode.tool} ${failedEpisode.kind} (${failedEpisode.operation})`;
    return title.length <= max ? title : `${title.slice(0, Math.max(0, max - 1))}…`;
  }
  const lower = assistantText.toLowerCase();
  if (KNOWLEDGE_MOMENT_LEXICON.some((w) => lower.includes(w)) && assistantText.trim()) {
    return makeTitle(assistantText, max);
  }
  return makeTitle(fallback, max);
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
  /** Phase 2C: structured tool-call trajectory from the transcript tail. */
  toolCalls?: ToolCallEvidence[];
  /** Deterministic grouped episodes derived from the tool-call trajectory. */
  episodes?: TrajectoryEpisode[];
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
  toolCalls?: ToolCallEvidence[];
  episodes?: TrajectoryEpisode[];
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
    ...(params.toolCalls && params.toolCalls.length > 0 ? { toolCalls: params.toolCalls } : {}),
    ...(params.episodes && params.episodes.length > 0 ? { episodes: params.episodes } : {}),
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
  const toolCalls = (signal.toolCalls ?? []).map((call) => {
    const parts = [call.tool];
    if (call.action) parts.push(`action=${call.action}`);
    if (call.topic) parts.push(`topic=${call.topic}`);
    parts.push(`outcome=${call.outcome}`);
    if (call.errorMessage) parts.push(`err="${call.errorMessage.replace(/"/g, "'").slice(0, 120)}"`);
    return `- ${parts.join(" ")}`;
  }).join("\n");
  const sopHint = renderSopFrontmatterHint(signal.toolCalls);
  const lines = [
    ...(sopHint ? [sopHint, ""] : []),
    `# ${signal.title}`,
    "",
    signal.summary,
    "",
    `source: ${signal.source} · project: ${signal.project ?? "?"} · session: ${signal.sessionId}${signal.runId ? ` · run: ${signal.runId}` : ""}`,
    ...(signal.candidateType !== "unknown" ? [`candidateType: ${signal.candidateType}`] : []),
    "evidence:",
    evidence || "- (none)",
  ];
  if (toolCalls) {
    lines.push("tool_trajectory:", toolCalls);
  }
  const episodes = (signal.episodes ?? []).map((ep) => {
    const outcomes = ep.outcomes.join(",");
    return `- ${ep.kind} ${ep.tool} ${ep.operation} [${outcomes}]`;
  }).join("\n");
  if (episodes) {
    lines.push("episodes:", episodes);
  }
  return lines.join("\n");
}

/**
 * Phase 2C: when a signal carries a structured tool trajectory, emit a
 * frontmatter hint at the top of the evidence file so `maestro knowledge stage
 * --content-file` deposits a knowhow entry the SopLoader can discover. The
 * hint uses the first failing tool call's tool + guide topic (or the first
 * call) so the candidate attaches to the right pi tool's SOP registry.
 */
function renderSopFrontmatterHint(toolCalls: ToolCallEvidence[] | undefined): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const failing = toolCalls.find((call) => call.outcome !== "ok") ?? toolCalls[0];
  const tool = failing.tool;
  const topic = failing.topic;
  const lines = [
    "---",
    `title: <SOP title — summarize the ${tool} pitfall or recipe>`,
    "type: recipe",
    `tools: [${tool}]`,
  ];
  if (topic) {
    lines.push(`sop_topic: ${topic}`);
  } else {
    lines.push("sop_topic: <kebab-case-topic>");
  }
  lines.push("sop_order: 0", `category: ${tool}-sop`, "---");
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
  /** Auto-staged candidates in `auto-deposit` mode (deposit ledger writes). */
  deposits: number;
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
      error: `mode expects one of ${SELF_EVOLVE_MODES.join(" | ")} (dry-run: review only; auto-deposit: gate-passing candidates auto-staged, never auto-promoted), got "${raw}"`,
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
    `  mode: ${config.mode} — ${modeDescription(config.mode)}`,
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

/** One-line behavior description per evolution mode (display + hint text). */
export function modeDescription(mode: SelfEvolveMode): string {
  return mode === "auto-deposit"
    ? "review gate-passing candidates are auto-staged (pending pool; never auto-promotes)"
    : "candidate signals only, never stages or promotes knowledge";
}

/** One-line status-bar text; undefined when the indicator should be hidden. */
export function formatStatusText(
  enabled: boolean,
  counters: SelfEvolveCounters,
): string | undefined {
  if (!enabled) return "EVOL off";
  const compact = `${counters.signals}·${counters.deduped}·${counters.suppressed}`;
  const deposits = counters.deposits > 0 ? `·${counters.deposits}D` : "";
  return `EVOL ● ${compact}${deposits}${counters.failures > 0 ? ` !${counters.failures}` : ""}`;
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

/** Structured review record, appended to the global reviews dir. */
export interface SelfEvolveReview {
  schemaVersion: number;
  kind: "review";
  /** True when the review ran in dry-run mode (no auto-deposit was attempted). */
  dryRun: boolean;
  /** Evolution mode at review time (`dry-run` or `auto-deposit`). */
  mode: SelfEvolveMode;
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
  /** Auto-deposited stage executions attempted in `auto-deposit` mode (audit count). */
  deposited?: number;
  /** Phase 3: session that ran the review (for `/self-evolve review pending`). */
  sessionId?: string;
  /** Phase 3: signal ids covered by this review (for `review pending` dedup). */
  signalIds?: string[];
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
  const mode = review.mode === "auto-deposit" ? "(auto-deposit)" : "(dry-run)";
  const lines = [
    `SELF-EVOLVE REVIEW ${mode} — ${review.signals} signals · model ${review.model ?? "auto"}`,
    `  stage: ${stage.length} · skip: ${skip.length} · uncertain: ${uncertain.length}${missing > 0 ? ` · missing verdicts: ${missing}` : ""}${review.deposited !== undefined ? ` · deposited: ${review.deposited}` : ""}`,
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
// Auto-deposit records (Phase 2B: gate-passing candidates auto-staged)
// ---------------------------------------------------------------------------

/** Result of executing one stage command (host-bound; runtime keeps the pure shape). */
export interface StageExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Audit record appended to the global deposits dir for each auto-stage. */
export interface DepositRecord {
  schemaVersion: number;
  kind: "deposit";
  createdAt: string;
  project?: string;
  mode: SelfEvolveMode;
  signalId: string;
  title: string;
  candidateType: CandidateType;
  source: SelfEvolveSource;
  sessionId?: string;
  runId?: string;
  command: string;
  exitCode: number;
  /** Parsed candidate id from the stage output (`KDC-…`); present on success. */
  stagedId?: string;
  error?: string;
}

/** Deposits output dir under the global output root. */
export function depositsDirPath(outputRoot: string): string {
  return resolve(outputRoot, "deposits");
}

/** Local-time `YYYY-MM-DD` deposit file name. */
export function depositFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}.jsonl`;
}

/**
 * Build the structured argv for the auto-stage command, mirroring the
 * human-facing `suggestion` template (same identity/evidence wiring —
 * session-first, run fallback — so manual and automatic paths agree).
 * Returns undefined for non-actionable signals (`unknown` candidate type).
 * argv avoids shell quoting — spawn passes arguments directly.
 */
export function buildStageCommandArgs(
  signal: SelfEvolveSignal,
  evidenceFile: string,
): string[] | undefined {
  if (signal.candidateType === "unknown") return undefined;
  const type = signal.candidateType === "spec" ? "spec" : "knowhow";
  const refs = (signal.evidence ?? []).map((entry) => entry.ref).slice(0, 8).join(", ");
  const args = ["knowledge", "stage", type, signal.title, "--content-file", evidenceFile];
  if (signal.sessionId) {
    args.push("--session", signal.sessionId);
  } else if (signal.runId) {
    args.push("--run", signal.runId);
  }
  if (refs) args.push("--evidence", refs);
  return args;
}

/** True for well-formed signal ids (`se-` + 12 hex chars) — guards path building. */
export function isValidSignalId(id: string | undefined): id is string {
  return typeof id === "string" && /^se-[0-9a-f]{12}$/.test(id);
}

/** Rebuild the human-readable command line for the deposit audit record. */
export function formatStageCommandLine(args: readonly string[]): string {
  return `maestro ${args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg)).join(" ")}`;
}

/**
 * Parse the staged candidate id (`KDC-…`) from the stage CLI output. Prefers
 * the `--json` shape (`candidate_id`); falls back to a loose id pattern scan.
 */
export function parseStagedId(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { candidate_id?: unknown };
    if (typeof parsed.candidate_id === "string" && parsed.candidate_id.length > 0) {
      return parsed.candidate_id;
    }
  } catch {
    // not JSON — fall through to the pattern scan
  }
  const match = /\b(KDC-[A-Za-z0-9-]+)\b/.exec(trimmed);
  return match?.[1];
}

/** Human-readable deposit summary for `/self-evolve deposits`. */
export function formatDepositSummary(record: DepositRecord): string {
  const time = new Date(record.createdAt).toLocaleString();
  const status = record.exitCode === 0
    ? `staged ${record.stagedId ?? "?"}`
    : `failed rc=${record.exitCode}${record.error ? ` · ${record.error}` : ""}`;
  return `[${time}] ${record.signalId} · ${record.candidateType} · ${status}: ${record.title}`;
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
