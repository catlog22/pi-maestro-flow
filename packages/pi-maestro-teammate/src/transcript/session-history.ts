/**
 * Bounded, read-only projection of host-authorized Pi transcripts.
 *
 * Callers never supply transcript paths. Each inventory candidate is opened
 * once, without following symlinks where the platform exposes O_NOFOLLOW,
 * then fstat, bounded-read, parse, active-chain selection, and projection all
 * operate from that same handle snapshot. No transcript bytes are cached.
 */

import { constants, type FileHandle, lstat, open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

export const SESSION_HISTORY_VERSION = 1 as const;
export const SESSION_HISTORY_URI_SCHEME = "session://" as const;
export const MAX_SESSION_HISTORY_FILES = 20;
export const MAX_SESSION_HISTORY_BYTES = 32 * 1024 * 1024;
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
export type SessionHistorySearchOptions = SessionHistoryOptions;
export type SessionHistoryReadOptions = SessionHistoryOptions;
export type SessionHistoryCompactionOptions = Omit<SessionHistoryOptions, "include">;

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
  matchCount: number;
}
export interface SessionHistoryCompactionResult extends ScanMetrics {
  version: typeof SESSION_HISTORY_VERSION;
  generation?: number;
  checkpoints: readonly SessionHistoryEntry[];
  checkpointCount: number;
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
  selectedTurn?: number;
  selectedEntryId?: string;
  turn?: SessionHistoryTurn;
  selectedEntry?: SessionHistoryEntryRead;
}
export interface SessionHistoryReadRequest extends SessionHistoryReadOptions {
  sessionId: string;
  entryId?: string;
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
    const include = normalizedInclude(options.include);
    const limit = boundedLimit(options.limit);
    const scan = await this.#scan(include, options.signal);
    const folded = query.toLocaleLowerCase("en-US");
    const matches: SessionHistorySearchMatch[] = [];
    let matchCount = 0;
    for (const session of scan.sessions) {
      for (const entry of session.entries) {
        const index = entry.text.toLocaleLowerCase("en-US").indexOf(folded);
        if (index < 0) continue;
        matchCount += 1;
        if (matches.length >= limit) continue;
        matches.push({
          sessionId: entry.sessionId,
          entryId: entry.entryId,
          turn: entry.turn,
          resourceUri: entry.resourceUri,
          kind: entry.kind,
          timestamp: entry.timestamp,
          snippet: boundedSnippet(entry.text, index),
        });
      }
    }
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      query,
      matches: Object.freeze(matches),
      matchCount,
    }, matchCount - matches.length);
  }

  async searchSessions(query: string, options: SessionHistorySearchOptions = {}): Promise<SessionHistorySearchResult> {
    return this.search(query, options);
  }

  async compactions(options: SessionHistoryCompactionOptions = {}): Promise<SessionHistoryCompactionResult> {
    const limit = boundedLimit(options.limit);
    const scan = await this.#scan(new Set<SessionHistoryInclude>(["compaction"]), options.signal);
    const all = scan.sessions
      .flatMap((session) => session.entries)
      .filter((entry) => entry.kind === "compaction")
      .sort((left, right) => right.timestamp - left.timestamp || right.entryId.localeCompare(left.entryId));
    const checkpoints = all.slice(0, limit);
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      checkpoints: Object.freeze(checkpoints),
      checkpointCount: all.length,
    }, all.length - checkpoints.length);
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
    validateIdentifierInput(request.sessionId, "sessionId");
    if (request.entryId !== undefined) validateIdentifierInput(request.entryId, "entryId");
    if (request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 0)) {
      throw new TypeError("turn must be a non-negative integer.");
    }
    const include = normalizedInclude(request.include);
    const limit = boundedLimit(request.limit);
    const scan = await this.#scan(include, request.signal);
    const loaded = scan.sessions.find((item) => item.summary.sessionId === request.sessionId);
    const selected = loaded && request.turn !== undefined
      ? loaded.turns.find((item) => item.turn === request.turn)
      : undefined;
    const selectedEntry = loaded && request.entryId !== undefined
      ? makeEntryRead(loaded, request.entryId, limit)
      : undefined;
    const turn = selected ? boundedTurn(selected, limit) : undefined;
    const found = Boolean(loaded && (request.entryId !== undefined
      ? selectedEntry
      : request.turn !== undefined ? turn : true));
    const omitted = selected && turn ? selected.entries.length - turn.entries.length : 0;
    return resultWithMetrics(scan, {
      version: SESSION_HISTORY_VERSION,
      ...(scan.generation === undefined ? {} : { generation: scan.generation }),
      sessionId: request.sessionId,
      found,
      ...(request.turn === undefined ? {} : { selectedTurn: request.turn, ...(turn ? { turn } : {}) }),
      ...(request.entryId === undefined ? {} : {
        selectedEntryId: request.entryId,
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

  async #scan(include: ReadonlySet<SessionHistoryInclude>, signal?: AbortSignal): Promise<ScanResult> {
    const inventory = await resolveInventory(this.#inventory, signal);
    if (inventory.error) {
      return { sessions: [], filesRead: 0, bytesRead: 0, truncated: false,
        omissions: [{ reason: "inventory-error", message: inventory.error }] };
    }
    const omissions: SessionHistoryOmission[] = [];
    const addOmission = (value: SessionHistoryOmission): void => {
      if (omissions.length < MAX_SESSION_HISTORY_OMISSIONS) omissions.push(value);
    };
    const sessions: LoadedSession[] = [];
    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    let filesConsidered = 0;
    let filesRead = 0;
    let bytesRead = 0;
    let truncated = false;
    for (const raw of inventory.entries) {
      checkAbort(signal);
      const candidate = normalizeInventoryEntry(raw);
      if (!candidate) { addOmission({ reason: "invalid-inventory" }); continue; }
      const pathKey = process.platform === "win32" ? resolve(candidate.path).toLowerCase() : resolve(candidate.path);
      if (seenPaths.has(pathKey)) { addOmission({ reason: "duplicate", fileName: candidate.fileName, id: candidate.id }); continue; }
      seenPaths.add(pathKey);
      if (filesConsidered >= MAX_SESSION_HISTORY_FILES) {
        addOmission({ reason: "file-limit", fileName: candidate.fileName, sessionId: candidate.sessionId, id: candidate.id });
        truncated = true;
        continue;
      }
      filesConsidered += 1;
      const result = await loadCandidate(candidate, bytesRead, include, signal);
      bytesRead += result.bytesRead;
      if (result.omission) {
        addOmission(result.omission);
        if (result.omission.reason === "over-budget") truncated = true;
        continue;
      }
      if (!result.loaded) continue;
      filesRead += 1;
      if (seenIds.has(result.loaded.summary.sessionId)) {
        addOmission({ reason: "duplicate-session-id", sessionId: result.loaded.summary.sessionId });
        filesRead -= 1;
        continue;
      }
      seenIds.add(result.loaded.summary.sessionId);
      sessions.push(result.loaded);
    }
    return {
      ...(inventory.generation === undefined ? {} : { generation: inventory.generation }),
      sessions, filesRead, bytesRead, truncated, omissions: Object.freeze(omissions),
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
}> {
  try {
    checkAbort(signal);
    const value = typeof source === "function" ? await source(signal)
      : isInventoryProviderObject(source) ? await source.list(signal) : source;
    if (Array.isArray(value)) return { entries: Object.freeze([...value]) };
    if (!isInventoryValue(value)) return { entries: [], error: "Host session inventory is malformed." };
    return { entries: Object.freeze([...value.entries]), ...(value.generation === undefined ? {} : { generation: value.generation }) };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadCandidate(
  candidate: ValidInventoryEntry,
  bytesAlreadyRead: number,
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
    const declared = candidate.sizeBytes;
    const remaining = MAX_SESSION_HISTORY_BYTES - bytesAlreadyRead;
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining
      || declared !== undefined && (declared > MAX_SESSION_HISTORY_BYTES || declared > remaining)) {
      return { bytesRead: 0, omission: labeled(candidate, "over-budget") };
    }
    const read = await readBounded(handle, remaining, signal);
    if (read.overBudget) return { bytesRead: read.bytesRead, omission: labeled(candidate, "over-budget") };
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

async function readBounded(handle: FileHandle, limit: number, signal?: AbortSignal): Promise<{
  bytes: Uint8Array; bytesRead: number; overBudget: boolean;
}> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    checkAbort(signal);
    const requested = Math.min(64 * 1024, limit - total + 1);
    if (requested <= 0) break;
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > limit) return { bytes: new Uint8Array(), bytesRead: limit, overBudget: true };
  }
  return { bytes: Buffer.concat(chunks, total), bytesRead: total, overBudget: false };
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
  let turn = 0;
  let firstUser: string | undefined;
  for (const entry of chain) {
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || 0 : 0;
    if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const value = message as Record<string, unknown>;
      const role = value.role;
      const messageTimestamp = typeof value.timestamp === "number" ? value.timestamp : timestamp;
      if (role === "user") {
        turn += 1;
        const text = contentText(value.content);
        turnSeeds.push({
          turn,
          startedAt: messageTimestamp,
          userText: include.has("user") ? text.split("\n", 1)[0] ?? "" : "",
        });
        if (include.has("user")) firstUser ??= text;
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "user", text, timestamp: messageTimestamp });
      } else if (role === "assistant") {
        const blocks = Array.isArray(value.content) ? value.content : [];
        for (const block of blocks) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const candidate = block as Record<string, unknown>;
          if (candidate.type === "text" && typeof candidate.text === "string") {
            pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "assistant", text: candidate.text, timestamp: messageTimestamp });
          }
        }
      } else if (role === "toolResult") {
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "tool_result", text: contentText(value.content), timestamp: messageTimestamp });
      } else if (role === "custom" && value.display === true) {
        pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "visible_custom", text: contentText(value.content), timestamp: messageTimestamp });
      }
      // bashExecution and all other message roles are deliberately excluded.
    } else if (entry.type === "custom_message" && entry.display === true) {
      pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "visible_custom", text: contentText(entry.content), timestamp });
    } else if (entry.type === "compaction") {
      pushEntry(entries, include, { sessionId, entryId: entry.id, turn, kind: "compaction", text: typeof entry.summary === "string" ? entry.summary : "", timestamp });
    }
    // branch/model/thinking-level and other state metadata are excluded.
  }
  if (entries.some((entry) => entry.turn === 0)) {
    turnSeeds.unshift({ turn: 0, startedAt: entries.find((entry) => entry.turn === 0)?.timestamp ?? 0, userText: "session start" });
  }
  return { entries, turnSeeds, ...(firstUser === undefined ? {} : { firstUser }) };
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

function boundedTurn(turn: SessionHistoryTurn, limit: number): SessionHistoryTurn {
  const entries = Object.freeze(turn.entries.slice(0, limit));
  return { ...turn, rowCount: entries.length, textLength: entries.reduce((sum, entry) => sum + entry.text.length, 0), entries };
}
function makeEntryRead(loaded: LoadedSession, entryId: string, limit: number): SessionHistoryEntryRead | undefined {
  const entries = loaded.entries.filter((entry) => entry.entryId === entryId).slice(0, limit);
  if (entries.length === 0) return undefined;
  return { sessionId: loaded.summary.sessionId, entryId, turn: entries[0]!.turn,
    resourceUri: sessionEntryUri(loaded.summary.sessionId, entryId), entries: Object.freeze(entries) };
}

function resultWithMetrics<T extends object>(scan: ScanResult, value: T, omitted: number): T & ScanMetrics {
  const omissions = [...scan.omissions];
  if (omitted > 0 && omissions.length < MAX_SESSION_HISTORY_OMISSIONS) omissions.push({ reason: "result-limit", count: omitted });
  return { ...value, filesRead: scan.filesRead, bytesRead: scan.bytesRead,
    truncated: scan.truncated || omitted > 0, omissions: Object.freeze(omissions) };
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
    && ((value as { generation?: unknown }).generation === undefined
      || typeof (value as { generation?: unknown }).generation === "number"
      && Number.isSafeInteger((value as { generation: number }).generation)
      && (value as { generation: number }).generation >= 0));
}
function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Session history read aborted.");
}
