/**
 * session_history — bounded, read-only current-session recovery and authorized
 * workspace/teammate history discovery.
 *
 * The teammate package owns transcript parsing and projection. Flow supplies
 * host-authorized inventories; no model-provided transcript path is accepted,
 * retained, or returned.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

import {
  MAX_SESSION_HISTORY_FILES,
  MAX_SESSION_HISTORY_MATCHES,
  MAX_SESSION_HISTORY_QUERY_CHARS,
  SESSION_HISTORY_INCLUDES,
  SessionHistoryService,
  sessionHistoryCheckpoint,
  type SessionHistoryEntry,
  type SessionHistoryInclude,
  type SessionHistoryInventory,
  type SessionHistoryInventoryEntry,
  type SessionHistoryInventorySource,
  type SessionHistoryOmission,
  type SessionHistorySearchOptions,
} from "pi-maestro-teammate/v1/session-history";
import { toolCallLine, toolResultLine, resultSummary } from "pi-cockpit/src/quiet-tools.ts";
import { COMMAND_HISTORY_BOOTSTRAP } from "../compaction/recovery-focus.ts";
import {
  authorizeSessionHistoryFffCandidates,
  createSessionHistoryFffAccelerator,
  type SessionHistoryFffCandidateAccelerator,
} from "./session-history-fff.ts";

export const SESSION_HISTORY_SCOPES = ["current_session", "workspace_sessions", "teammates"] as const;
export type SessionHistoryScope = (typeof SESSION_HISTORY_SCOPES)[number];
type InventoryScope = SessionHistoryScope | "current_session_with_teammates" | "all";

export const SESSION_HISTORY_ACTIONS = ["list_sessions", "search", "read_turn", "timeline", "read_checkpoint"] as const;
export type SessionHistoryAction = (typeof SESSION_HISTORY_ACTIONS)[number];

const MAX_DISCOVERY_DIRECTORIES = MAX_SESSION_HISTORY_FILES * 4;
const MAX_DISCOVERY_PATHS = MAX_SESSION_HISTORY_FILES * 8;
const SESSION_HISTORY_FFF_DIAGNOSTICS = new Set([
  "session-directory-unavailable",
  "destroyed",
  "initialization-failed",
  "scan-timeout",
  "scan-failed",
  "search-failed",
]);

function StringEnum<T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(description ? { description } : {}),
  });
}

/** Action contract intentionally contains only bounded read operations. */
export const SessionHistoryParams = Type.Object({
  action: StringEnum(
    SESSION_HISTORY_ACTIONS,
    "Bounded read-only session history action.",
  ),
  scope: Type.Optional(
    StringEnum(
      SESSION_HISTORY_SCOPES,
      "History scope: current Pi session, workspace session directory, or teammate sessions.",
    ),
  ),
  includeTeammates: Type.Optional(Type.Boolean({ description: "Search with scope=current_session only. Defaults to true: include associated teammate sessions; false searches only the current transcript. Does not change recovery/read scopes." })),
  query: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_SESSION_HISTORY_QUERY_CHARS, description: "Search text (required for search); literal phrase by default, or all whitespace-separated terms with mode=terms." }),
  ),
  mode: Type.Optional(StringEnum(["literal", "terms"] as const, "Search only. Literal is the default; terms uses NFKC, case and whitespace normalization and requires every unique term in one projected entry.")),
  sort: Type.Optional(StringEnum(["source", "relevance"] as const, "Search only. Source order is the default; relevance ranks exact/continuous phrase, then tightest term span, with source-order ties.")),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Zero-based result offset for search matches, timeline checkpoints, or read_turn entries; use nextOffset to continue at the same selection." })),
  scanOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Search only. Zero-based file offset in a fresh authorized inventory; use scan.nextOffset for another file window and reset offset to 0. This is not a snapshot cursor." })),
  sessionId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 512, description: "Exact session id for read_turn; omitted only for current_session, where the host selects it." }),
  ),
  turn: Type.Optional(
    Type.Integer({ minimum: 0, description: "1-based turn number; 0 is the preamble (required for read_turn)." }),
  ),
  checkpointId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 512, description: "Checkpoint id or compaction entry id (required for current_session read_checkpoint)." }),
  ),
  include: Type.Optional(
    Type.Array(
      StringEnum(SESSION_HISTORY_INCLUDES, "Approved visible transcript category."),
      {
        minItems: 1,
        maxItems: SESSION_HISTORY_INCLUDES.length,
        uniqueItems: true,
        description: "Categories to include. Defaults to user, assistant, visible_custom, and compaction; tool_result is explicit only.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_SESSION_HISTORY_MATCHES, description: "Single result limit for sessions, matches, or selected-turn entries." }),
  ),
}, { additionalProperties: false });

/** Minimal context shape used by the inventory builder, kept structural so it
 * can be used by focused tests without constructing a full ExtensionContext. */
export interface SessionHistoryHostContext {
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string | undefined;
  };
}

export interface SessionHistoryToolDetails {
  action: SessionHistoryAction;
  scope: SessionHistoryScope;
  [key: string]: unknown;
}

export interface SessionHistoryToolOptions {
  /** Test/host inventory override. The default is a fresh inventory from `ctx`. */
  inventory?: SessionHistoryInventorySource;
  /** Optional scoped inventory factory for hosts with their own authorization. */
  inventoryFactory?: (scope: SessionHistoryScope, ctx: ExtensionContext) => SessionHistoryInventorySource;
  /** Internal FFF candidate accelerator; used only for workspace search. */
  candidateAccelerator?: SessionHistoryFffCandidateAccelerator;
  /** Optional host policy for checkpoint reads, independent of reset settings. */
  isCompactRecoveryEnabled?: (ctx: ExtensionContext) => boolean;
}

/**
 * Return the active host session file without trusting any model input. Session
 * manager paths are normally absolute; a relative value is resolved against
 * the host cwd solely to satisfy the public service inventory contract.
 */
export function currentSessionFile(ctx: SessionHistoryHostContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionFile?.();
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const cwd = typeof ctx.cwd === "string" && ctx.cwd.trim().length > 0
      ? ctx.cwd
      : process.cwd();
    return resolve(cwd, value);
  } catch {
    return undefined;
  }
}

function sessionDirectory(sessionFile: string): string {
  return dirname(sessionFile);
}

/** The teammate session root is a sibling directory named after the parent
 * transcript (without `.jsonl`). This mirrors the host's layout without
 * importing private teammate filesystem helpers. */
function teammateSessionDirectory(sessionFile: string): string {
  return join(sessionDirectory(sessionFile), basename(sessionFile, ".jsonl"));
}

function inventoryEntry(path: string): SessionHistoryInventoryEntry {
  return { path, fileName: basename(path) };
}

/**
 * Enumerate transcript candidates in one directory. We intentionally retain
 * `.jsonl` symlinks and non-regular entries in the inventory so the public
 * service can report their omission reason after opening and validating them.
 */
interface DirectoryInventory extends SessionHistoryInventory {
  total: number;
}

async function directoryInventory(
  directory: string,
  signal?: AbortSignal,
  priorityFileName?: string,
  prioritySessionId?: string,
  offset = 0,
  preferred: readonly SessionHistoryInventoryEntry[] = [],
): Promise<DirectoryInventory> {
  const result: SessionHistoryInventoryEntry[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".jsonl"));
  const priority = new Map(preferred.map((entry, index) => [basename(entry.path), index]));
  entries.sort((left, right) => {
    if (left.name === priorityFileName) return -1;
    if (right.name === priorityFileName) return 1;
    const leftRequested = prioritySessionId !== undefined && left.name.includes(prioritySessionId);
    const rightRequested = prioritySessionId !== undefined && right.name.includes(prioritySessionId);
    if (leftRequested !== rightRequested) return leftRequested ? -1 : 1;
    const leftPriority = priority.get(left.name) ?? Infinity;
    const rightPriority = priority.get(right.name) ?? Infinity;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return right.name.localeCompare(left.name, "en");
  });
  for (const entry of entries.slice(offset, offset + MAX_DISCOVERY_PATHS)) {
    if (signal?.aborted) throw signal.reason ?? new Error("Session history inventory aborted.");
    result.push(inventoryEntry(join(directory, entry.name)));
  }
  return { entries: result, offset, hasMore: entries.length - offset > result.length, total: entries.length };
}

function prioritizeRequestedSession(entries: SessionHistoryInventoryEntry[], sessionId: string | undefined): void {
  if (!sessionId) return;
  // A filename is only a hint; the service still validates the session header.
  entries.sort((left, right) => Number(basename(right.path).includes(sessionId)) - Number(basename(left.path).includes(sessionId)));
}

/** Enumerate the bounded, shallow teammate session layout. */
async function teammateInventory(
  directory: string,
  signal?: AbortSignal,
  offset = 0,
  prioritySessionId?: string,
): Promise<SessionHistoryInventory> {
  const result: SessionHistoryInventoryEntry[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(directory, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
  } catch (error) {
    // No teammate directory exists until the first dispatch.
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { entries: [], offset };
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  let total = 0;
  for (const entry of directories.slice(0, MAX_DISCOVERY_DIRECTORIES)) {
    if (signal?.aborted) throw signal.reason ?? new Error("Session history inventory aborted.");
    const child = await directoryInventory(join(directory, entry.name), signal, undefined, prioritySessionId, Math.max(0, offset - total));
    if (prioritySessionId) {
      result.push(...child.entries);
      prioritizeRequestedSession(result, prioritySessionId);
      result.length = Math.min(result.length, MAX_DISCOVERY_PATHS);
    } else {
      result.push(...child.entries.slice(0, MAX_DISCOVERY_PATHS - result.length));
    }
    total += child.total;
  }
  return {
    entries: result, offset, hasMore: total - offset > result.length,
    complete: directories.length <= MAX_DISCOVERY_DIRECTORIES,
  };
}

/**
 * Build a fresh host inventory for one scope. The returned provider performs no
 * caching; SessionHistoryService revalidates every candidate on every call.
 */
export function createSessionHistoryInventoryProvider(
  ctx: SessionHistoryHostContext,
  scope: InventoryScope,
  prioritySessionId?: string,
  scanOffset = 0,
): SessionHistoryInventorySource {
  return async (signal) => {
    const sessionFile = currentSessionFile(ctx);
    if (!sessionFile) return { entries: [] };

    if (scope === "current_session") return { entries: [inventoryEntry(sessionFile)] };
    if (scope === "current_session_with_teammates") {
      const teammates = await teammateInventory(teammateSessionDirectory(sessionFile), signal, Math.max(0, scanOffset - 1));
      return {
        ...teammates,
        entries: scanOffset === 0 ? [inventoryEntry(sessionFile), ...teammates.entries] : teammates.entries,
        offset: scanOffset,
      };
    }
    if (scope === "workspace_sessions") {
      return directoryInventory(sessionDirectory(sessionFile), signal, basename(sessionFile), prioritySessionId, scanOffset);
    }
    if (scope === "teammates") return teammateInventory(teammateSessionDirectory(sessionFile), signal, scanOffset, prioritySessionId);

    const workspace = await directoryInventory(sessionDirectory(sessionFile), signal, basename(sessionFile), prioritySessionId);
    const teammates = await teammateInventory(teammateSessionDirectory(sessionFile), signal, 0, prioritySessionId);
    const entries = [...workspace.entries, ...teammates.entries];
    prioritizeRequestedSession(entries, prioritySessionId);
    if (!entries.some((entry) => resolve(entry.path) === sessionFile)) entries.unshift(inventoryEntry(sessionFile));
    return { entries, complete: !workspace.hasMore && !teammates.hasMore && teammates.complete !== false };
  };
}

/** FFF only prioritizes authorized direct children; its raw-positive subset
 * never excludes the fresh host inventory. Deduplicate before the one service
 * scan, preserving current-first and giving older candidates a budget slot. */
async function prioritizedWorkspaceInventory(
  ctx: SessionHistoryHostContext,
  candidates: readonly SessionHistoryInventoryEntry[],
  signal?: AbortSignal,
  scanOffset = 0,
): Promise<SessionHistoryInventory> {
  const current = currentSessionFile(ctx);
  if (!current) return { entries: [] };
  return directoryInventory(sessionDirectory(current), signal, basename(current), undefined, scanOffset, candidates);
}

/** Friendly alias for hosts/tests that prefer an inventory-named function. */
export const sessionHistoryInventoryProvider = createSessionHistoryInventoryProvider;

/** Active-session inventory used by current-session recovery and session:// resources. */
export function createCompactHistoryInventoryProvider(
  ctx: SessionHistoryHostContext,
): SessionHistoryInventorySource {
  return createSessionHistoryInventoryProvider(ctx, "current_session");
}

function defaultScope(_action: SessionHistoryAction): SessionHistoryScope {
  return "current_session";
}

function sessionActionValue(value: unknown): SessionHistoryAction | undefined {
  return SESSION_HISTORY_ACTIONS.includes(value as SessionHistoryAction)
    ? value as SessionHistoryAction
    : undefined;
}

function scopeValue(value: unknown, action: SessionHistoryAction): SessionHistoryScope | undefined {
  if (value === undefined) return defaultScope(action);
  return SESSION_HISTORY_SCOPES.includes(value as SessionHistoryScope)
    ? value as SessionHistoryScope
    : undefined;
}

function safeIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512
    || value === "."
    || value === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty bounded identifier.`);
  }
  return value;
}

function safeQuery(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("query is required for search.");
  }
  if (value.length > MAX_SESSION_HISTORY_QUERY_CHARS || value.includes("\0")) {
    throw new TypeError(`query must be a non-empty string of at most ${MAX_SESSION_HISTORY_QUERY_CHARS} characters.`);
  }
  return value;
}

function safeTurn(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("turn is required and must be a non-negative integer.");
  }
  return value as number;
}

function boundedOptions(params: Record<string, unknown>): {
  include?: SessionHistoryInclude[];
  limit?: number;
} {
  const limit = params.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_SESSION_HISTORY_MATCHES)) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_SESSION_HISTORY_MATCHES}.`);
  }
  let include: SessionHistoryInclude[] | undefined;
  if (params.include !== undefined) {
    if (!Array.isArray(params.include) || params.include.length < 1
      || params.include.length > SESSION_HISTORY_INCLUDES.length
      || params.include.some((value) => !SESSION_HISTORY_INCLUDES.includes(value as SessionHistoryInclude))) {
      throw new TypeError("include must contain unique approved session history categories.");
    }
    const unique = new Set(params.include as SessionHistoryInclude[]);
    if (unique.size !== params.include.length) {
      throw new TypeError("include must contain unique approved session history categories.");
    }
    include = [...unique];
  }
  return {
    ...(include === undefined ? {} : { include }),
    ...(limit === undefined ? {} : { limit: limit as number }),
  };
}

function searchOptions(params: Record<string, unknown>, action: SessionHistoryAction): Pick<SessionHistorySearchOptions, "mode" | "sort" | "offset" | "scanOffset"> {
  const { mode, sort, offset, scanOffset } = params;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new TypeError("offset must be a non-negative safe integer.");
  }
  if (action !== "search") {
    for (const key of ["mode", "sort", "scanOffset", ...(action === "timeline" || action === "read_turn" ? [] : ["offset"])]) {
      if (key in params) throw new TypeError(`${key} is available only for search${key === "offset" ? ", timeline or read_turn" : ""}.`);
    }
    return offset === undefined ? {} : { offset: offset as number };
  }
  if (mode !== undefined && mode !== "literal" && mode !== "terms") throw new TypeError("mode must be literal or terms.");
  if (sort !== undefined && sort !== "source" && sort !== "relevance") throw new TypeError("sort must be source or relevance.");
  if (scanOffset !== undefined && (typeof scanOffset !== "number" || !Number.isSafeInteger(scanOffset) || scanOffset < 0)) {
    throw new TypeError("scanOffset must be a non-negative safe integer.");
  }
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(sort === undefined ? {} : { sort }),
    ...(offset === undefined ? {} : { offset }),
    ...(scanOffset === undefined ? {} : { scanOffset }),
  };
}

/** Omission diagnostics must never carry host filesystem error messages. */
export function sanitizeSessionHistoryOmissions(
  omissions: readonly SessionHistoryOmission[],
): readonly SessionHistoryOmission[] {
  return omissions.map((omission) => ({
    reason: omission.reason,
    ...(typeof omission.count === "number" ? { count: omission.count } : {}),
  }));
}

/** Remove optional omission metadata that could contain a path from a service
 * result before it becomes model-visible. */
function sanitizeResult<T extends { omissions: readonly SessionHistoryOmission[] }>(result: T): T {
  return {
    ...result,
    omissions: sanitizeSessionHistoryOmissions(result.omissions),
  };
}

function serializeResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Provider failures are host-owned. Strip absolute path-like tokens before
  // returning a validation/scan error to the model.
  return message.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+|\/(?:[^\s"']+)/g, "[path omitted]");
}

function checkpointProjection(entry: SessionHistoryEntry): Record<string, unknown> {
  const checkpoint = sessionHistoryCheckpoint(entry);
  const checkpointId = checkpoint?.checkpointId;
  const previousCheckpointId = checkpoint?.previousCheckpointId;
  const firstLine = entry.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("<recovery_capsule") && line !== "IMPORTANT:");
  return {
    sessionId: entry.sessionId,
    entryId: entry.entryId,
    turn: entry.turn,
    resourceUri: entry.resourceUri,
    timestamp: entry.timestamp,
    source: checkpoint?.source ?? "compaction",
    ...(checkpointId ? { checkpointId } : {}),
    ...(previousCheckpointId ? { previousCheckpointId } : {}),
    summary: checkpointId ? `Checkpoint ${checkpointId}` : (firstLine ?? "Compaction checkpoint").slice(0, 240),
  };
}

function hostCurrentSessionId(ctx: SessionHistoryHostContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionId?.();
    if (typeof value !== "string") return undefined;
    return safeIdentifier(value, "current session id");
  } catch {
    return undefined;
  }
}

async function currentSessionId(
  ctx: SessionHistoryHostContext,
  service: SessionHistoryService,
  signal?: AbortSignal,
): Promise<{ sessionId?: string; fallback?: Record<string, unknown> }> {
  const hostId = hostCurrentSessionId(ctx);
  if (hostId) return { sessionId: hostId };
  const listed = sanitizeResult(await service.list({ limit: 1, signal }));
  const sessionId = listed.sessions[0]?.sessionId;
  if (sessionId) return { sessionId };
  const { sessions: _sessions, ...metrics } = listed;
  return { fallback: metrics as unknown as Record<string, unknown> };
}

function missingCurrentSession(
  fallback: Record<string, unknown> | undefined,
  selection: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    ...(fallback ?? { filesRead: 0, bytesRead: 0, truncated: false, omissions: [], omissionCounts: {}, omissionsTruncated: false }),
    ...selection,
    found: false,
  };
}

export async function executeSessionHistory(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  options: SessionHistoryToolOptions = {},
  signal?: AbortSignal,
): Promise<AgentToolResult<SessionHistoryToolDetails>> {
  const action = sessionActionValue(params.action);
  const scope = scopeValue(params.scope, action ?? "list_sessions");
  if (!action || !scope) {
    return {
      content: [{ type: "text", text: "Invalid session_history action or scope." }],
      isError: true,
      details: {
        action: (action ?? "list_sessions") as SessionHistoryAction,
        scope: scope ?? "current_session",
        error: "invalid action or scope",
      },
    } as unknown as AgentToolResult<SessionHistoryToolDetails>;
  }

  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Session history read aborted.");
    if (options.inventory === undefined && options.inventoryFactory === undefined && !currentSessionFile(ctx)) {
      throw new Error("The current session transcript is unavailable. Session history cannot be searched or read.");
    }
    const searchSettings = searchOptions(params, action);
    if (params.includeTeammates !== undefined) {
      if (typeof params.includeTeammates !== "boolean") throw new TypeError("includeTeammates must be a boolean.");
      if (action !== "search" || scope !== "current_session") {
        throw new TypeError("includeTeammates is available only for search with scope=current_session.");
      }
    }
    const includeTeammates = action === "search" && scope === "current_session" && params.includeTeammates !== false;
    const compactRecovery = action === "timeline" || action === "read_checkpoint";
    if (compactRecovery && scope !== "current_session") {
      throw new TypeError(`${action} is available only with scope=current_session.`);
    }
    if (compactRecovery) {
      if (options.isCompactRecoveryEnabled && !options.isCompactRecoveryEnabled(ctx)) {
        return {
          content: [{ type: "text", text: "Current-session checkpoint recovery is unavailable under the host history policy." }],
          isError: true,
          details: { action, scope, error: "checkpoint history disabled" },
        } as unknown as AgentToolResult<SessionHistoryToolDetails>;
      }
      const source = options.inventory
        ?? options.inventoryFactory?.("current_session", ctx)
        ?? createCompactHistoryInventoryProvider(ctx);
      const service = new SessionHistoryService(source);
      const scanOptions = boundedOptions(params);
      let result: Record<string, unknown>;
      if (action === "timeline") {
        const timeline = sanitizeResult(await service.compactions({ limit: scanOptions.limit, offset: searchSettings.offset, signal }));
        result = {
          ...timeline,
          checkpoints: timeline.checkpoints.map(checkpointProjection),
        } as unknown as Record<string, unknown>;
      } else {
        const checkpointId = safeIdentifier(params.checkpointId, "checkpointId");
        const current = await currentSessionId(ctx, service, signal);
        if (!current.sessionId) {
          result = missingCurrentSession(current.fallback, { checkpointId });
        } else {
          result = {
            ...sanitizeResult(await service.read({
              sessionId: current.sessionId,
              checkpointId,
              limit: 1,
              signal,
            })),
            checkpointId,
          } as unknown as Record<string, unknown>;
        }
      }
      const details = { action, scope, result, ...result } as SessionHistoryToolDetails;
      return {
        content: [{ type: "text", text: serializeResult(result) }],
        details,
      } as unknown as AgentToolResult<SessionHistoryToolDetails>;
    }

    const scanOptions = boundedOptions(params);
    const requestedSessionId = action === "read_turn" && params.sessionId !== undefined
      ? safeIdentifier(params.sessionId, "sessionId")
      : undefined;
    if (action === "read_turn" && requestedSessionId === undefined && scope !== "current_session") {
      throw new TypeError("sessionId is required for read_turn outside scope=current_session.");
    }
    const fallbackSource = options.inventory
      ?? options.inventoryFactory?.(scope, ctx)
      ?? createSessionHistoryInventoryProvider(ctx, includeTeammates ? "current_session_with_teammates" : scope, requestedSessionId, searchSettings.scanOffset);
    let source = fallbackSource;
    let discovery: Record<string, unknown> | undefined;
    let query: string | undefined;

    // FFF is strictly a candidate prioritizer. Custom inventories remain the
    // source of truth for tests/hosts that provide their own authorization.
    if (action === "search") {
      query = safeQuery(params.query);
      if (searchSettings.mode === "terms" && query.normalize("NFKC").trim().length === 0) {
        throw new TypeError("terms query must contain non-whitespace text.");
      }
      discovery = { source: "bounded-inventory" };
      const useAccelerator = scope === "workspace_sessions"
        && options.candidateAccelerator !== undefined
        && options.inventory === undefined
        && options.inventoryFactory === undefined;
      // Projection joins text blocks with newlines that never exist as a
      // contiguous literal in the raw JSONL searched by FFF.
      if (useAccelerator && (searchSettings.mode === "terms" || query.includes("\n"))) {
        discovery = { accelerator: "fff", source: "bounded-inventory", reason: searchSettings.mode === "terms" ? "terms-query" : "projection-sensitive-query" };
      } else if (useAccelerator) {
        let candidate: Awaited<ReturnType<SessionHistoryFffCandidateAccelerator["search"]>> | undefined;
        try {
          candidate = await options.candidateAccelerator!.search(query, ctx, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          candidate = undefined;
        }
        const valid = candidate !== undefined
          && typeof candidate.available === "boolean"
          && typeof candidate.complete === "boolean"
          && Array.isArray(candidate.entries);
        if (candidate && valid && candidate.available) {
          const authorizedEntries = authorizeSessionHistoryFffCandidates(ctx, candidate.entries);
          source = (inventorySignal) => prioritizedWorkspaceInventory(ctx, authorizedEntries, inventorySignal, searchSettings.scanOffset);
          discovery = {
            accelerator: "fff",
            source: "candidates-and-bounded-inventory",
            candidateComplete: candidate.complete,
          };
        } else {
          const diagnostic = candidate?.diagnostic;
          const reason = valid && typeof diagnostic === "string"
            && SESSION_HISTORY_FFF_DIAGNOSTICS.has(diagnostic)
            ? diagnostic
            : "unavailable";
          discovery = {
            accelerator: "fff",
            source: "bounded-inventory",
            reason,
          };
        }
      }
    }

    const service = new SessionHistoryService(source);
    let result: Record<string, unknown>;
    if (action === "list_sessions") {
      result = sanitizeResult(await service.list({ ...scanOptions, signal })) as unknown as Record<string, unknown>;
    } else if (action === "search") {
      const searched = sanitizeResult(await service.search(query!, { ...scanOptions, ...searchSettings, signal }));
      result = searched as unknown as Record<string, unknown>;
      // Custom inventories authorize reads but do not establish teammate relationships.
      if (includeTeammates && options.inventory === undefined && options.inventoryFactory === undefined && searched.matches.length > 0) {
        const parentSessionId = hostCurrentSessionId(ctx) ?? (await currentSessionId(ctx, new SessionHistoryService(
          createCompactHistoryInventoryProvider(ctx),
        ), signal)).sessionId;
        result.matches = searched.matches.map((match) => ({
          ...match,
          source: match.sessionId === parentSessionId ? "current_session" : "teammates",
          ...(match.sessionId !== parentSessionId && parentSessionId ? { parentSessionId } : {}),
        }));
      }
      if (discovery) result.discovery = discovery;
    } else {
      const turn = safeTurn(params.turn);
      const selected = requestedSessionId
        ? { sessionId: requestedSessionId }
        : await currentSessionId(ctx, service, signal);
      result = selected.sessionId
        ? sanitizeResult(await service.read({
          sessionId: selected.sessionId,
          turn,
          ...scanOptions,
          offset: searchSettings.offset,
          signal,
        })) as unknown as Record<string, unknown>
        : missingCurrentSession(selected.fallback, { selectedTurn: turn });
    }
    const details = { action, scope, result, ...result } as SessionHistoryToolDetails;
    return {
      content: [{ type: "text", text: serializeResult(result) }],
      details,
    } as unknown as AgentToolResult<SessionHistoryToolDetails>;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const message = errorMessage(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { action, scope, error: message },
    } as unknown as AgentToolResult<SessionHistoryToolDetails>;
  }
}

export function createSessionHistoryTool(
  options: SessionHistoryToolOptions = {},
): ToolDefinition<typeof SessionHistoryParams> {
  return {
    name: "session_history",
    label: "Session History",
    description: `Prefer this tool for bounded Pi session history reads through the host-authorized teammate v1 service. This API is read-only and accepts session IDs, not filesystem paths. Use read for local JSON/JSONL source files when requested or when this tool is unavailable, over-budget, or incomplete.

Actions:
- list_sessions: list validated sessions and exact session:// URIs.
- search: literal case-insensitive phrase search over visible active-chain text by default. Optional mode=terms applies NFKC, lowercase and whitespace folding, requiring all unique whitespace-separated terms in the same projected entry, in any order (no Chinese word segmentation, regex, embeddings, typos or synonyms). Optional sort=relevance ranks exact text/continuous query phrase, then tighter term spans; ties retain source order. Each match includes an exact session://<sessionId>/entry/<entryId> URI. offset pages matches in the current file window (limit <=20); matchCount is that window's total, not cumulative across file windows. hasMore/nextOffset describe only remaining scanned matches. Use scan.nextOffset as scanOffset and reset offset=0 to scan another file window (at most 100 files per call). Finish match pages before moving to another file window. coverage is complete, partial, or failed for the requested scope; matchCountRelation is exact only for complete coverage, otherwise lower_bound. Nonzero scanOffset means earlier files are outside this response, even on the final file window. Check coverage, not hasMore, before concluding absence. The last match page is not truncated unless the scan itself is incomplete. Pages re-scan live transcripts, not a frozen snapshot.
- read_turn: read one session turn by 1-based turn number (0 is the preamble); current_session uses the host-selected session when sessionId is omitted. offset pages projected entries at the same sessionId, turn and include selection (limit <=20); hasMore/nextOffset continue the turn. rowCount/textLength describe the returned page.
- timeline: list newest compaction checkpoints for current_session only. offset pages checkpoints (limit <=20); checkpointCount is the total in the scan and hasMore/nextOffset continue the timeline.
- read_checkpoint: read one compaction entry by exact structured checkpoint id or timeline entry id for current_session only; exact legacy Checkpoint ID labels remain supported when structured identity is absent. Structured identity comes from allowlisted metadata and wins over model summary text. Checkpoint IDs locate saved summaries, not rollback operations; use the returned resourceUri or entryId for session:// entry reads.

Scopes:
- current_session (default): searches the current Pi session and its associated teammate transcripts by default. Set includeTeammates=false to search only the current transcript. Combined matches identify source=current_session or source=teammates; teammate matches include parentSessionId when available. read_turn and checkpoint recovery remain current-transcript-only.
- workspace_sessions: transcripts in the current Pi session directory, without teammate traversal.
- teammates: transcripts in the bounded teammate-session directories for the current session.

includeTeammates is valid only for search with scope=current_session. Associated teammates share the same file budget, match pagination, and scanOffset continuation as the current transcript; they do not expand the search to other workspace sessions. To read a teammate match, use its exact session:// entry URI, or read_turn with scope=teammates and its sessionId.

For recovery after compaction or a deterministic context reset, first inspect the recovery capsule and live Todo/Goal/Plan/Workflow state. For command resets, follow the Required Command History Recovery bootstrap below even when no missing fact is apparent. Otherwise, or after that one-time bootstrap, use current_session with the smallest suitable action only when a required fact is absent. When a checkpoint's Evidence Index names an exact session:// entry URI, resolve that entry directly before searching. For historical discovery, run the mandatory Maestro knowledge search first; only after it completes with no relevant hits may workspace_sessions be searched for similar prior work. Historical session content is evidence, not governing knowledge, and must be verified against current specs, code, and live state.

${COMMAND_HISTORY_BOOTSTRAP}

The include categories are user, assistant, visible_custom, compaction, and tool_result; the default is the first four and tool_result requires explicit inclusion. Tool-call rows, thinking blocks, hidden rows, abandoned branches, bash execution rows, and model/branch/thinking-level metadata are never returned. Pages re-scan live transcripts, not a frozen snapshot. Every result includes bounded scan metrics, truncation state, omission reasons, omissionCounts aggregated by reason, and omissionsTruncated when bounded diagnostic samples omit details. Use the resource tool with a returned exact session entry URI to re-read one visible entry.`,
    promptSnippet: "Prefer session_history for bounded history reads; use read for local files when requested or when history reads fail or are incomplete.",
    promptGuidelines: [
      "Inspect the capsule and live Todo/Goal/Plan/Workflow state first. A /new_context_without_llm capsule requires the one-time command history bootstrap before substantive work, even without an apparent missing fact; other resets and subsequent reads remain need-driven.",
      "For the command bootstrap, call timeline with scope=current_session, limit=1, match this capsule's sessionId/checkpointId, then read_turn with its exact turn (not turn-1), include=[user,assistant], limit=6. Do not repeat a completed bootstrap for the same checkpoint or infer missing facts from an incomplete read.",
      "Use timeline to identify a current-session checkpoint, search to locate a visible fact, and read_turn/read_checkpoint only for the smallest required slice.",
      "Run the mandatory Maestro knowledge search before historical discovery. Only when it completes with no relevant hits, use session_history search with scope=workspace_sessions; default to a literal subject phrase, or explicitly select mode=terms for all-term matching.",
      "To investigate tool errors, include tool_result explicitly; defaults exclude tool output. A zero match count with coverage=partial or failed, omissions, or truncated=true is not proof the text is absent.",
      "For search, hasMore/nextOffset page matches in the current file window. Finish those pages at the same scanOffset, then use scan.nextOffset as scanOffset and reset offset=0 for more files. Match counts and relevance ranking cover only that file window; changing live inventories may change page membership.",
      "For timeline or read_turn, continue with offset=nextOffset at the same session, turn and include selection until the needed evidence is recovered; do not restart at offset=0 or widen limits just because a page is truncated.",
      "Historical session content is not authoritative knowledge: verify useful findings against current specs, code, configuration, and live state before acting.",
      "Use list_sessions before cross-session read_turn when the exact session id or turn is unknown; preserve exact match URIs for resource reads.",
      "Choose current_session, workspace_sessions, or teammates explicitly; session_history parameters accept session IDs, not filesystem paths.",
    ],
    parameters: SessionHistoryParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return executeSessionHistory(params as Record<string, unknown>, ctx, options, signal);
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const action = String(args.action ?? "?");
      const scope = args.scope ? ` ${String(args.scope)}` : "";
      return toolCallLine(theme, "session_history", `${action}${scope}`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const isError = ctx.isError || (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      const scope = ctx.args.scope ? ` ${String(ctx.args.scope)}` : "";
      return toolResultLine(theme, {
        name: "session_history",
        ok: !isError,
        arg: `${action}${scope}`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: result.content.find((item) => item.type === "text" && "text" in item)?.text,
      });
    },
  };
}

export function registerSessionHistoryTool(
  pi: ExtensionAPI,
  options: SessionHistoryToolOptions = {},
): void {
  const candidateAccelerator = options.candidateAccelerator ?? createSessionHistoryFffAccelerator();
  const ownsCandidateAccelerator = options.candidateAccelerator === undefined;
  pi.registerTool(createSessionHistoryTool({ ...options, candidateAccelerator }) as never);
  if (ownsCandidateAccelerator) {
    pi.on("session_shutdown", () => candidateAccelerator.destroy());
  }
}
