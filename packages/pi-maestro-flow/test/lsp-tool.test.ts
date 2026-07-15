import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createLspTool, LSP_ACTIONS } from "../src/tools/lsp-tool.ts";
import type { Diagnostic, LspClientLike, LspManagerLike, LspServerConfig, ServerStatus, WorkspaceEdit } from "../src/tools/lsp/types.ts";

class FakeClient implements LspClientLike {
  readonly config: LspServerConfig = { name: "fake", command: "fake-lsp", args: [], fileTypes: [".ts"], rootMarkers: [] };
  readonly root: string;
  readonly capabilities = { hoverProvider: true, renameProvider: true };
  readonly closed = false;
  readonly methods: string[] = [];
  readonly notifications: string[] = [];
  abortWillRename = false;
  willRenameEdit: WorkspaceEdit | null = null;
  willRenameError?: Error;

  constructor(root: string) { this.root = root; }

  async ensureFileOpen(file: string): Promise<string> { return pathToFileURL(file).href; }
  async request(method: string, params: unknown): Promise<unknown> {
    this.methods.push(method);
    const fileUri = pathToFileURL(path.join(this.root, "sample.ts")).href;
    const location = { uri: fileUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
    if (["textDocument/definition", "textDocument/typeDefinition", "textDocument/implementation", "textDocument/references"].includes(method)) return [location];
    if (method === "textDocument/hover") return { contents: { kind: "markdown", value: "const value: number" } };
    if (method === "textDocument/documentSymbol") return [{ name: "value", kind: 13, range: location.range, selectionRange: location.range }];
    if (method === "workspace/symbol") return [{ name: "value", kind: 13, location }];
    if (method === "textDocument/rename") return { changes: { [fileUri]: [{ range: location.range, newText: "renamed" }] } };
    if (method === "textDocument/codeAction") return [{ title: "Fix value", edit: { changes: { [fileUri]: [{ range: location.range, newText: "fixed" }] } } }];
    if (method === "workspace/diagnostic") return { items: [] };
    if (method === "custom/method") return { echoed: params };
    if (method === "workspace/willRenameFiles") {
      if (this.abortWillRename) { const error = new Error("aborted"); error.name = "AbortError"; throw error; }
      if (this.willRenameError) throw this.willRenameError;
      return this.willRenameEdit;
    }
    return null;
  }
  notify(method: string): void { this.notifications.push(method); }
  async getDiagnostics(): Promise<Diagnostic[]> {
    return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: "sample warning" }];
  }
  async shutdown(): Promise<void> {}
}

class FakeManager implements LspManagerLike {
  readonly client: FakeClient;
  readonly clients: FakeClient[];
  reloaded = false;
  constructor(root: string, clients?: FakeClient[]) {
    this.clients = clients ?? [new FakeClient(root)];
    this.client = this.clients[0]!;
  }
  async clientForFile(): Promise<LspClientLike> { return this.client; }
  async clientsForWorkspace(): Promise<LspClientLike[]> { return this.clients; }
  async status(): Promise<ServerStatus[]> { return [{ name: "fake", command: "fake-lsp", root: this.client.root, state: "ready" }]; }
  async reload(): Promise<void> { this.reloaded = true; }
  async shutdown(): Promise<void> {}
}

test("LSP schema exposes the complete oh-my-pi 14-action contract", () => {
  assert.deepEqual(LSP_ACTIONS, [
    "diagnostics", "definition", "references", "hover", "symbols", "rename", "rename_file",
    "code_actions", "type_definition", "implementation", "status", "reload", "capabilities", "request",
  ]);
});

test("LSP tool routes navigation, diagnostics, symbols, capabilities, status, reload, and raw requests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-tool-"));
  await fs.writeFile(path.join(root, "sample.ts"), "value = 1;\n", "utf8");
  const manager = new FakeManager(root);
  const tool = createLspTool(manager);
  const ctx = { cwd: root } as never;

  for (const action of ["diagnostics", "definition", "references", "hover", "type_definition", "implementation"] as const) {
    const response = await tool.execute(action, { action, file: "sample.ts", line: 1, symbol: "value" }, undefined, undefined, ctx);
    assert.equal(response.isError, undefined, action);
    assert.equal(response.details?.success, true, action);
  }
  assert.equal((await tool.execute("symbols-file", { action: "symbols", file: "sample.ts" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("symbols-workspace", { action: "symbols", file: "*", query: "value" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("workspace-diagnostics", { action: "diagnostics", file: "*" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("capabilities", { action: "capabilities" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("status", { action: "status" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("request", { action: "request", query: "custom/method", payload: "{\"x\":1}" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal((await tool.execute("reload", { action: "reload" }, undefined, undefined, ctx)).details?.success, true);
  assert.equal(manager.reloaded, true);
});

test("LSP raw request output is bounded and payload details are summarized", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-output-"));
  const manager = new FakeManager(root);
  const tool = createLspTool(manager);
  const payload = JSON.stringify({ content: "界".repeat(20_000) });
  try {
    const response = await tool.execute("request-bounded", {
      action: "request",
      query: "custom/method",
      payload,
    }, undefined, undefined, { cwd: root } as never);
    const text = (response.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text, "utf8") <= 16 * 1024);
    assert.match(text, /Output truncated/);
    assert.equal(response.details?.request.payload, `<${Buffer.byteLength(payload, "utf8")} byte JSON payload>`);
    assert.equal(response.details?.output?.truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LSP rename, code action, and rename_file support preview and apply behavior", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-write-"));
  const sample = path.join(root, "sample.ts");
  await fs.writeFile(sample, "value = 1;\n", "utf8");
  const manager = new FakeManager(root);
  const tool = createLspTool(manager);
  const ctx = { cwd: root } as never;

  const preview = await tool.execute("rename-preview", { action: "rename", file: "sample.ts", line: 1, symbol: "value", new_name: "renamed", apply: false }, undefined, undefined, ctx);
  assert.match((preview.content[0] as { text: string }).text, /Rename preview/);
  assert.equal(await fs.readFile(sample, "utf8"), "value = 1;\n");

  const applied = await tool.execute("code-action", { action: "code_actions", file: "sample.ts", line: 1, symbol: "value", query: "Fix", apply: true }, undefined, undefined, ctx);
  assert.equal(applied.details?.success, true);
  assert.equal(await fs.readFile(sample, "utf8"), "fixed = 1;\n");

  const destination = path.join(root, "renamed.ts");
  const renamed = await tool.execute("rename-file", { action: "rename_file", file: sample, new_name: destination }, undefined, undefined, ctx);
  assert.equal(renamed.details?.success, true);
  assert.equal(await fs.readFile(destination, "utf8"), "fixed = 1;\n");
  assert.ok(manager.client.notifications.includes("workspace/didRenameFiles"));
});

test("LSP rename_file never commits after willRenameFiles aborts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-abort-"));
  const source = path.join(root, "source.ts");
  const destination = path.join(root, "destination.ts");
  await fs.writeFile(source, "value\n", "utf8");
  const manager = new FakeManager(root);
  manager.client.abortWillRename = true;
  const tool = createLspTool(manager);
  try {
    await assert.rejects(() => tool.execute("rename-abort", { action: "rename_file", file: source, new_name: destination }, undefined, undefined, { cwd: root } as never), { name: "AbortError" });
    assert.equal(await fs.readFile(source, "utf8"), "value\n");
    assert.equal(await fs.stat(destination).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LSP rename_file collects every server edit before committing one transaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-transaction-"));
  const source = path.join(root, "source.ts");
  const destination = path.join(root, "destination.ts");
  const references = path.join(root, "references.ts");
  await fs.writeFile(source, "value\n", "utf8");
  await fs.writeFile(references, "source.ts\n", "utf8");
  const first = new FakeClient(root);
  first.willRenameEdit = { changes: {
    [pathToFileURL(references).href]: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
      newText: "destination.ts",
    }],
  } };
  const second = new FakeClient(root);
  second.willRenameError = new Error("second server failed");
  const tool = createLspTool(new FakeManager(root, [first, second]));
  try {
    await assert.rejects(() => tool.execute("rename-transaction", {
      action: "rename_file", file: source, new_name: destination,
    }, undefined, undefined, { cwd: root } as never), /second server failed/);
    assert.equal(await fs.readFile(source, "utf8"), "value\n");
    assert.equal(await fs.readFile(references, "utf8"), "source.ts\n");
    assert.equal(await fs.stat(destination).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
