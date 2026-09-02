/**
 * session_history — bounded, read-only discovery of host-authorized Pi
 * session transcripts.
 *
 * The teammate package owns transcript parsing and projection. Flow only builds
 * a fresh, host-authorized inventory from the current Pi session context and
 * passes it through the public v1 session-history API. No path supplied by the
 * model is ever accepted, retained, or returned.
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
  type SessionHistoryInclude,
  type SessionHistoryInventoryEntry,
  type SessionHistoryInventorySource,
  type SessionHistoryOmission,
} from "pi-maestro-teammate/v1/session-history";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";

export const SESSION_HISTORY_SCOPES = ["current_session", "workspace_sessions", "teammates"] as const;
export type SessionHistoryScope = (typeof SESSION_HISTORY_SCOPES)[number];
type InventoryScope = SessionHistoryScope | "all";

const MAX_DISCOVERY_DIRECTORIES = MAX_SESSION_HISTORY_FILES * 4;
const MAX_DISCOVERY_PATHS = MAX_SESSION_HISTORY_FILES * 8;

function StringEnum<T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(description ? { description } : {}),
  });
}

/** Action contract intentionally contains only read operations. */
export const SessionHistoryParams = Type.Object({
  action: StringEnum(
    ["list_sessions", "search", "read_turn"] as const,
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

export type SessionHistoryAction = "list_sessions" | "search" | "read_turn";

/** Minimal context shape used by the inventory builder, kept structural so it
 * can be used by focused tests without constructing a full ExtensionContext. */
export interface SessionHistoryHostContext {
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
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

function defaultScope(_action: SessionHistoryAction): SessionHistoryScope {
  return "current_session";
}

function actionValue(value: unknown): SessionHistoryAction | undefined {
  return value === "list_sessions" || value === "search" || value === "read_turn"
    ? value
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

export async function executeSessionHistory(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  options: SessionHistoryToolOptions = {},
  signal?: AbortSignal,
): Promise<AgentToolResult<SessionHistoryToolDetails>> {
  const action = actionValue(params.action);
  const scope = scopeValue(params.scope, action ?? "list_sessions");
  if (!action || !scope) {
    return {
      content: [{ type: "text", text: "Invalid session_history action or scope." }],
      isError: true,
      details: { action: (action ?? "list_sessions") as SessionHistoryAction, scope: scope ?? "current_session", error: "invalid action or scope" },
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
      const readResult = sanitizeResult(await service.read({
        sessionId,
        turn,
        ...scanOptions,
        signal,
      }));
      // The service read result contains only the selected turn/entries and
      // scan metrics; it never widens into a full-session transcript dump.
      result = readResult as unknown as Record<string, unknown>;
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
    description: `Read bounded Pi session history through the host-authorized teammate v1 service. This tool is read-only and accepts no transcript paths, writes, caches, or indexes.

Actions:
- list_sessions: list validated sessions and exact session:// URIs.
- search: literal case-insensitive search over visible active-chain text; each match includes an exact session://<sessionId>/entry/<entryId> URI.
- read_turn: read one session turn by exact sessionId and 1-based turn number (0 is the preamble).

Scopes:
- current_session: only the current Pi session transcript.
- workspace_sessions: transcripts in the current Pi session directory.
- teammates: transcripts in the bounded teammate-session directories for the current session.

The include categories are user, assistant, visible_custom, compaction, and tool_result; the default is the first four and tool_result requires explicit inclusion. Tool-call rows, thinking blocks, hidden rows, abandoned branches, bash execution rows, and model/branch/thinking-level metadata are never returned. Every result includes bounded scan metrics, truncation state, and omission reasons. Use the resource tool with a returned exact session entry URI to re-read one visible entry; arbitrary filesystem paths are rejected.`,
    promptSnippet: "Bounded read-only session history discovery with exact session entry resource URIs",
    promptGuidelines: [
      "Use list_sessions before read_turn when the exact session id or turn is unknown.",
      "Use search for literal case-insensitive discovery; preserve the exact match URI for resource round-trips.",
      "Choose current_session, workspace_sessions, or teammates explicitly when the narrower view is sufficient.",
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
