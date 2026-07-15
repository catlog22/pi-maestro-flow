import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import { lspManager } from "./manager.ts";
import { formatDiagnostics, LSP_AUTO_MAX_OUTPUT_BYTES, type LspFormattedOutput } from "./output.ts";
import type { LspManagerLike } from "./types.ts";

const EDIT_TOOL_NAMES = new Set(["edit", "write"]);
const AUTO_DIAGNOSTIC_TIMEOUT_MS = 2_500;
const AUTO_DIAGNOSTIC_WAIT_MS = 1_000;
const AUTO_DIAGNOSTIC_DEBOUNCE_MS = 75;
const AUTO_DIAGNOSTIC_LIMIT = 20;
const AUTO_DIAGNOSTIC_SEVERITIES = new Set([1, 2]);

type ToolResultContent = ToolResultEvent["content"];
type AutoDiagnosticResult = { content: ToolResultContent } | undefined;

interface AutoDiagnosticOptions {
  timeoutMs?: number;
  waitMs?: number;
  debounceMs?: number;
}

export function registerLspAutoDiagnostics(pi: ExtensionAPI): void {
  pi.on("tool_result", createLspAutoDiagnosticsHandler());
}

export function createLspAutoDiagnosticsHandler(
  manager: LspManagerLike = lspManager,
  options: AutoDiagnosticOptions = {},
): (event: ToolResultEvent, ctx: ExtensionContext) => Promise<AutoDiagnosticResult> {
  const generations = new Map<string, number>();
  const reportedFailures = new Set<string>();
  const lastNotificationByFile = new Map<string, string>();
  const timeoutMs = options.timeoutMs ?? AUTO_DIAGNOSTIC_TIMEOUT_MS;
  const waitMs = options.waitMs ?? AUTO_DIAGNOSTIC_WAIT_MS;
  const debounceMs = options.debounceMs ?? AUTO_DIAGNOSTIC_DEBOUNCE_MS;

  return async (event, ctx) => {
    const editedFile = editedFileFromEvent(event, ctx.cwd);
    if (!editedFile) return undefined;

    const generation = (generations.get(editedFile) ?? 0) + 1;
    generations.set(editedFile, generation);
    const timeout = withTimeout(ctx.signal, timeoutMs);
    try {
      await delay(debounceMs, timeout.signal);
      if (generations.get(editedFile) !== generation) return undefined;

      const client = await manager.clientForFile(editedFile, ctx.cwd, undefined, timeout.signal, timeoutMs);
      const uri = await client.ensureFileOpen(editedFile);
      client.notify("textDocument/didSave", { textDocument: { uri } });
      const diagnostics = await client.getDiagnostics(uri, Math.min(waitMs, timeoutMs), timeout.signal);
      if (generations.get(editedFile) !== generation) return undefined;

      const formatted = formatDiagnostics(editedFile, diagnostics, {
        cwd: ctx.cwd,
        limit: AUTO_DIAGNOSTIC_LIMIT,
        maxBytes: LSP_AUTO_MAX_OUTPUT_BYTES,
        severities: AUTO_DIAGNOSTIC_SEVERITIES,
      });
      notifyDiagnosticResult(ctx, editedFile, formatted, lastNotificationByFile);
      return appendText(event.content, formatted.text);
    } catch (error) {
      if (isAbortError(error) || timeout.signal.aborted) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (/No language server is configured/i.test(message)) return undefined;
      const failureKey = `${editedFile}\0${message}`;
      if (reportedFailures.has(failureKey)) return undefined;
      reportedFailures.add(failureKey);
      const unavailable = `LSP check unavailable: ${truncateLine(message.replace(/\s+/g, " "), 240).text}`;
      ctx.ui.notify(unavailable, "warning");
      return appendText(event.content, unavailable);
    } finally {
      if (generations.get(editedFile) === generation) generations.delete(editedFile);
      timeout.dispose();
    }
  };
}

function notifyDiagnosticResult(
  ctx: ExtensionContext,
  file: string,
  formatted: LspFormattedOutput,
  lastNotificationByFile: Map<string, string>,
): void {
  const counts = formatted.diagnosticCounts ?? { errors: 0, warnings: 0, infos: 0, hints: 0 };
  const display = displayPath(file, ctx.cwd);
  const parts: string[] = [];
  if (counts.errors > 0) parts.push(`${counts.errors} error(s)`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} warning(s)`);
  if (counts.infos > 0) parts.push(`${counts.infos} info`);
  if (counts.hints > 0) parts.push(`${counts.hints} hint(s)`);
  const message = `LSP ${display}: ${parts.join(", ") || "OK"}`;
  const notificationKey = `${message}\0${formatted.text}`;
  if (lastNotificationByFile.get(file) === notificationKey) return;
  lastNotificationByFile.set(file, notificationKey);
  ctx.ui.notify(message, counts.errors > 0 ? "error" : counts.warnings > 0 ? "warning" : "info");
}

function displayPath(file: string, cwd: string): string {
  const relative = path.relative(path.resolve(cwd), path.resolve(file));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : path.normalize(file);
}

function editedFileFromEvent(event: ToolResultEvent, cwd: string): string | undefined {
  if (event.isError || !EDIT_TOOL_NAMES.has(event.toolName)) return undefined;
  const mutationPath = fileMutationPath(event.details);
  const inputPath = typeof event.input.path === "string"
    ? event.input.path.trim()
    : typeof event.input.file_path === "string" ? event.input.file_path.trim() : "";
  const candidate = mutationPath ?? inputPath;
  return candidate ? path.resolve(cwd, candidate) : undefined;
}

function fileMutationPath(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const mutation = (details as { fileMutation?: unknown }).fileMutation;
  if (!mutation || typeof mutation !== "object") return undefined;
  const candidate = (mutation as { path?: unknown }).path;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function appendText(content: ToolResultContent, text: string): { content: ToolResultContent } {
  return { content: [...content, { type: "text", text }] };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return signal.aborted ? Promise.reject(abortError()) : Promise.resolve();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function abortError(): Error {
  const error = new Error("LSP automatic diagnostics aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
