/**
 * Bounded, read-only projection of host-authorized Pi transcripts.
 *
 * Callers never supply transcript paths. Each inventory candidate is opened
 * once, without following symlinks where the platform exposes O_NOFOLLOW,
 * then fstat, snapshot read, parse, active-chain selection, and projection all
 * operate from that same handle snapshot. No transcript bytes are cached.
 */

import { constants, type FileHandle, lstat, open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

export const SESSION_HISTORY_VERSION = 1 as const;
export const SESSION_HISTORY_URI_SCHEME = "session://" as const;
export const MAX_SESSION_HISTORY_FILES = 100;
/** @deprecated History reads no longer have a byte budget. */
export const MAX_SESSION_HISTORY_BYTES = Infinity;
export const MAX_SESSION_HISTORY_MATCHES = 20;
export const MAX_SESSION_HISTORY_SNIPPET_CHARS = 1_000;
export const MAX_SESSION_HISTORY_QUERY_CHARS = 4_096;
export const MAX_SESSION_HISTORY_OMISSIONS = 64;
export const SESSION_HISTORY_INCLUDES = [
  "user",
  "assistant",
  "visible_custom",
  "compaction",
  "tool_result",
] as const;
export const DEFAULT_SESSION_HISTORY_INCLUDE = [
  "user",
  "assistant",
  "visible_custom",
  "compaction",
] as const;

export type SessionHistoryInclude = (typeof SESSION_HISTORY_INCLUDES)[number];

/** Paths exist only in the host-side inventory and are never returned. */
export interface SessionHistoryInventoryEntry {
  path: string;
  sessionId?: string;
  fileName?: string;
  id?: string;
  sizeBytes?: number;
  modified?: Date | number | string;
  revision?: string;
  headerValid?: boolean;
  cwd?: string;
}

export interface SessionHistoryInventory {
  generation?: number;
  entries: readonly SessionHistoryInventoryEntry[];
  /** Absolute candidate offset of this supplied window (default 0). */
  offset?: number;
  /** Additional candidates exist beyond this window (default false). */
  hasMore?: boolean;
  /** Discovery itself was not budget-truncated (default true). */
  complete?: boolean;
}

export type SessionHistoryInventoryValue = SessionHistoryInventory | readonly SessionHistoryInventoryEntry[];
export type SessionHistoryInventoryProvider = (
  signal?: AbortSignal,
) => SessionHistoryInventoryValue | Promise<SessionHistoryInventoryValue>;
export interface SessionHistoryInventoryProviderObject {
  list(signal?: AbortSignal): SessionHistoryInventoryValue | Promise<SessionHistoryInventoryValue>;
}
export type SessionHistoryInventorySource =
  | SessionHistoryInventoryValue
  | SessionHistoryInventoryProvider
  | SessionHistoryInventoryProviderObject;
export interface SessionHistoryServiceOptions { inventory: SessionHistoryInventorySource }

export type SessionHistoryOmissionReason =
  | "invalid-inventory"
  | "missing"
  | "symlink"
  | "non-regular"
  | "over-budget"
  | "invalid-header"
  | "session-id-mismatch"
  | "duplicate"
  | "duplicate-session-id"
  | "read-error"
  | "inventory-error"
  | "file-limit"
  | "result-limit";

export interface SessionHistoryOmission {
  reason: SessionHistoryOmissionReason;
  fileName?: string;
  sessionId?: string;
  id?: string;
  message?: string;
  count?: number;
}

export interface SessionHistoryOptions {
  include?: readonly SessionHistoryInclude[];
  /** One result limit: sessions for list, matches for search, entries for reads. */
  limit?: number;
  signal?: AbortSignal;
}
export type SessionHistoryListOptions = SessionHistoryOptions;
export interface SessionHistorySearchOptions extends SessionHistoryOptions {
  /** Literal matching is the compatibility default; terms require every unique normalized term in one projected entry. */
  mode?: "literal" | "terms";
  /** Relevance ranks exact text, continuous phrase, then the tightest term span; ties retain source order. */
  sort?: "source" | "relevance";
  /** Zero-based match offset within this fresh scan (not a snapshot cursor). */
  offset?: number;
  /** Zero-based unique candidate offset; independent of match pagination. */
  scanOffset?: number;
}
export interface SessionHistoryReadOptions extends SessionHistoryOptions {
  /** Zero-based projected entry offset within the selected turn or entry. */
  offset?: number;
}
export interface SessionHistoryCompactionOptions extends Omit<SessionHistoryOptions, "include"> {
  /** Zero-based checkpoint offset in the newest-first timeline. */
  offset?: number;
}

/** Minimal allowlisted identity, never the persisted recovery state. */
export interface SessionHistoryCheckpoint {
  checkpointId: string;
  previousCheckpointId?: string;
  source: "compaction" | "new-context";
}

export interface SessionHistorySession {
  sessionId: string;
  resourceUri: string;
  startedAt?: number;
  updatedAt: number;
  sizeBytes: number;
  entryCount: number;
  messageCount: number;
  turnCount: number;
  firstMessage?: string;
  compacted: boolean;
}

export interface SessionHistoryEntry {
  sessionId: string;
  entryId: string;
  turn: number;
  resourceUri: string;
  kind: SessionHistoryInclude;
  text: string;
  timestamp: number;
  /** Present only for recognized Maestro compaction details. */
  checkpoint?: SessionHistoryCheckpoint;
}

export interface SessionHistoryTurn {
  sessionId: string;
  turn: number;
  startedAt: number;
  userText: string;
  rowCount: number;
  textLength: number;
  entries: readonly SessionHistoryEntry[];
}

interface ScanMetrics {
  filesRead: number;
  bytesRead: number;
  truncated: boolean;
  omissions: readonly SessionHistoryOmission[];
  omissionCounts: Readonly<Partial<Record<SessionHistoryOmissionReason, number>>>;
  omissionsTruncated: boolean;
}

export interface SessionHistoryListResult extends ScanMetrics {
  version: typeof SESSION_HISTORY_VERSION;
  generation?: number;
  sessions: readonly SessionHistorySession[];
}
export interface SessionHistorySearchMatch {
  sessionId: string;
  entryId: string;
  turn: number;
  resourceUri: string;
  kind: SessionHistoryInclude;
  timestamp: number;
  snippet: string;
}
export interface SessionHistorySearchResult extends ScanMetrics {
  version: typeof SESSION_HISTORY_VERSION;
  generation?: number;
  query: string;
  matches: readonly SessionHistorySearchMatch[];
  /** Matches in the current file window, not cumulative across scan pages. */
  matchCount: number;
  matchCountRelation: "exact" | "lower_bound";
  coverage: "complete" | "partial" | "failed";
  /** Match pagination within the current file window only. */
  hasMore: boolean;
  nextOffset?: number;
  scan: { offset: number; hasMore: boolean; nextOffset?: number };
}
export interface SessionHistoryCompactionResult extends ScanMetrics {
  version: typeof SESSION_HISTORY_VERSION;
  generation?: number;
  checkpoints: readonly SessionHistoryEntry[];
  checkpointCount: number;
  hasMore: boolean;
  nextOffset?: number;
}
export interface SessionHistoryEntryRead {
  sessionId: string;
  entryId: string;
  turn: number;
  resourceUri: string;
  entries: readonly SessionHistoryEntry[];
}
export interface SessionHistoryReadResult extends ScanMetrics {
  version: typeof SESSION_HISTORY_VERSION;
  generation?: number;
  sessionId: string;
  found: boolean;
  hasMore: boolean;
  nextOffset?: number;
  selectedTurn?: number;
  selectedEntryId?: string;
  turn?: SessionHistoryTurn;
  selectedEntry?: SessionHistoryEntryRead;
}
export interface SessionHistoryReadRequest extends SessionHistoryReadOptions {
  sessionId: string;
  entryId?: string;
  /** Exact checkpoint identity or compaction entry id; never a text search. */
  checkpointId?: string;
  turn?: number;
}

interface ValidInventoryEntry {
  path: string;
  fileName?: string;
  sessionId?: string;
  id?: string;
  sizeBytes?: number;
}
interface LoadedSession {
  summary: SessionHistorySession;
  turns: readonly SessionHistoryTurn[];
  entries: readonly SessionHistoryEntry[];
}
interface ScanResult extends ScanMetrics {
  generation?: number;
  sessions: LoadedSession[];
  coverage: SessionHistorySearchResult["coverage"];
  scan: SessionHistorySearchResult["scan"];
}
interface CandidateResult {
  loaded?: LoadedSession;
  bytesRead: number;
  omission?: SessionHistoryOmission;
}

type RawEntry = Record<string, unknown> & { id: string; type: string; parentId?: string | null };

export function sessionHistoryUri(sessionId: string): string {
  return `${SESSION_HISTORY_URI_SCHEME}${encodeSegment(sessionId)}`;
}
export function sessionEntryUri(sessionId: string, entryId: string): string {
  return `${sessionHistoryUri(sessionId)}/entry/${encodeSegment(entryId)}`;
}
export const sessionHistoryEntryUri = sessionEntryUri;

export interface ParsedSessionHistoryUri { sessionId: string; entryId?: string }
export function parseSessionHistoryUri(value: string): ParsedSessionHistoryUri | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const match = /^session:\/\/([^/]+)(?:\/entry\/([^/]+))?$/.exec(value);
  if (!match) return undefined;
  try {
    const sessionId = decodeURIComponent(match[1]!);
    const entryId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (!validIdentifier(sessionId) || entryId !== undefined && !validIdentifier(entryId)) return undefined;
    return entryId === undefined ? { sessionId } : { sessionId, entryId };
  } catch {
    return undefined;
  }
}

export class SessionHistoryService {
  readonly #inventory: SessionHistoryInventorySource;

  constructor(source: SessionHistoryInventorySource | SessionHistoryServiceOptions) {
    this.#inventory = isServiceOptions(source) ? source.inventory : source;
    if (typeof this.#inventory !== "function" && !Array.isArray(this.#inventory)
      && !isInventoryValue(this.#inventory) && !isInventoryProviderObject(this.#inventory)) {
      throw new TypeError("Session history requires a host-authorized inventory.");
    }
  }

  async list(options: SessionHistoryListOptions = {}): Promise<SessionHistoryListResult> {
    rejectSearchOptions(options);
    const include = normalizedInclude(options.include);
    const limit = boundedLimit(options.limit);
    const scan = await this.#scan(include, options.signal);
    const sessions = scan.sessions.slice(0, limit).map((item) => item.summary);
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      sessions: Object.freeze(sessions),
    }, scan.sessions.length - sessions.length);
  }

  async listSessions(options: SessionHistoryListOptions = {}): Promise<SessionHistoryListResult> {
    return this.list(options);
  }

  async search(query: string, options: SessionHistorySearchOptions = {}): Promise<SessionHistorySearchResult> {
    validateQuery(query);
    const mode = options.mode ?? "literal";
    const sort = options.sort ?? "source";
    if (mode !== "literal" && mode !== "terms") throw new TypeError("mode must be literal or terms.");
    if (sort !== "source" && sort !== "relevance") throw new TypeError("sort must be source or relevance.");
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative safe integer.");
    const scanOffset = options.scanOffset ?? 0;
    if (!Number.isSafeInteger(scanOffset) || scanOffset < 0) throw new TypeError("scanOffset must be a non-negative safe integer.");
    const folded = mode === "terms" ? normalizedSearchText(query) : query.toLocaleLowerCase("en-US");
    if (mode === "terms" && folded.length === 0) throw new TypeError("terms query must contain non-whitespace text.");
    const terms = mode === "terms" ? [...new Set(folded.split(" "))] : [folded];
    const include = normalizedInclude(options.include);
    const limit = boundedLimit(options.limit);
    const scan = await this.#scan(include, options.signal, scanOffset);
    const ranked: Array<{ entry: SessionHistoryEntry; index: number; rank: number; span: number; sourceOrder: number }> = [];
    for (const session of scan.sessions) {
      for (const entry of session.entries) {
        const text = mode === "terms" ? normalizedSearchText(entry.text) : entry.text.toLocaleLowerCase("en-US");
        const indices = terms.map((term) => text.indexOf(term));
        if (indices.some((index) => index < 0)) continue;
        const phraseIndex = text.indexOf(folded);
        ranked.push({
          entry,
          index: phraseIndex >= 0 ? phraseIndex : Math.min(...indices),
          rank: text === folded ? 0 : phraseIndex >= 0 ? 1 : 2,
          span: sort === "relevance" ? tightestTermSpan(text, terms, indices) : 0,
          sourceOrder: ranked.length,
        });
      }
    }
    if (sort === "relevance") ranked.sort((left, right) =>
      left.rank - right.rank || left.span - right.span || left.sourceOrder - right.sourceOrder);
    const page = ranked.slice(offset, offset + limit);
    const matches: SessionHistorySearchMatch[] = page.map(({ entry, index }) => ({
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      turn: entry.turn,
      resourceUri: entry.resourceUri,
      kind: entry.kind,
      timestamp: entry.timestamp,
      snippet: boundedSnippet(entry.text, mode === "terms" && entry.text.length > MAX_SESSION_HISTORY_SNIPPET_CHARS
        ? originalSearchIndex(entry.text, index) : index),
    }));
    const remaining = Math.max(0, ranked.length - offset - matches.length);
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      query,
      matches: Object.freeze(matches),
      matchCount: ranked.length,
      matchCountRelation: scan.coverage === "complete" ? "exact" as const : "lower_bound" as const,
      coverage: scan.coverage,
      scan: scan.scan,
      hasMore: remaining > 0,
      ...(remaining > 0 ? { nextOffset: offset + matches.length } : {}),
    }, remaining);
  }

  async searchSessions(query: string, options: SessionHistorySearchOptions = {}): Promise<SessionHistorySearchResult> {
    return this.search(query, options);
  }

  async compactions(options: SessionHistoryCompactionOptions = {}): Promise<SessionHistoryCompactionResult> {
    rejectSearchOptions(options, true);
    const offset = boundedOffset(options.offset);
    const limit = boundedLimit(options.limit);
    const scan = await this.#scan(new Set<SessionHistoryInclude>(["compaction"]), options.signal);
    const all = scan.sessions
      .flatMap((session) => session.entries)
      .filter((entry) => entry.kind === "compaction")
      .sort((left, right) => right.timestamp - left.timestamp || right.entryId.localeCompare(left.entryId));
    const checkpoints = all.slice(offset, offset + limit);
    const remaining = Math.max(0, all.length - offset - checkpoints.length);
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      checkpoints: Object.freeze(checkpoints),
      checkpointCount: all.length,
      hasMore: remaining > 0,
      ...(remaining > 0 ? { nextOffset: offset + checkpoints.length } : {}),
    }, remaining);
  }

  async listCompactions(options: SessionHistoryCompactionOptions = {}): Promise<SessionHistoryCompactionResult> {
    return this.compactions(options);
  }

  async read(sessionId: string, options?: SessionHistoryReadOptions): Promise<SessionHistoryReadResult>;
  async read(request: SessionHistoryReadRequest): Promise<SessionHistoryReadResult>;
  async read(
    sessionOrRequest: string | SessionHistoryReadRequest,
    options: SessionHistoryReadOptions = {},
  ): Promise<SessionHistoryReadResult> {
    const request = typeof sessionOrRequest === "string" ? { sessionId: sessionOrRequest, ...options } : sessionOrRequest;
    rejectSearchOptions(request, true);
    const offset = boundedOffset(request.offset);
    validateIdentifierInput(request.sessionId, "sessionId");
    if (request.entryId !== undefined) validateIdentifierInput(request.entryId, "entryId");
    if (request.checkpointId !== undefined) {
      validateIdentifierInput(request.checkpointId, "checkpointId");
      if (request.entryId !== undefined || request.turn !== undefined) {
        throw new TypeError("checkpointId cannot be combined with entryId or turn.");
      }
    }
    if (request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 0)) {
      throw new TypeError("turn must be a non-negative integer.");
    }
    const include = request.checkpointId === undefined ? normalizedInclude(request.include) : new Set<SessionHistoryInclude>(["compaction"]);
    const limit = boundedLimit(request.limit);
    const scan = await this.#scan(include, request.signal);
    const loaded = scan.sessions.find((item) => item.summary.sessionId === request.sessionId);
    const selected = loaded && request.turn !== undefined
      ? loaded.turns.find((item) => item.turn === request.turn)
      : undefined;
    const entryId = request.checkpointId === undefined ? request.entryId : loaded?.entries.find(
      (entry) => entry.entryId === request.checkpointId,
    )?.entryId ?? loaded?.entries.find(
      (entry) => sessionHistoryCheckpoint(entry)?.checkpointId === request.checkpointId,
    )?.entryId;
    const entryRows = loaded && entryId !== undefined ? loaded.entries.filter((entry) => entry.entryId === entryId) : [];
    const selectedEntry = entryRows.length > 0 ? makeEntryRead(entryRows, offset, limit) : undefined;
    const turn = selected ? boundedTurn(selected, limit, offset) : undefined;
    const entrySelection = request.entryId !== undefined || request.checkpointId !== undefined;
    const found = Boolean(loaded && (entrySelection ? selectedEntry : request.turn !== undefined ? turn : true));
    const total = entrySelection ? entryRows.length : selected?.entries.length ?? 0;
    const returned = entrySelection ? selectedEntry?.entries.length ?? 0 : turn?.entries.length ?? 0;
    const omitted = Math.max(0, total - offset - returned);
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      sessionId: request.sessionId,
      found,
      hasMore: omitted > 0,
      ...(omitted > 0 ? { nextOffset: offset + returned } : {}),
      ...(request.turn === undefined ? {} : { selectedTurn: request.turn, ...(turn ? { turn } : {}) }),
      ...(entryId === undefined ? {} : {
        selectedEntryId: entryId,
        ...(selectedEntry ? { selectedEntry } : {}),
      }),
    }, omitted);
  }

  async readSession(sessionId: string, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryReadResult> {
    return this.read(sessionId, options);
  }
  async readEntry(sessionId: string, entryId: string, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryEntryRead | undefined> {
    const result = await this.read({ ...options, sessionId, entryId });
    return result.selectedEntry;
  }
  async readTurn(sessionId: string, turn: number, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryTurn | undefined> {
    const result = await this.read({ ...options, sessionId, turn });
    return result.turn;
  }
  async readUri(uri: string, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryReadResult> {
    const parsed = parseSessionHistoryUri(uri);
    if (!parsed) throw new TypeError("Invalid session history URI.");
    // An exact entry URI is itself an explicit tool-result selection.
    const include = options.include ?? (parsed.entryId ? SESSION_HISTORY_INCLUDES : DEFAULT_SESSION_HISTORY_INCLUDE);
    return this.read({ ...options, include, ...parsed });
  }

  async #scan(include: ReadonlySet<SessionHistoryInclude>, signal?: AbortSignal, scanOffset = 0): Promise<ScanResult> {
    const inventory = await resolveInventory(this.#inventory, signal);
    if (inventory.error || inventory.offset > scanOffset) {
      return { sessions: [], filesRead: 0, bytesRead: 0, truncated: false,
        omissions: [{ reason: "inventory-error", message: inventory.error ?? "Host inventory starts after the requested scan offset." }],
        omissionCounts: Object.freeze({ "inventory-error": 1 }), omissionsTruncated: false,
        coverage: "failed", scan: { offset: scanOffset, hasMore: false } };
    }
    const omissions: SessionHistoryOmission[] = [];
    const omissionCounts: Partial<Record<SessionHistoryOmissionReason, number>> = {};
    let omissionsTruncated = false;
    const addOmission = (value: SessionHistoryOmission): void => {
      omissionCounts[value.reason] = (omissionCounts[value.reason] ?? 0) + (value.count ?? 1);
      if (omissions.length < MAX_SESSION_HISTORY_OMISSIONS) omissions.push(value);
      else omissionsTruncated = true;
    };
    const sessions: LoadedSession[] = [];
    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    let filesConsidered = 0;
    let filesSkipped = 0;
    let filesRead = 0;
    let bytesRead = 0;
    let truncated = inventory.hasMore || !inventory.complete;
    let scanHasMore = inventory.hasMore;
    let incomplete = scanOffset > 0 || truncated;
    for (const raw of inventory.entries) {
      checkAbort(signal);
      const candidate = normalizeInventoryEntry(raw);
      if (!candidate) { addOmission({ reason: "invalid-inventory" }); incomplete = true; continue; }
      const pathKey = process.platform === "win32" ? resolve(candidate.path).toLowerCase() : resolve(candidate.path);
      if (seenPaths.has(pathKey)) { addOmission({ reason: "duplicate", fileName: candidate.fileName, id: candidate.id }); continue; }
      seenPaths.add(pathKey);
      if (filesSkipped < scanOffset - inventory.offset) { filesSkipped += 1; continue; }
      if (filesConsidered >= MAX_SESSION_HISTORY_FILES) {
        addOmission({ reason: "file-limit", fileName: candidate.fileName, sessionId: candidate.sessionId, id: candidate.id });
        truncated = true;
        incomplete = true;
        scanHasMore = true;
        continue;
      }
      filesConsidered += 1;
      const result = await loadCandidate(candidate, include, signal);
      bytesRead += result.bytesRead;
      if (result.omission) {
        addOmission(result.omission);
        incomplete = true;
        continue;
      }
      if (!result.loaded) continue;
      filesRead += 1;
      if (seenIds.has(result.loaded.summary.sessionId)) {
        addOmission({ reason: "duplicate-session-id", sessionId: result.loaded.summary.sessionId });
        filesRead -= 1;
        incomplete = true;
        continue;
      }
      seenIds.add(result.loaded.summary.sessionId);
      sessions.push(result.loaded);
    }
    return {
      ...(inventory.generation === undefined ? {} : { generation: inventory.generation }),
      sessions, filesRead, bytesRead, truncated, omissions: Object.freeze(omissions),
      omissionCounts: Object.freeze(omissionCounts), omissionsTruncated,
      coverage: filesConsidered > 0 && sessions.length === 0 ? "failed" : incomplete ? "partial" : "complete",
      scan: { offset: scanOffset, hasMore: scanHasMore,
        ...(scanHasMore && filesConsidered > 0 && Number.isSafeInteger(scanOffset + filesConsidered)
          ? { nextOffset: scanOffset + filesConsidered } : {}) },
    };
  }
}

export function createSessionHistoryService(source: SessionHistoryInventorySource | SessionHistoryServiceOptions): SessionHistoryService {
  return new SessionHistoryService(source);
}
export function listSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, options: SessionHistoryListOptions = {}): Promise<SessionHistoryListResult> {
  return createSessionHistoryService(source).list(options);
}
export function searchSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, query: string, options: SessionHistorySearchOptions = {}): Promise<SessionHistorySearchResult> {
  return createSessionHistoryService(source).search(query, options);
}
export function listSessionCompactions(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, options: SessionHistoryCompactionOptions = {}): Promise<SessionHistoryCompactionResult> {
  return createSessionHistoryService(source).compactions(options);
}
export function readSessionHistory(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, request: SessionHistoryReadRequest): Promise<SessionHistoryReadResult> {
  return createSessionHistoryService(source).read(request);
}
export function readSessionHistoryEntry(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, sessionId: string, entryId: string, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryEntryRead | undefined> {
  return createSessionHistoryService(source).readEntry(sessionId, entryId, options);
}
export function readSessionHistoryTurn(source: SessionHistoryInventorySource | SessionHistoryServiceOptions, sessionId: string, turn: number, options: SessionHistoryReadOptions = {}): Promise<SessionHistoryTurn | undefined> {
  return createSessionHistoryService(source).readTurn(sessionId, turn, options);
}

async function resolveInventory(source: SessionHistoryInventorySource, signal?: AbortSignal): Promise<{
  entries: readonly SessionHistoryInventoryEntry[]; generation?: number; error?: string;
  offset: number; hasMore: boolean; complete: boolean;
}> {
  try {
    checkAbort(signal);
    const value = typeof source === "function" ? await source(signal)
      : isInventoryProviderObject(source) ? await source.list(signal) : source;
    if (Array.isArray(value)) return { entries: Object.freeze([...value]), offset: 0, hasMore: false, complete: true };
    if (!isInventoryValue(value)) return { entries: [], offset: 0, hasMore: false, complete: true, error: "Host session inventory is malformed." };
    return { entries: Object.freeze([...value.entries]), offset: value.offset ?? 0,
      hasMore: value.hasMore ?? false, complete: value.complete ?? true,
      ...(value.generation === undefined ? {} : { generation: value.generation }) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { entries: [], offset: 0, hasMore: false, complete: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadCandidate(
  candidate: ValidInventoryEntry,
  include: ReadonlySet<SessionHistoryInclude>,
  signal?: AbortSignal,
): Promise<CandidateResult> {
  checkAbort(signal);
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(candidate.path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) return { bytesRead: 0, omission: labeled(candidate, "non-regular") };
    if (process.platform === "win32" && typeof constants.O_NOFOLLOW !== "number") {
      // libuv does not expose O_NOFOLLOW on Windows. Revalidate the opened
      // object's file identity against lstat: a reparse-point candidate is
      // rejected, and a rename/swap cannot redirect the already-open handle.
      const pathStat = await lstat(candidate.path);
      if (pathStat.isSymbolicLink()) return { bytesRead: 0, omission: labeled(candidate, "symlink") };
      if (!pathStat.isFile()) return { bytesRead: 0, omission: labeled(candidate, "non-regular") };
      if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
        return { bytesRead: 0, omission: labeled(candidate, "read-error") };
      }
    }
    const size = Number(stat.size);
    const read = await readSnapshot(handle, size, signal);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return { bytesRead: read.bytesRead, omission: labeled(candidate, "invalid-header") };
    }
    let parsed: Array<Record<string, unknown>>;
    try {
      parsed = parseSessionEntries(content) as unknown as Array<Record<string, unknown>>;
    } catch (error) {
      return { bytesRead: read.bytesRead, omission: { ...labeled(candidate, "invalid-header"), message: error instanceof Error ? error.message : String(error) } };
    }
    const header = parsed[0];
    if (!header || header.type !== "session" || !validIdentifier(header.id)) {
      return { bytesRead: read.bytesRead, omission: labeled(candidate, "invalid-header") };
    }
    const sessionId = header.id;
    if (candidate.sessionId !== undefined && candidate.sessionId !== sessionId) {
      return { bytesRead: read.bytesRead, omission: { ...labeled(candidate, "session-id-mismatch"), sessionId } };
    }
    const rawEntries = parsed.filter((entry): entry is RawEntry =>
      entry.type !== "session" && validIdentifier(entry.id));
    const chain = activeChain(rawEntries);
    const projected = projectChain(sessionId, chain, include);
    const turns = makeTurns(sessionId, projected.entries, projected.turnSeeds);
    const startedAt = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const summary: SessionHistorySession = {
      sessionId,
      resourceUri: sessionHistoryUri(sessionId),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      updatedAt: stat.mtimeMs,
      sizeBytes: read.bytesRead,
      entryCount: new Set(projected.entries.map((entry) => entry.entryId)).size,
      messageCount: chain.filter((entry) => entry.type === "message").length,
      turnCount: projected.turnSeeds.filter((turn) => turn.turn > 0).length,
      ...(projected.firstUser ? { firstMessage: projected.firstUser.slice(0, MAX_SESSION_HISTORY_SNIPPET_CHARS) } : {}),
      compacted: chain.some((entry) => entry.type === "compaction"),
    };
    return { bytesRead: read.bytesRead, loaded: { summary, turns, entries: projected.entries } };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const reason: SessionHistoryOmissionReason = code === "ELOOP" || code === "EMLINK" ? "symlink"
      : code === "ENOENT" || code === "ENOTDIR" ? "missing" : "read-error";
    return { bytesRead: 0, omission: { ...labeled(candidate, reason), message: error instanceof Error ? error.message : String(error) } };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readSnapshot(handle: FileHandle, size: number, signal?: AbortSignal): Promise<{
  bytes: Uint8Array; bytesRead: number;
}> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < size) {
    checkAbort(signal);
    const requested = Math.min(64 * 1024, size - total);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { bytes: Buffer.concat(chunks, total), bytesRead: total };
}

function activeChain(entries: RawEntry[]): RawEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: RawEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

interface TurnSeed { turn: number; startedAt: number; userText: string }

function projectChain(sessionId: string, chain: readonly RawEntry[], include: ReadonlySet<SessionHistoryInclude>): {
  entries: SessionHistoryEntry[]; turnSeeds: TurnSeed[]; firstUser?: string;
} {
  const entries: SessionHistoryEntry[] = [];
  const turnSeeds: TurnSeed[] = [];
  // Apply branch-local context edits so the history shows what the model
  // actually received: a null replacement omits the target, otherwise the
  // replacement content stands in for the entry's own content. Mirror the
  // host's scope: only edits surviving the latest compaction boundary (the
  // kept range plus everything after it) can affect the projection.
  let editScopeStart = 0;
  for (let index = chain.length - 1; index >= 0; index--) {
    if (chain[index]?.type !== "compaction") continue;
    const firstKept = chain[index]?.firstKeptEntryId;
    const keptIndex = typeof firstKept === "string" ? chain.findIndex((entry) => entry.id === firstKept) : -1;
    editScopeStart = keptIndex >= 0 && keptIndex < index ? keptIndex : index;
    break;
  }
  const contextEdits = new Map<string, unknown>();
  for (const entry of chain.slice(editScopeStart)) {
    if (entry.type === "context_edit" && typeof entry.targetId === "string" && entry.replacement !== undefined) {
      contextEdits.set(entry.targetId, entry.replacement);
    }
  }
  const projectedContent = (entryIndex: number, entry: RawEntry, content: unknown): { omit: boolean; content: unknown } => {
    // Edits to entries outside the surviving scope are inert for the host —
    // its projection no longer contains the target — so history shows the
    // original bytes the model last saw.
    if (entryIndex < editScopeStart) return { omit: false, content };
    const edit = contextEdits.get(entry.id);
    if (edit === null) return { omit: true, content };
    if (edit && typeof edit === "object" && !Array.isArray(edit) && "content" in edit) {
      return { omit: false, content: (edit as Record<string, unknown>).content };
    }
    return { omit: false, content };
  };
  let turn = 0;
  let firstUser: string | undefined;
  for (const [entryIndex, entry] of chain.entries()) {
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || 0 : 0;
    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const value = message as Record<string, unknown>;
      const role = value.role;
      const messageTimestamp = typeof value.timestamp === "number" ? value.timestamp : timestamp;
      const projected = projectedContent(entryIndex, entry, value.content);
      if (projected.omit) continue;
      if (role === "user") {
        turn += 1;
        const text = contentText(projected.content);
        turnSeeds.push({
          turn,
          startedAt: messageTimestamp,
          userText: include.has("user") ? text.split("\n", 1)[0] ?? "" : "",
        });
        if (include.has("user")) firstUser ??= text;
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "user", text, timestamp: messageTimestamp });
      } else if (role === "assistant") {
        // The host wraps a string replacement into a single text block for
        // assistant/toolResult roles; mirror that so an edited assistant
        // message still renders instead of vanishing.
        const blocks = Array.isArray(projected.content)
          ? projected.content
          : typeof projected.content === "string"
            ? [{ type: "text", text: projected.content }]
            : [];
        for (const block of blocks) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const candidate = block as Record<string, unknown>;
          if (candidate.type === "text" && typeof candidate.text === "string") {
            pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "assistant", text: candidate.text, timestamp: messageTimestamp });
          }
        }
      } else if (role === "toolResult") {
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "tool_result", text: contentText(projected.content), timestamp: messageTimestamp });
      } else if (role === "custom" && value.display === true) {
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "visible_custom", text: contentText(projected.content), timestamp: messageTimestamp });
      }
      // bashExecution and all other message roles are deliberately excluded.
    } else if (entry.type === "custom_message" && entry.display === true) {
      const projected = projectedContent(entryIndex, entry, entry.content);
      if (projected.omit) continue;
      pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "visible_custom", text: contentText(projected.content), timestamp });
    } else if (entry.type === "compaction") {
      const checkpoint = projectCheckpointDetails(entry.details);
      pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "compaction", text: typeof entry.summary === "string" ? entry.summary : "", timestamp,
        ...(checkpoint ? { checkpoint } : {}) });
    }
    // branch/model/thinking-level and other state metadata are excluded.
  }
  if (entries.some((entry) => entry.turn === 0)) {
    turnSeeds.unshift({ turn: 0, startedAt: entries.find((entry) => entry.turn === 0)?.timestamp ?? 0, userText: "session start" });
  }
  return { entries, turnSeeds, ...(firstUser === undefined ? {} : { firstUser }) };
}

function safeCheckpointId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value);
}

function projectCheckpointDetails(value: unknown): SessionHistoryCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const details = value as Record<string, unknown>;
  if (details.kind !== "maestro-session-checkpoint" || ![1, 2, 3, 4].includes(details.schemaVersion as number)
    || !safeCheckpointId(details.checkpointId)) return undefined;
  const context = details.newContext;
  const producer = context && typeof context === "object" && !Array.isArray(context)
    ? (context as Record<string, unknown>).source : undefined;
  const newContext = producer === "todo-transition" || producer === "plan-confirm" || producer === "tool" || producer === "command";
  return {
    checkpointId: details.checkpointId,
    ...(safeCheckpointId(details.previousCheckpointId) ? { previousCheckpointId: details.previousCheckpointId } : {}),
    source: newContext ? "new-context" : "compaction",
  };
}

/** Structured identity wins; exact summary labels retain legacy lookup support. */
export function sessionHistoryCheckpoint(entry: SessionHistoryEntry): SessionHistoryCheckpoint | undefined {
  if (entry.kind !== "compaction") return undefined;
  if (entry.checkpoint) return entry.checkpoint;
  const checkpointId = /^- Checkpoint ID:([^\r\n]*)\r?$/m.exec(entry.text)?.[1]?.trim();
  if (!safeCheckpointId(checkpointId)) return undefined;
  const previousCheckpointId = /^- Previous Checkpoint:([^\r\n]*)\r?$/m.exec(entry.text)?.[1]?.trim();
  const newContext = /^<recovery_capsule version="[12]">\r?\n/.test(entry.text)
    && /^- Capsule: Maestro New Context Recovery Capsule v[12]; no model summary was generated\.\r?$/m.test(entry.text);
  return { checkpointId, source: newContext ? "new-context" : "compaction",
    ...(safeCheckpointId(previousCheckpointId) ? { previousCheckpointId } : {}) };
}

function pushEntry(
  target: SessionHistoryEntry[],
  include: ReadonlySet<SessionHistoryInclude>,
  entry: Omit<SessionHistoryEntry, "resourceUri">,
): void {
  if (!include.has(entry.kind)) return;
  target.push({ ...entry, resourceUri: sessionEntryUri(entry.sessionId, entry.entryId) });
}

function makeTurns(
  sessionId: string,
  entries: readonly SessionHistoryEntry[],
  seeds: readonly TurnSeed[],
): SessionHistoryTurn[] {
  const grouped = new Map<number, SessionHistoryEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.turn) ?? [];
    bucket.push(entry);
    grouped.set(entry.turn, bucket);
  }
  return seeds.map((seed) => {
    const rows = grouped.get(seed.turn) ?? [];
    return {
      sessionId,
      turn: seed.turn,
      startedAt: seed.startedAt,
      userText: seed.userText,
      rowCount: rows.length,
      textLength: rows.reduce((sum, row) => sum + row.text.length, 0),
      entries: Object.freeze([...rows]),
    };
  });
}

function boundedTurn(turn: SessionHistoryTurn, limit: number, offset: number): SessionHistoryTurn {
  const entries = Object.freeze(turn.entries.slice(offset, offset + limit));
  return { ...turn, rowCount: entries.length, textLength: entries.reduce((sum, entry) => sum + entry.text.length, 0), entries };
}
function makeEntryRead(rows: readonly SessionHistoryEntry[], offset: number, limit: number): SessionHistoryEntryRead {
  const first = rows[0]!;
  return { sessionId: first.sessionId, entryId: first.entryId, turn: first.turn,
    resourceUri: first.resourceUri, entries: Object.freeze(rows.slice(offset, offset + limit)) };
}

function resultWithMetrics<T extends object>(scan: ScanResult, value: T, omitted: number): T & ScanMetrics {
  const omissions = [...scan.omissions];
  const omissionCounts = { ...scan.omissionCounts };
  const sampleOverflow = omitted > 0 && omissions.length >= MAX_SESSION_HISTORY_OMISSIONS;
  if (omitted > 0) {
    omissionCounts["result-limit"] = (omissionCounts["result-limit"] ?? 0) + omitted;
    if (!sampleOverflow) omissions.push({ reason: "result-limit", count: omitted });
  }
  return { ...value, filesRead: scan.filesRead, bytesRead: scan.bytesRead,
    truncated: scan.truncated || omitted > 0, omissions: Object.freeze(omissions),
    omissionCounts: Object.freeze(omissionCounts), omissionsTruncated: scan.omissionsTruncated || sampleOverflow };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block && typeof block === "object" && !Array.isArray(block)
    && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string"
    ? [(block as Record<string, unknown>).text as string] : []).join("\n");
}

function normalizeInventoryEntry(value: unknown): ValidInventoryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.path !== "string" || !candidate.path || !isAbsolute(candidate.path)
    || /[\u0000-\u001f\u007f]/.test(candidate.path)) return undefined;
  const sessionId = optionalIdentifier(candidate.sessionId);
  const id = optionalIdentifier(candidate.id);
  const sizeBytes = candidate.sizeBytes === undefined ? undefined
    : typeof candidate.sizeBytes === "number" && Number.isSafeInteger(candidate.sizeBytes) && candidate.sizeBytes >= 0 ? candidate.sizeBytes : null;
  const fileName = candidate.fileName === undefined ? basename(candidate.path)
    : typeof candidate.fileName === "string" && candidate.fileName.length <= 512 && !/[\u0000-\u001f\u007f]/.test(candidate.fileName) ? candidate.fileName : null;
  if (sessionId === null || id === null || sizeBytes === null || fileName === null) return undefined;
  return { path: candidate.path, ...(fileName ? { fileName } : {}), ...(sessionId ? { sessionId } : {}),
    ...(id ? { id } : {}), ...(sizeBytes === undefined ? {} : { sizeBytes }) };
}
function optionalIdentifier(value: unknown): string | undefined | null {
  return value === undefined ? undefined : validIdentifier(value) ? value : null;
}
function labeled(candidate: ValidInventoryEntry, reason: SessionHistoryOmissionReason): SessionHistoryOmission {
  return { reason, ...(candidate.fileName ? { fileName: candidate.fileName } : {}),
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}), ...(candidate.id ? { id: candidate.id } : {}) };
}
function normalizedInclude(values: readonly SessionHistoryInclude[] | undefined): ReadonlySet<SessionHistoryInclude> {
  const input = values ?? DEFAULT_SESSION_HISTORY_INCLUDE;
  if (!Array.isArray(input) || input.length === 0) throw new TypeError("include must contain at least one approved category.");
  const result = new Set<SessionHistoryInclude>();
  for (const value of input) {
    if (!SESSION_HISTORY_INCLUDES.includes(value)) throw new TypeError(`Unsupported session history include category: ${String(value)}.`);
    if (result.has(value)) throw new TypeError("include categories must be unique.");
    result.add(value);
  }
  return result;
}
function boundedLimit(value: number | undefined): number {
  if (value === undefined) return MAX_SESSION_HISTORY_MATCHES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SESSION_HISTORY_MATCHES) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_SESSION_HISTORY_MATCHES}.`);
  }
  return value;
}
function boundedOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("offset must be a non-negative safe integer.");
  return value;
}
function rejectSearchOptions(options: SessionHistoryOptions, allowOffset = false): void {
  for (const key of (allowOffset ? ["mode", "sort", "scanOffset"] : ["mode", "sort", "offset", "scanOffset"])) {
    if (key in options) throw new TypeError(`${key} is available only for search.`);
  }
}
function normalizedSearchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/** Map a non-whitespace match back via whole-prefix normalization, only for
 * returned long snippets. Per-character/grapheme normalization is insufficient:
 * compatibility Hangul jamo can compose across original grapheme boundaries.
 * Prefix lengths account for composition, expansion and collapsed whitespace. */
function originalSearchIndex(text: string, target: number): number {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (normalizedSearchText(text.slice(0, middle)).length > target) high = middle;
    else low = middle + 1;
  }
  let index = Math.max(0, low - 1);
  // A normalized character may expand to several UTF-16 units; anchor an
  // astral source character at its high surrogate, not in its middle.
  if (index > 0 && /[\uDC00-\uDFFF]/.test(text[index]!)) index -= 1;
  return index;
}

/** Smallest covering window over all unique substring terms; no tokenization
 * beyond query whitespace and no matching across projected entries. */
function tightestTermSpan(text: string, terms: readonly string[], initial: readonly number[]): number {
  if (terms.length === 1) return terms[0]!.length;
  const indices = [...initial];
  let best = Infinity;
  while (true) {
    const start = Math.min(...indices);
    const end = Math.max(...indices.map((index, term) => index + terms[term]!.length));
    best = Math.min(best, end - start);
    const earliest = indices.indexOf(start);
    const next = text.indexOf(terms[earliest]!, start + 1);
    if (next < 0) return best;
    indices[earliest] = next;
  }
}
function validateQuery(query: string): void {
  if (typeof query !== "string" || query.length === 0 || query.length > MAX_SESSION_HISTORY_QUERY_CHARS || query.includes("\0")) {
    throw new TypeError(`query must be a non-empty string of at most ${MAX_SESSION_HISTORY_QUERY_CHARS} characters.`);
  }
}
function validateIdentifierInput(value: string, name: string): void {
  if (!validIdentifier(value)) throw new TypeError(`${name} must be a non-empty bounded identifier.`);
}
function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f/\\]/.test(value);
}
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());
}
function boundedSnippet(text: string, matchIndex: number): string {
  if (text.length <= MAX_SESSION_HISTORY_SNIPPET_CHARS) return text;
  const limit = MAX_SESSION_HISTORY_SNIPPET_CHARS;
  let start = Math.max(0, matchIndex - Math.floor(limit / 2));
  let end = Math.min(text.length, start + limit);
  if (end - start < limit) start = Math.max(0, end - limit);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `…${snippet.slice(1)}`;
  if (end < text.length) snippet = `${snippet.slice(0, -1)}…`;
  return snippet.slice(0, limit);
}
function isServiceOptions(value: unknown): value is SessionHistoryServiceOptions {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "inventory" in value);
}
function isInventoryProviderObject(value: unknown): value is SessionHistoryInventoryProviderObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { list?: unknown }).list === "function");
}
function isInventoryValue(value: unknown): value is SessionHistoryInventory {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray((value as { entries?: unknown }).entries)
    && ((value as { offset?: unknown }).offset === undefined
      || Number.isSafeInteger((value as { offset: number }).offset) && (value as { offset: number }).offset >= 0)
    && ((value as { hasMore?: unknown }).hasMore === undefined || typeof (value as { hasMore?: unknown }).hasMore === "boolean")
    && ((value as { complete?: unknown }).complete === undefined || typeof (value as { complete?: unknown }).complete === "boolean")
    && ((value as { generation?: unknown }).generation === undefined
      || typeof (value as { generation?: unknown }).generation === "number"
      && Number.isSafeInteger((value as { generation: number }).generation)
      && (value as { generation: number }).generation >= 0));
}
function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Session history read aborted.");
}
