import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { lspManager } from "./lsp/manager.ts";
import type {
  Location,
  LocationLink,
  LspClientLike,
  LspManagerLike,
  Position,
  Range,
  WorkspaceEdit,
} from "./lsp/types.ts";
import {
  boundText,
  formatDiagnostics,
  formatItems,
  formatJson,
  formatLocations,
  formatSymbols,
  formatWorkspaceDiagnostics,
  type LspFormattedOutput,
} from "./lsp/output.ts";
import { applyWorkspaceEdit, previewWorkspaceEdit } from "./lsp/workspace-edit.ts";

export const LSP_ACTIONS = [
  "diagnostics", "definition", "references", "hover", "symbols", "rename", "rename_file",
  "code_actions", "type_definition", "implementation", "status", "reload", "capabilities", "request",
] as const;

export const LSP_READ_ONLY_ACTIONS = new Set([
  "diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities",
]);

const LspActionSchema = Type.Unsafe<(typeof LSP_ACTIONS)[number]>({ type: "string", enum: [...LSP_ACTIONS] });

export const LspParams = Type.Object({
  action: LspActionSchema,
  file: Type.Optional(Type.String({ description: "File path, or * for workspace diagnostics/symbols/reload" })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line number" })),
  symbol: Type.Optional(Type.String({ description: "Symbol on the target line; supports name#N occurrence" })),
  query: Type.Optional(Type.String({ description: "Workspace symbol query, code-action selector, or raw LSP method" })),
  new_name: Type.Optional(Type.String({ description: "New symbol name or destination path" })),
  apply: Type.Optional(Type.Boolean({ description: "Apply returned edits instead of previewing/listing" })),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "Timeout in seconds; clamped to 5..60" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum result items to return; defaults to 50" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Result offset for continuing a truncated list" })),
  payload: Type.Optional(Type.String({ description: "JSON payload for action=request" })),
});

export interface LspToolDetails {
  action: (typeof LSP_ACTIONS)[number];
  success: boolean;
  serverName?: string;
  request: Record<string, unknown>;
  output?: { totalItems?: number; shownItems?: number; truncated: boolean };
}

export function createLspTool(manager: LspManagerLike = lspManager): ToolDefinition<typeof LspParams, LspToolDetails> {
  return {
    name: "lsp",
    label: "LSP",
    description: "Query language servers for diagnostics, definitions, references, hover, symbols, renames, code actions, capabilities, reloads, and raw requests.",
    promptSnippet: "Use lsp for semantic code navigation, diagnostics, and language-aware refactoring.",
    promptGuidelines: [
      "Use 1-indexed line numbers and provide symbol when a line contains multiple relevant identifiers.",
      "Use apply=false to preview rename or code-action edits before applying them.",
      "Use limit and offset to page through large diagnostics, symbol, reference, or code-action results.",
    ],
    parameters: LspParams,
    executionMode: "sequential",
    async execute(_id, params, callerSignal, _onUpdate, ctx): Promise<AgentToolResult<LspToolDetails>> {
      const timeoutMs = Math.min(60, Math.max(5, params.timeout ?? 20)) * 1_000;
      const timeout = withTimeout(callerSignal, timeoutMs);
      try {
        return await executeLspAction(manager, params, ctx.cwd, timeout.signal, timeoutMs);
      } catch (error) {
        if (timeout.signal.aborted && (callerSignal?.aborted || isAbortError(error))) throw abortError();
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        timeout.dispose();
      }
    },
  };
}

async function executeLspAction(
  manager: LspManagerLike,
  params: Static<typeof LspParams>,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AgentToolResult<LspToolDetails>> {
  const { action } = params;
  if (action === "status") {
    const statuses = await manager.status(cwd);
    return result(params, statuses.map((item) => `${item.name}: ${item.state} (${item.command}) @ ${item.root}${item.error ? ` — ${item.error}` : ""}`).join("\n") || "No language servers configured.", true);
  }
  if (action === "reload") {
    await manager.reload();
    return result(params, "LSP configuration and client processes reloaded.", true);
  }
  if (action === "capabilities") {
    const clients = params.file && params.file !== "*"
      ? [await manager.clientForFile(resolveFile(cwd, params.file), cwd, undefined, signal, timeoutMs)]
      : await manager.clientsForWorkspace(cwd, signal, timeoutMs);
    return result(params, boundText(clients.map((client) => `${client.config.name}:\n${JSON.stringify(client.capabilities, null, 2)}`).join("\n\n")), true, clients.map((client) => client.config.name).join(", "));
  }
  if (action === "request") {
    if (!params.query?.trim()) return result(params, "Error: action=request requires query with the LSP method name.", false);
    const client = await resolveClient(manager, params.file, cwd, signal, timeoutMs);
    const payload = params.payload ? parsePayload(params.payload) : await automaticRequestPayload(client, params, cwd);
    const response = await client.request(params.query.trim(), payload, signal, timeoutMs);
    return result(params, formatJson(response), true, client.config.name);
  }
  if (action === "symbols" && (!params.file || params.file === "*")) {
    if (!params.query?.trim()) return result(params, "Error: workspace symbols require query.", false);
    const clients = await manager.clientsForWorkspace(cwd, signal, timeoutMs);
    const settled = await Promise.allSettled(clients.map((client) => client.request("workspace/symbol", { query: params.query }, signal, timeoutMs)));
    const symbols = settled.flatMap((item) => item.status === "fulfilled" && Array.isArray(item.value) ? item.value : []);
    return result(params, symbols.length > 0
      ? formatSymbols(symbols, listOptions(cwd, params))
      : `No symbols matching "${params.query}"`, true, clients.map((client) => client.config.name).join(", "));
  }
  if (action === "diagnostics" && params.file === "*") {
    const clients = await manager.clientsForWorkspace(cwd, signal, timeoutMs);
    const settled = await Promise.allSettled(clients.map((client) => client.request("workspace/diagnostic", { previousResultIds: [] }, signal, timeoutMs)));
    const reports = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    return result(params, reports.length > 0
      ? formatWorkspaceDiagnostics(reports, listOptions(cwd, params))
      : "No workspace diagnostics reported.", true, clients.map((client) => client.config.name).join(", "));
  }
  if (action === "rename_file") return executeRenameFile(manager, params, cwd, signal, timeoutMs);

  if (!params.file || params.file === "*") return result(params, `Error: action=${action} requires a concrete file path.`, false);
  const file = resolveFile(cwd, params.file);
  const client = await manager.clientForFile(file, cwd, undefined, signal, timeoutMs);
  const uri = await client.ensureFileOpen(file);

  if (action === "diagnostics") {
    const diagnostics = await client.getDiagnostics(uri, Math.min(timeoutMs, 2_000), signal);
    return result(params, formatDiagnostics(file, diagnostics, listOptions(cwd, params)), true, client.config.name);
  }
  if (action === "symbols") {
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, signal, timeoutMs);
    return result(params, symbols && Array.isArray(symbols) && symbols.length > 0
      ? formatSymbols(symbols, listOptions(cwd, params))
      : `No symbols found in ${file}`, true, client.config.name);
  }

  const position = await resolvePosition(file, params.line ?? 1, params.symbol);
  const textDocumentPosition = { textDocument: { uri }, position };
  if (action === "definition" || action === "type_definition" || action === "implementation") {
    const method = action === "definition" ? "textDocument/definition" : action === "type_definition" ? "textDocument/typeDefinition" : "textDocument/implementation";
    const locations = normalizeLocations(await client.request(method, textDocumentPosition, signal, timeoutMs));
    return result(params, locations.length > 0 ? formatLocations(locations, listOptions(cwd, params)) : `No ${action.replace("_", " ")} found`, true, client.config.name);
  }
  if (action === "references") {
    const locations = normalizeLocations(await client.request("textDocument/references", { ...textDocumentPosition, context: { includeDeclaration: true } }, signal, timeoutMs));
    return result(params, locations.length > 0 ? formatLocations(locations, listOptions(cwd, params)) : "No references found", true, client.config.name);
  }
  if (action === "hover") {
    const hover = await client.request("textDocument/hover", textDocumentPosition, signal, timeoutMs);
    return result(params, boundText(flattenHover(hover) || "No hover information"), true, client.config.name);
  }
  if (action === "rename") {
    if (!params.new_name?.trim()) return result(params, "Error: action=rename requires new_name.", false, client.config.name);
    const edit = await client.request("textDocument/rename", { ...textDocumentPosition, newName: params.new_name }, signal, timeoutMs) as WorkspaceEdit | null;
    if (!edit) return result(params, "Rename returned no edits", true, client.config.name);
    if (params.apply === false) return result(params, `Rename preview:\n${previewWorkspaceEdit(edit)}`, true, client.config.name);
    const applied = await applyWorkspaceEdit(edit, cwd);
    return result(params, `Applied rename:\n${applied.operations.join("\n")}`, true, client.config.name);
  }
  if (action === "code_actions") {
    const diagnostics = await client.getDiagnostics(uri, 200, signal);
    const pointRange: Range = { start: position, end: position };
    const raw = await client.request("textDocument/codeAction", { textDocument: { uri }, range: pointRange, context: { diagnostics } }, signal, timeoutMs);
    const actions = Array.isArray(raw) ? raw as CodeAction[] : [];
    if (params.apply !== true) return result(params, actions.length > 0
      ? formatItems(actions.map((item, index) => `${index + 1}. ${item.title}`), listOptions(cwd, params), "No code actions found")
      : "No code actions found", true, client.config.name);
    if (!params.query?.trim()) return result(params, "Error: query is required when apply=true for code_actions.", false, client.config.name);
    let selected = actions.find((item) => item.title.toLowerCase().includes(params.query!.toLowerCase()));
    if (!selected) return result(params, `No code action matching "${params.query}"`, false, client.config.name);
    if (!selected.edit && selected.data !== undefined) {
      selected = await client.request("codeAction/resolve", selected, signal, timeoutMs) as CodeAction;
    }
    const messages: string[] = [];
    if (selected.edit) messages.push(...(await applyWorkspaceEdit(selected.edit, cwd)).operations);
    if (selected.command) {
      const command = typeof selected.command === "string" ? { command: selected.command, arguments: [] } : selected.command;
      await client.request("workspace/executeCommand", command, signal, timeoutMs);
      messages.push(`command ${command.command}`);
    }
    return result(params, messages.length > 0 ? `Applied code action ${selected.title}:\n${messages.join("\n")}` : `Code action ${selected.title} contained no edit or command.`, true, client.config.name);
  }
  return result(params, `Unknown LSP action: ${action}`, false, client.config.name);
}

interface CodeAction {
  title: string;
  edit?: WorkspaceEdit;
  command?: string | { command: string; arguments?: unknown[] };
  data?: unknown;
}

async function executeRenameFile(manager: LspManagerLike, params: Static<typeof LspParams>, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<AgentToolResult<LspToolDetails>> {
  if (!params.file || !params.new_name) return result(params, "Error: rename_file requires file and new_name.", false);
  const source = resolveFile(cwd, params.file);
  const destination = resolveFile(cwd, params.new_name);
  await assertWorkspacePath(source, cwd);
  await assertWorkspacePath(destination, cwd);
  if (source === destination) return result(params, "Error: source and destination are identical.", false);
  await fs.access(source);
  try {
    await fs.access(destination);
    return result(params, `Error: destination already exists: ${destination}`, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const filePair = { oldUri: pathToFileURL(source).href, newUri: pathToFileURL(destination).href };
  if (params.apply === false) return result(params, `Rename file preview:\n${source} -> ${destination}`, true);
  const clients = await manager.clientsForWorkspace(cwd, signal, timeoutMs);
  const documentChanges: NonNullable<WorkspaceEdit["documentChanges"]> = [];
  for (const client of clients) {
    try {
      const edit = await client.request("workspace/willRenameFiles", { files: [filePair] }, signal, timeoutMs) as WorkspaceEdit | null;
      if (edit) appendWorkspaceEdit(documentChanges, edit);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      if (!isMethodNotFound(error)) throw error;
    }
  }
  if (signal.aborted) throw abortError();
  documentChanges.push({ kind: "rename", oldUri: filePair.oldUri, newUri: filePair.newUri });
  const applied = await applyWorkspaceEdit({ documentChanges }, cwd);
  for (const client of clients) client.notify("workspace/didRenameFiles", { files: [filePair] });
  return result(params, `Renamed ${source} -> ${destination}:\n${applied.operations.join("\n")}`, true, clients.map((client) => client.config.name).join(", "));
}

function appendWorkspaceEdit(target: NonNullable<WorkspaceEdit["documentChanges"]>, edit: WorkspaceEdit): void {
  if (edit.changes && edit.documentChanges) throw new Error("WorkspaceEdit must not contain both changes and documentChanges.");
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    target.push({ textDocument: { uri, version: null }, edits });
  }
  target.push(...(edit.documentChanges ?? []));
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof Error && /(?:LSP error -32601|method not found)/i.test(error.message);
}

async function resolveClient(manager: LspManagerLike, file: string | undefined, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<LspClientLike> {
  if (file && file !== "*") return manager.clientForFile(resolveFile(cwd, file), cwd, undefined, signal, timeoutMs);
  const clients = await manager.clientsForWorkspace(cwd, signal, timeoutMs);
  const client = clients[0];
  if (!client) throw new Error("No language server available.");
  return client;
}

async function automaticRequestPayload(client: LspClientLike, params: Static<typeof LspParams>, cwd: string): Promise<unknown> {
  if (!params.file || params.file === "*") return {};
  const file = resolveFile(cwd, params.file);
  const uri = await client.ensureFileOpen(file);
  return { textDocument: { uri }, position: await resolvePosition(file, params.line ?? 1, params.symbol) };
}

async function resolvePosition(file: string, oneBasedLine: number, symbol?: string): Promise<Position> {
  const content = await fs.readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  const lineIndex = oneBasedLine - 1;
  const text = lines[lineIndex];
  if (text === undefined) throw new Error(`Line ${oneBasedLine} is outside ${file}.`);
  if (!symbol) return { line: lineIndex, character: text.search(/\S|$/) };
  const match = /^(.*?)(?:#(\d+))?$/.exec(symbol);
  const needle = match?.[1] ?? symbol;
  const occurrence = Number(match?.[2] ?? 1);
  let from = 0;
  let column = -1;
  for (let index = 0; index < occurrence; index += 1) {
    column = text.indexOf(needle, from);
    if (column < 0) column = text.toLowerCase().indexOf(needle.toLowerCase(), from);
    if (column < 0) throw new Error(`Symbol "${needle}" occurrence ${occurrence} was not found on line ${oneBasedLine}.`);
    from = column + needle.length;
  }
  return { line: lineIndex, character: column };
}

function normalizeLocations(value: unknown): Location[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((item) => {
    const record = item as Partial<Location & LocationLink>;
    if (record.uri && record.range) return [{ uri: record.uri, range: record.range }];
    if (record.targetUri && (record.targetSelectionRange || record.targetRange)) {
      return [{ uri: record.targetUri, range: record.targetSelectionRange ?? record.targetRange! }];
    }
    return [];
  });
}

function flattenHover(value: unknown): string {
  const contents = (value as { contents?: unknown } | null)?.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(flattenMarkedString).filter(Boolean).join("\n");
  return flattenMarkedString(contents);
}

function flattenMarkedString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { value?: unknown; language?: unknown; kind?: unknown };
  if (typeof record.value !== "string") return "";
  return record.language ? `\`\`\`${record.language}\n${record.value}\n\`\`\`` : record.value;
}

function result(
  params: Static<typeof LspParams>,
  output: string | LspFormattedOutput,
  success: boolean,
  serverName?: string,
): AgentToolResult<LspToolDetails> {
  const formatted = typeof output === "string" ? boundText(output) : output;
  return {
    content: [{ type: "text", text: formatted.text }],
    details: {
      action: params.action,
      success,
      request: requestDetails(params),
      ...(serverName ? { serverName } : {}),
      output: {
        ...(formatted.totalItems === undefined ? {} : { totalItems: formatted.totalItems }),
        ...(formatted.shownItems === undefined ? {} : { shownItems: formatted.shownItems }),
        truncated: formatted.truncated,
      },
    },
  } as AgentToolResult<LspToolDetails>;
}

function resolveFile(cwd: string, file: string): string {
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
}

async function assertWorkspacePath(file: string, cwd: string): Promise<void> {
  const root = await fs.realpath(cwd);
  let resolved: string;
  try { resolved = await fs.realpath(file); }
  catch { resolved = path.resolve(file); }
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`LSP mutation is outside the workspace: ${file}`);
  }
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listOptions(cwd: string, params: Static<typeof LspParams>): { cwd: string; limit?: number; offset?: number } {
  return {
    cwd,
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.offset === undefined ? {} : { offset: params.offset }),
  };
}

function requestDetails(params: Static<typeof LspParams>): Record<string, unknown> {
  if (params.payload === undefined) return params as Record<string, unknown>;
  const { payload, ...rest } = params;
  return { ...rest, payload: `<${Buffer.byteLength(payload, "utf8")} byte JSON payload>` };
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
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
  const error = new Error("LSP request aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
