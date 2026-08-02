// Content-type detection, ported from headroom transforms/content_detector.py
// (Apache-2.0). Detects tool-output shape (JSON / diff / HTML / search / log /
// tabular / config / code) so the lossless folder can pick the most effective
// algorithm instead of relying on the tool name alone. Pure stdlib, never throws.

export type DetectedContentType =
  | "json_array" | "source_code" | "search" | "build" | "diff"
  | "html" | "tabular" | "structured_config" | "text";

export interface DetectionResult {
  contentType: DetectedContentType;
  confidence: number;
  metadata: Record<string, unknown>;
}

const SEARCH_RESULT_PATTERN = /^[^\s:]+:\d+:/;
const MD_SEP_CELL = /^:?-{2,}:?$/;
const DIFF_HEADER_PATTERN = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/;
const DIFF_CHANGE_PATTERN = /^[+-][^+-]/;
const LOG_PATTERNS: RegExp[] = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /^npm ERR!|^yarn error|^cargo error/,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/,
  /^\s*at\s+[\w.$/]+\(/,
  /^\s*at async \S/,
  /^(panic|fatal error): /,
  /^goroutine \d+ \[/,
  /^\t\S+\.go:\d+ \+0x/,
  /^thread '[^']*' panicked at/,
  /^stack backtrace:/,
  /^\s+\d+: \S/,
  /^\s+at \S+:\d+:\d+$/,
  /^Unhandled exception\./,
  /^\s*at .+\) in .+:line \d+/,
  /^Caused by: /,
  /^\s*\.\.\. \d+ more$/,
];
const HTML_DOCTYPE_PATTERN = /^\s*<!doctype\s+html/i;
const HTML_TAG_PATTERN = /<html[\s>]/i;
const HTML_HEAD_PATTERN = /<head[\s>]/i;
const HTML_BODY_PATTERN = /<body[\s>]/i;
const HTML_STRUCTURAL_TAGS = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi;
const CONFIG_SECTION_RE = /^\s*\[\[?[\w.\-"' ]+\]\]?\s*$/;
const TOML_ASSIGN_RE = /^\s*(?:[\w.\-]+|"[^"]+"|'[^']+')\s*=\s*\S/;
const INI_ASSIGN_RE = /^\s*[\w.\-@ ]+?\s*[=:]\s*/;
const YAML_KEY_RE = /^\s*(?:-\s+)?(?:[\w.\-/]+|"[^"]+"|'[^']+')\s*:(?:\s|$)/;
const YAML_LIST_RE = /^\s*-\s+\S/;
const YAML_DOC_RE = /^---\s*$|^\.\.\.\s*$/;
const CONFIG_COMMENT_RE = /^\s*[#;]/;
const CODE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /^\s*(def|class|import|from|async def)\s+\w+/,
    /^\s*@\w+/,
    /^\s*"""/,
    /^\s*if __name__\s*==/,
  ],
  javascript: [
    /^\s*(function|const|let|var|class|import|export)\s+/,
    /^\s*(async\s+function|=>\s*\{)/,
    /^\s*module\.exports/,
  ],
  typescript: [
    /^\s*(interface|type|enum|namespace)\s+\w+/,
    /:\s*(string|number|boolean|any|void)\b/,
  ],
  go: [
    /^\s*(func|type|package|import)\s+/,
    /^\s*func\s+\([^)]+\)\s+\w+/,
  ],
  rust: [
    /^\s*(fn|struct|enum|impl|mod|use|pub)\s+/,
    /^\s*#\[/,
  ],
  java: [
    /^\s*(public|private|protected)\s+(class|interface|enum)/,
    /^\s*@\w+/,
    /^\s*package\s+[\w.]+;/,
  ],
  csharp: [
    /^\s*using\s+[\w.]+\s*;/,
    /^\s*namespace\s+[\w.]+/,
    /^\s*(public|private|protected|internal|sealed|static|abstract|partial)\s+(class|struct|record|interface|enum)\b/,
    /^.*\b(get|set|init);/,
  ],
  php: [
    /<\?php\b/,
    /^\s*namespace\s+[\w\\]+\s*;/,
    /^\s*use\s+[\w\\]+(\s+as\s+\w+)?\s*;/,
    /^\s*(public|private|protected|static|abstract|final)?\s*function\s+\w+\s*\(/,
    /\$this->/,
  ],
};

const JSON_MIN_BULK_FRACTION = 0.6;

function decodeConcatenatedJson(content: string): unknown[] | null {
  const items: unknown[] = [];
  let index = 0;
  const length = content.length;
  while (index < length) {
    while (index < length && /\s/.test(content[index])) index++;
    if (index >= length) break;
    const parsed = parseJsonAt(content, index);
    if (parsed === undefined) return null;
    items.push(parsed.value);
    index = parsed.end;
  }
  return items.length > 0 ? items : null;
}

/** Parse one JSON value at `start`; returns { value, end } or undefined. */
function parseJsonAt(content: string, start: number): { value: unknown; end: number } | undefined {
  // Walk to the end of the first top-level value (string-aware brace balance),
  // then verify it with the real parser.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < content.length; index++) {
    const ch = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  try {
    return { value: JSON.parse(content.slice(start, end)) as unknown, end };
  } catch {
    return undefined;
  }
}

function tryDetectJson(content: string): DetectionResult | null {
  const stripped = content.trim();
  if (!stripped) return null;
  let value: unknown;
  try {
    value = JSON.parse(stripped) as unknown;
  } catch {
    if (stripped.startsWith("{")) {
      const items = decodeConcatenatedJson(stripped);
      if (items && items.length >= 2 && items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
        return { contentType: "json_array", confidence: 1, metadata: { concatenated: true, itemCount: items.length } };
      }
    }
    const start = Math.min(
      ...[stripped.indexOf("{"), stripped.indexOf("[")].filter((i) => i >= 0),
    );
    if (Number.isNaN(start) || start < 0) return null;
    // Conservative wrapped-JSON acceptance: parse the suffix, require the
    // leading whitespace wrapper to be a small fraction of the payload.
    const probe = parseJsonAt(stripped, start);
    if (probe === undefined) return null;
    if (start > stripped.length * (1 - JSON_MIN_BULK_FRACTION)) return null;
    value = probe.value;
    if (!(typeof value === "object" && value !== null)) return null;
    return {
      contentType: "json_array",
      confidence: Array.isArray(value) ? 0.9 : 0.85,
      metadata: { wrapped: true },
    };
  }
  if (!(typeof value === "object" && value !== null)) return null;
  const isArray = Array.isArray(value);
  return {
    contentType: "json_array",
    confidence: isArray ? 1 : 0.9,
    metadata: { isArray, isObject: !isArray },
  };
}

function tryDetectDiff(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 500);
  let headerMatches = 0;
  let changeMatches = 0;
  for (const line of lines) {
    if (DIFF_HEADER_PATTERN.test(line)) headerMatches++;
    if (DIFF_CHANGE_PATTERN.test(line)) changeMatches++;
  }
  if (headerMatches === 0) return null;
  const confidence = Math.min(1, 0.5 + headerMatches * 0.2 + changeMatches * 0.05);
  return { contentType: "diff", confidence, metadata: { headerMatches, changeLines: changeMatches } };
}

function tryDetectHtml(content: string): DetectionResult | null {
  const sample = content.slice(0, 3000);
  const hasDoctype = HTML_DOCTYPE_PATTERN.test(sample);
  const hasHtmlTag = HTML_TAG_PATTERN.test(sample);
  const hasHead = HTML_HEAD_PATTERN.test(sample);
  const hasBody = HTML_BODY_PATTERN.test(sample);
  const structuralMatches = (sample.match(HTML_STRUCTURAL_TAGS) ?? []).length;
  if (!hasDoctype && !hasHtmlTag && structuralMatches < 3) return null;
  let confidence = 0;
  if (hasDoctype) confidence += 0.5;
  if (hasHtmlTag) confidence += 0.3;
  if (hasHead) confidence += 0.1;
  if (hasBody) confidence += 0.1;
  confidence += Math.min(0.3, structuralMatches * 0.03);
  confidence = Math.min(1, confidence);
  if (confidence < 0.5) return null;
  return { contentType: "html", confidence, metadata: { structuralTags: structuralMatches } };
}

function tryDetectSearch(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100);
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return null;
  const matching = nonEmpty.filter((line) => SEARCH_RESULT_PATTERN.test(line)).length;
  const ratio = matching / nonEmpty.length;
  if (ratio < 0.3) return null;
  return {
    contentType: "search",
    confidence: Math.min(1, 0.4 + ratio * 0.6),
    metadata: { matchingLines: matching, totalLines: nonEmpty.length },
  };
}

function tryDetectLog(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 200);
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return null;
  let patternMatches = 0;
  let errorMatches = 0;
  for (const line of nonEmpty) {
    for (let index = 0; index < LOG_PATTERNS.length; index++) {
      if (LOG_PATTERNS[index].test(line)) {
        patternMatches++;
        if (index < 2) errorMatches++;
        break;
      }
    }
  }
  const ratio = patternMatches / nonEmpty.length;
  if (ratio < 0.1) return null;
  return {
    contentType: "build",
    confidence: Math.min(1, 0.3 + ratio * 0.5 + errorMatches * 0.05),
    metadata: { patternMatches, errorMatches, totalLines: nonEmpty.length },
  };
}

function mdCellCount(row: string): number {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
}

function isMdSeparator(row: string): boolean {
  const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  if (cells.length < 2) return false;
  return cells.every((cell) => MD_SEP_CELL.test(cell));
}

function tryDetectMarkdownTable(lines: string[]): DetectionResult | null {
  for (let index = 0; index < lines.length - 1; index++) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (header.includes("|") && isMdSeparator(separator)) {
      const columns = mdCellCount(header);
      if (columns >= 2) {
        return { contentType: "tabular", confidence: 0.95, metadata: { format: "markdown", columns } };
      }
    }
  }
  return null;
}

function looksLikeProse(sample: string[], delim: string): boolean {
  const enders = sample.filter((row) => row.trimEnd().match(/[.!?]$/)).length;
  if (enders / sample.length >= 0.5) return true;
  const cells = sample.flatMap((row) => row.split(delim));
  const avgWords = cells.reduce((sum, cell) => sum + cell.trim().split(/\s+/).filter(Boolean).length, 0)
    / Math.max(cells.length, 1);
  return avgWords > 3;
}

function tryDetectDelimited(lines: string[]): DetectionResult | null {
  const sample = lines.slice(0, 20);
  if (sample.length < 3) return null;
  let best: DetectionResult | null = null;
  const delimiters: Array<[string, number]> = [[",", 0.85], ["\t", 0.7], [";", 0.85], ["|", 0.85]];
  for (const [delim, minConsistency] of delimiters) {
    const counts = sample.map((row) => row.split(delim).length - 1);
    if (counts[0] === 0) continue;
    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    const [commonCount, freq] = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0];
    if (commonCount === 0) continue;
    const consistency = freq / sample.length;
    const columns = commonCount + 1;
    if (columns < 2 || consistency < minConsistency) continue;
    if (looksLikeProse(sample, delim)) continue;
    const confidence = Math.min(0.95, 0.5 + consistency * 0.3 + Math.min(columns, 5) * 0.03);
    if (best === null || confidence > best.confidence) {
      best = { contentType: "tabular", confidence, metadata: { format: "csv", delimiter: delim, columns } };
    }
  }
  return best;
}

function tryDetectTabular(content: string): DetectionResult | null {
  const lines = content.split("\n").filter((line) => line.trim() !== "").slice(0, 50);
  if (lines.length < 3) return null;
  return tryDetectMarkdownTable(lines) ?? tryDetectDelimited(lines);
}

function tryDetectStructuredConfig(content: string): DetectionResult | null {
  const head = content.trimStart().slice(0, 1);
  if (!head || head === "{" || head === "<") return null;
  const lines = content.split("\n").slice(0, 200);
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length < 3) return null;
  const body = nonEmpty.filter((line) => !CONFIG_COMMENT_RE.test(line));
  if (body.length < 3) return null;

  const sections = body.filter((line) => CONFIG_SECTION_RE.test(line)).length;
  if (sections >= 1) {
    const assigns = body.filter((line) => TOML_ASSIGN_RE.test(line) || INI_ASSIGN_RE.test(line)).length;
    if (assigns >= 2 && (sections + assigns) / body.length >= 0.6) {
      const share = (sections + assigns) / body.length;
      return {
        contentType: "structured_config",
        confidence: Math.min(0.95, 0.7 + share * 0.25),
        metadata: { flavor: "toml-ini", sections, assignments: assigns },
      };
    }
  }

  const yamlKeys = body.filter((line) => YAML_KEY_RE.test(line)).length;
  const yamlLists = body.filter((line) => YAML_LIST_RE.test(line) && !YAML_KEY_RE.test(line)).length;
  const docMarks = body.filter((line) => YAML_DOC_RE.test(line.trim())).length;
  if (yamlKeys < 3) return null;
  const share = (yamlKeys + yamlLists + docMarks) / body.length;
  if (share < 0.6) return null;
  const enders = body.filter((line) => /[.!?]$/.test(line.trimEnd())).length;
  if (enders / body.length >= 0.5) return null;
  const avgWords = body.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0) / body.length;
  if (avgWords > 8) return null;
  return {
    contentType: "structured_config",
    confidence: Math.min(0.9, 0.55 + share * 0.35),
    metadata: { flavor: "yaml", keys: yamlKeys, listItems: yamlLists },
  };
}

function tryDetectCode(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100);
  const scores = new Map<string, number>();
  for (const line of lines) {
    for (const [language, patterns] of Object.entries(CODE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          scores.set(language, (scores.get(language) ?? 0) + 1);
          break;
        }
      }
    }
  }
  if (scores.size === 0) return null;
  let bestLanguage = "";
  let bestScore = 0;
  for (const [language, score] of scores) {
    if (score > bestScore) {
      bestLanguage = language;
      bestScore = score;
    }
  }
  if (bestScore < 3) return null;
  const nonEmpty = lines.filter((line) => line.trim() !== "").length;
  const ratio = bestScore / Math.max(nonEmpty, 1);
  return {
    contentType: "source_code",
    confidence: Math.min(1, 0.4 + ratio * 0.4 + bestScore * 0.02),
    metadata: { language: bestLanguage, patternMatches: bestScore },
  };
}

/**
 * Detect the content type of tool output, mirroring upstream's priority order
 * (JSON > diff > HTML > search > log > tabular > config > code > text).
 */
export function detectContentType(content: string): DetectionResult {
  if (!content || !content.trim()) {
    return { contentType: "text", confidence: 0, metadata: {} };
  }
  const jsonResult = tryDetectJson(content);
  if (jsonResult) return jsonResult;
  const diffResult = tryDetectDiff(content);
  if (diffResult && diffResult.confidence >= 0.7) return diffResult;
  const htmlResult = tryDetectHtml(content);
  if (htmlResult && htmlResult.confidence >= 0.7) return htmlResult;
  const searchResult = tryDetectSearch(content);
  if (searchResult && searchResult.confidence >= 0.6) return searchResult;
  const logResult = tryDetectLog(content);
  if (logResult && logResult.confidence >= 0.5) return logResult;
  const tabularResult = tryDetectTabular(content);
  if (tabularResult && tabularResult.confidence >= 0.6) return tabularResult;
  const configResult = tryDetectStructuredConfig(content);
  if (configResult && configResult.confidence >= 0.6) return configResult;
  const codeResult = tryDetectCode(content);
  if (codeResult && codeResult.confidence >= 0.5) return codeResult;
  return { contentType: "text", confidence: 0.5, metadata: {} };
}
