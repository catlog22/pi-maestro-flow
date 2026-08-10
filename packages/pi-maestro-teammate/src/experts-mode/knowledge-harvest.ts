import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getMode, resolveStatePath } from "./mode.ts";
import { loadRules } from "./rules.ts";
import { depositHarvestToSelfEvolvePool } from "./self-evolve-deposit.ts";
import type {
  ExpertsRules,
  KnowledgeHarvestSuggestion,
  KnowledgeStageCommand,
  SettleHarvestInput,
  SettleHarvestResult,
} from "./types.ts";

const DEFAULT_MAX_SUGGESTIONS = 5;
const DEFAULT_MIN_BODY = 40;
const DEFAULT_MAX_BODY = 4000;
const STATE_KEY = "knowledgeSuggestions";
const SEEN_KEY = "knowledgeSuggestionFingerprints";

const RAW_TRACE_PATTERNS = [
  /tool_call/i,
  /function_call/i,
  /```json\s*\{\s*"type"\s*:\s*"tool"/i,
  /\[experts-mode\]/i,
  /bash-bg-complete/i,
  /teammate-complete/i,
  /Observation:/i,
  /<\/?tool/i,
];

const LOW_VALUE_PATTERNS = [
  /^(ok|done|yes|no|thanks|你好|谢谢|继续)\.?$/i,
  /lorem ipsum/i,
  /TODO:\s*fill/i,
  /^test\s*only$/i,
];

const SIGNAL_HINTS: Array<{ re: RegExp; kind: KnowledgeHarvestSuggestion["kind"]; weight: number }> = [
  { re: /when doing|when you|pitfall|watch out|注意|陷阱|不要|avoid\b|gotcha/i, kind: "pitfall", weight: 3 },
  { re: /failed|failure|error|bug|regression|失败|报错|根因|root cause/i, kind: "failure-lesson", weight: 3 },
  { re: /trade-?off|权衡|prefer X|instead of|rather than|取舍/i, kind: "trade-off", weight: 2 },
  { re: /must|should always|constraint|禁止|必须|invariant|prescriptive/i, kind: "constraint", weight: 2 },
  { re: /lesson|learned|经验|复盘|knowhow|recipe|pattern/i, kind: "knowhow", weight: 1 },
];

/**
 * P7: harvest knowledge *suggestions* from expert settle content.
 * - Suggest only (default); never auto-promote.
 * - Quality bar rejects raw traces / trivial ops.
 * - Fingerprint dedup against prior suggestions in .experts-mode.json.
 */
export function harvestKnowledgeOnSettle(
  input: SettleHarvestInput,
  opts: {
    cwd?: string;
    statePath?: string;
    rules?: ExpertsRules;
    record?: boolean;
    maxSuggestions?: number;
  } = {},
): SettleHarvestResult {
  const cwd = opts.cwd ?? process.cwd();
  const rules = opts.rules ?? loadRules();
  const settleCfg = rules.settle ?? {};
  const enabled = settleCfg.knowledgeHarvest !== false;
  const max = opts.maxSuggestions
    ?? settleCfg.maxSuggestions
    ?? DEFAULT_MAX_SUGGESTIONS;

  if (!enabled) {
    return {
      suggestions: [],
      skipped: [{ reason: "knowledge harvest disabled in rules.settle" }],
      stageCommands: [],
    };
  }

  if (getMode(cwd, opts.statePath) !== "experts" && input.force !== true) {
    return {
      suggestions: [],
      skipped: [{ reason: "normal mode — harvest skipped (set force:true to override)" }],
      stageCommands: [],
    };
  }

  const bodies = collectBodies(input);
  const seen = new Set(readSeenFingerprints(cwd, opts.statePath));
  const suggestions: KnowledgeHarvestSuggestion[] = [];
  const skipped: Array<{ reason: string; preview?: string }> = [];

  for (const body of bodies) {
    const candidates = extractCandidateBlocks(body, input);
    for (const cand of candidates) {
      const quality = scoreCandidate(cand.text);
      if (!quality.ok) {
        skipped.push({ reason: quality.reason, preview: cand.text.slice(0, 80) });
        continue;
      }
      const fingerprint = fingerprintText(cand.text);
      if (seen.has(fingerprint)) {
        skipped.push({ reason: "duplicate fingerprint", preview: cand.text.slice(0, 80) });
        continue;
      }
      seen.add(fingerprint);
      const title = cand.title || deriveTitle(cand.text, quality.kind);
      const suggestion: KnowledgeHarvestSuggestion = {
        id: `kh-${fingerprint.slice(0, 12)}`,
        target: "knowhow",
        kind: quality.kind,
        title,
        content: truncateBody(cand.text, settleCfg.maxBodyChars ?? DEFAULT_MAX_BODY),
        fingerprint,
        score: quality.score,
        agentId: input.agentId,
        taskType: input.taskType,
        stage: input.stage,
        sessionId: input.sessionId,
        runId: input.runId,
        evidence: input.evidenceRefs ?? [],
        at: new Date().toISOString(),
        source: "experts-settle",
      };
      suggestions.push(suggestion);
      if (suggestions.length >= max) break;
    }
    if (suggestions.length >= max) break;
  }

  // Prefer higher score
  suggestions.sort((a, b) => b.score - a.score);
  const limited = suggestions.slice(0, max);

  const stageCommands = limited.map((s) => buildStageCommand(s, input));

  if (opts.record !== false && limited.length > 0) {
    try {
      persistSuggestions(cwd, limited, [...seen], opts.statePath);
    } catch {
      // bookkeeping must not break settle
    }
  }

  // P7b: optional autoStage → self-evolve pending suggestions pool (never promote).
  let poolDeposit: SettleHarvestResult["poolDeposit"];
  if (settleCfg.autoStage === true && limited.length > 0) {
    try {
      const deposit = depositHarvestToSelfEvolvePool(limited, {
        cwd,
        sessionId: input.sessionId,
        runId: input.runId,
        outputRoot: typeof settleCfg.selfEvolveOutputRoot === "string"
          ? settleCfg.selfEvolveOutputRoot
          : undefined,
      });
      poolDeposit = {
        written: deposit.written,
        skipped: deposit.skipped,
        filePath: deposit.filePath,
        ids: deposit.ids,
      };
      if (deposit.errors.length) {
        for (const err of deposit.errors) {
          skipped.push({ reason: `self-evolve pool: ${err}` });
        }
      }
    } catch (error) {
      skipped.push({
        reason: `self-evolve pool failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { suggestions: limited, skipped, stageCommands, poolDeposit };
}

/** Build a copy-pasteable `maestro knowledge stage` command (never auto-runs). */
export function buildStageCommand(
  suggestion: KnowledgeHarvestSuggestion,
  input: Pick<SettleHarvestInput, "sessionId" | "runId" | "evidenceRefs"> = {},
): KnowledgeStageCommand {
  const sessionId = suggestion.sessionId || input.sessionId;
  const runId = suggestion.runId || input.runId;
  const args = [
    "knowledge",
    "stage",
    suggestion.target,
    suggestion.title,
  ];
  // content via stdin/file is preferred by CLI quality bar; we return content separately.
  const flags: string[] = ["--json"];
  if (runId) flags.push("--run", runId);
  else if (sessionId) flags.push("--session", sessionId);
  if (suggestion.evidence.length) {
    flags.push("--evidence", suggestion.evidence.join(","));
  }
  flags.push("--category", suggestion.kind);

  const shell = [
    "maestro",
    "knowledge",
    "stage",
    suggestion.target,
    JSON.stringify(suggestion.title),
    "--content-file",
    "-",
    ...(runId ? ["--run", runId] : sessionId ? ["--session", sessionId] : []),
    ...(suggestion.evidence.length ? ["--evidence", suggestion.evidence.join(",")] : []),
    "--category",
    suggestion.kind,
    "--json",
  ].join(" ");

  return {
    argv: ["maestro", ...args, ...flags],
    shell,
    content: suggestion.content,
    suggestionId: suggestion.id,
  };
}

export function getKnowledgeSuggestions(
  cwd = process.cwd(),
  statePath?: string,
): KnowledgeHarvestSuggestion[] {
  const raw = readRaw(cwd, statePath);
  if (!Array.isArray(raw[STATE_KEY])) return [];
  return (raw[STATE_KEY] as unknown[])
    .map((item) => normalizeSuggestion(item))
    .filter((x): x is KnowledgeHarvestSuggestion => Boolean(x));
}

export function clearKnowledgeSuggestions(
  cwd = process.cwd(),
  opts: { statePath?: string; keepFingerprints?: boolean } = {},
): void {
  const prev = readRaw(cwd, opts.statePath);
  const next: Record<string, unknown> = {
    ...prev,
    [STATE_KEY]: [],
    updatedAt: new Date().toISOString(),
  };
  if (!opts.keepFingerprints) next[SEEN_KEY] = [];
  writeRaw(cwd, next, opts.statePath);
}

/** Pure quality gate used by harvest + tests. */
export function assessKnowledgeCandidate(text: string): {
  ok: boolean;
  reason: string;
  kind: KnowledgeHarvestSuggestion["kind"];
  score: number;
} {
  return scoreCandidate(String(text || ""));
}

function collectBodies(input: SettleHarvestInput): string[] {
  const out: string[] = [];
  if (typeof input.content === "string" && input.content.trim()) out.push(input.content);
  if (Array.isArray(input.contents)) {
    for (const c of input.contents) {
      if (typeof c === "string" && c.trim()) out.push(c);
    }
  }
  return out;
}

function extractCandidateBlocks(
  body: string,
  input: SettleHarvestInput,
): Array<{ title?: string; text: string }> {
  const text = stripResultEnvelope(body).trim();
  if (!text) return [];

  // Explicit markers from expert output
  const marked: Array<{ title?: string; text: string }> = [];
  const blockRe =
    /(?:^|\n)\s*(?:KNOWLEDGE|KNOWHOW|PITFALL|LESSON|FAILURE|CONSTRAINT|TRADE-?OFF)\s*[:：]\s*(.+?)(?=\n\s*(?:KNOWLEDGE|KNOWHOW|PITFALL|LESSON|FAILURE|CONSTRAINT|TRADE-?OFF)\s*[:：]|\n---|\n#|$)/gis;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const chunk = m[1]?.trim();
    if (chunk) marked.push({ text: chunk });
  }
  if (marked.length) return marked;

  // fenced knowhow blocks
  const fenceRe = /```(?:knowhow|knowledge|pitfall)\s*([\s\S]*?)```/gi;
  while ((m = fenceRe.exec(text)) !== null) {
    const chunk = m[1]?.trim();
    if (chunk) marked.push({ text: chunk });
  }
  if (marked.length) return marked;

  // Heuristic: split into paragraphs; keep substantial ones with signal
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const scored = paras
    .map((p) => ({ text: p, q: scoreCandidate(p) }))
    .filter((x) => x.q.ok)
    .sort((a, b) => b.q.score - a.q.score)
    .slice(0, 3)
    .map((x) => ({ text: x.text }));

  if (scored.length) return scored;

  // Last resort: whole body if it itself passes quality
  if (scoreCandidate(text).ok) {
    return [{
      title: input.titleHint,
      text,
    }];
  }
  return [];
}

function scoreCandidate(text: string): {
  ok: boolean;
  reason: string;
  kind: KnowledgeHarvestSuggestion["kind"];
  score: number;
} {
  const t = text.trim();
  if (t.length < DEFAULT_MIN_BODY) {
    return { ok: false, reason: `too short (<${DEFAULT_MIN_BODY})`, kind: "knowhow", score: 0 };
  }
  if (RAW_TRACE_PATTERNS.some((re) => re.test(t))) {
    return { ok: false, reason: "raw tool/trace content rejected", kind: "knowhow", score: 0 };
  }
  if (LOW_VALUE_PATTERNS.some((re) => re.test(t))) {
    return { ok: false, reason: "trivial / low-value content", kind: "knowhow", score: 0 };
  }
  // Reject pure code dumps without prose
  const codeRatio = (t.match(/[{};=<>]/g) || []).length / Math.max(t.length, 1);
  if (codeRatio > 0.12 && !SIGNAL_HINTS.some((h) => h.re.test(t))) {
    return { ok: false, reason: "code-heavy without lesson signal", kind: "knowhow", score: 0 };
  }

  let score = 1;
  let kind: KnowledgeHarvestSuggestion["kind"] = "knowhow";
  for (const hint of SIGNAL_HINTS) {
    if (hint.re.test(t)) {
      score += hint.weight;
      if (hint.weight >= 2 || kind === "knowhow") kind = hint.kind;
    }
  }
  // Prefer actionable structure: "when X … because Y"
  if (/\bwhen\b.+\b(because|since|否则|因为)\b/i.test(t) || /当.+时.+(因为|否则)/.test(t)) {
    score += 2;
  }
  if (score < 2) {
    return { ok: false, reason: "no durable lesson signal", kind: "knowhow", score };
  }
  return { ok: true, reason: "ok", kind, score };
}

function stripResultEnvelope(body: string): string {
  const idx = body.search(/---\s*RESULT\s*---/i);
  if (idx >= 0) {
    return body.slice(idx).replace(/---\s*RESULT\s*---/i, "").trim();
  }
  return body;
}

function deriveTitle(text: string, kind: string): string {
  const first = text.split(/\n/)[0]?.trim() || kind;
  const cleaned = first.replace(/^[#*\-\d.)\s]+/, "").slice(0, 80);
  return cleaned || `experts-${kind}`;
}

function truncateBody(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20).trimEnd()}\n…[truncated]`;
}

function fingerprintText(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
  return createHash("sha256").update(norm).digest("hex");
}

function readRaw(cwd: string, statePath?: string): Record<string, unknown> {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRaw(cwd: string, next: Record<string, unknown>, statePath?: string): void {
  const file = resolveStatePath(cwd, statePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readSeenFingerprints(cwd: string, statePath?: string): string[] {
  const raw = readRaw(cwd, statePath);
  if (!Array.isArray(raw[SEEN_KEY])) return [];
  return (raw[SEEN_KEY] as unknown[]).map(String).filter(Boolean);
}

function persistSuggestions(
  cwd: string,
  suggestions: KnowledgeHarvestSuggestion[],
  seen: string[],
  statePath?: string,
): void {
  const prev = readRaw(cwd, statePath);
  const existing = Array.isArray(prev[STATE_KEY])
    ? (prev[STATE_KEY] as unknown[]).map(normalizeSuggestion).filter(Boolean) as KnowledgeHarvestSuggestion[]
    : [];
  const byFp = new Map<string, KnowledgeHarvestSuggestion>();
  for (const s of existing) byFp.set(s.fingerprint, s);
  for (const s of suggestions) byFp.set(s.fingerprint, s);
  const merged = [...byFp.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, DEFAULT_MAX_SUGGESTIONS * 4);
  writeRaw(cwd, {
    ...prev,
    mode: prev.mode === "experts" || prev.mode === "normal" ? prev.mode : getMode(cwd, statePath),
    [STATE_KEY]: merged,
    [SEEN_KEY]: seen.slice(-200),
    updatedAt: new Date().toISOString(),
  }, statePath);
}

function normalizeSuggestion(item: unknown): KnowledgeHarvestSuggestion | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.content !== "string" || typeof o.fingerprint !== "string") {
    return null;
  }
  return {
    id: o.id,
    target: o.target === "spec" ? "spec" : "knowhow",
    kind: (["pitfall", "failure-lesson", "trade-off", "constraint", "knowhow"].includes(String(o.kind))
      ? String(o.kind)
      : "knowhow") as KnowledgeHarvestSuggestion["kind"],
    title: String(o.title || o.id),
    content: String(o.content),
    fingerprint: String(o.fingerprint),
    score: typeof o.score === "number" ? o.score : 0,
    agentId: typeof o.agentId === "string" ? o.agentId : undefined,
    taskType: typeof o.taskType === "string" ? o.taskType : undefined,
    stage: typeof o.stage === "string" ? o.stage : undefined,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    runId: typeof o.runId === "string" ? o.runId : undefined,
    evidence: Array.isArray(o.evidence) ? o.evidence.map(String) : [],
    at: typeof o.at === "string" ? o.at : new Date().toISOString(),
    source: "experts-settle",
  };
}
