import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LspClient } from "../src/tools/lsp/client.ts";

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
