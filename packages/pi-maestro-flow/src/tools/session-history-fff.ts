import type { GrepCursor, GrepMatch, InitOptions, Result } from "@ff-labs/fff-node";
import { awaitFffTeardown, createFffProcessFinder, type CreateFffFinder, type FffFinder } from "./fff-process.ts";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  MAX_SESSION_HISTORY_FILES,
  type SessionHistoryInventoryEntry,
} from "pi-maestro-teammate/v1/session-history";

/** Keep native initialization bounded; session history always has a safe fallback. */
export const SESSION_HISTORY_FFF_SCAN_TIMEOUT_MS = 5_000;
/** Per-query wall-clock budget. The raw and encoded forms each get one budget. */
export const SESSION_HISTORY_FFF_SEARCH_TIME_BUDGET_MS = 500;
/** One matching line per file is enough to identify a candidate transcript. */
export const SESSION_HISTORY_FFF_PAGE_SIZE = MAX_SESSION_HISTORY_FILES;
/** Prevent a broken/native cursor from causing an unbounded loop. */
export const SESSION_HISTORY_FFF_MAX_PAGES = 32;

const NATIVE_GREP_DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export type SessionHistoryFffDiagnostic =
  | "session-directory-unavailable"
  | "destroyed"
  | "initialization-failed"
  | "scan-timeout"
  | "scan-failed"
  | "search-failed";

/** The only host state the accelerator needs; no model-provided path is used. */
export interface SessionHistoryFffHostContext {
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
  };
}

export interface SessionHistoryFffSearchResult {
  /** False means callers must use the bounded inventory implementation. */
  available: boolean;
  /** False means candidate discovery may have omitted matching files. */
  complete: boolean;
  entries: readonly SessionHistoryInventoryEntry[];
  diagnostic?: SessionHistoryFffDiagnostic;
}

export interface SessionHistoryFffCandidateAccelerator {
  search(
    query: string,
    ctx: SessionHistoryFffHostContext,
    signal?: AbortSignal,
  ): Promise<SessionHistoryFffSearchResult>;
  destroy(): void | Promise<void>;
}

export interface SessionHistoryFffOptions {
  createFinder?: CreateFffFinder;
  scanTimeoutMs?: number;
  searchTimeBudgetMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** Test clock; production uses Date.now. */
  now?: () => number;
}

interface Candidate {
  path: string;
  fileName: string;
  modified: number;
}

interface FinderState {
  finder: FffFinder;
  basePath: string;
}

/**
 * Resolve the host-selected current transcript and derive its exact containing
 * directory. This mirrors the host inventory's relative-path handling but is
 * kept local so the FFF module has no runtime dependency on the tool module.
 */
export function sessionHistoryWorkspaceDirectory(
  ctx: SessionHistoryFffHostContext,
): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionFile?.();
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const cwd = typeof ctx.cwd === "string" && ctx.cwd.trim().length > 0
      ? ctx.cwd
      : process.cwd();
    return dirname(resolve(cwd, value));
  } catch {
    return undefined;
  }
}

function sessionHistoryWorkspaceFile(
  ctx: SessionHistoryFffHostContext,
): string | undefined {
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

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function directChildJsonlPath(directory: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  let candidate: string;
  try {
    candidate = resolve(value);
  } catch {
    return undefined;
  }
  const fileName = basename(candidate);
  if (!fileName.endsWith(".jsonl") || !samePath(dirname(candidate), directory)) return undefined;
  return candidate;
}

/**
 * Defense in depth for injected accelerators: only direct-child `.jsonl`
 * entries under the host-selected directory can reach SessionHistoryService.
 * Metadata is intentionally discarded; the service re-stats and re-reads files.
 */
export function authorizeSessionHistoryFffCandidates(
  ctx: SessionHistoryFffHostContext,
  entries: readonly SessionHistoryInventoryEntry[],
): readonly SessionHistoryInventoryEntry[] {
  const directory = sessionHistoryWorkspaceDirectory(ctx);
  if (!directory) return [];
  const result: SessionHistoryInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = directChildJsonlPath(directory, entry?.path);
    if (!candidate) continue;
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path: candidate, fileName: basename(candidate) });
  }
  return Object.freeze(result);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Session history FFF search aborted.");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  checkAbort(signal);
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}

function resultError(result: Result<unknown>): string {
  return result.ok ? "" : result.error;
}

function candidateFromMatch(basePath: string, match: Pick<GrepMatch, "relativePath" | "modified">): Candidate | undefined {
  if (!match || typeof match.relativePath !== "string") return undefined;
  // FFF paths are base-relative. Reject all separators (including the other
  // platform's separator) so only a direct child can be admitted.
  const relativePath = match.relativePath;
  if (relativePath.length === 0 || isAbsolute(relativePath)
    || /[\\/\u0000-\u001f\u007f]/.test(relativePath)
    || !relativePath.endsWith(".jsonl")) return undefined;
  const path = resolve(basePath, relativePath);
  const fileName = basename(path);
  if (fileName !== relativePath || !fileName.endsWith(".jsonl")
    || !samePath(dirname(path), basePath)) return undefined;
  const modified = typeof match.modified === "number" && Number.isFinite(match.modified)
    ? match.modified
    : 0;
  return { path, fileName, modified };
}

function compareCandidates(left: Candidate, right: Candidate, activeFileName: string): number {
  const leftActive = samePath(left.fileName, activeFileName);
  const rightActive = samePath(right.fileName, activeFileName);
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  if (left.modified !== right.modified) return right.modified - left.modified;
  return left.fileName.localeCompare(right.fileName, "en");
}

function availableResult(
  entries: readonly SessionHistoryInventoryEntry[],
  complete: boolean,
): SessionHistoryFffSearchResult {
  return { available: true, complete, entries: Object.freeze([...entries]) };
}

function unavailableResult(diagnostic: SessionHistoryFffDiagnostic): SessionHistoryFffSearchResult {
  return { available: false, complete: false, entries: Object.freeze([]), diagnostic };
}

/**
 * Create the lazy, single-finder FFF candidate accelerator used by
 * `session_history` workspace searches. It never returns FFF line text: only
 * validated candidate paths are passed to SessionHistoryService.
 */
export function createSessionHistoryFffAccelerator(
  options: SessionHistoryFffOptions = {},
): SessionHistoryFffCandidateAccelerator {
  const createFinder = options.createFinder ?? createFffProcessFinder;
  const scanTimeoutMs = Math.min(
    boundedPositive(options.scanTimeoutMs, SESSION_HISTORY_FFF_SCAN_TIMEOUT_MS),
    SESSION_HISTORY_FFF_SCAN_TIMEOUT_MS,
  );
  const searchTimeBudgetMs = Math.min(
    boundedPositive(options.searchTimeBudgetMs, SESSION_HISTORY_FFF_SEARCH_TIME_BUDGET_MS),
    SESSION_HISTORY_FFF_SEARCH_TIME_BUDGET_MS,
  );
  const pageSize = Math.min(
    boundedPositive(options.pageSize, SESSION_HISTORY_FFF_PAGE_SIZE),
    SESSION_HISTORY_FFF_PAGE_SIZE,
  );
  const maxPages = Math.min(
    boundedPositive(options.maxPages, SESSION_HISTORY_FFF_MAX_PAGES),
    SESSION_HISTORY_FFF_MAX_PAGES,
  );
  const now = options.now ?? Date.now;

  let state: FinderState | undefined;
  let initializing: Promise<FffFinder> | undefined;
  let initializingBasePath: string | undefined;
  const ownedFinders = new Set<FffFinder>();
  const pendingScans = new Set<Promise<FffFinder>>();
  let generation = 0;
  let destroyed = false;
  let failedBasePath: string | undefined;

  const retireFinder = async (finder: FffFinder): Promise<void> => {
    await finder.destroy();
    await finder.closed;
    ownedFinders.delete(finder);
  };
  const ensureFinder = async (basePath: string, signal?: AbortSignal): Promise<FffFinder> => {
    checkAbort(signal);
    if (destroyed) throw new Error("FFF accelerator destroyed.");
    if (state && !state.finder.isDestroyed && samePath(state.basePath, basePath)) return state.finder;
    if (failedBasePath && samePath(failedBasePath, basePath)) {
      throw new Error("FFF initialization previously failed.");
    }
    if (initializing && initializingBasePath && samePath(initializingBasePath, basePath)) {
      return await awaitAbortable(initializing, signal);
    }
    const requestedGeneration = ++generation;
    state = undefined;
    const assertOwner = (): void => {
      if (requestedGeneration !== generation || destroyed) throw new Error("FFF accelerator was destroyed.");
    };
    const task = Promise.resolve().then(async (): Promise<FffFinder> => {
      assertOwner();
      // Never overlap an old worker with its replacement, even after a failed kill.
      for (const previous of ownedFinders) {
        await retireFinder(previous);
        assertOwner();
      }
      let finder: FffFinder | undefined;
      try {
        const created = createFinder({ basePath, aiMode: true } satisfies InitOptions);
        if (!created.ok) {
          failedBasePath = basePath;
          throw new Error(resultError(created));
        }
        finder = created.value;
        ownedFinders.add(finder);
        if (finder.closed) {
          const owned = finder;
          void finder.closed.then(() => ownedFinders.delete(owned));
        }
        // Keep the shared initialization independent of caller cancellation.
        const scanned = await finder.waitForScan(scanTimeoutMs);
        assertOwner();
        if (finder.isDestroyed) throw new Error("FFF worker stopped.");
        if (!scanned.ok || !scanned.value) {
          failedBasePath = basePath;
          throw new Error(scanned.ok ? "FFF initial scan timed out." : `FFF initial scan failed: ${scanned.error}`);
        }
        state = { finder, basePath };
        return finder;
      } catch (error) {
        if (requestedGeneration === generation && !destroyed && finder && !finder.isDestroyed) {
          failedBasePath = basePath;
        }
        if (finder) await retireFinder(finder);
        throw error;
      }
    }).finally(() => {
      pendingScans.delete(task);
      if (initializing === task) {
        initializing = undefined;
        initializingBasePath = undefined;
      }
    });
    pendingScans.add(task);
    initializing = task;
    initializingBasePath = basePath;
    return await awaitAbortable(task, signal);
  };

  const search = async (
    query: string,
    ctx: SessionHistoryFffHostContext,
    signal?: AbortSignal,
  ): Promise<SessionHistoryFffSearchResult> => {
    checkAbort(signal);
    if (destroyed) return unavailableResult("destroyed");
    const basePath = sessionHistoryWorkspaceDirectory(ctx);
    const activeFile = sessionHistoryWorkspaceFile(ctx);
    if (!basePath || !activeFile) return unavailableResult("session-directory-unavailable");
    const activeFileName = basename(activeFile);

    let finder: FffFinder;
    try {
      finder = await ensureFinder(basePath, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic: SessionHistoryFffDiagnostic = message.includes("timed out")
        ? "scan-timeout"
        : message.includes("initial scan failed") ? "scan-failed" : "initialization-failed";
      return unavailableResult(diagnostic);
    }

    const candidates = new Map<string, Candidate>();
    const seen = new Set<string>();
    let complete = true;
    let overflow = false;
    const encodedQuery = JSON.stringify(query).slice(1, -1);
    const queries = encodedQuery === query ? [query] : [query, encodedQuery];
    const addCandidate = (match: Pick<GrepMatch, "relativePath" | "modified">): void => {
      const candidate = candidateFromMatch(basePath, match);
      if (!candidate) return;
      const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
      if (seen.has(key)) {
        const existing = candidates.get(key);
        if (existing && candidate.modified > existing.modified) candidates.set(key, candidate);
        return;
      }
      seen.add(key);
      if (candidates.size < MAX_SESSION_HISTORY_FILES) {
        candidates.set(key, candidate);
      } else {
        overflow = true;
        const worst = [...candidates.entries()].sort((left, right) =>
          compareCandidates(right[1], left[1], activeFileName))[0];
        if (worst && compareCandidates(candidate, worst[1], activeFileName) < 0) {
          candidates.delete(worst[0]);
          candidates.set(key, candidate);
        }
      }
    };

    try {
      // Native content filtering can omit large files despite maxFileSize.
      // Discover them by metadata and let SessionHistoryService search them.
      const deadline = now() + searchTimeBudgetMs;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        checkAbort(signal);
        if (now() >= deadline) { complete = false; break; }
        const files = await awaitAbortable(Promise.resolve(finder.glob("*.jsonl", { pageIndex, pageSize })), signal);
        if (destroyed || finder.isDestroyed) throw new Error("FFF accelerator was destroyed.");
        if (!files.ok) throw new Error(files.error);
        for (const file of files.value.items) {
          if (file.size > NATIVE_GREP_DEFAULT_MAX_FILE_BYTES) addCandidate(file);
        }
        if ((pageIndex + 1) * pageSize >= files.value.totalMatched) break;
        if (pageIndex + 1 === maxPages) complete = false;
      }
      for (const form of queries) {
        checkAbort(signal);
        const deadline = now() + searchTimeBudgetMs;
        let cursor: GrepCursor | null = null;
        let pages = 0;
        while (true) {
          checkAbort(signal);
          const remaining = deadline - now();
          if (remaining <= 0 || pages >= maxPages) {
            complete = false;
            break;
          }
          pages += 1;
          const result: Awaited<ReturnType<FffFinder["grep"]>> = await awaitAbortable(Promise.resolve(finder.grep(form, {
            mode: "plain",
            smartCase: false,
            // The native U64 parameter cannot represent Infinity.
            maxFileSize: Number.MAX_SAFE_INTEGER,
            maxMatchesPerFile: 1,
            pageSize,
            timeBudgetMs: Math.max(1, Math.min(searchTimeBudgetMs, Math.floor(remaining))),
            cursor,
            beforeContext: 0,
            afterContext: 0,
            classifyDefinitions: false,
          })), signal);
          if (destroyed || finder.isDestroyed) throw new Error("FFF accelerator was destroyed.");
          if (!result.ok) throw new Error(result.error);
          for (const match of result.value.items) addCandidate(match);
          cursor = result.value.nextCursor;
          if (!cursor) break;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      return unavailableResult("search-failed");
    }

    const entries = [...candidates.values()]
      .sort((left, right) => compareCandidates(left, right, activeFileName))
      .slice(0, MAX_SESSION_HISTORY_FILES)
      .map(({ path, fileName }) => ({ path, fileName }));
    return availableResult(
      authorizeSessionHistoryFffCandidates(ctx, entries),
      complete && !overflow,
    );
  };

  return {
    search,
    async destroy(): Promise<void> {
      destroyed = true;
      generation += 1;
      const scans = [...pendingScans];
      state = undefined;
      initializing = undefined;
      initializingBasePath = undefined;
      failedBasePath = undefined;
      await awaitFffTeardown([...ownedFinders].map(retireFinder), scans);
    },
  };
}
