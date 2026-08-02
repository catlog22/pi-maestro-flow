/**
 * Format-native, reversible lossless compaction.
 *
 * Algorithm ported from headroom `lossless_compaction.py` (Apache-2.0,
 * https://github.com/chopratejas/headroom). Kept dependency-free and
 * byte-faithful to the original: every transform ships with an exact inverse,
 * and `compactLossless` self-checks the round-trip at runtime — if the inverse
 * does not reproduce the original (modulo intentionally-dropped non-semantic
 * bits such as ANSI color) or the result is not actually smaller, the original
 * content is returned unchanged. Nothing here throws.
 *
 * Output keeps *looking like its own type*: grep stays grep, logs stay logs,
 * diffs stay diffs. No retrieval marker is ever emitted, so the model needs no
 * decode step.
 */

/** Kinds dispatched by `compactLossless`. */
export type LosslessKind = "log" | "search" | "paths" | "diff" | "text" | "config";

// ANSI CSI SGR (color/style) escape sequences: ESC [ ... m. Color is
// non-semantic, so stripping it is a safe (one-way) lossless-of-meaning op.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

// syslog-style run-collapse marker. The count is captured for exact inversion.
const RUN_MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/;

// multi-line block back-reference marker. Length and distance (both in lines,
// in ORIGINAL coordinates) are captured for exact inversion.
const BLOCK_MARKER_RE = /^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/;

// foldRepeatedBlocks search bounds: minimum/maximum block length worth a
// marker, candidate anchors per line, and an input size cap so the scan stays
// negligible on huge payloads.
const FOLD_MIN_BLOCK = 3;
const FOLD_MAX_BLOCK = 64;
const FOLD_MAX_CANDIDATES = 8;
const FOLD_MAX_LINES = 20_000;

// grep/ripgrep default row shape: `path:line:content`.
const GREP_ROW_RE = /^(?<path>[^\n:]+):(?<line>\d+):(?<content>.*)$/;
// heading-form data row (`line:content`) produced by searchHeading.
const HEADING_ROW_RE = /^(?<line>\d+):(?<content>.*)$/;
// dir-heading data row: `<base>:<line>:<content>` where base has no '/'
// (the `/` inside the char class is escaped — regex literal).
const DIR_DATA_RE = /^(?<base>[^\/\n:]+):(?<line>\d+):(?<content>.*)$/;
// whole-line file path: optional ./../ root, >=1 directory segment, basename.
const PATH_ROW_RE = /^(?<dir>(?:\.{0,2}\/)?(?:[^\/\s:]+\/)+)(?<base>[^\/\s:]+)$/;

// unified-diff `index <sha>..<sha> <mode>` line — bookkeeping only, git does
// not need it to apply the diff.
const DIFF_INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+( [0-7]+)?$/;

function splitKeepTrailing(text: string): { lines: string[]; hadTrailing: boolean } {
  if (text === "") return { lines: [], hadTrailing: false };
  const hadTrailing = text.endsWith("\n");
  const body = hadTrailing ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), hadTrailing };
}

function joinLines(lines: string[], hadTrailing: boolean): string {
  const out = lines.join("\n");
  return hadTrailing ? out + "\n" : out;
}

/** Remove ANSI CSI/SGR (color) escape sequences. Color is non-semantic. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Collapse runs of >=2 identical consecutive lines (syslog convention). */
export function collapseRuns(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    const runLength = j - i + 1;
    if (runLength >= 2) {
      out.push(lines[i]!);
      out.push(`... (repeated ${runLength} times)`);
    } else {
      out.push(lines[i]!);
    }
    i = j + 1;
  }
  return joinLines(out, hadTrailing);
}

/** Exact inverse of `collapseRuns`. */
export function expandRuns(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (i + 1 < lines.length) {
      const m = RUN_MARKER_RE.exec(lines[i + 1]!);
      if (m) {
        const count = Number(m[1]);
        for (let k = 0; k < count; k++) out.push(line);
        i += 2;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return joinLines(out, hadTrailing);
}

/** True if any run-collapse marker line is present. */
export function isRunCollapsed(text: string): boolean {
  for (const line of text.split("\n")) {
    if (RUN_MARKER_RE.test(line)) return true;
  }
  return false;
}

function rememberLine(positions: Map<string, number[]>, line: string, index: number): void {
  const bucket = positions.get(line);
  if (bucket === undefined) {
    positions.set(line, [index]);
  } else {
    bucket.push(index);
    if (bucket.length > FOLD_MAX_CANDIDATES) bucket.shift();
  }
}

/**
 * Collapse multi-line blocks that repeat earlier content into back-refs —
 * the block-level generalization of `collapseRuns`: a run of K consecutive
 * lines (K >= 3) that exactly reproduces K lines seen D lines earlier becomes
 * `... (repeats K lines from D lines back)`. Exact inverse:
 * `unfoldRepeatedBlocks`.
 */
export function foldRepeatedBlocks(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  const n = lines.length;
  if (n < FOLD_MIN_BLOCK * 2 || n > FOLD_MAX_LINES) return text;
  const positions = new Map<string, number[]>();
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    const bucket = positions.get(lines[i]!);
    if (bucket !== undefined) {
      for (let q = bucket.length - 1; q >= 0; q--) {
        const anchor = bucket[q]!;
        const maxLen = Math.min(FOLD_MAX_BLOCK, n - i, i - anchor);
        let length = 0;
        while (length < maxLen && lines[anchor + length] === lines[i + length]) length++;
        if (length > bestLen) {
          bestLen = length;
          bestDist = i - anchor;
        }
      }
    }
    if (bestLen >= FOLD_MIN_BLOCK) {
      const marker = `... (repeats ${bestLen} lines from ${bestDist} lines back)`;
      let blockChars = 0;
      for (let k = 0; k < bestLen; k++) blockChars += lines[i + k]!.length + 1;
      if (blockChars > marker.length + 1) {
        out.push(marker);
        for (let k = 0; k < bestLen; k++) rememberLine(positions, lines[i + k]!, i + k);
        i += bestLen;
        continue;
      }
    }
    rememberLine(positions, lines[i]!, i);
    out.push(lines[i]!);
    i += 1;
  }
  return joinLines(out, hadTrailing);
}

/** Exact inverse of `foldRepeatedBlocks`. */
export function unfoldRepeatedBlocks(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  for (const line of lines) {
    const m = BLOCK_MARKER_RE.exec(line);
    if (m) {
      const length = Number(m[1]);
      const dist = Number(m[2]);
      const start = out.length - dist;
      if (start >= 0 && length <= dist) {
        for (let k = 0; k < length; k++) out.push(out[start + k]!);
        continue;
      }
    }
    out.push(line);
  }
  return joinLines(out, hadTrailing);
}

/**
 * Convert grep `path:line:content` rows into ripgrep --heading form: a
 * repeated path becomes a header line once, then `line:content` rows beneath.
 * Exactly reversible via `searchUnheading`.
 */
export function searchHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let currentPath: string | undefined;
  for (const line of lines) {
    const m = GREP_ROW_RE.exec(line);
    if (m) {
      const path = m.groups!.path;
      if (path !== currentPath) {
        out.push(path);
        currentPath = path;
      }
      out.push(`${m.groups!.line}:${m.groups!.content}`);
    } else {
      out.push(line);
      currentPath = undefined;
    }
  }
  return joinLines(out, hadTrailing);
}

/** Exact inverse of `searchHeading`. */
export function searchUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let currentPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const data = HEADING_ROW_RE.exec(line);
    if (currentPath !== undefined && data) {
      out.push(`${currentPath}:${data.groups!.line}:${data.groups!.content}`);
      i += 1;
      continue;
    }
    if (!data && i + 1 < lines.length && HEADING_ROW_RE.test(lines[i + 1]!)) {
      currentPath = line;
      i += 1;
      continue;
    }
    currentPath = undefined;
    out.push(line);
    i += 1;
  }
  return joinLines(out, hadTrailing);
}

/**
 * Fold grep `path:line:content` rows by DIRECTORY: consecutive rows whose path
 * shares a parent directory collapse to that directory once (a header ending
 * in `/`), then `base:line:content` rows beneath. Complements `searchHeading`
 * (factors a repeated FILE) with the common `grep -rn` case of one match per
 * file. Exactly reversed by `searchDirUnheading`.
 */
export function searchDirHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let currentDir: string | undefined;
  for (const line of lines) {
    const m = GREP_ROW_RE.exec(line);
    if (m && m.groups!.path.includes("/")) {
      const path = m.groups!.path;
      const cut = path.lastIndexOf("/") + 1;
      const dirPart = path.slice(0, cut);
      const base = path.slice(cut);
      if (dirPart !== currentDir) {
        out.push(dirPart);
        currentDir = dirPart;
      }
      out.push(`${base}:${m.groups!.line}:${m.groups!.content}`);
    } else {
      out.push(line);
      currentDir = undefined;
    }
  }
  return joinLines(out, hadTrailing);
}

/** Exact inverse of `searchDirHeading`. */
export function searchDirUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let currentDir: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const data = DIR_DATA_RE.exec(line);
    if (currentDir !== undefined && data) {
      out.push(`${currentDir}${line}`);
      i += 1;
      continue;
    }
    if (line.endsWith("/") && i + 1 < lines.length && DIR_DATA_RE.test(lines[i + 1]!)) {
      currentDir = line;
      i += 1;
      continue;
    }
    currentDir = undefined;
    out.push(line);
    i += 1;
  }
  return joinLines(out, hadTrailing);
}

/**
 * Fold a pure file-path listing (`find` / `ls -1` / `rg -l` output) into
 * ripgrep-heading form: each parent directory printed once (ending in `/`),
 * then bare basenames beneath. Reversibility is not assumed — `compactLossless`
 * verifies the exact round-trip and discards the fold on any mismatch.
 */
export function pathHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.filter((ln) => PATH_ROW_RE.test(ln)).length < 2) return text;
  const out: string[] = [];
  let current: string | undefined;
  for (const line of lines) {
    const m = PATH_ROW_RE.exec(line);
    if (m) {
      const dir = m.groups!.dir;
      if (dir !== current) {
        out.push(dir);
        current = dir;
      }
      out.push(m.groups!.base);
    } else {
      out.push(line);
      current = undefined;
    }
  }
  return joinLines(out, hadTrailing);
}

/** Exact inverse of `pathHeading`. */
export function pathUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const isBase = line !== "" && !line.includes("/");
    if (current !== undefined && isBase) {
      out.push(current + line);
      i += 1;
      continue;
    }
    if (line.endsWith("/") && i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1]!.includes("/")) {
      current = line;
      i += 1;
      continue;
    }
    current = undefined;
    out.push(line);
    i += 1;
  }
  return joinLines(out, hadTrailing);
}

/** Drop `index <sha>..<sha>` lines from a unified diff (still applies). */
export function diffStripIndex(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text);
  if (lines.length === 0) return text;
  return joinLines(lines.filter((line) => !DIFF_INDEX_RE.test(line)), hadTrailing);
}

/**
 * Dispatch format-native lossless compaction by `kind`. For reversible kinds
 * the round-trip is verified internally (modulo the intentionally-dropped
 * non-semantic bits, e.g. ANSI color for logs); if verification fails or the
 * result is not smaller, the original content is returned unchanged. Never
 * throws; unknown kinds pass through.
 */
export function compactLossless(content: string, kind: LosslessKind): string {
  if (!content) return content;
  try {
    if (kind === "log") {
      // ANSI is non-semantic and dropped one-way; run-collapse must be
      // exactly reversible against the de-ANSI'd baseline.
      const baseline = stripAnsi(content);
      const candidate = collapseRuns(baseline);
      if (expandRuns(candidate) !== baseline) return content;
      return candidate.length < content.length ? candidate : content;
    }

    if (kind === "search") {
      // Two independent folds; keep the smaller that round-trips exactly.
      let best = content;
      const folds: Array<[string, (t: string) => string]> = [
        [searchHeading(content), searchUnheading],
        [searchDirHeading(content), searchDirUnheading],
      ];
      for (const [candidate, inverse] of folds) {
        if (inverse(candidate) === content && candidate.length < best.length) best = candidate;
      }
      return best;
    }

    if (kind === "paths") {
      const candidate = pathHeading(content);
      if (pathUnheading(candidate) !== content) return content;
      return candidate.length < content.length ? candidate : content;
    }

    if (kind === "diff") {
      // Purely subtractive of non-semantic bookkeeping lines; the remaining
      // hunks still apply. No exact inverse needed.
      const candidate = diffStripIndex(content);
      return candidate.length < content.length ? candidate : content;
    }

    if (kind === "text") {
      const candidate = collapseRuns(content);
      if (expandRuns(candidate) !== content) return content;
      return candidate.length < content.length ? candidate : content;
    }

    if (kind === "config") {
      // Structured config (YAML/TOML/INI): single-line runs first, then
      // repeated multi-line stanzas. Inverse applies in reverse order.
      const candidate = foldRepeatedBlocks(collapseRuns(content));
      if (expandRuns(unfoldRepeatedBlocks(candidate)) !== content) return content;
      return candidate.length < content.length ? candidate : content;
    }
  } catch {
    return content;
  }
  return content;
}

/** True when `compactLossless` would emit a strictly smaller string. */
export function hasLosslessGain(content: string, kind: LosslessKind): boolean {
  return compactLossless(content, kind).length < content.length;
}
