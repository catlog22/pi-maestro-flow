import * as path from "node:path";
import { truncateHead, truncateLine, type TruncationResult } from "@earendil-works/pi-coding-agent";
import type { Diagnostic, Location } from "./types.ts";
import { uriToFile } from "./workspace-edit.ts";

export const LSP_DEFAULT_LIMIT = 50;
export const LSP_MAX_OUTPUT_BYTES = 16 * 1024;
export const LSP_AUTO_MAX_OUTPUT_BYTES = 4 * 1024;
const LSP_MAX_LINE_CHARS = 500;
const TRUNCATION_NOTICE_BYTES = 180;

export interface LspFormattedOutput {
  text: string;
  totalItems?: number;
  shownItems?: number;
  truncated: boolean;
  diagnosticCounts?: { errors: number; warnings: number; infos: number; hints: number };
}

interface ListOptions {
  cwd: string;
  limit?: number;
  offset?: number;
  maxBytes?: number;
}

interface DiagnosticOptions extends ListOptions {
  severities?: ReadonlySet<number>;
}

interface DiagnosticEntry {
  file: string;
  diagnostic: Diagnostic;
}

export function formatDiagnostics(
  file: string,
  diagnostics: Diagnostic[],
  options: DiagnosticOptions,
): LspFormattedOutput {
  return formatDiagnosticEntries(
    diagnostics.map((diagnostic) => ({ file, diagnostic })),
    options,
  );
}

export function formatWorkspaceDiagnostics(
  reports: unknown[],
  options: DiagnosticOptions,
): LspFormattedOutput {
  const entries = reports.flatMap((report) => collectWorkspaceDiagnostics(report));
  if (entries.length === 0) {
    return { text: "No workspace diagnostics reported.", totalItems: 0, shownItems: 0, truncated: false };
  }
  return formatDiagnosticEntries(entries, options);
}

export function formatLocations(locations: Location[], options: ListOptions): LspFormattedOutput {
  const items = dedupe(locations.map((location) => {
    const file = uriToFile(location.uri);
    return truncateLine(`${displayPath(file, options.cwd)}:${location.range.start.line + 1}:${location.range.start.character + 1}`, LSP_MAX_LINE_CHARS).text;
  }));
  return formatList(items, options, "No locations found");
}

export function formatSymbols(value: unknown, options: ListOptions): LspFormattedOutput {
  const items = dedupe(flattenSymbols(value, options.cwd));
  return formatList(items, options, "No symbols found");
}

export function formatItems(items: string[], options: ListOptions, emptyText: string): LspFormattedOutput {
  return formatList(dedupe(items.map((item) => truncateLine(item, LSP_MAX_LINE_CHARS).text)), options, emptyText);
}

export function formatJson(value: unknown, maxBytes = LSP_MAX_OUTPUT_BYTES): LspFormattedOutput {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  return boundText(serialized, maxBytes);
}

export function boundText(text: string, maxBytes = LSP_MAX_OUTPUT_BYTES): LspFormattedOutput {
  const truncation = truncateHead(text, { maxLines: 500, maxBytes: Math.max(1, maxBytes - TRUNCATION_NOTICE_BYTES) });
  if (!truncation.truncated) return { text, truncated: false };
  return {
    text: `${truncation.content}\n${truncationNotice(truncation)}`,
    truncated: true,
  };
}

function formatDiagnosticEntries(entries: DiagnosticEntry[], options: DiagnosticOptions): LspFormattedOutput {
  const normalized = dedupeDiagnostics(entries)
    .sort(compareDiagnostics);
  const severityCounts = countSeverities(normalized);
  const diagnosticCounts = diagnosticCountRecord(severityCounts);
  const visible = options.severities
    ? normalized.filter((entry) => options.severities!.has(entry.diagnostic.severity ?? 4))
    : normalized;
  const omittedBySeverity = normalized.length - visible.length;
  const header = diagnosticHeader(severityCounts, omittedBySeverity);
  if (visible.length === 0) {
    return { text: header, totalItems: normalized.length, shownItems: 0, truncated: false, diagnosticCounts };
  }

  const multipleFiles = new Set(visible.map((entry) => path.resolve(entry.file))).size > 1;
  const lines = visible.map(({ file, diagnostic }) => {
    const severity = severityName(diagnostic.severity);
    const code = diagnostic.code === undefined ? "" : ` ${String(diagnostic.code)}`;
    const location = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
    const prefix = multipleFiles ? `${displayPath(file, options.cwd)}:` : "";
    const message = truncateLine(normalizeMessage(diagnostic.message), LSP_MAX_LINE_CHARS).text;
    return `${prefix}${location} ${severity}${code} ${message}`;
  });
  const fileHeader = multipleFiles ? header : `${displayPath(visible[0]!.file, options.cwd)} — ${header}`;
  const formatted = formatList(lines, options, header, fileHeader, visible.length);
  return {
    ...formatted,
    totalItems: normalized.length,
    truncated: formatted.truncated || omittedBySeverity > 0,
    diagnosticCounts,
  };
}

function formatList(
  items: string[],
  options: ListOptions,
  emptyText: string,
  header?: string,
  totalOverride?: number,
): LspFormattedOutput {
  const total = totalOverride ?? items.length;
  if (items.length === 0) return { text: emptyText, totalItems: total, shownItems: 0, truncated: false };
  const offset = Math.min(Math.max(0, options.offset ?? 0), items.length);
  const limit = Math.max(1, options.limit ?? LSP_DEFAULT_LIMIT);
  const selected = items.slice(offset, offset + limit);
  if (selected.length === 0) {
    return {
      text: `No items at offset ${offset}; total ${total}.`,
      totalItems: total,
      shownItems: 0,
      truncated: false,
    };
  }
  const prefix = header ? `${header}\n` : "";
  const maxBytes = options.maxBytes ?? LSP_MAX_OUTPUT_BYTES;
  const truncation = truncateHead(`${prefix}${selected.join("\n")}`, {
    maxLines: selected.length + (header ? 1 : 0),
    maxBytes: Math.max(1, maxBytes - TRUNCATION_NOTICE_BYTES),
  });
  const headerLines = header && truncation.outputLines > 0 ? 1 : 0;
  const shown = Math.min(selected.length, Math.max(0, truncation.outputLines - headerLines));
  const hasMore = offset + shown < items.length || total > items.length;
  const truncated = truncation.truncated || hasMore;
  const nextOffset = offset + shown;
  const notice = truncated
    ? `\n[Showing ${shown} of ${total} item(s)${hasMore ? `; use offset=${nextOffset} to continue` : ""}.]`
    : "";
  return {
    text: `${truncation.content}${notice}`,
    totalItems: total,
    shownItems: shown,
    truncated,
  };
}

function collectWorkspaceDiagnostics(value: unknown, inheritedUri?: string): DiagnosticEntry[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectWorkspaceDiagnostics(item, inheritedUri));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const entries: DiagnosticEntry[] = [];
  const uri = typeof record.uri === "string" ? record.uri : inheritedUri;
  if (uri && Array.isArray(record.items)) {
    for (const item of record.items) {
      if (isDiagnostic(item)) entries.push({ file: uriToFile(uri), diagnostic: item });
      else entries.push(...collectWorkspaceDiagnostics(item, uri));
    }
  } else if (Array.isArray(record.items)) {
    entries.push(...record.items.flatMap((item) => collectWorkspaceDiagnostics(item)));
  }
  if (record.relatedDocuments && typeof record.relatedDocuments === "object") {
    for (const [relatedUri, report] of Object.entries(record.relatedDocuments as Record<string, unknown>)) {
      entries.push(...collectWorkspaceDiagnostics(report, relatedUri));
    }
  }
  return entries;
}

function flattenSymbols(value: unknown, cwd: string, depth = 0): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => flattenSymbols(item, cwd, depth));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const kind = typeof record.kind === "number" ? symbolKind(record.kind) : "symbol";
  const location = symbolLocation(record, cwd);
  const current = name
    ? [truncateLine(`${"  ".repeat(Math.min(depth, 4))}${kind} ${name}${location ? ` — ${location}` : ""}`, LSP_MAX_LINE_CHARS).text]
    : [];
  const children = Array.isArray(record.children)
    ? record.children.flatMap((child) => flattenSymbols(child, cwd, depth + 1))
    : [];
  return [...current, ...children];
}

function symbolLocation(record: Record<string, unknown>, cwd: string): string | undefined {
  const location = record.location && typeof record.location === "object"
    ? record.location as Record<string, unknown>
    : record;
  const uri = typeof location.uri === "string" ? location.uri : undefined;
  const range = location.range && typeof location.range === "object"
    ? location.range as { start?: { line?: unknown; character?: unknown } }
    : undefined;
  const line = range?.start?.line;
  const character = range?.start?.character;
  const point = typeof line === "number" && typeof character === "number" ? `${line + 1}:${character + 1}` : undefined;
  if (!uri) return point;
  return `${displayPath(uriToFile(uri), cwd)}${point ? `:${point}` : ""}`;
}

function dedupeDiagnostics(entries: DiagnosticEntry[]): DiagnosticEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ file, diagnostic }) => {
    const key = [
      path.resolve(file), diagnostic.range.start.line, diagnostic.range.start.character,
      diagnostic.severity ?? 4, diagnostic.code ?? "", normalizeMessage(diagnostic.message),
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareDiagnostics(left: DiagnosticEntry, right: DiagnosticEntry): number {
  return (left.diagnostic.severity ?? 4) - (right.diagnostic.severity ?? 4)
    || left.file.localeCompare(right.file)
    || left.diagnostic.range.start.line - right.diagnostic.range.start.line
    || left.diagnostic.range.start.character - right.diagnostic.range.start.character;
}

function countSeverities(entries: DiagnosticEntry[]): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const { diagnostic } of entries) counts[Math.min(4, Math.max(1, diagnostic.severity ?? 4)) - 1] += 1;
  return counts;
}

function diagnosticCountRecord([errors, warnings, infos, hints]: [number, number, number, number]): {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
} {
  return { errors, warnings, infos, hints };
}

function diagnosticHeader(counts: [number, number, number, number], omitted: number): string {
  const [errors, warnings, infos, hints] = counts;
  if (errors + warnings + infos + hints === 0) return "LSP: OK";
  const parts = [`${errors} error(s)`, `${warnings} warning(s)`];
  if (infos > 0) parts.push(`${infos} info`);
  if (hints > 0) parts.push(`${hints} hint(s)`);
  return `LSP: ${parts.join(", ")}${omitted > 0 ? `; ${omitted} lower-severity item(s) omitted` : ""}`;
}

function severityName(severity: number | undefined): string {
  const normalized = Math.min(4, Math.max(1, severity ?? 4));
  return (["", "error", "warning", "info", "hint"] as const)[normalized] ?? "hint";
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function displayPath(file: string, cwd: string): string {
  const relative = path.relative(path.resolve(cwd), path.resolve(file));
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.normalize(file);
}

function truncationNotice(truncation: TruncationResult): string {
  return `[Output truncated: ${truncation.outputLines}/${truncation.totalLines} line(s), ${truncation.outputBytes}/${truncation.totalBytes} byte(s).]`;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Diagnostic>;
  return typeof record.message === "string"
    && typeof record.range?.start?.line === "number"
    && typeof record.range?.start?.character === "number";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function symbolKind(kind: number): string {
  return ([
    "", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
    "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object",
    "key", "null", "enum-member", "struct", "event", "operator", "type-parameter",
  ][kind] ?? "symbol");
}
