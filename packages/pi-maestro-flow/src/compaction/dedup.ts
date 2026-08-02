// Cross-turn verbatim de-duplication, ported from headroom
// transforms/cross_turn_dedup.py (Apache-2.0).
//
// Bash agents re-display the same bytes across turns (cat -> sed -n -> git
// diff -> cat again). A later tool output whose contiguous span already
// appeared verbatim in an earlier tool output is replaced by an in-context
// pointer naming the earlier output (kept physically present, keep-earliest).
//
// Invariants preserved from the upstream design:
// 1. PREFIX-MONOTONICITY (cache safety): a block is only ever matched against
//    strictly earlier blocks, so appending a turn never mutates earlier bytes.
// 2. IN-WINDOW ACCURACY: only verbatim spans are folded and the earliest
//    occurrence is never rewritten, so the pointer's original is always
//    physically present earlier in the same request.
// 3. Never raises: any failure returns the input unchanged.

export const DEFAULT_DEDUP_MIN_LINES = 3;
export const DEFAULT_DEDUP_MIN_CHARS = 40;
const MAX_ANCHOR_CANDIDATES = 16;

/** One tool-output block. `callId` is the stable identity used in pointers. */
export interface DedupBlock {
  text: string;
  callId: string;
  /** Never rewritten, but still indexed as a reference target. */
  protected?: boolean;
}

export interface DedupResult {
  blocks: DedupBlock[];
  /** folded callId -> referenced callId (the in-context original). */
  refs: Map<string, string>;
  stats: { spansFolded: number; linesRemoved: number; charsRemoved: number };
}

const LINENO_PATTERN = /^([1-9]\d*)(:|\t)(.*)$/;

/** Split a leading unpadded line-number: (number, matchKey, content). */
function numAndKey(line: string): [number | null, string, string] {
  const m = LINENO_PATTERN.exec(line);
  if (m === null) return [null, line, line];
  return [Number(m[1]), m[2] + m[3], m[3]];
}

function isTrivial(line: string): boolean {
  const s = line.trim();
  if (s.length < 4) return true;
  return new Set([
    "return", "pass", "else:", "try:", "except:", "finally:", "break", "continue",
    "});", "})", "],", "),", '"""', "'''", "...",
  ]).has(s);
}

function pointerText(span: string[], refCallId: string, delta: number): string {
  const anchorLine = span.find((line) => line.trim() !== "");
  let anchor = anchorLine === undefined ? "" : numAndKey(anchorLine)[2].trim();
  if (anchor.length > 20) anchor = `${anchor.slice(0, 17)}...`;
  if (delta !== 0) {
    return `[↑${span.length}L same as msg ${refCallId} ${delta > 0 ? "+" : ""}${delta}L: ${anchor}]`;
  }
  return `[↑${span.length}L same as msg ${refCallId}: ${anchor}]`;
}

function indexLines(
  lines: Array<string | null>,
  blockPos: number,
  anchorIndex: Map<string, Array<[number, number]>>,
): void {
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line === null) continue;
    const [, key, content] = numAndKey(line);
    if (isTrivial(content)) continue;
    const bucket = anchorIndex.get(key);
    if (bucket === undefined) {
      anchorIndex.set(key, [[blockPos, li]]);
    } else if (bucket.length < MAX_ANCHOR_CANDIDATES) {
      bucket.push([blockPos, li]);
    }
  }
}

interface Match {
  length: number;
  blockPos: number;
  lineIdx: number;
  delta: number;
}

function longestMatch(
  current: string[],
  start: number,
  anchorIndex: Map<string, Array<[number, number]>>,
  corpus: Array<Array<string | null>>,
): Match | null {
  const [anchorKey] = [numAndKey(current[start])[1]];
  const candidates = anchorIndex.get(anchorKey);
  if (candidates === undefined) return null;
  let best: Match | null = null;
  for (const [bp, li] of candidates) {
    const blockLines = corpus[bp];
    let k = 0;
    let delta: number | null = null;
    while (start + k < current.length && li + k < blockLines.length) {
      const ca = current[start + k];
      const cb = blockLines[li + k];
      if (cb === null) break;
      const [na, ka] = numAndKey(ca);
      const [nb, kb] = numAndKey(cb);
      if (ka !== kb) break;
      if (na !== null && nb !== null) {
        const d = na - nb;
        if (delta === null) delta = d;
        else if (delta !== d) break;
      } else if (ca !== cb) {
        break;
      }
      k++;
    }
    if (k > 0 && (best === null || k > best.length)) {
      best = { length: k, blockPos: bp, lineIdx: li, delta: delta ?? 0 };
    }
  }
  return best;
}

/**
 * Rewrite later verbatim spans to in-context pointers. Prefix-monotonic and
 * information-preserving. Never raises.
 */
export function dedupBlocks(
  blocks: DedupBlock[],
  options: { minLines?: number; minChars?: number } = {},
): DedupResult {
  const minLines = options.minLines ?? DEFAULT_DEDUP_MIN_LINES;
  const minChars = options.minChars ?? DEFAULT_DEDUP_MIN_CHARS;
  const stats = { spansFolded: 0, linesRemoved: 0, charsRemoved: 0 };
  try {
    const corpus: Array<Array<string | null>> = [];
    const anchorIndex = new Map<string, Array<[number, number]>>();
    const outBlocks: DedupBlock[] = [];
    const refs = new Map<string, string>();

    for (const block of blocks) {
      const lines = block.text.split("\n");

      if (block.protected === true) {
        const verbatim: Array<string | null> = [...lines];
        indexLines(verbatim, corpus.length, anchorIndex);
        corpus.push(verbatim);
        outBlocks.push(block);
        continue;
      }

      const out: string[] = [];
      const verbatim: Array<string | null> = [];
      let i = 0;
      while (i < lines.length) {
        const m = longestMatch(lines, i, anchorIndex, corpus);
        if (m !== null && m.length >= minLines) {
          const span = lines.slice(i, i + m.length);
          const spanText = span.join("\n");
          if (spanText.length >= minChars) {
            const refCallId = blocks[m.blockPos].callId;
            const ptr = pointerText(span, refCallId, m.delta);
            out.push(ptr);
            for (let n = 0; n < m.length; n++) verbatim.push(null);
            stats.spansFolded++;
            stats.linesRemoved += m.length;
            stats.charsRemoved += spanText.length - ptr.length;
            refs.set(block.callId, refCallId);
            i += m.length;
            continue;
          }
        }
        out.push(lines[i]);
        verbatim.push(lines[i]);
        i++;
      }

      indexLines(verbatim, corpus.length, anchorIndex);
      corpus.push(verbatim);
      outBlocks.push({ text: out.join("\n"), callId: block.callId });
    }

    return { blocks: outBlocks, refs, stats };
  } catch {
    return { blocks, refs: new Map(), stats: { spansFolded: 0, linesRemoved: 0, charsRemoved: 0 } };
  }
}

/** CACHE-SAFETY invariant: dedup of any prefix equals the full result truncated. */
export function isPrefixMonotonic(blocks: DedupBlock[], options: { minLines?: number; minChars?: number } = {}): boolean {
  const full = dedupBlocks(blocks, options).blocks.map((b) => b.text);
  for (let k = 1; k <= blocks.length; k++) {
    const partial = dedupBlocks(blocks.slice(0, k), options).blocks.map((b) => b.text);
    for (let index = 0; index < k; index++) {
      if (partial[index] !== full[index]) return false;
    }
  }
  return true;
}
