import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { toolCallLine, toolResultLine, resultSummary } from "../quiet-render.ts";
import { FileFinder, type FileFinderApi } from "@ff-labs/fff-node";
import { Type } from "typebox";

const SCAN_TIMEOUT_MS = 15_000;
// Keep at most this many indexed workspaces alive. Each finder owns a native
// file watcher plus an in-memory index, so unbounded caching would trade one
// scan storm for another.
const MAX_CACHED_FINDERS = 4;

/**
 * Returns a human-readable reason when `dir` is a filesystem root or the user's
 * home directory. fff-node already refuses these at the native layer unless
 * `enableHomeDirScanning`/`enableFsRootScanning` are set; failing fast here
 * avoids the obscure native error and the wasted per-call init attempt.
 */
function unsafeBasePathReason(dir: string): string | undefined {
  if (dir === parse(dir).root) return "filesystem roots";
  if (dir.toLowerCase() === homedir().toLowerCase()) return "home directories";
  return undefined;
}

/** Evicts the least-recently-used finder once the cache exceeds its cap. */
function evictOldestFinder(finders: Map<string, FileFinderApi>): void {
  while (finders.size > MAX_CACHED_FINDERS) {
    const oldestKey = finders.keys().next().value;
    if (oldestKey === undefined) break;
    finders.get(oldestKey)?.destroy();
    finders.delete(oldestKey);
  }
}

const FffGrepParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Literal text to search for" }),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Lines of context before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum number of matches to return (default: 20)" })),
});

const FffFindParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Fuzzy file-path query" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum number of files to return (default: 30)" })),
});

/**
 * Adds FFF's native index only to the root Pi session. The tools stay separate
 * from Pi's built-ins, so existing grep/find calls remain backward compatible.
 */
export function registerFff(pi: ExtensionAPI): void {
  const finders = new Map<string, FileFinderApi>();
  const failedCwds = new Set<string>();
  const initializing = new Map<string, Promise<FileFinderApi>>();

  const ensureFinder = async (cwd: string): Promise<FileFinderApi> => {
    const key = resolve(cwd);
    const denied = unsafeBasePathReason(key);
    if (denied) {
      throw new Error(`FFF does not index ${denied}; start Pi from a specific project directory or use the built-in find/grep tools`);
    }
    if (failedCwds.has(key)) {
      throw new Error(`FFF index for ${key} failed to scan; use the built-in find/grep tools instead`);
    }
    const cached = finders.get(key);
    if (cached && !cached.isDestroyed) return cached;
    const pending = initializing.get(key);
    if (pending) return pending;
    const task = (async (): Promise<FileFinderApi> => {
      const created = FileFinder.create({ basePath: key, aiMode: true });
      if (!created.ok) {
        failedCwds.add(key);
        throw new Error(`FFF initialization failed: ${created.error}`);
      }
      const finder = created.value;
      const scanned = await finder.waitForScan(SCAN_TIMEOUT_MS);
      // waitForScan returns { ok: true, value: false } on timeout; destroying
      // the finder here stops the runaway background index of large trees.
      if (!scanned.ok || !scanned.value) {
        const reason = scanned.ok
          ? `FFF initial scan timed out after ${SCAN_TIMEOUT_MS}ms`
          : `FFF initial scan failed: ${scanned.error}`;
        finder.destroy();
        failedCwds.add(key);
        throw new Error(reason);
      }
      finders.set(key, finder);
      evictOldestFinder(finders);
      return finder;
    })().finally(() => { initializing.delete(key); });
    initializing.set(key, task);
    return task;
  };

  pi.on("session_shutdown", () => {
    for (const finder of finders.values()) finder.destroy();
    finders.clear();
    failedCwds.clear();
  });

  pi.registerTool({
    name: "ffgrep",
    label: "FFF Grep",
    description: "Fast FFF-backed literal content search in the current workspace.",
    promptSnippet: "Search workspace file contents with FFF.",
    parameters: FffGrepParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) throw abortError();
      const activeFinder = await ensureFinder(ctx.cwd);
      if (signal?.aborted) throw abortError();
      const result = activeFinder.grep(params.pattern, {
        mode: "plain",
        smartCase: true,
        pageSize: params.limit ?? 20,
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        classifyDefinitions: true,
      });
      if (!result.ok) throw new Error(`FFF grep failed: ${result.error}`);
      return { content: [{ type: "text", text: formatGrep(result.value) }] } as AgentToolResult<unknown>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "ffgrep", `"${String(args.pattern ?? "")}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      const lines = text.split("\n").filter(Boolean);
      return toolResultLine(theme, {
        name: "ffgrep",
        ok: text !== "No matches" && lines.length > 0,
        arg: `"${String(ctx.args.pattern ?? "")}"`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });

  pi.registerTool({
    name: "fffind",
    label: "FFF Find",
    description: "Fast FFF-backed fuzzy file-path search in the current workspace.",
    promptSnippet: "Find workspace files by fuzzy path with FFF.",
    parameters: FffFindParams,
    async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) throw abortError();
      const activeFinder = await ensureFinder(ctx.cwd);
      if (signal?.aborted) throw abortError();
      const result = activeFinder.fileSearch(params.pattern, { pageSize: params.limit ?? 30 });
      if (!result.ok) throw new Error(`FFF file search failed: ${result.error}`);
      const text = result.value.items.length
        ? result.value.items.map((item) => item.relativePath).join("\n")
        : "No files found";
      return { content: [{ type: "text", text }] } as AgentToolResult<unknown>;
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "fffind", `"${String(args.pattern ?? "")}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      return toolResultLine(theme, {
        name: "fffind",
        ok: text !== "No files found",
        arg: `"${String(ctx.args.pattern ?? "")}"`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });
}

function formatGrep(result: { items: Array<{ relativePath: string; lineNumber: number; lineContent: string }> }): string {
  return result.items.length
    ? result.items.map((item) => `${item.relativePath}:${item.lineNumber}: ${item.lineContent}`).join("\n")
    : "No matches found";
}

function abortError(): Error {
  const error = new Error("FFF search aborted.");
  error.name = "AbortError";
  return error;
}
