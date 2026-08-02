import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;
export const DEFAULT_MCP_ARTIFACT_MAX_FILES = 32;
export const DEFAULT_MCP_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MCP_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_MCP_ARTIFACT_DIRECTORY = join(tmpdir(), "pi-mcp-output");
const ARTIFACT_FILE_PATTERN = /^(?:output|mcp-result)-(\d{13})-[a-zA-Z0-9-]+\.txt$/;
const JSON_CHUNK_CHARS = 4096;
const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = Record<string, unknown>;

export interface McpOutputGuardDetails {
  truncated: true;
  originalBytes: number;
  returnedBytes: number;
  originalLines: number;
  returnedLines: number;
  /** Number of image content blocks returned untouched alongside the truncated text. */
  imageBlocksPassedThrough?: number;
  fullOutputPath?: string;
  writeError?: string;
}

export interface McpResultSummary {
  omitted: true;
  reason: string;
  isError: boolean;
  contentBlocks: number;
  contentSummary: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  extraFields?: Array<Record<string, unknown>>;
  rawResultBytes: number;
  fullResultPath?: string;
  resultWriteError?: string;
}

export interface McpArtifactRetentionOptions {
  /** A single directory used for all retained MCP output artifacts. */
  directory?: string;
  maxFiles?: number;
  maxBytes?: number;
  ttlMs?: number;
}

export interface McpOutputGuardOptions {
  enabled?: boolean;
  prefix?: string;
  suffix?: string;
  emptyTextFallback?: string;
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
  artifactRetention?: McpArtifactRetentionOptions;
  /**
   * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
   * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
   * with a compact summary and spilled to a temp file. Omit for call sites
   * whose details never carried the raw result (e.g. direct tools).
   */
  rawMcpResult?: unknown;
}

export interface GuardedMcpOutput {
  content: ContentBlock[];
  outputGuard?: McpOutputGuardDetails;
  mcpResult?: unknown;
}

export function resolveMcpOutputGuardOptions(settings?: McpSettings): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"> {
  const configured = settings?.outputGuard;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** Spread helper for tool-result details: includes mcpResult/outputGuard only when present. */
export function guardedMcpDetails(guarded: GuardedMcpOutput): Record<string, unknown> {
  return {
    ...(guarded.mcpResult !== undefined ? { mcpResult: guarded.mcpResult } : {}),
    ...(guarded.outputGuard ? { outputGuard: guarded.outputGuard } : {}),
  };
}

/**
 * Bound model-facing MCP output. Text output is capped at maxBytes/maxLines and
 * spilled to a temp file when oversized. Image blocks pass through untouched —
 * they are delivered to the provider as native image content, not text context.
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  if (options.enabled === false) {
    return {
      content: addAffixes(normalizedContent, prefix, suffix),
      mcpResult: options.rawMcpResult,
    };
  }

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (stats.bytes > maxBytes || stats.lines > maxLines) {
    const { path: fullOutputPath, error: writeError } = await saveTextArtifact("output", composedOutput, options.artifactRetention);
    const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, notice);
    const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
    const finalText = `${preview.content}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    outputGuard = {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      fullOutputPath,
      writeError,
    };
  }

  const mcpResult = options.rawMcpResult === undefined
    ? undefined
    : await boundMcpResult(options.rawMcpResult, detailsMaxBytes, options.artifactRetention);

  return { content: guardedContent, outputGuard, mcpResult };
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim().slice(0, 100)
      : "image/png";
    return { ...block, mimeType };
  });
}

function withEmptyTextFallback(content: ContentBlock[], fallback: string | undefined): ContentBlock[] {
  if (!fallback) return content;
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  if (textOutput) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string): { maxBytes: number; maxLines: number } {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(text: string, maxBytes: number, maxLines: number): { content: string; bytes: number; lines: number } {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) break;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        output.push(truncateStringToBytes(line, remaining));
      }
      break;
    }
    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  const content = output.join("\n");
  const stats = textStats(content);
  return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: { bytes: number; lines: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath) {
    return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

/**
 * Bound details.mcpResult without serializing the complete value in memory.
 * The first traversal stops as soon as the configured byte budget is crossed.
 */
async function boundMcpResult(
  result: unknown,
  detailsMaxBytes: number,
  retention: McpArtifactRetentionOptions | undefined,
): Promise<unknown> {
  const measured = measureJson(result, detailsMaxBytes);
  if (!measured.exceeded && !measured.lossy) return result;

  const saved = await saveJsonArtifact("mcp-result", result, retention);
  return summarizeMcpResult(
    result,
    saved.bytes ?? measured.bytes,
    saved.path,
    saved.error,
    measured.lossy || saved.lossy,
  );
}

function summarizeMcpResult(
  result: unknown,
  rawBytes: number,
  fullResultPath: string | undefined,
  resultWriteError: string | undefined,
  lossy: boolean,
): McpResultSummary {
  const record = asRecord(result);
  const contentValue = record ? dataProperty(record, "content") : undefined;
  const content = Array.isArray(contentValue) ? contentValue : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason: lossy
      ? "Raw MCP result was not safely JSON-compatible and was replaced with this summary; the retained artifact uses explicit placeholders for unsupported values."
      : "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record ? dataProperty(record, "isError") === true : false,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    fullResultPath,
    resultWriteError,
  };

  if (record && safeKeys(record).includes("structuredContent")) {
    summary.structuredContent = summarizeValue(dataProperty(record, "structuredContent"));
  }
  if (record && safeKeys(record).includes("_meta")) {
    summary.meta = summarizeValue(dataProperty(record, "_meta"));
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = safeKeys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key) => {
        const value = dataProperty(record, key);
        return { key: truncateKey(key), type: typeof value, estimatedBytes: estimateValueBytes(value), omitted: true };
      });
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: unknown[]): Array<Record<string, unknown>> {
  const summaries: Array<Record<string, unknown>> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
    const record = asRecord(block);
    if (!record) return { type: typeof block, omitted: true };
    const type = dataProperty(record, "type");
    if (type === "text") {
      const textValue = dataProperty(record, "text");
      const text = typeof textValue === "string" ? textValue : "";
      return { type: "text", bytes: byteLength(text), lines: textStats(text).lines, textOmitted: true };
    }
    if (type === "image") {
      const dataValue = dataProperty(record, "data");
      const mimeTypeValue = dataProperty(record, "mimeType");
      const data = typeof dataValue === "string" ? dataValue : "";
      return { type: "image", mimeType: typeof mimeTypeValue === "string" ? mimeTypeValue : undefined, dataBytes: byteLength(data), dataOmitted: true };
    }
    return { type: typeof type === "string" ? type : "unknown", estimatedBytes: estimateValueBytes(record), omitted: true };
  });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return { type: value === null ? "null" : typeof value, estimatedBytes: estimateValueBytes(value), omitted: true };
  }
  const keys = safeKeys(record);
  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes(value: unknown): number {
  return measureJson(value, DEFAULT_MCP_DETAILS_MAX_BYTES).bytes;
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

interface JsonSerializationState {
  lossy: boolean;
}

function measureJson(value: unknown, maxBytes: number): { exceeded: boolean; bytes: number; lossy: boolean } {
  const state: JsonSerializationState = { lossy: false };
  let bytes = 0;
  for (const chunk of serializeJsonValue(value, state, new Set<object>())) {
    bytes += byteLength(chunk);
    if (bytes > maxBytes) return { exceeded: true, bytes, lossy: state.lossy };
  }
  return { exceeded: false, bytes, lossy: state.lossy };
}

function* serializeJsonValue(
  value: unknown,
  state: JsonSerializationState,
  ancestors: Set<object>,
): Generator<string> {
  if (value === null) {
    yield "null";
    return;
  }
  if (typeof value === "string") {
    yield* serializeJsonString(value);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? String(value) : "null";
    return;
  }
  if (typeof value === "boolean") {
    yield value ? "true" : "false";
    return;
  }
  if (typeof value === "bigint") {
    state.lossy = true;
    yield* serializeJsonString(`${value}n`);
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    state.lossy = true;
    yield "null";
    return;
  }

  if (hasCustomJsonSerializer(value)) state.lossy = true;
  if (ancestors.has(value)) {
    state.lossy = true;
    yield* serializeJsonString("[Circular]");
    return;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ",";
        const item = dataProperty(value as unknown as Recordish, String(index));
        yield* serializeJsonValue(item, state, ancestors);
      }
      yield "]";
      return;
    }

    yield "{";
    let emitted = 0;
    for (const key of serializationKeys(value, state)) {
      const descriptor = safeDescriptor(value, key);
      if (descriptor && "value" in descriptor && isJsonObjectOmission(descriptor.value)) continue;
      if (emitted > 0) yield ",";
      emitted += 1;
      yield* serializeJsonString(key);
      yield ":";
      if (!descriptor || !("value" in descriptor)) {
        state.lossy = true;
        yield* serializeJsonString("[Accessor omitted]");
      } else {
        yield* serializeJsonValue(descriptor.value, state, ancestors);
      }
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

function* serializeJsonString(value: string): Generator<string> {
  yield "\"";
  let chunk = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let encoded: string;
    if (code === 0x22) encoded = "\\\"";
    else if (code === 0x5c) encoded = "\\\\";
    else if (code === 0x08) encoded = "\\b";
    else if (code === 0x0c) encoded = "\\f";
    else if (code === 0x0a) encoded = "\\n";
    else if (code === 0x0d) encoded = "\\r";
    else if (code === 0x09) encoded = "\\t";
    else if (code < 0x20) encoded = `\\u${code.toString(16).padStart(4, "0")}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encoded = value[index] + value[index + 1];
        index += 1;
      } else {
        encoded = `\\u${code.toString(16)}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      encoded = `\\u${code.toString(16)}`;
    } else {
      encoded = value[index];
    }
    chunk += encoded;
    if (chunk.length >= JSON_CHUNK_CHARS) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
  yield "\"";
}

function isJsonObjectOmission(value: unknown): boolean {
  return typeof value === "undefined" || typeof value === "function" || typeof value === "symbol";
}

function serializationKeys(value: object, state: JsonSerializationState): string[] {
  try {
    return Object.keys(value);
  } catch {
    state.lossy = true;
    return [];
  }
}

function hasCustomJsonSerializer(value: object): boolean {
  let current: object | null = value;
  try {
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
      if (descriptor) return !("value" in descriptor) || typeof descriptor.value === "function";
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return true;
  }
  return false;
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function safeDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function dataProperty(record: Recordish, key: string): unknown {
  const descriptor = safeDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

interface ResolvedArtifactRetention {
  directory: string;
  maxFiles: number;
  maxBytes: number;
  ttlMs: number;
}

interface ArtifactEntry {
  path: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  bytes: number;
}

let artifactSequence = 0;
let artifactOperationQueue: Promise<void> = Promise.resolve();
const artifactExpiryTimers = new Map<string, NodeJS.Timeout>();

function saveTextArtifact(
  kind: string,
  text: string,
  options: McpArtifactRetentionOptions | undefined,
): Promise<{ path?: string; error?: string; bytes?: number }> {
  return retainArtifact(kind, function* chunks() {
    for (let offset = 0; offset < text.length; offset += 64 * 1024) {
      yield text.slice(offset, offset + 64 * 1024);
    }
  }, options);
}

async function saveJsonArtifact(
  kind: string,
  value: unknown,
  options: McpArtifactRetentionOptions | undefined,
): Promise<{ path?: string; error?: string; bytes?: number; lossy: boolean }> {
  const state: JsonSerializationState = { lossy: false };
  const saved = await retainArtifact(
    kind,
    () => serializeJsonValue(value, state, new Set<object>()),
    options,
  );
  return { ...saved, lossy: state.lossy };
}

function retainArtifact(
  kind: string,
  chunks: () => Iterable<string>,
  options: McpArtifactRetentionOptions | undefined,
): Promise<{ path?: string; error?: string; bytes?: number }> {
  const retention = resolveArtifactRetention(options);
  return enqueueArtifactOperation(async () => {
    let path: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let bytes = 0;
    try {
      await ensurePrivateArtifactDirectory(retention.directory);
      await pruneArtifacts(retention);
      const createdAt = Date.now();
      const sequence = (artifactSequence = (artifactSequence + 1) % 1_000_000);
      const name = `${kind}-${String(createdAt).padStart(13, "0")}-${process.pid}-${String(sequence).padStart(6, "0")}-${randomBytes(6).toString("hex")}.txt`;
      path = join(retention.directory, name);
      handle = await open(path, "wx", 0o600);
      for (const chunk of chunks()) {
        bytes += byteLength(chunk);
        if (bytes > retention.maxBytes) {
          throw new Error(`Artifact exceeds retention byte limit of ${retention.maxBytes}`);
        }
        await handle.write(chunk, undefined, "utf8");
      }
      await handle.close();
      handle = undefined;
      await chmod(path, 0o600);
      const retained = await pruneArtifacts(retention, path);
      if (!retained) throw new Error("Artifact could not be retained within the configured count/byte limits");
      scheduleArtifactExpiry(path, retention);
      return { path, bytes };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (path) await removeArtifact(path);
      return { error: error instanceof Error ? error.message : String(error), bytes: bytes || undefined };
    }
  });
}

function resolveArtifactRetention(options: McpArtifactRetentionOptions | undefined): ResolvedArtifactRetention {
  return {
    directory: typeof options?.directory === "string" && options.directory.trim()
      ? options.directory
      : DEFAULT_MCP_ARTIFACT_DIRECTORY,
    maxFiles: positiveInt(options?.maxFiles) ?? DEFAULT_MCP_ARTIFACT_MAX_FILES,
    maxBytes: positiveInt(options?.maxBytes) ?? DEFAULT_MCP_ARTIFACT_MAX_BYTES,
    ttlMs: positiveInt(options?.ttlMs) ?? DEFAULT_MCP_ARTIFACT_TTL_MS,
  };
}

function enqueueArtifactOperation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = artifactOperationQueue.then(operation, operation);
  artifactOperationQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

async function ensurePrivateArtifactDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe MCP artifact directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

async function pruneArtifacts(retention: ResolvedArtifactRetention, protectedPath?: string): Promise<boolean> {
  const now = Date.now();
  let entries = await listArtifacts(retention.directory);
  for (const entry of entries) {
    if (now - entry.modifiedAt >= retention.ttlMs && entry.path !== protectedPath) {
      await removeArtifact(entry.path);
    }
  }

  entries = await listArtifacts(retention.directory);
  let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  while (entries.length > retention.maxFiles || totalBytes > retention.maxBytes) {
    const victimIndex = entries.findIndex((entry) => entry.path !== protectedPath);
    if (victimIndex < 0) {
      if (protectedPath) await removeArtifact(protectedPath);
      return false;
    }
    const [victim] = entries.splice(victimIndex, 1);
    totalBytes -= victim.bytes;
    await removeArtifact(victim.path);
  }
  return protectedPath === undefined || entries.some((entry) => entry.path === protectedPath);
}

async function listArtifacts(directory: string): Promise<ArtifactEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const artifacts: ArtifactEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ARTIFACT_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      artifacts.push({
        path,
        name: entry.name,
        createdAt: Number(match[1]),
        modifiedAt: info.mtimeMs,
        bytes: info.size,
      });
    } catch {
      // A concurrent cleanup may remove an entry between readdir and stat.
    }
  }
  return artifacts.sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
}

async function removeArtifact(path: string): Promise<void> {
  const timer = artifactExpiryTimers.get(path);
  if (timer) clearTimeout(timer);
  artifactExpiryTimers.delete(path);
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function scheduleArtifactExpiry(path: string, retention: ResolvedArtifactRetention): void {
  const existing = artifactExpiryTimers.get(path);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    artifactExpiryTimers.delete(path);
    void enqueueArtifactOperation(async () => {
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs >= retention.ttlMs) await removeArtifact(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }).catch(() => undefined);
  }, retention.ttlMs);
  timer.unref();
  artifactExpiryTimers.set(path, timer);
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function textStats(text: string): { bytes: number; lines: number } {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
