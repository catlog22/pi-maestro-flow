import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { toolCallLine, toolResultLine, resultSummary } from "pi-cockpit/src/quiet-tools.ts";
import type { FileItem, GrepCursor, GrepMatch } from "@ff-labs/fff-node";
import { awaitFffTeardown, createFffProcessFinder, type CreateFffFinder, type FffFinder } from "./fff-process.ts";
import { Type } from "typebox";
import { resolveSearchScopePath } from "./search-scope-guard.ts";
import { runRgSearch } from "./search-rg.ts";

export const SearchToolParameters = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description:
      "Text to search for — a literal string by default; a Rust-syntax regular expression with mode=\"regex\" (no look-around or backreferences — rewrite foo\\((?!\\)) as foo\\([^)]*\\)); an approximate term with mode=\"fuzzy\"",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Directory or file inside the workspace (default: workspace root). On large projects, specify a subdirectory or file to avoid a broad root scan.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("plain"), Type.Literal("regex"), Type.Literal("fuzzy")], {
      description:
        "plain = literal substring (default); regex = regular expression; fuzzy = approximate content matching for unknown spellings (requires the index; incompatible with forced ignoreCase or '!' globs)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "Filter searched files by glob, e.g. '*.ts' or 'src/**/*.spec.ts'; prefix with '!' to exclude",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 20,
      description: "Lines to show before and after each match for output=\"lines\" (default: 0, max: 20)",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({
      description:
        "true = always case-insensitive; false = always case-sensitive; omit for smart case (insensitive only when the pattern is all-lowercase)",
    }),
  ),
  output: Type.Optional(
    Type.Union([Type.Literal("lines"), Type.Literal("files"), Type.Literal("count")], {
      description:
        "lines = matching lines with file:line prefixes (default); files = matching file paths only; count = per-file matching-line totals as file:N rows",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
      description: "Max matches (lines) or file rows (files/count) to return (default: 50, max: 1000)",
    }),
  ),
});

export interface SearchToolInput {
  pattern: string;
  path?: string;
  mode?: "plain" | "regex" | "fuzzy";
  glob?: string;
  context?: number;
  ignoreCase?: boolean;
  output?: "lines" | "files" | "count";
  limit?: number;
}

/**
 * Shared search surface consumed by both the root `search` tool and the
 * teammate child-tool broker — one workspace index serves every session.
 */
export interface FffSearchHandle {
  search(
    input: SearchToolInput,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
}

export interface RegisterFffOptions {
  /** Test seam: replace isolated FileFinder creation. */
  createFinder?: CreateFffFinder;
  /** Test seam: replace the ripgrep fallback runner. */
  runRg?: typeof runRgSearch;
  /** Test seam: initial scan timeout. */
  scanTimeoutMs?: number;
}

const SCAN_TIMEOUT_MS = 15_000;
const SEARCH_TIME_BUDGET_MS = 8_000;
const FFF_PAGE_SIZE = 200;
const MAX_DRAIN_PAGES = 200;
const MAX_DRAIN_MATCHES = 50_000;
const MAX_GLOB_FILES = 20_000;
const MAX_CACHED_FINDERS = 4;
const MAX_INITIALIZING_FINDERS = 4;
const MAX_OWNED_FINDERS = MAX_CACHED_FINDERS + MAX_INITIALIZING_FINDERS;
const MAX_FAILED_ROOTS = 32;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** One index per workspace root — never one per searched subdirectory. */
export function registerFff(pi: ExtensionAPI, options: RegisterFffOptions = {}): FffSearchHandle {
  const finders = new Map<string, FffFinder>();
  const initializingFinders = new Map<string, FffFinder>();
  const failedRoots = new Set<string>();
  const initializing = new Map<string, Promise<FffFinder>>();
  // Includes initializing and closing workers until their exit is confirmed.
  const ownedFinders = new Map<string, FffFinder>();
  const retireFinder = async (root: string, finder: FffFinder): Promise<void> => {
    await finder.destroy();
    await finder.closed;
    if (ownedFinders.get(root) === finder) ownedFinders.delete(root);
  };
  const createFinder = options.createFinder ?? createFffProcessFinder;
  const scanTimeoutMs = options.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
  const runRg = options.runRg ?? runRgSearch;
  let lifecycleGeneration = 0;

  const unsafeBasePathReason = (cwd: string): string | null => {
    const resolved = resolve(cwd);
    if (resolved === homedir()) return "home directories";
    if (resolved === parse(resolved).root) return "filesystem roots";
    return null;
  };

  const rememberFailedRoot = (root: string): void => {
    failedRoots.delete(root);
    failedRoots.add(root);
    while (failedRoots.size > MAX_FAILED_ROOTS) {
      const oldest = failedRoots.values().next().value;
      if (oldest === undefined) break;
      failedRoots.delete(oldest);
    }
  };

  const ensureFinder = async (root: string): Promise<FffFinder> => {
    const denied = unsafeBasePathReason(root);
    if (denied) throw new Error(`search does not index ${denied}; start Pi from a specific project directory`);
    if (failedRoots.has(root)) {
      throw new Error(`search failed to scan ${root}; use rg in bash instead for deterministic fallback`);
    }
    const ready = finders.get(root);
    if (ready && !ready.isDestroyed) return ready;
    if (ready) finders.delete(root);
    const pending = initializing.get(root);
    if (pending) return pending;
    if (initializing.size >= MAX_INITIALIZING_FINDERS) {
      throw new Error(`search initialization limit reached (${MAX_INITIALIZING_FINDERS}); retry after an active scan completes`);
    }

    const generation = lifecycleGeneration;
    let initPromise!: Promise<FffFinder>;
    initPromise = Promise.resolve().then(async () => {
      if (generation !== lifecycleGeneration) throw new Error("search session ended");
      const previous = ownedFinders.get(root);
      if (previous) await retireFinder(root, previous);
      if (generation !== lifecycleGeneration) throw new Error("search session ended");
      if (ownedFinders.size >= MAX_OWNED_FINDERS) {
        throw new Error(`search worker limit reached (${MAX_OWNED_FINDERS}); previous workers must close before starting another`);
      }
      const created = createFinder({ basePath: root });
      if (!created.ok) {
        throw new Error(`search index unavailable (${created.error})`);
      }
      const finder = created.value;
      ownedFinders.set(root, finder);
      if (finder.closed) {
        void finder.closed.then(() => {
          if (ownedFinders.get(root) === finder) ownedFinders.delete(root);
        });
      }
      let published = false;
      initializingFinders.set(root, finder);
      try {
        const scan = await finder.waitForScan(scanTimeoutMs);
        if (generation !== lifecycleGeneration) throw new Error("search session ended");
        if (finder.isDestroyed) throw new Error("search index unavailable (FFF worker stopped)");
        if (!scan.ok) {
          rememberFailedRoot(root);
          throw new Error(`search failed to scan ${root} (${scan.error}); use rg in bash instead for deterministic fallback`);
        }
        if (!scan.value) {
          rememberFailedRoot(root);
          throw new Error(`search timed out scanning ${root}; use rg in bash instead for deterministic fallback`);
        }
        while (finders.size >= MAX_CACHED_FINDERS) {
          const oldest = finders.entries().next().value;
          if (!oldest) break;
          finders.delete(oldest[0]);
          await retireFinder(oldest[0], oldest[1]);
          if (generation !== lifecycleGeneration) throw new Error("search session ended");
          if (finder.isDestroyed) throw new Error("search index unavailable (FFF worker stopped)");
        }
        finders.set(root, finder);
        published = true;
        return finder;
      } finally {
        if (initializingFinders.get(root) === finder) initializingFinders.delete(root);
        if (!published) await retireFinder(root, finder);
      }
    }).finally(() => {
      if (initializing.get(root) === initPromise) initializing.delete(root);
    });
    initializing.set(root, initPromise);
    return initPromise;
  };

  // Cancellation belongs to the caller, not to the shared initializer. Stop
  // waiting promptly without destroying an index other calls may still need.
  const waitForFinder = (root: string, signal?: AbortSignal): Promise<FffFinder> => {
    if (signal?.aborted) return Promise.reject(fffAbortError());
    const pending = ensureFinder(root);
    if (!signal) return pending;
    return new Promise((resolveFinder, rejectFinder) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        rejectFinder(fffAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (finder) => {
          signal.removeEventListener("abort", onAbort);
          resolveFinder(finder);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          rejectFinder(error);
        },
      );
      if (signal.aborted) onAbort();
    });
  };

  pi.on("session_start", (_event, ctx) => {
    void ensureFinder(resolve(ctx.cwd)).catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    lifecycleGeneration += 1;
    const scans = [...initializing.values()];
    const workers = [...ownedFinders.entries()];
    initializingFinders.clear();
    initializing.clear();
    finders.clear();
    failedRoots.clear();
    await awaitFffTeardown(workers.map(([root, finder]) => retireFinder(root, finder)), scans);
  });

  /** Normalize a scope path to the '/'-separated index prefix it filters to. */
  const scopePrefixOf = (root: string, scopePath: string): string => {
    const prefix = relative(root, scopePath).split(sep).join("/");
    if (prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) {
      throw new Error(`search path must resolve inside the indexed workspace ${root}`);
    }
    return prefix;
  };

  const inScope = (relativePath: string, scopePrefix: string, globSet?: Set<string>): boolean =>
    (scopePrefix === "" || relativePath === scopePrefix || relativePath.startsWith(`${scopePrefix}/`))
    && (globSet === undefined || globSet.has(relativePath));

  /** Collect the indexed file set matching a glob (npm-glob semantics; bare names get a '**' prefix). */
  const collectGlobSet = async (finder: FffFinder, glob: string, signal?: AbortSignal): Promise<Set<string>> => {
    const normalized = glob.includes("/") || glob.includes("\\") ? glob : `**/${glob}`;
    const files = new Set<string>();
    const pageSize = 1000;
    for (let pageIndex = 0; files.size < MAX_GLOB_FILES; pageIndex += 1) {
      if (signal?.aborted) throw fffAbortError();
      const result = await awaitFffOperation(finder.glob(normalized, { pageIndex, pageSize }), signal);
      if (finder.isDestroyed) throw new Error("search index ended");
      if (!result.ok) {
        throw new Error(`search glob failed: ${result.error}`);
      }
      for (const item of result.value.items) files.add(item.relativePath);
      if (result.value.items.length === 0 || (pageIndex + 1) * pageSize >= result.value.totalMatched) break;
    }
    return files;
  };

  const formatLines = (matches: GrepMatch[]): string => {
    const rows: string[] = [];
    for (const match of matches) {
      const before = match.contextBefore ?? [];
      for (const [index, line] of before.entries()) {
        rows.push(`${match.relativePath}-${match.lineNumber - before.length + index}- ${line}`);
      }
      rows.push(`${match.relativePath}:${match.lineNumber}: ${match.lineContent}`);
      const after = match.contextAfter ?? [];
      for (const [index, line] of after.entries()) {
        rows.push(`${match.relativePath}-${match.lineNumber + 1 + index}- ${line}`);
      }
    }
    return rows.join("\n");
  };

  const fffSearch = async (
    finder: FffFinder,
    input: SearchToolInput,
    scopePrefix: string,
    mode: "plain" | "regex" | "fuzzy",
    output: "lines" | "files" | "count",
    limit: number,
    context: number,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    let globSet: Set<string> | undefined;
    if (input.glob) {
      globSet = await collectGlobSet(finder, input.glob, signal);
      if (globSet.size === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: { engine: "fff", exhausted: true } };
      }
    }
    const matches: GrepMatch[] = [];
    const filesSeen = new Set<string>();
    let cursor: GrepCursor | null = null;
    let exhausted = false;
    let filesSearched = 0;
    let regexFallbackNote: string | undefined;
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
      if (signal?.aborted) {
        const error = new Error("search aborted.");
        error.name = "AbortError";
        throw error;
      }
      if (output === "lines" && matches.length >= limit) break;
      if (output === "files" && filesSeen.size >= limit) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result: Awaited<ReturnType<FffFinder["grep"]>> = await awaitFffOperation(finder.grep(input.pattern, {
        mode,
        smartCase: input.ignoreCase !== false,
        cursor,
        beforeContext: context,
        afterContext: context,
        pageSize: output === "lines" ? Math.max((limit - matches.length) * 2, 50) : FFF_PAGE_SIZE,
        classifyDefinitions: true,
        timeBudgetMs: remaining,
      }), signal);
      if (finder.isDestroyed) throw new Error("search index ended");
      if (!result.ok) {
        throw new Error(`search failed: ${result.error}`);
      }
      if (result.value.regexFallbackError) {
        regexFallbackNote = `invalid regex — matched literally (${result.value.regexFallbackError})`;
      }
      filesSearched += result.value.totalFilesSearched ?? 0;
      for (const item of result.value.items) {
        if (!inScope(item.relativePath, scopePrefix, globSet)) continue;
        matches.push(item);
        filesSeen.add(item.relativePath);
      }
      cursor = result.value.nextCursor ?? null;
      if (!cursor || result.value.items.length === 0) break;
      if (matches.length >= MAX_DRAIN_MATCHES) break;
    }
    exhausted = cursor === null;

    let text: string;
    if (output === "files") {
      const rows = [...new Set(matches.map((match) => match.relativePath))].slice(0, limit);
      text = rows.length ? rows.join("\n") : "No matches found";
    } else if (output === "count") {
      const counts = new Map<string, number>();
      for (const match of matches) counts.set(match.relativePath, (counts.get(match.relativePath) ?? 0) + 1);
      const rows = [...counts.entries()].slice(0, limit).map(([file, count]) => `${file}:${count}`);
      text = rows.length ? rows.join("\n") : "No matches found";
    } else {
      text = matches.length ? formatLines(matches.slice(0, limit)) : "No matches found";
    }

    const rowCount = output === "lines" ? matches.length : filesSeen.size;
    const limitReached = rowCount > limit || (!exhausted && rowCount >= limit);
    const notes: string[] = [];
    if (regexFallbackNote) notes.push(regexFallbackNote);
    if (limitReached) {
      notes.push(`${limit} ${output === "lines" ? "matches" : "rows"} limit reached — refine the pattern or raise limit`);
    }
    if (!exhausted && (output === "count" || !limitReached)) {
      notes.push(output === "count"
        ? "index drain stopped early — counts may be incomplete"
        : "index drain stopped early — results may be incomplete; narrow path, glob, or pattern");
    }
    return {
      content: [{ type: "text", text: notes.length ? `${text}\n\n[${notes.join("; ")}]` : text }],
      details: { engine: "fff", exhausted, filesSearched, truncated: !exhausted || limitReached },
    };
  };

  const rgSearch = async (
    input: SearchToolInput,
    scopePath: string,
    mode: "plain" | "regex",
    output: "lines" | "files" | "count",
    limit: number,
    context: number,
    reason: string | undefined,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    const request = {
      pattern: input.pattern,
      regex: mode === "regex",
      path: scopePath,
      glob: input.glob,
      context,
      ignoreCase: input.ignoreCase,
      output,
      limit,
      signal,
    };
    let regexFallback = false;
    const result = await runRg(request).catch((error: unknown) => {
      if (mode !== "regex" || !(error instanceof Error) || !error.message.includes("regex parse error")) throw error;
      regexFallback = true;
      return runRg({ ...request, regex: false });
    });
    const notes = [`engine: rg${reason ? ` (${reason})` : ""}`];
    if (regexFallback) notes.push("invalid regex — matched literally");
    if (result.limitReached) notes.push(`${limit} ${output === "lines" ? "matches" : "rows"} limit reached — refine the pattern or raise limit`);
    if (result.timedOut) notes.push("search timed out — results may be incomplete; narrow path, glob, or pattern");
    return {
      content: [{ type: "text", text: `${result.text}\n\n[${notes.join("; ")}]` }],
      details: { engine: "rg", truncated: result.limitReached || result.timedOut },
    };
  };

  const search: FffSearchHandle["search"] = async (input, workspaceRoot, signal) => {
    if (signal?.aborted) throw fffAbortError();
    const root = resolve(workspaceRoot);
    const denied = unsafeBasePathReason(root);
    if (denied) {
      throw new Error(`search does not index ${denied}; start Pi from a specific project directory`);
    }
    const scopePath = resolveSearchScopePath(input.path, root);
    const scopePrefix = scopePrefixOf(root, scopePath);
    const mode = input.mode ?? "plain";
    const output = input.output ?? "lines";
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const context = Math.min(Math.max(input.context ?? 0, 0), 20);

    const forcedInsensitive = input.ignoreCase === true && /[A-Z]/.test(input.pattern);
    const globNeedsRg = input.glob?.startsWith("!") ?? false;
    if (mode === "fuzzy" && (forcedInsensitive || globNeedsRg)) {
      throw new Error(
        "search mode=fuzzy requires the FFF index and does not support forced ignoreCase or negated globs",
      );
    }

    // Root-wide native grep can monopolize the event loop; rg streams from a
    // child process instead. Retain the index as a fallback when rg is absent.
    if (scopePrefix === "" && mode !== "fuzzy") {
      try {
        return await rgSearch(input, scopePath, mode, output, limit, context, "workspace-root search", signal);
      } catch (error) {
        if (forcedInsensitive || globNeedsRg || !(error instanceof Error)
          || !error.message.startsWith("ripgrep (rg) is not available")) throw error;
      }
    }

    const generation = lifecycleGeneration;
    let finder: FffFinder | undefined;
    let rgReason: string | undefined;
    if (mode === "fuzzy") {
      finder = await waitForFinder(root, signal);
    } else if (forcedInsensitive) {
      rgReason = "forced case-insensitive matching";
    } else if (globNeedsRg) {
      rgReason = "negated glob pattern";
    } else {
      try {
        finder = await waitForFinder(root, signal);
      } catch (error) {
        if (signal?.aborted) throw fffAbortError();
        if (generation !== lifecycleGeneration) throw error;
        rgReason = `index unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!finder) {
      return rgSearch(input, scopePath, mode === "regex" ? "regex" : "plain", output, limit, context, rgReason, signal);
    }
    try {
      return await fffSearch(finder, input, scopePrefix, mode, output, limit, context, signal);
    } catch (error) {
      if (signal?.aborted) throw fffAbortError();
      if (generation !== lifecycleGeneration || !finder.isDestroyed || mode === "fuzzy") throw error;
      await retireFinder(root, finder);
      if (generation !== lifecycleGeneration) throw error;
      return rgSearch(input, scopePath, mode, output, limit, context, "FFF worker unavailable", signal);
    }
  };

  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search workspace contents: scoped searches use the shared FFF index in an isolated child process; root-wide plain/regex searches use time-bounded ripgrep (rg) to avoid blocking on large indexes. Fuzzy matching requires the index. Supports literal/regex/fuzzy and lines/files/count output; does not invoke GNU grep. Specify path or glob for large projects. Prefer this over running grep or rg through bash.",
    promptSnippet: "Search contents (literal/regex/fuzzy); narrow path for large projects.",
    promptGuidelines: [
      "output=\"lines\" (default) returns file:line match text with optional context lines; output=\"files\" lists candidate paths before reading them; output=\"count\" shows per-file match totals to gauge how widespread a pattern is.",
      "mode=\"plain\" is literal substring matching for exact identifiers. mode=\"regex\" uses Rust regex syntax — look-around and backreferences are not supported; an invalid regex falls back to literal matching with a note. mode=\"fuzzy\" is approximate matching when the exact spelling is unknown.",
      "Omit ignoreCase for smart case (insensitive only when the pattern is all-lowercase); set true to force insensitivity or false for always-sensitive.",
      "path scopes to a directory or a single file inside the workspace; omit it only for intentional root-wide search (rg, with an 8-second scan budget). glob filters file names at any depth and supports '!' negation.",
      "Limited or timed-out results end with a bracketed note; narrow with a more specific pattern, path, or glob before raising limit. Root search may return partial results on timeout.",
      "Typical calls: {pattern: \"handleRequest\", output: \"files\"} to locate; {pattern: \"class \\w+Service\", mode: \"regex\", glob: \"*.ts\"} for typed patterns; {pattern: \"TODO\", ignoreCase: true, context: 2} for annotated hits; {pattern: \"getUsr\", mode: \"fuzzy\"} when the spelling is unknown.",
      "Use fffind for file-path search instead of content search.",
    ],
    parameters: SearchToolParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        const error = new Error("search aborted.");
        error.name = "AbortError";
        throw error;
      }
      return search(params, ctx.cwd, signal);
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      return toolCallLine(theme, "search", `"${String(args.pattern ?? "")}"`);
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      return toolResultLine(theme, {
        name: "search",
        ok: text !== "No matches found" && text.length > 0,
        arg: `"${String(ctx.args.pattern ?? "")}"`,
        summary: resultSummary(result),
        expanded: opts.expanded,
        detail: text,
      });
    },
  });

  pi.registerTool({
    name: "fffind",
    label: "Find",
    description:
      "Fuzzy file path search over the workspace index. For content search use `search`.",
    promptSnippet: "Fuzzy file path search via the workspace index.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, description: "Fuzzy file path fragment" }),
      path: Type.Optional(Type.String({ description: "Directory under the workspace to scope to" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max results (default: 50)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        const error = new Error("fffind aborted.");
        error.name = "AbortError";
        throw error;
      }
      const root = resolve(ctx.cwd);
      const scopePath = resolveSearchScopePath(params.path, root);
      const scopePrefix = scopePrefixOf(root, scopePath);
      const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), 200);
      const finder = await waitForFinder(root, signal);
      const items: FileItem[] = [];
      let exhausted = false;
      const pageSize = Math.min(Math.max(limit * 2, 50), 500);
      for (let pageIndex = 0; items.length < limit && pageIndex < MAX_DRAIN_PAGES; pageIndex += 1) {
        if (signal?.aborted) throw fffAbortError("fffind");
        const result = await awaitFffOperation(finder.fileSearch(params.pattern, { pageIndex, pageSize }), signal, "fffind");
        if (finder.isDestroyed) throw new Error("fffind index ended");
        if (!result.ok) {
          throw new Error(`fffind failed: ${result.error}`);
        }
        for (const item of result.value.items) {
          if (inScope(item.relativePath, scopePrefix)) items.push(item);
        }
        exhausted = result.value.items.length === 0 || (pageIndex + 1) * pageSize >= result.value.totalMatched;
        if (exhausted) break;
      }
      const rows = items.slice(0, limit).map((item) => item.relativePath);
      const limitReached = items.length > limit || (!exhausted && items.length >= limit);
      const text = rows.length ? rows.join("\n") : "No files found";
      const note = limitReached
        ? `${limit} files limit reached — refine the pattern or raise limit`
        : !exhausted ? "index drain stopped early — results may be incomplete; narrow path or pattern" : undefined;
      return {
        content: [{ type: "text", text: note ? `${text}\n\n[${note}]` : text }],
        details: { engine: "fff", exhausted, truncated: !exhausted || limitReached },
      };
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

  return { search };
}

async function awaitFffOperation<T>(operation: T | Promise<T>, signal?: AbortSignal, toolName = "search"): Promise<T> {
  const pending = Promise.resolve(operation);
  if (!signal) return pending;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(fffAbortError(toolName));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function fffAbortError(toolName = "search"): Error {
  const error = new Error(`${toolName} aborted.`);
  error.name = "AbortError";
  return error;
}
