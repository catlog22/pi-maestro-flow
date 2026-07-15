import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createLspAutoDiagnosticsHandler } from "../src/tools/lsp/auto-diagnostics.ts";
import type { Diagnostic, LspClientLike, LspManagerLike, LspServerConfig, ServerStatus } from "../src/tools/lsp/types.ts";

const DIAGNOSTICS: Diagnostic[] = [
  diagnostic(1, 1, "broken type", 1, "TS1"),
  diagnostic(2, 3, "unsafe value", 2, "TS2"),
  diagnostic(3, 1, "informational", 3),
];

class FakeClient implements LspClientLike {
  readonly config: LspServerConfig = { name: "fake", command: "fake", args: [], fileTypes: [".ts"], rootMarkers: [] };
  readonly root = "C:\\workspace";
  readonly capabilities = {};
  readonly closed = false;
  readonly calls: string[] = [];
  diagnostics = DIAGNOSTICS;

  async ensureFileOpen(file: string): Promise<string> {
    this.calls.push(`open:${file}`);
    return `file:///${file.replace(/\\/g, "/")}`;
  }
  request(): Promise<unknown> { return Promise.resolve(null); }
  notify(method: string): void { this.calls.push(method); }
  async getDiagnostics(): Promise<Diagnostic[]> { this.calls.push("diagnostics"); return this.diagnostics; }
  async shutdown(): Promise<void> {}
}

class FakeManager implements LspManagerLike {
  readonly client = new FakeClient();
  calls = 0;
  error?: Error;

  async clientForFile(): Promise<LspClientLike> {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.client;
  }
  async clientsForWorkspace(): Promise<LspClientLike[]> { return [this.client]; }
  async status(): Promise<ServerStatus[]> { return []; }
  async reload(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

test("automatic diagnostics run after successful edit/write and append compact results", async () => {
  const manager = new FakeManager();
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 0 });
  const cwd = path.resolve("workspace");
  const notifications: Notification[] = [];
  const editResult = await handler(event("edit", "src/app.ts"), context(cwd, notifications));

  assert.ok(editResult);
  const text = resultText(editResult);
  assert.match(text, /src\/app\.ts — LSP: 1 error\(s\), 1 warning\(s\), 1 info/);
  assert.match(text, /1:1 error TS1 broken type/);
  assert.match(text, /2:3 warning TS2 unsafe value/);
  assert.doesNotMatch(text, /informational/);
  assert.deepEqual(notifications, [{ message: "LSP src/app.ts: 1 error(s), 1 warning(s), 1 info", type: "error" }]);
  assert.deepEqual(manager.client.calls.slice(-2), ["textDocument/didSave", "diagnostics"]);

  manager.client.calls.length = 0;
  const mutationPath = path.join(cwd, "src", "from-details.ts");
  const writeResult = await handler(event("write", "ignored.ts", {
    fileMutation: { path: mutationPath },
  }), context(cwd));
  assert.ok(writeResult);
  assert.match(manager.client.calls[0] ?? "", /from-details\.ts$/);
});

test("automatic diagnostics ignore failed and non-editing tools", async () => {
  const manager = new FakeManager();
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 0 });
  const ctx = context(path.resolve("workspace"));

  assert.equal(await handler(event("edit", "src/app.ts", undefined, true), ctx), undefined);
  assert.equal(await handler(event("read", "src/app.ts"), ctx), undefined);
  assert.equal(manager.calls, 0);
});

test("automatic diagnostics coalesce concurrent edits to the same file", async () => {
  const manager = new FakeManager();
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 20 });
  const ctx = context(path.resolve("workspace"));
  const first = handler(event("edit", "src/app.ts"), ctx);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = handler(event("write", "src/app.ts"), ctx);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, undefined);
  assert.ok(secondResult);
  assert.equal(manager.calls, 1);
});

test("automatic diagnostics fail open and report repeated startup failures only once", async () => {
  const manager = new FakeManager();
  manager.error = new Error("Unable to start typescript: command missing");
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 0 });
  const notifications: Notification[] = [];
  const ctx = context(path.resolve("workspace"), notifications);

  const first = await handler(event("edit", "src/app.ts"), ctx);
  const second = await handler(event("edit", "src/app.ts"), ctx);
  assert.match(resultText(first), /LSP check unavailable/);
  assert.equal(second, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");

  manager.error = new Error("No language server is configured for .md files.");
  assert.equal(await handler(event("write", "README.md"), ctx), undefined);
});

test("interactive notifications reflect severity and suppress unchanged repeats", async () => {
  const manager = new FakeManager();
  manager.client.diagnostics = [diagnostic(1, 1, "warning", 2)];
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 0 });
  const notifications: Notification[] = [];
  const ctx = context(path.resolve("workspace"), notifications);

  await handler(event("edit", "src/app.ts"), ctx);
  await handler(event("edit", "src/app.ts"), ctx);
  manager.client.diagnostics = [];
  await handler(event("write", "src/app.ts"), ctx);

  assert.deepEqual(notifications, [
    { message: "LSP src/app.ts: 1 warning(s)", type: "warning" },
    { message: "LSP src/app.ts: OK", type: "info" },
  ]);
});

test("automatic diagnostic additions stay within the 4 KiB budget", async () => {
  const manager = new FakeManager();
  manager.client.diagnostics = Array.from({ length: 100 }, (_, index) => diagnostic(
    index + 1,
    1,
    `error ${index} ${"x".repeat(600)}`,
    1,
  ));
  const handler = createLspAutoDiagnosticsHandler(manager, { debounceMs: 0 });
  const result = await handler(event("edit", "src/app.ts"), context(path.resolve("workspace")));
  const addition = result?.content.at(-1);
  assert.equal(addition?.type, "text");
  assert.ok(Buffer.byteLength(addition?.type === "text" ? addition.text : "", "utf8") <= 4 * 1024);
  assert.match(addition?.type === "text" ? addition.text : "", /Showing/);
});

function event(toolName: string, file: string, details?: unknown, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolName,
    toolCallId: `${toolName}-${file}`,
    input: { path: file },
    content: [{ type: "text", text: `${toolName} complete` }],
    details,
    isError,
  } as ToolResultEvent;
}

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

function context(cwd: string, notifications: Notification[] = []): ExtensionContext {
  return {
    cwd,
    signal: undefined,
    ui: {
      notify(message: string, type: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
  } as ExtensionContext;
}

function resultText(result: { content: ToolResultEvent["content"] } | undefined): string {
  return result?.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") ?? "";
}

function diagnostic(line: number, character: number, message: string, severity: number, code?: string): Diagnostic {
  return {
    range: { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character } },
    severity,
    message,
    ...(code ? { code } : {}),
  };
}
