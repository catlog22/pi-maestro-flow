import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, isAbsolute, relative, sep } from "node:path";
import { SearchText } from "./search-output.ts";

export type SearchOutputMode = "lines" | "files" | "count";

export interface RgSearchRequest {
  pattern: string;
  /** true = regex mode; false = literal (--fixed-strings). fuzzy never reaches rg. */
  regex: boolean;
  /** Absolute search root. */
  path: string;
  glob?: string;
  context: number;
  ignoreCase?: boolean;
  output: SearchOutputMode;
  limit: number;
  signal?: AbortSignal;
  /** Maximum wall time for the child process, including a root-wide traversal. */
  timeBudgetMs?: number;
}

export interface RgSearchResult {
  /** Bounded row preview; the search tool reserves space for final notices. */
  text: string;
  /** Bytes of observed rows before preview clipping (not unseen matches). */
  originalBytes?: number;
  /** true when collection stopped early because the limit was reached. */
  limitReached: boolean;
  timedOut?: boolean;
}

const RG_TIME_BUDGET_MS = 8_000;
const RG_MAX_FILESIZE = "10M";
const RG_BINARIES = ["rg", "rg.exe"];

/** Ripgrep-backed fallback for `search` when the FFF index is unavailable. */
export async function runRgSearch(request: RgSearchRequest): Promise<RgSearchResult> {
  const args = buildArgs(request);
  return collectRows(args, request);
}

/** Exported for tests: maps a search request to the ripgrep argv. */
export function buildArgs(request: RgSearchRequest): string[] {
  const args: string[] = ["--color=never", "--hidden", "--max-filesize", RG_MAX_FILESIZE];
  // Match the FFF engine's case semantics: undefined means smart case.
  if (request.ignoreCase === true) args.push("--ignore-case");
  else if (request.ignoreCase === undefined) args.push("--smart-case");
  if (!request.regex) args.push("--fixed-strings");
  if (request.glob) args.push("--glob", request.glob);
  if (request.output === "lines") {
    args.push("--json", "--line-number");
    if (request.context > 0) args.push("--context", String(request.context));
  } else if (request.output === "files") {
    args.push("--files-with-matches");
  } else {
    args.push("--count", "--with-filename");
  }
  args.push("--", request.pattern, request.path);
  return args;
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

async function collectRows(args: string[], request: RgSearchRequest): Promise<RgSearchResult> {
  const { signal } = request;
  if (signal?.aborted) throw rgAbortError();
  return new Promise<RgSearchResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let binaryIndex = 0;
    const trySpawn = (): void => {
      const child = spawn(RG_BINARIES[binaryIndex]!, args, { stdio: ["ignore", "pipe", "pipe"] });
      const rl = createInterface({ input: child.stdout });
      const rows = new SearchText();
      let stderr = "";
      let killedForLimit = false;
      let timedOut = false;
      let aborted = false;
      const cleanup = () => {
        clearTimeout(timer);
        rl.close();
        signal?.removeEventListener("abort", onAbort);
      };
      const killChild = (forLimit: boolean) => {
        killedForLimit ||= forLimit;
        if (!child.killed) child.kill();
      };
      const onAbort = () => {
        aborted = true;
        killChild(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killChild(false);
      }, request.timeBudgetMs ?? RG_TIME_BUDGET_MS);
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length);
      });
      let counted = 0;
      rl.on("line", (line) => {
        if (killedForLimit || timedOut || !line.trim()) return;
        const mapped = mapLine(line, request);
        if (!mapped) return;
        rows.push(mapped.row);
        if (mapped.countable) {
          counted += 1;
          if (counted >= request.limit) killChild(true);
        }
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        if (error.code === "ENOENT" && binaryIndex + 1 < RG_BINARIES.length) {
          binaryIndex += 1;
          trySpawn();
          return;
        }
        settle(() => rejectPromise(
          error.code === "ENOENT"
            ? new Error("ripgrep (rg) is not available on PATH; install ripgrep or restore the FFF index")
            : new Error(`Failed to run ripgrep: ${error.message}`),
        ));
      });
      child.on("close", (code) => {
        cleanup();
        if (aborted) {
          settle(() => rejectPromise(rgAbortError()));
          return;
        }
        if (!killedForLimit && !timedOut && code !== 0 && code !== 1) {
          settle(() => rejectPromise(new Error(stderr.trim() || `ripgrep exited with code ${code}`)));
          return;
        }
        settle(() => resolvePromise({
          text: rows.originalBytes ? rows.text : "No matches found",
          originalBytes: rows.originalBytes || Buffer.byteLength("No matches found", "utf8"),
          limitReached: killedForLimit,
          timedOut,
        }));
      });
    };
    trySpawn();
  });
}

interface MappedRow {
  row: string;
  /** Whether this row counts toward the limit (context lines do not). */
  countable: boolean;
}

function mapLine(line: string, request: RgSearchRequest): MappedRow | undefined {
  if (request.output === "lines") {
    let event: RgJsonEvent;
    try {
      event = JSON.parse(line) as RgJsonEvent;
    } catch {
      return undefined;
    }
    if (event.type !== "match" && event.type !== "context") return undefined;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const text = event.data?.lines?.text;
    if (!filePath || typeof lineNumber !== "number" || text === undefined) return undefined;
    const rel = relativePath(filePath, request.path);
    const clean = text.replace(/\r?\n$/, "");
    return event.type === "match"
      ? { row: `${rel}:${lineNumber}: ${clean}`, countable: true }
      : { row: `${rel}-${lineNumber}- ${clean}`, countable: false };
  }
  if (request.output === "count") {
    const match = /^(.*):(\d+)$/.exec(line);
    if (!match) return undefined;
    return { row: `${relativePath(match[1]!, request.path)}:${match[2]}`, countable: true };
  }
  return { row: relativePath(line, request.path), countable: true };
}

function relativePath(filePath: string, searchPath: string): string {
  const rel = isAbsolute(filePath) ? relative(searchPath, filePath) : filePath;
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  return basename(filePath);
}

function rgAbortError(): Error {
  const error = new Error("search aborted.");
  error.name = "AbortError";
  return error;
}
