import { createHash } from "node:crypto";
import type { KnowledgeStageOptions } from "./cli-adapter.ts";

/**
 * K14: 窗口会话原始记录提取器（Pi 插件侧）。
 *
 * 从 Pi 宿主会话分支（ctx.sessionManager.getBranch()）提取最近的可读文本，
 * 组装成 K13 stage 输入 JSON `{host_kind, host_session_id, entry_id, quote}`，
 * 经 knowledge stage `--transcript-quote` 透传给 CLI。quote 默认截断至 32 KiB
 * （对齐 K13 单片段上限）。铁律 10：提取的 quote 按 untrusted 处理——只作为证据
 * 快照原料，绝不进注入/索引/LLM 上下文。
 */

/** K13 stage 片段输入的最小结构（与 CLI 侧契约一致）。 */
export interface TranscriptQuoteInput {
  host_kind: string;
  host_session_id: string;
  entry_id: string;
  quote: string;
}

export interface TranscriptBoundCandidate {
  /** Human-authored/distilled knowledge正文，绝不由 quote 自动填充。 */
  content: string;
  /** Window transcript descriptor，仅作为 --transcript-quote evidence 输入。 */
  transcriptQuote: string;
}

/**
 * Keep candidate正文 and raw window quote on separate fields. This pure helper
 * is used by the production handler and tested directly so future refactors
 * cannot accidentally route the quote into review/corpus content again.
 */
export function bindTranscriptEvidence(
  candidateContent: string,
  transcriptQuote: string,
): TranscriptBoundCandidate {
  if (!candidateContent.trim()) throw new Error("candidate content is required");
  const descriptor = JSON.parse(transcriptQuote) as Partial<TranscriptQuoteInput>;
  if (typeof descriptor.quote !== "string" || descriptor.quote.length === 0) {
    throw new Error("transcript quote descriptor is invalid");
  }
  return { content: candidateContent, transcriptQuote };
}

export interface StageWindowKnowledgeResult<TResult> {
  result: TResult | null;
  reason?: string;
}

/**
 * Production K14 composition: extract the current window quote, keep it out of
 * candidate content, and invoke the caller's real stage adapter. Tests inject a
 * fake stage function but execute this exact production function.
 */
export async function stageWindowKnowledgeCandidate<TResult>(
  ctx: TranscriptContextLike,
  sessionId: string | undefined,
  candidate: Omit<KnowledgeStageOptions, "transcriptQuote" | "transcriptQuoteFile">,
  stage: (options: KnowledgeStageOptions) => Promise<TResult>,
): Promise<StageWindowKnowledgeResult<TResult>> {
  const reasons: string[] = [];
  const transcriptQuote = extractTranscriptQuote(ctx, sessionId, {
    onReason(reason) {
      reasons.push(reason);
    },
  });
  if (!transcriptQuote) {
    return { result: null, reason: reasons.at(-1) ?? "No readable transcript entry is available" };
  }
  const bound = bindTranscriptEvidence(candidate.content, transcriptQuote);
  return {
    result: await stage({
      ...candidate,
      content: bound.content,
      transcriptQuote: bound.transcriptQuote,
    }),
  };
}

/** K13 单片段 quote 字节上限（CLI 侧同值，32 KiB）。 */
export const DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES = 32 * 1024;

/** 去重指纹集默认保留的最近指纹数。 */
const DEFAULT_MAX_FINGERPRINTS = 8;

/** 结构最小 sessionManager 视图：对齐 extension 里 ctx.sessionManager 的只读用法。 */
export interface TranscriptSessionManagerLike {
  getBranch?(): unknown;
  getSessionId?(): string | undefined;
}

export interface TranscriptContextLike {
  sessionManager: TranscriptSessionManagerLike;
}

export interface ExtractTranscriptQuoteOptions {
  /** quote 字节上限（默认 32 KiB，对齐 K13 单片段上限）。 */
  maxQuoteBytes?: number;
  /**
   * 可选最近 N 条指纹集：同一内容去重。跨调用共享同一 Set 时，连续调用不会
   * 重复提取同一 quote（命中则跳过该条目，继续找更早的非重复条目）。
   */
  dedupFingerprints?: Set<string>;
  /** 指纹集保留条目数上限（默认 8；超出移除最旧）。 */
  maxFingerprints?: number;
  /** 失败/跳过原因记录器（默认 console.warn；测试可注入 spy）。 */
  onReason?: (reason: string) => void;
}

/**
 * 提取最近一条可读会话文本并组装 K13 JSON。
 *
 * 提取顺序（在全局时间倒序上）：
 * 1. 优先最近的原始 message/custom_message 文本；
 * 2. 原文不可用时才回退到 compaction/branch_summary 派生摘要。
 * 任意 custom data 不作为 transcript 证据，避免把插件状态误当对话原文。
 *
 * 错误安全：getBranch 抛错 / 空分支 / 无文本 / 全部命中去重指纹时返回 null，
 * 并通过 opts.onReason（默认 console.warn）记录原因，不向上抛异常。
 *
 * @param ctx       会话上下文（仅使用 sessionManager 只读面）
 * @param sessionId 可选的调用方会话 id——只用于原因记录的诊断上下文，
 *                  K13 JSON 的 host_session_id 固定取自 ctx.sessionManager
 * @param opts      截断上限 / 去重指纹集 / 原因记录器
 */
export function extractTranscriptQuote(
  ctx: TranscriptContextLike,
  sessionId: string | undefined,
  opts: ExtractTranscriptQuoteOptions = {},
): string | null {
  const reason = opts.onReason ?? defaultReason;
  const maxQuoteBytes = positiveInteger(opts.maxQuoteBytes ?? DEFAULT_TRANSCRIPT_QUOTE_MAX_BYTES, "maxQuoteBytes");
  const fingerprintLimit = positiveInteger(opts.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS, "maxFingerprints");
  const contextLabel = sessionId ? ` (session ${sessionId})` : "";

  let branch: unknown;
  try {
    branch = ctx.sessionManager.getBranch?.();
  } catch (error) {
    reason(`getBranch() threw${contextLabel}: ${errorMessage(error)}`);
    return null;
  }
  if (!Array.isArray(branch) || branch.length === 0) {
    reason(`no branch entries available${contextLabel}`);
    return null;
  }

  // getBranch() 返回 root 优先（时间正序），倒序扫描得到"最近优先"。
  const entries = [...branch].reverse() as BranchEntryLike[];
  const hostSessionId = ctx.sessionManager.getSessionId?.()?.trim() || "unknown";
  const dedup = opts.dedupFingerprints;

  // 第一遍：最新原始对话消息。不能让更旧的 compaction/custom 抢过
  // 用户刚刚产生的窗口原文。
  const primary = selectQuote(entries, originalEntryText, hostSessionId, dedup, fingerprintLimit, maxQuoteBytes);
  if (primary.json) return primary.json;

  // 第二遍：原文不可用时才回退到明确的派生摘要。
  const fallback = selectQuote(entries, derivedEntryText, hostSessionId, dedup, fingerprintLimit, maxQuoteBytes);
  if (fallback.json) return fallback.json;

  if (primary.sawText || fallback.sawText) {
    reason(`all candidate quotes match recent fingerprints (dedup)${contextLabel}`);
  } else {
    reason(`no readable text found in branch entries${contextLabel}`);
  }
  return null;
}

interface BranchEntryLike {
  type?: string;
  id?: string;
  summary?: string;
  content?: unknown;
  details?: unknown;
  data?: unknown;
  message?: { content?: unknown };
}

interface SelectOutcome {
  json: string;
  sawText: boolean;
}

/** 按提取器逐条扫描（最近优先），返回首个非去重命中的 K13 JSON。 */
function selectQuote(
  entries: readonly BranchEntryLike[],
  extract: (entry: BranchEntryLike) => string | undefined,
  hostSessionId: string,
  dedup: Set<string> | undefined,
  fingerprintLimit: number,
  maxQuoteBytes: number,
): SelectOutcome {
  let sawText = false;
  for (const entry of entries) {
    if (!entry.id) continue;
    const text = extract(entry);
    if (!text) continue;
    sawText = true;
    const fingerprint = sha256Hex(text);
    if (dedup?.has(fingerprint)) continue; // 同一内容去重：跳过，继续找更早条目
    if (dedup) rememberFingerprint(dedup, fingerprint, fingerprintLimit);
    const quote = truncateUtf8(text, maxQuoteBytes);
    const payload: TranscriptQuoteInput = {
      host_kind: "pi",
      host_session_id: hostSessionId,
      entry_id: entry.id,
      quote,
    };
    return { json: JSON.stringify(payload), sawText: true };
  }
  return { json: "", sawText };
}

/** 原始窗口消息；custom data/state 永不自动当作 transcript。 */
function originalEntryText(entry: BranchEntryLike): string | undefined {
  if (entry.type === "message") return contentText(entry.message?.content);
  if (entry.type === "custom_message") return contentText(entry.content);
  return undefined;
}

/** 原文不可用时的派生证据回退面。 */
function derivedEntryText(entry: BranchEntryLike): string | undefined {
  if (entry.type === "compaction") {
    return firstStringField(entry.details) ?? nonBlank(entry.summary);
  }
  if (entry.type === "branch_summary") return nonBlank(entry.summary);
  return undefined;
}

const TEXT_KEYS = ["text", "content", "summary", "message", "quote"] as const;

/** 从字符串或对象里取第一个非空白文本字段（不裁剪内容，保留原始 fidelity）。 */
function firstStringField(value: unknown): string | undefined {
  if (typeof value === "string") return nonBlank(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const text = nonBlank(candidate);
      if (text) return text;
    }
  }
  return undefined;
}

/** content 块数组（text 类型）或纯字符串 → 文本。 */
function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return nonBlank(value);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (block && typeof block === "object") {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") {
        const text = nonBlank(record.text);
        if (text) parts.push(text);
      }
    } else if (typeof block === "string") {
      const text = nonBlank(block);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 按码点截断 UTF-8 文本，保证不切断多字节字符（对齐 runner 的 boundedDiagnostic 风格）。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 保留最近 limit 条指纹：Set 保持插入序，超出时移除最旧。 */
function rememberFingerprint(set: Set<string>, fingerprint: string, limit: number): void {
  set.add(fingerprint);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function defaultReason(message: string): void {
  console.warn(`[pi-maestro-flow][knowledge] transcript quote extraction: ${message}`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
