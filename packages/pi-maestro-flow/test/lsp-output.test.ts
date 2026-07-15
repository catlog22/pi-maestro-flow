import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  formatDiagnostics,
  formatJson,
  formatSymbols,
  formatWorkspaceDiagnostics,
} from "../src/tools/lsp/output.ts";
import type { Diagnostic } from "../src/tools/lsp/types.ts";

const cwd = path.resolve("workspace");
const file = path.join(cwd, "src", "app.ts");

test("diagnostic output deduplicates, sorts, paginates, and avoids repeated absolute paths", () => {
  const warning = diagnostic(5, "warning", 2);
  const error = diagnostic(2, "error\nwith   whitespace", 1);
  const output = formatDiagnostics(file, [warning, error, error], { cwd, limit: 1 });

  assert.equal(output.totalItems, 2);
  assert.equal(output.shownItems, 1);
  assert.equal(output.truncated, true);
  assert.match(output.text, /^src\/app\.ts — LSP: 1 error\(s\), 1 warning\(s\)/);
  assert.match(output.text, /2:1 error error with whitespace/);
  assert.doesNotMatch(output.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
  assert.match(output.text, /offset=1/);
});

test("workspace diagnostics flatten reports and group paths compactly", () => {
  const uri = pathToFileURL(file).href;
  const output = formatWorkspaceDiagnostics([
    { items: [{ uri, kind: "full", items: [diagnostic(3, "broken", 1)] }] },
  ], { cwd });

  assert.equal(output.totalItems, 1);
  assert.match(output.text, /src\/app\.ts — LSP: 1 error/);
  assert.match(output.text, /3:1 error broken/);
});

test("symbol output flattens nested protocol objects", () => {
  const output = formatSymbols([
    { name: "Container", kind: 5, range: { start: { line: 1, character: 2 } }, children: [
      { name: "run", kind: 6, range: { start: { line: 4, character: 1 } } },
    ] },
  ], { cwd });

  assert.equal(output.text, "class Container — 2:3\n  method run — 5:2");
  assert.doesNotMatch(output.text, /[{}\[\]"]/);
});

test("generic JSON output uses a UTF-8 byte budget and reports truncation", () => {
  const output = formatJson({ content: "界".repeat(10_000) }, 1_024);
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.text, "utf8") <= 1_024);
  assert.match(output.text, /Output truncated/);
});

function diagnostic(line: number, message: string, severity: number): Diagnostic {
  return {
    range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
    severity,
    message,
  };
}
