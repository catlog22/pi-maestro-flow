import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;

interface ParsedSession {
  header: JsonObject;
  entries: JsonObject[];
  lineByEntryId: Map<string, number>;
}

interface ProtocolMessage {
  message: JsonObject;
  entryId: string;
}

export type ForkSnapshotDestination =
  | { kind: "path"; path: string }
  | { kind: "temp"; directory?: string };

export interface CreateForkSnapshotOptions {
  sourcePath: string;
  spawningToolCallId: string;
  destination: ForkSnapshotDestination;
}

export type ForkSnapshotDiagnosticCode =
  | "invalid-options"
  | "source-read-failed"
  | "invalid-jsonl"
  | "invalid-session-header"
  | "unsupported-session-version"
  | "invalid-entry"
  | "duplicate-entry-id"
  | "broken-parent-chain"
  | "parent-cycle"
  | "spawning-tool-call-not-found"
  | "invalid-compaction"
  | "invalid-tool-call"
  | "duplicate-tool-call"
  | "invalid-tool-result"
  | "unknown-tool-result"
  | "duplicate-tool-result"
  | "unmatched-tool-call"
  | "destination-write-failed";

export interface ForkSnapshotDiagnostic {
  kind: "fork-snapshot-invalid";
  code: ForkSnapshotDiagnosticCode;
  message: string;
  sourcePath: string;
  line?: number;
  entryId?: string;
  toolCallId?: string;
}

export interface ForkSnapshotSuccess {
  ok: true;
  sourcePath: string;
  snapshotPath: string;
  sessionId: string;
  spawningToolCallId: string;
  excludedMessageId: string;
  retainedEntryCount: number;
  retainedLeafId: string | null;
  temporaryDirectory?: string;
  /**
   * Set when a synthetic compaction boundary was injected into the snapshot so
   * the child's provider context excludes the oldest retained history. Callers
   * surface this to the transcript so dispatchers know the forked context was
   * truncated rather than carrying the full parent history.
   */
  injectedCompactionBoundary?: boolean;
}

export interface ForkSnapshotFailure {
  ok: false;
  diagnostic: ForkSnapshotDiagnostic;
}

export type ForkSnapshotResult = ForkSnapshotSuccess | ForkSnapshotFailure;

const SESSION_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

/**
 * When the retained ancestor chain exceeds this many entries and no recent
 * compaction already bounds the projected context, inject a synthetic
 * compaction boundary so the child's buildSessionContext truncates the oldest
 * history instead of feeding the full fork-parent transcript to the model.
 * Conservative: only pathological fork sources (long sessions that never
 * auto-compacted) trigger injection; normal small forks are unchanged.
 */
const FORK_COMPACTION_THRESHOLD = 50;

/**
 * Materialize a Pi v3 fork source immediately before one exact tool call.
 * The spawning assistant message and every descendant are excluded together.
 */
export function createForkSnapshot(options: CreateForkSnapshotOptions): ForkSnapshotResult {
  const sourcePath = options.sourcePath;
  if (!isNonEmptyString(sourcePath) || !isNonEmptyString(options.spawningToolCallId)) {
    return failure(sourcePath, "invalid-options", "Source path and spawning toolCall id must be non-empty strings");
  }
  if (options.destination.kind === "path" && !isNonEmptyString(options.destination.path)) {
    return failure(sourcePath, "invalid-options", "Fork snapshot destination path must not be empty");
  }
  if (options.destination.kind === "temp"
    && options.destination.directory !== undefined
    && !isNonEmptyString(options.destination.directory)) {
    return failure(sourcePath, "invalid-options", "Fork snapshot temporary directory must not be empty");
  }

  let content: string;
  try {
    content = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    return failure(sourcePath, "source-read-failed", `Cannot read fork source: ${errorMessage(error)}`);
  }

  const parsed = parseSession(content, sourcePath);
  if (!parsed.ok) return parsed;

  const byId = new Map<string, JsonObject>();
  for (const entry of parsed.session.entries) byId.set(entry.id as string, entry);

  const activeChain = buildAncestorChain(parsed.session.entries.at(-1), byId, sourcePath, parsed.session.lineByEntryId);
  if (!activeChain.ok) return activeChain;

  let spawningIndex = -1;
  for (let index = activeChain.chain.length - 1; index >= 0; index -= 1) {
    if (assistantContainsToolCall(activeChain.chain[index]!, options.spawningToolCallId)) {
      spawningIndex = index;
      break;
    }
  }
  if (spawningIndex < 0) {
    return failure(
      sourcePath,
      "spawning-tool-call-not-found",
      `Active session branch does not contain assistant toolCall ${options.spawningToolCallId}`,
      { toolCallId: options.spawningToolCallId },
    );
  }

  const spawningEntry = activeChain.chain[spawningIndex]!;
  const retainedEntries = activeChain.chain.slice(0, spawningIndex);
  const injection = injectCompactionBoundaryIfNeeded(retainedEntries, parsed.session.header);
  const retainedAfterInjection = injection.entries;
  const protocolMessages = selectProtocolMessages(retainedAfterInjection, sourcePath, parsed.session.lineByEntryId);
  if (!protocolMessages.ok) return protocolMessages;
  const protocolValidation = validateToolProtocol(protocolMessages.messages, sourcePath, parsed.session.lineByEntryId);
  if (!protocolValidation.ok) return protocolValidation;

  const serialized = `${[parsed.session.header, ...retainedAfterInjection].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const destination = materializeDestination(options.destination, serialized, sourcePath);
  if (!destination.ok) return destination;

  return {
    ok: true,
    sourcePath,
    snapshotPath: destination.snapshotPath,
    sessionId: parsed.session.header.id as string,
    spawningToolCallId: options.spawningToolCallId,
    excludedMessageId: spawningEntry.id as string,
    retainedEntryCount: retainedAfterInjection.length,
    retainedLeafId: (retainedAfterInjection.at(-1)?.id as string | undefined) ?? null,
    ...(destination.temporaryDirectory ? { temporaryDirectory: destination.temporaryDirectory } : {}),
    ...(injection.injected ? { injectedCompactionBoundary: true } : {}),
  };
}

function parseSession(content: string, sourcePath: string):
  | { ok: true; session: ParsedSession }
  | ForkSnapshotFailure {
  const parsedLines: Array<{ value: JsonObject; line: number }> = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return failure(sourcePath, "invalid-jsonl", `Invalid JSON on session line ${index + 1}: ${errorMessage(error)}`, {
        line: index + 1,
      });
    }
    if (!isObject(value)) {
      return failure(sourcePath, "invalid-jsonl", `Session line ${index + 1} is not a JSON object`, {
        line: index + 1,
      });
    }
    parsedLines.push({ value, line: index + 1 });
  }

  const first = parsedLines[0];
  if (!first || first.value.type !== "session"
    || !isNonEmptyString(first.value.id)
    || !isNonEmptyString(first.value.timestamp)
    || typeof first.value.cwd !== "string") {
    return failure(sourcePath, "invalid-session-header", "Fork source must begin with a valid Pi session header", {
      ...(first ? { line: first.line } : {}),
    });
  }
  if (first.value.version !== 3) {
    return failure(
      sourcePath,
      "unsupported-session-version",
      `Fork source must use Pi session version 3, received ${String(first.value.version)}`,
      { line: first.line },
    );
  }
  if (first.value.parentSession !== undefined && typeof first.value.parentSession !== "string") {
    return failure(sourcePath, "invalid-session-header", "Session header parentSession must be a string", {
      line: first.line,
    });
  }

  const entries: JsonObject[] = [];
  const lineByEntryId = new Map<string, number>();
  for (const parsedLine of parsedLines.slice(1)) {
    const entry = parsedLine.value;
    if (entry.type === "session") {
      return failure(sourcePath, "invalid-entry", "A session header may only appear as the first JSONL entry", {
        line: parsedLine.line,
      });
    }
    if (typeof entry.type !== "string" || !SESSION_ENTRY_TYPES.has(entry.type)
      || !isNonEmptyString(entry.id)
      || !(entry.parentId === null || isNonEmptyString(entry.parentId))
      || !isNonEmptyString(entry.timestamp)) {
      return failure(sourcePath, "invalid-entry", `Invalid Pi session entry on line ${parsedLine.line}`, {
        line: parsedLine.line,
        ...(isNonEmptyString(entry.id) ? { entryId: entry.id } : {}),
      });
    }
    if (entry.type === "message" && !isObject(entry.message)) {
      return failure(sourcePath, "invalid-entry", `Message entry ${entry.id} has no structured message`, {
        line: parsedLine.line,
        entryId: entry.id,
      });
    }
    if (lineByEntryId.has(entry.id)) {
      return failure(sourcePath, "duplicate-entry-id", `Duplicate session entry id ${entry.id}`, {
        line: parsedLine.line,
        entryId: entry.id,
      });
    }
    entries.push(entry);
    lineByEntryId.set(entry.id, parsedLine.line);
  }
  return { ok: true, session: { header: first.value, entries, lineByEntryId } };
}

function buildAncestorChain(
  leaf: JsonObject | undefined,
  byId: Map<string, JsonObject>,
  sourcePath: string,
  lineByEntryId: Map<string, number>,
): { ok: true; chain: JsonObject[] } | ForkSnapshotFailure {
  if (!leaf) return { ok: true, chain: [] };
  const reverseChain: JsonObject[] = [];
  const seen = new Set<string>();
  let current: JsonObject | undefined = leaf;
  while (current) {
    const id = current.id as string;
    if (seen.has(id)) {
      return failure(sourcePath, "parent-cycle", `Session parent chain contains a cycle at ${id}`, {
        entryId: id,
        line: lineByEntryId.get(id),
      });
    }
    seen.add(id);
    reverseChain.push(current);
    const parentId = current.parentId as string | null;
    if (parentId === null) break;
    current = byId.get(parentId);
    if (!current) {
      return failure(sourcePath, "broken-parent-chain", `Session entry ${id} refers to missing parent ${parentId}`, {
        entryId: id,
        line: lineByEntryId.get(id),
      });
    }
  }
  reverseChain.reverse();
  return { ok: true, chain: reverseChain };
}

function assistantContainsToolCall(entry: JsonObject, toolCallId: string): boolean {
  if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") return false;
  if (!Array.isArray(entry.message.content)) return false;
  return entry.message.content.some((block) => isObject(block)
    && block.type === "toolCall"
    && block.id === toolCallId);
}

/**
 * Result of evaluating whether a synthetic compaction boundary should be
 * injected into a fork snapshot and, if so, the rewritten retained chain.
 */
interface CompactionInjectionResult {
  entries: JsonObject[];
  injected: boolean;
}

/**
 * Decide whether to inject a synthetic compaction boundary into the retained
 * ancestor chain and, when beneficial, return the rewritten chain.
 *
 * Injection triggers only when the projected provider context (after any
 * existing compaction already bounds it) still exceeds the conservative
 * FORK_COMPACTION_THRESHOLD and a safe cut point exists. This covers both the
 * never-compacted long session and the case where a prior compaction is
 * followed by a long post-compaction tail. Fail-open preserves current
 * behavior when no safe cut point exists.
 */
function injectCompactionBoundaryIfNeeded(
  retainedEntries: JsonObject[],
  header: JsonObject,
): CompactionInjectionResult {
  if (retainedEntries.length <= FORK_COMPACTION_THRESHOLD) {
    return { entries: retainedEntries, injected: false };
  }
  // Determine the tail after the latest existing compaction: Pi core's
  // buildContextEntries already omits everything before the latest compaction,
  // so only the post-compaction tail can still be oversized. If there is no
  // compaction, the whole retained chain is the tail under consideration.
  let tailStart = 0;
  for (let index = 0; index < retainedEntries.length; index += 1) {
    if (retainedEntries[index]!.type === "compaction") {
      tailStart = index + 1;
    }
  }
  const tail = retainedEntries.slice(tailStart);
  if (tail.length <= FORK_COMPACTION_THRESHOLD) {
    // Projected context is already bounded by an existing compaction or small.
    return { entries: retainedEntries, injected: false };
  }
  // Find a safe cut point within the tail (relative to tail start) and inject
  // a new boundary so the post-compaction tail is also truncated.
  const cutPoint = findSafeCompactionCutPoint(tail);
  if (cutPoint === null) {
    return { entries: retainedEntries, injected: false };
  }
  return injectBoundaryAt(retainedEntries, tailStart + cutPoint, header);
}

/**
 * From the tail of the retained chain, find the earliest safe cut point k such
 * that entries[k..] form a self-contained protocol block: the first retained
 * entry is a user message or follows a paired toolResult, and every assistant
 * toolCall inside the retained suffix has its matching toolResult. The cut
 * point is the index of the first retained entry; entries[0..k-1] are omitted
 * by the synthetic compaction.
 */
function findSafeCompactionCutPoint(entries: JsonObject[]): number | null {
  if (entries.length === 0) return null;
  // Scan from the tail toward the head. The cut point k means entries[k-1]
  // becomes firstKeptEntryId (projected as the first retained message), so the
  // suffix entries[k-1..] must form a self-contained protocol block: every
  // assistant toolCall in entries[k-1..] has its matching toolResult also in
  // entries[k-1..], and entries[k-1] itself must not be a toolResult whose
  // toolCall lives in the omitted region.
  for (let cut = entries.length - 1; cut > 0; cut -= 1) {
    const keptSuffix = entries.slice(cut - 1);
    if (!isSafeProtocolBoundary(keptSuffix)) continue;
    return cut;
  }
  return null;
}

/**
 * A retained suffix starting at the compaction's firstKeptEntryId is safe when
 * it begins at a user message (a clean turn start) and every assistant toolCall
 * within the suffix has a matching toolResult also within the suffix. Starting
 * at a user message guarantees the first retained entry is never a toolResult
 * whose toolCall lives in the omitted pre-compaction region.
 */
function isSafeProtocolBoundary(suffix: JsonObject[]): boolean {
  if (suffix.length === 0) return false;
  const first = suffix[0]!;
  // A clean boundary starts at a user message.
  if (first.type !== "message" || !isObject(first.message) || first.message.role !== "user") {
    return false;
  }
  // Every assistant toolCall in the suffix must have a matching toolResult in
  // the suffix; otherwise validateToolProtocol fails with unmatched-tool-call.
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const entry of suffix) {
    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "toolCall" && isNonEmptyString(block.id)) {
          calls.add(block.id as string);
        }
      }
    } else if (message.role === "toolResult" && isNonEmptyString(message.toolCallId)) {
      results.add(message.toolCallId as string);
    }
  }
  if (calls.size === 0) return true;
  for (const callId of calls) {
    if (!results.has(callId)) return false;
  }
  return true;
}

/**
 * Insert a synthetic compaction entry C at index k so the child's
 * buildContextEntries projects [C.summary, entries[k-1], entries[k], ..., leaf]
 * and omits entries[0..k-2]. The layout satisfies both fork-snapshot's own
 * selectProtocolMessages invariant (firstKeptIndex < compactionIndex) and Pi
 * core's buildContextEntries (firstKeptEntryId precedes the compaction).
 */
function injectBoundaryAt(
  entries: JsonObject[],
  cutPoint: number,
  header: JsonObject,
): CompactionInjectionResult {
  const before = entries[cutPoint - 1]!;
  const after = entries[cutPoint]!;
  const omittedCount = cutPoint - 1; // entries[0..cutPoint-2] omitted by projection
  const summary = `Earlier fork-parent history omitted by fork compaction boundary (${omittedCount} entries). Recent retained context follows.`;
  const compaction: JsonObject = {
    type: "compaction",
    id: randomUUID(),
    parentId: before.id as string,
    timestamp: (header.timestamp as string | undefined) ?? new Date().toISOString(),
    summary,
    firstKeptEntryId: before.id as string,
    tokensBefore: omittedCount,
  };
  // Rewrite only the entry immediately after the cut to parent on C, keeping
  // the rest of the parentId chain intact (no orphans, tree stays complete).
  const rewrittenAfter: JsonObject = { ...after, parentId: compaction.id as string };
  const result = [...entries.slice(0, cutPoint), compaction, rewrittenAfter, ...entries.slice(cutPoint + 1)];
  return { entries: result, injected: true };
}

function selectProtocolMessages(
  entries: JsonObject[],
  sourcePath: string,
  lineByEntryId: Map<string, number>,
): { ok: true; messages: ProtocolMessage[] } | ForkSnapshotFailure {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }

  let selectedEntries = entries;
  const embeddedMessages: ProtocolMessage[] = [];
  if (compactionIndex >= 0) {
    const compaction = entries[compactionIndex]!;
    if (Array.isArray(compaction.retainedTail)) {
      for (const message of compaction.retainedTail) {
        if (!isObject(message) || typeof message.role !== "string") {
          return failure(sourcePath, "invalid-compaction", `Compaction ${compaction.id} has an invalid retainedTail message`, {
            entryId: compaction.id as string,
            line: lineByEntryId.get(compaction.id as string),
          });
        }
        embeddedMessages.push({ message, entryId: compaction.id as string });
      }
      selectedEntries = entries.slice(compactionIndex + 1);
    } else {
      if (!isNonEmptyString(compaction.firstKeptEntryId)) {
        return failure(sourcePath, "invalid-compaction", `Compaction ${compaction.id} has no firstKeptEntryId`, {
          entryId: compaction.id as string,
          line: lineByEntryId.get(compaction.id as string),
        });
      }
      const firstKeptIndex = entries.findIndex((entry, index) => index < compactionIndex
        && entry.id === compaction.firstKeptEntryId);
      if (firstKeptIndex < 0) {
        return failure(
          sourcePath,
          "invalid-compaction",
          `Compaction ${compaction.id} refers to unavailable firstKeptEntryId ${compaction.firstKeptEntryId}`,
          {
            entryId: compaction.id as string,
            line: lineByEntryId.get(compaction.id as string),
          },
        );
      }
      selectedEntries = [
        ...entries.slice(firstKeptIndex, compactionIndex),
        ...entries.slice(compactionIndex + 1),
      ];
    }
  }

  const messages = [...embeddedMessages];
  for (const entry of selectedEntries) {
    if (entry.type === "message" && isObject(entry.message)) {
      messages.push({ message: entry.message, entryId: entry.id as string });
    }
  }
  return { ok: true, messages };
}

function validateToolProtocol(
  messages: ProtocolMessage[],
  sourcePath: string,
  lineByEntryId: Map<string, number>,
): { ok: true } | ForkSnapshotFailure {
  const calls = new Map<string, { entryId: string; matched: boolean }>();
  for (const { message, entryId } of messages) {
    if (message.role === "assistant") {
      const content = message.content;
      if (content !== undefined && content !== null && !Array.isArray(content)) {
        return failure(sourcePath, "invalid-tool-call", `Assistant message ${entryId} has non-array content`, {
          entryId,
          line: lineByEntryId.get(entryId),
        });
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (!isObject(block) || block.type !== "toolCall") continue;
        if (!isNonEmptyString(block.id)) {
          return failure(sourcePath, "invalid-tool-call", `Assistant message ${entryId} has a toolCall without an id`, {
            entryId,
            line: lineByEntryId.get(entryId),
          });
        }
        if (calls.has(block.id)) {
          return failure(sourcePath, "duplicate-tool-call", `Retained context contains duplicate toolCall ${block.id}`, {
            entryId,
            line: lineByEntryId.get(entryId),
            toolCallId: block.id,
          });
        }
        calls.set(block.id, { entryId, matched: false });
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    if (!isNonEmptyString(message.toolCallId)) {
      return failure(sourcePath, "invalid-tool-result", `Tool result message ${entryId} has no toolCallId`, {
        entryId,
        line: lineByEntryId.get(entryId),
      });
    }
    const call = calls.get(message.toolCallId);
    if (!call) {
      return failure(sourcePath, "unknown-tool-result", `Tool result ${entryId} refers to unknown toolCall ${message.toolCallId}`, {
        entryId,
        line: lineByEntryId.get(entryId),
        toolCallId: message.toolCallId,
      });
    }
    if (call.matched) {
      return failure(sourcePath, "duplicate-tool-result", `Retained context contains duplicate results for toolCall ${message.toolCallId}`, {
        entryId,
        line: lineByEntryId.get(entryId),
        toolCallId: message.toolCallId,
      });
    }
    call.matched = true;
  }

  for (const [toolCallId, call] of calls) {
    if (!call.matched) {
      return failure(sourcePath, "unmatched-tool-call", `Retained toolCall ${toolCallId} has no tool result`, {
        entryId: call.entryId,
        line: lineByEntryId.get(call.entryId),
        toolCallId,
      });
    }
  }
  return { ok: true };
}

function materializeDestination(
  destination: ForkSnapshotDestination,
  content: string,
  sourcePath: string,
): { ok: true; snapshotPath: string; temporaryDirectory?: string } | ForkSnapshotFailure {
  let snapshotPath: string;
  let createdSnapshotPath: string | undefined;
  let temporaryDirectory: string | undefined;
  try {
    if (destination.kind === "temp") {
      const base = path.resolve(destination.directory ?? os.tmpdir());
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      temporaryDirectory = fs.mkdtempSync(path.join(base, "pi-fork-snapshot-"));
      snapshotPath = path.join(temporaryDirectory, `session-${randomUUID()}.jsonl`);
    } else {
      snapshotPath = path.resolve(destination.path);
      if (snapshotPath === path.resolve(sourcePath)) {
        return failure(sourcePath, "invalid-options", "Fork snapshot destination must differ from its source");
      }
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const fd = fs.openSync(snapshotPath, flags, 0o600);
    createdSnapshotPath = snapshotPath;
    try {
      fs.writeFileSync(fd, content, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return {
      ok: true,
      snapshotPath,
      ...(temporaryDirectory ? { temporaryDirectory } : {}),
    };
  } catch (error) {
    if (temporaryDirectory) {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup after a failed materialization.
      }
    } else if (createdSnapshotPath) {
      try {
        fs.unlinkSync(createdSnapshotPath);
      } catch {
        // Best-effort cleanup after a failed materialization.
      }
    }
    return failure(sourcePath, "destination-write-failed", `Cannot write fork snapshot: ${errorMessage(error)}`);
  }
}

function failure(
  sourcePath: string,
  code: ForkSnapshotDiagnosticCode,
  message: string,
  details: Pick<ForkSnapshotDiagnostic, "line" | "entryId" | "toolCallId"> = {},
): ForkSnapshotFailure {
  return {
    ok: false,
    diagnostic: {
      kind: "fork-snapshot-invalid",
      code,
      message,
      sourcePath,
      ...(details.line !== undefined ? { line: details.line } : {}),
      ...(details.entryId !== undefined ? { entryId: details.entryId } : {}),
      ...(details.toolCallId !== undefined ? { toolCallId: details.toolCallId } : {}),
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
