/**
 * compact_history — bounded, read-only recovery history for the current Pi
 * session.
 *
 * The teammate package owns transcript parsing and projection. Flow supplies
 * only the host-authorized active session file; no model-provided scope,
 * session id, or path is accepted, retained, or returned.
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
  type SessionHistoryEntry,
  type SessionHistoryInclude,
  type SessionHistoryInventoryEntry,
  type SessionHistoryInventorySource,
  type SessionHistoryOmission,
} from "pi-maestro-teammate/v1/session-history";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";

export const SESSION_HISTORY_SCOPES = ["current_session", "workspace_sessions", "teammates"] as const;
export type SessionHistoryScope = (typeof SESSION_HISTORY_SCOPES)[number];
type InventoryScope = SessionHistoryScope | "all";

export const SESSION_HISTORY_ACTIONS = ["list_sessions", "search", "read_turn"] as const;
export type SessionHistoryAction = (typeof SESSION_HISTORY_ACTIONS)[number];

export const COMPACT_HISTORY_ACTIONS = ["timeline", "search", "read_turn", "read_checkpoint"] as const;
export type CompactHistoryAction = (typeof COMPACT_HISTORY_ACTIONS)[number];

const MAX_DISCOVERY_DIRECTORIES = MAX_SESSION_HISTORY_FILES * 4;
const MAX_DISCOVERY_PATHS = MAX_SESSION_HISTORY_FILES * 8;

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
  query: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_SESSION_HISTORY_QUERY_CHARS, description: "Literal, case-insensitive search text (required for search)." }),
  ),
  sessionId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 512, description: "Exact session id (required for read_turn)." }),
  ),
  turn: Type.Optional(
    Type.Integer({ minimum: 0, description: "1-based turn number; 0 is the preamble (required for read_turn)." }),
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

/** Action contract intentionally contains only current-session read operations. */
export const CompactHistoryParams = Type.Object({
  action: StringEnum(
    COMPACT_HISTORY_ACTIONS,
    "Current-session compact recovery action.",
  ),
  query: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_SESSION_HISTORY_QUERY_CHARS, description: "Literal, case-insensitive search text (required for search)." }),
  ),
  turn: Type.Optional(
    Type.Integer({ minimum: 0, description: "1-based turn number; 0 is the preamble (required for read_turn)." }),
  ),
  checkpointId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 512, description: "Checkpoint id or compaction entry id (required for read_checkpoint)." }),
  ),
  include: Type.Optional(
    Type.Array(
      StringEnum(SESSION_HISTORY_INCLUDES, "Approved visible transcript category."),
      {
        minItems: 1,
        maxItems: SESSION_HISTORY_INCLUDES.length,
        uniqueItems: true,
        description: "Categories for search/read_turn. Defaults to user, assistant, visible_custom, and compaction; tool_result is explicit only.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_SESSION_HISTORY_MATCHES, description: "Result limit for timeline, search, or selected-turn entries." }),
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
}

export interface CompactHistoryToolDetails {
  action: CompactHistoryAction;
  [key: string]: unknown;
}

export interface CompactHistoryToolOptions {
  /** Test/host inventory override. The default is the active file from `ctx`. */
  inventory?: SessionHistoryInventorySource;
  /** Optional current-session inventory factory for hosts with their own authorization. */
  inventoryFactory?: (ctx: ExtensionContext) => SessionHistoryInventorySource;
  /** Defense-in-depth gate for a definition retained after the opt-in mode is disabled. */
  isEnabled?: (ctx: ExtensionContext) => boolean;
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
async function directoryInventory(
  directory: string,
  signal?: AbortSignal,
): Promise<SessionHistoryInventoryEntry[]> {
  const result: SessionHistoryInventoryEntry[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(directory, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
  } catch {
    return result;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (signal?.aborted) throw signal.reason ?? new Error("Session history inventory aborted.");
    if (!entry.name.endsWith(".jsonl")) continue;
    result.push(inventoryEntry(join(directory, entry.name)));
    if (result.length >= MAX_DISCOVERY_PATHS) break;
  }
  return result;
}

/** Enumerate the bounded, shallow teammate session layout. */
async function teammateInventory(
  directory: string,
  signal?: AbortSignal,
): Promise<SessionHistoryInventoryEntry[]> {
  const result: SessionHistoryInventoryEntry[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(directory, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
  } catch {
    return result;
  }
  let directories = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (signal?.aborted) throw signal.reason ?? new Error("Session history inventory aborted.");
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    directories += 1;
    if (directories > MAX_DISCOVERY_DIRECTORIES) break;
    result.push(...await directoryInventory(join(directory, entry.name), signal));
    if (result.length >= MAX_DISCOVERY_PATHS) break;
  }
  return result.slice(0, MAX_DISCOVERY_PATHS);
}

/**
 * Build a fresh host inventory for one scope. The returned provider performs no
 * caching; SessionHistoryService revalidates every candidate on every call.
 */
export function createSessionHistoryInventoryProvider(
  ctx: SessionHistoryHostContext,
  scope: InventoryScope,
): SessionHistoryInventorySource {
  return async (signal) => {
    const sessionFile = currentSessionFile(ctx);
    if (!sessionFile) return { entries: [] };

    const entries: SessionHistoryInventoryEntry[] = [];
    if (scope === "current_session") {
      entries.push(inventoryEntry(sessionFile));
    } else if (scope === "workspace_sessions" || scope === "all") {
      entries.push(...await directoryInventory(sessionDirectory(sessionFile), signal));
    }
    if (scope === "teammates" || scope === "all") {
      entries.push(...await teammateInventory(teammateSessionDirectory(sessionFile), signal));
    }
    if (scope === "all") {
      // `workspace` entries were added above for the all-scope used by the
      // resource resolver. The active transcript is included even when a host
      // uses a non-standard filename, while the service still validates it.
      if (!entries.some((entry) => resolve(entry.path) === sessionFile)) {
        entries.unshift(inventoryEntry(sessionFile));
      }
    }
    return { entries };
  };
}

/** Friendly alias for hosts/tests that prefer an inventory-named function. */
export const sessionHistoryInventoryProvider = createSessionHistoryInventoryProvider;

/** Active-session inventory used by compact_history and session:// resources. */
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

function compactActionValue(value: unknown): CompactHistoryAction | undefined {
  return COMPACT_HISTORY_ACTIONS.includes(value as CompactHistoryAction)
    ? value as CompactHistoryAction
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

function capsuleField(text: string, label: string): string | undefined {
  const prefix = `- ${label}:`;
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value.slice(0, 512) : undefined;
}

function checkpointProjection(entry: SessionHistoryEntry): Record<string, unknown> {
  const checkpointId = capsuleField(entry.text, "Checkpoint ID");
  const previousCheckpointId = capsuleField(entry.text, "Previous Checkpoint");
  const newContext = entry.text.includes("Maestro New Context Recovery Capsule");
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
    source: newContext ? "new-context" : "compaction",
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
    ...(fallback ?? { filesRead: 0, bytesRead: 0, truncated: false, omissions: [] }),
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
    const source = options.inventory
      ?? options.inventoryFactory?.(scope, ctx)
      ?? createSessionHistoryInventoryProvider(ctx, scope);
    const service = new SessionHistoryService(source);
    const scanOptions = boundedOptions(params);
    let result: Record<string, unknown>;
    if (action === "list_sessions") {
      result = sanitizeResult(await service.list({ ...scanOptions, signal })) as unknown as Record<string, unknown>;
    } else if (action === "search") {
      const query = safeQuery(params.query);
      result = sanitizeResult(await service.search(query, { ...scanOptions, signal })) as unknown as Record<string, unknown>;
    } else {
      const sessionId = safeIdentifier(params.sessionId, "sessionId");
      const turn = safeTurn(params.turn);
      result = sanitizeResult(await service.read({
        sessionId,
        turn,
        ...scanOptions,
        signal,
      })) as unknown as Record<string, unknown>;
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

export async function executeCompactHistory(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  options: CompactHistoryToolOptions = {},
  signal?: AbortSignal,
): Promise<AgentToolResult<CompactHistoryToolDetails>> {
  const action = compactActionValue(params.action);
  if (!action) {
    return {
      content: [{ type: "text", text: "Invalid compact_history action." }],
      isError: true,
      details: { action: "timeline", error: "invalid action" },
    } as unknown as AgentToolResult<CompactHistoryToolDetails>;
  }

  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Compact history read aborted.");
    if (options.isEnabled && !options.isEnabled(ctx)) {
      return {
        content: [{ type: "text", text: "Compact History is unavailable because compaction.newContext.enabled is false." }],
        isError: true,
        details: { action, error: "new context disabled" },
      } as unknown as AgentToolResult<CompactHistoryToolDetails>;
    }
    const source = options.inventory
      ?? options.inventoryFactory?.(ctx)
      ?? createCompactHistoryInventoryProvider(ctx);
    const service = new SessionHistoryService(source);
    const scanOptions = boundedOptions(params);
    let result: Record<string, unknown>;

    if (action === "timeline") {
      const timeline = sanitizeResult(await service.compactions({ limit: scanOptions.limit, signal }));
      result = {
        ...timeline,
        checkpoints: timeline.checkpoints.map(checkpointProjection),
      } as unknown as Record<string, unknown>;
    } else if (action === "search") {
      const query = safeQuery(params.query);
      result = sanitizeResult(await service.search(query, { ...scanOptions, signal })) as unknown as Record<string, unknown>;
    } else if (action === "read_turn") {
      const turn = safeTurn(params.turn);
      const current = await currentSessionId(ctx, service, signal);
      result = current.sessionId
        ? sanitizeResult(await service.read({ sessionId: current.sessionId, turn, ...scanOptions, signal })) as unknown as Record<string, unknown>
        : missingCurrentSession(current.fallback, { selectedTurn: turn });
    } else {
      const checkpointId = safeIdentifier(params.checkpointId, "checkpointId");
      const current = await currentSessionId(ctx, service, signal);
      if (!current.sessionId) {
        result = missingCurrentSession(current.fallback, { checkpointId });
      } else {
        const direct = sanitizeResult(await service.read({
          sessionId: current.sessionId,
          entryId: checkpointId,
          include: ["compaction"],
          limit: 1,
          signal,
        }));
        if (direct.found && direct.selectedEntry) {
          result = { ...direct, checkpointId } as unknown as Record<string, unknown>;
        } else {
          const search = sanitizeResult(await service.search(checkpointId, {
            include: ["compaction"],
            limit: MAX_SESSION_HISTORY_MATCHES,
            signal,
          }));
          let selected: Record<string, unknown> | undefined;
          for (const match of search.matches) {
            const candidate = sanitizeResult(await service.read({
              sessionId: current.sessionId,
              entryId: match.entryId,
              include: ["compaction"],
              limit: 1,
              signal,
            }));
            const exact = candidate.selectedEntry?.entries.some(
              (entry) => capsuleField(entry.text, "Checkpoint ID") === checkpointId,
            );
            if (candidate.found && candidate.selectedEntry && exact) {
              selected = { ...candidate, checkpointId } as unknown as Record<string, unknown>;
              break;
            }
          }
          result = selected ?? {
            version: search.version,
            ...(search.generation === undefined ? {} : { generation: search.generation }),
            checkpointId,
            found: false,
            filesRead: search.filesRead,
            bytesRead: search.bytesRead,
            truncated: search.truncated,
            omissions: search.omissions,
          };
        }
      }
    }

    const details = { action, result, ...result } as CompactHistoryToolDetails;
    return {
      content: [{ type: "text", text: serializeResult(result) }],
      details,
    } as unknown as AgentToolResult<CompactHistoryToolDetails>;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const message = errorMessage(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { action, error: message },
    } as unknown as AgentToolResult<CompactHistoryToolDetails>;
  }
}

export function createSessionHistoryTool(
  options: SessionHistoryToolOptions = {},
): ToolDefinition<typeof SessionHistoryParams> {
  return {
    name: "session_history",
    label: "Session History",
    description: `Read bounded Pi session history through the host-authorized teammate v1 service. This tool is read-only and accepts no transcript paths, writes, caches, or indexes.

Actions:
- list_sessions: list validated sessions and exact session:// URIs.
- search: literal case-insensitive search over visible active-chain text; each match includes an exact session://<sessionId>/entry/<entryId> URI.
- read_turn: read one session turn by exact sessionId and 1-based turn number (0 is the preamble).

Scopes:
- current_session: only the current Pi session transcript.
- workspace_sessions: transcripts in the current Pi session directory.
- teammates: transcripts in the bounded teammate-session directories for the current session.

Use this as a secondary discovery source when Maestro knowledge search completed successfully but returned no relevant hits: search workspace_sessions with 1-3 subject keywords for similar prior work. Session history is historical evidence, not governing knowledge; verify useful findings against current specs, code, and live state. Do not use it instead of the mandatory Maestro Search/Load knowledge gate.

The include categories are user, assistant, visible_custom, compaction, and tool_result; the default is the first four and tool_result requires explicit inclusion. Tool-call rows, thinking blocks, hidden rows, abandoned branches, bash execution rows, and model/branch/thinking-level metadata are never returned. Every result includes bounded scan metrics, truncation state, and omission reasons. Use the resource tool with a returned exact session entry URI to re-read one visible entry; arbitrary filesystem paths are rejected.`,
    promptSnippet: "After a zero-relevant-hit Maestro knowledge search, use bounded read-only workspace session history to find similar prior work; treat it as historical evidence, not governing knowledge.",
    promptGuidelines: [
      "Run the mandatory Maestro knowledge search first. Only when it completes with no relevant hits, use session_history search with scope=workspace_sessions and 1-3 subject keywords to investigate similar prior sessions.",
      "Session history is a secondary historical lead, not authoritative knowledge: verify any useful finding against current specs, code, configuration, and live state before acting.",
      "Use list_sessions before read_turn when the exact session id or turn is unknown; use search for literal case-insensitive discovery and preserve exact match URIs for resource reads.",
      "Choose current_session, workspace_sessions, or teammates explicitly; use the narrowest scope that can answer the question and inspect teammate history only when its provenance is relevant.",
      "Never infer or provide a session transcript filesystem path; session history is host-authorized and read-only.",
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
      const isError = (result as { isError?: boolean }).isError === true;
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
  pi.registerTool(createSessionHistoryTool(options) as never);
}

export function createCompactHistoryTool(
  options: CompactHistoryToolOptions = {},
): ToolDefinition<typeof CompactHistoryParams> {
  return {
    name: "compact_history",
    label: "Compact History",
    description: `Read bounded recovery history for the current Pi session only. The host selects the active transcript; this tool accepts no session id, scope, transcript path, writes, caches, or indexes.

Actions:
- timeline: list the newest current-session compaction checkpoints and exact session:// entry URIs.
- search: literal case-insensitive search over visible active-chain text in the current session.
- read_turn: read one current-session turn by its 1-based turn number (0 is the preamble).
- read_checkpoint: read one compaction entry by checkpoint id or timeline entry id.

The visible categories are user, assistant, visible_custom, compaction, and tool_result; tool_result is explicit only. Tool-call rows, thinking blocks, hidden rows, abandoned branches, bash execution rows, and model/branch/thinking metadata are never returned. Use resource with an exact returned session://<sessionId>/entry/<entryId> URI when only one durable entry is needed.`,
    promptSnippet: "Current-session compact recovery timeline and bounded visible history",
    promptGuidelines: [
      "Recover from the capsule and live Todo/Goal/Plan/Workflow state first; use compact_history only when a required current-session fact is absent.",
      "Use timeline to identify a checkpoint, search to locate a visible fact, and read_turn/read_checkpoint only for the smallest required slice.",
      "Preserve exact session:// entry URIs for resource reads; never infer or provide a transcript filesystem path.",
      "compact_history never scans workspace or teammate sessions and never accepts a session id from the model.",
    ],
    parameters: CompactHistoryParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      return executeCompactHistory(params as Record<string, unknown>, ctx, options, signal);
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "compact_history", String(args.action ?? "?"));
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const isError = (result as { isError?: boolean }).isError === true;
      const action = String(ctx.args.action ?? "?");
      return toolResultLine(theme, {
        name: "compact_history",
        ok: !isError,
        arg: action,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: result.content.find((item) => item.type === "text" && "text" in item)?.text,
      });
    },
  };
}

export function registerCompactHistoryTool(
  pi: ExtensionAPI,
  options: CompactHistoryToolOptions = {},
): void {
  pi.registerTool(createCompactHistoryTool(options) as never);
}
