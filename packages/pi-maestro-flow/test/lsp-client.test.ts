import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LspClient, type LspClientCacheLimits } from "../src/tools/lsp/client.ts";

test("LSP client frames JSON-RPC, opens documents, receives diagnostics, and shuts down", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-client-"));
  const server = path.join(root, "fake-lsp.mjs");
  const shim = path.join(root, "fake-lsp.cmd");
  const source = path.join(root, "sample.ts");
  await fs.writeFile(source, "const value = 1;\n", "utf8");
  await fs.writeFile(server, `
let buffer = Buffer.alloc(0);
let applyResponse;
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true } } });
    else if (message.method === 'textDocument/didOpen') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: 'fake warning' }] } });
      send({ jsonrpc: '2.0', id: 999, method: 'workspace/applyEdit', params: { edit: { changes: {} } } });
    }
    else if (message.method === 'textDocument/didChange') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'updated error' }] } });
    }
    else if (message.id === 999 && !message.method) applyResponse = message.result;
    else if (message.method === 'textDocument/hover') {
      const respond = () => applyResponse
        ? send({ jsonrpc: '2.0', id: message.id, result: { contents: 'hovered', applyResponse } })
        : setTimeout(respond, 5);
      respond();
    }
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`, "utf8");
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`, "utf8");

  const client = await LspClient.start({
    name: "fake",
    command: process.platform === "win32" ? shim : process.execPath,
    args: process.platform === "win32" ? [] : [server],
    fileTypes: [".ts"],
    rootMarkers: [],
  }, root);
  try {
    assert.equal(client.capabilities.hoverProvider, true);
    const uri = await client.ensureFileOpen(source);
    assert.equal(uri, pathToFileURL(source).href);
    const diagnostics = await client.getDiagnostics(uri, 1_000);
    assert.equal(diagnostics[0]?.message, "fake warning");
    await fs.writeFile(source, "const value: string = 1;\n", "utf8");
    await client.ensureFileOpen(source);
    const updatedDiagnostics = await client.getDiagnostics(uri, 1_000);
    assert.equal(updatedDiagnostics[0]?.message, "updated error");
    const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 6 } });
    assert.deepEqual(hover, {
      contents: "hovered",
      applyResponse: { applied: false, failureReason: "Workspace edits require an explicit lsp rename or code_actions transaction." },
    });
  } finally {
    await client.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LSP shutdown kills a server that ignores shutdown and exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-shutdown-"));
  const server = path.join(root, "stubborn-lsp.mjs");
  const pidFile = path.join(root, "server.pid");
  await fs.writeFile(server, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
  }
});
`, "utf8");

  const client = await LspClient.start({
    name: "stubborn",
    command: process.execPath,
    args: [server],
    fileTypes: [".ts"],
    rootMarkers: [],
  }, root);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  try {
    await client.shutdown();
    assert.equal(client.closed, true);
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LSP client bounds document and diagnostic caches, closes LRU documents, and clears lifecycle state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-cache-"));
  const server = path.join(root, "cache-lsp.mjs");
  const shim = path.join(root, "cache-lsp.cmd");
  const closeLog = path.join(root, "did-close.jsonl");
  const limits: LspClientCacheLimits = {
    maxDocumentEntries: 2,
    maxDocumentBytes: 64,
    maxDiagnosticEntries: 2,
    maxDiagnosticBytes: 4_096,
    maxDiagnosticWaiters: 4,
  };
  await fs.writeFile(server, `
import fs from 'node:fs';
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    else if (message.method === 'textDocument/didOpen') {
      const uri = message.params.textDocument.uri;
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: uri }] } });
    }
    else if (message.method === 'textDocument/didClose') {
      fs.appendFileSync(${JSON.stringify(closeLog)}, JSON.stringify(message.params.textDocument.uri) + '\\n');
    }
    else if (message.method === 'test/publishDiagnostics') {
      for (const uri of message.params.uris) {
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: uri }] } });
      }
      send({ jsonrpc: '2.0', id: message.id, result: null });
    }
    else if (message.method === 'test/barrier') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`, "utf8");
  await fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`, "utf8");

  const files = await Promise.all(["a.ts", "b.ts", "c.ts"].map(async (name, index) => {
    const file = path.join(root, name);
    await fs.writeFile(file, `const v${index} = ${index};\n`, "utf8");
    return file;
  }));
  const client = await LspClient.start({
    name: "cache",
    command: process.platform === "win32" ? shim : process.execPath,
    args: process.platform === "win32" ? [] : [server],
    fileTypes: [".ts"],
    rootMarkers: [],
  }, root, undefined, 20_000, undefined, limits);
  try {
    const firstUri = await client.ensureFileOpen(files[0]);
    const secondUri = await client.ensureFileOpen(files[1]);
    await client.ensureFileOpen(files[0]); // Touch first; second is now LRU.
    const thirdUri = await client.ensureFileOpen(files[2]);
    await client.request("test/barrier", null);
    assert.deepEqual(client.cacheStats, {
      documentEntries: 2,
      documentBytes: 28,
      documentEvictions: 1,
      diagnosticEntries: 2,
      diagnosticBytes: client.cacheStats.diagnosticBytes,
      diagnosticEvictions: 0,
      diagnosticWaiterUris: 0,
      diagnosticWaiters: 0,
    });
    assert.ok(client.cacheStats.documentBytes <= limits.maxDocumentBytes);

    await client.request("test/publishDiagnostics", {
      uris: ["file:///diagnostic-a", "file:///diagnostic-b", "file:///diagnostic-c"],
    });
    assert.equal(client.cacheStats.diagnosticEntries, limits.maxDiagnosticEntries);
    assert.ok(client.cacheStats.diagnosticBytes <= limits.maxDiagnosticBytes);
    assert.ok(client.cacheStats.diagnosticEvictions >= 3);

    assert.deepEqual(await client.getDiagnostics("file:///timed-out", 1), []);
    assert.equal(client.cacheStats.diagnosticWaiterUris, 0);
    assert.equal(client.cacheStats.diagnosticWaiters, 0);

    const waiters = Array.from({ length: limits.maxDiagnosticWaiters }, (_, index) =>
      client.getDiagnostics(`file:///waiting-${index}`, 10_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.cacheStats.diagnosticWaiters, limits.maxDiagnosticWaiters);
    assert.equal(client.cacheStats.diagnosticWaiterUris, limits.maxDiagnosticWaiters);
    await assert.rejects(
      client.getDiagnostics("file:///waiting-overflow", 10_000),
      /Too many pending LSP diagnostic waiters/,
    );

    await client.shutdown();
    assert.deepEqual(await Promise.all(waiters), [[], [], [], []]);
    assert.deepEqual(client.cacheStats, {
      documentEntries: 0,
      documentBytes: 0,
      documentEvictions: 1,
      diagnosticEntries: 0,
      diagnosticBytes: 0,
      diagnosticEvictions: client.cacheStats.diagnosticEvictions,
      diagnosticWaiterUris: 0,
      diagnosticWaiters: 0,
    });
    const closedUris = (await fs.readFile(closeLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
    assert.deepEqual(new Set(closedUris), new Set([firstUri, secondUri, thirdUri]));
  } finally {
    if (!client.closed) await client.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
