import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { applyWorkspaceEdit } from "../src/tools/lsp/workspace-edit.ts";

const fullRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

test("WorkspaceEdit preserves ordered create/edit and rename/edit operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-workspace-edit-"));
  const created = path.join(root, "created.ts");
  const source = path.join(root, "source.ts");
  const renamed = path.join(root, "renamed.ts");
  await fs.writeFile(source, "old\n", "utf8");
  try {
    await applyWorkspaceEdit({ documentChanges: [
      { kind: "create", uri: pathToFileURL(created).href },
      { textDocument: { uri: pathToFileURL(created).href, version: null }, edits: [{ range: fullRange, newText: "created\n" }] },
      { kind: "rename", oldUri: pathToFileURL(source).href, newUri: pathToFileURL(renamed).href },
      { textDocument: { uri: pathToFileURL(renamed).href, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" }] },
    ] }, root);
    assert.equal(await fs.readFile(created, "utf8"), "created\n");
    assert.equal(await fs.readFile(renamed, "utf8"), "new\n");
    assert.equal(await fs.stat(source).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceEdit rejects paths outside the workspace before writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-workspace-root-"));
  const outside = path.join(os.tmpdir(), `maestro-outside-${process.pid}-${Date.now()}.ts`);
  try {
    await assert.rejects(() => applyWorkspaceEdit({ documentChanges: [
      { kind: "create", uri: pathToFileURL(outside).href },
    ] }, root), /outside the workspace/);
    assert.equal(await fs.stat(outside).then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test("WorkspaceEdit rejects invalid ranges and unsupported URI schemes before writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-workspace-range-"));
  const source = path.join(root, "source.ts");
  const uri = pathToFileURL(source).href;
  await fs.writeFile(source, "abc\n", "utf8");
  try {
    await assert.rejects(() => applyWorkspaceEdit({ changes: { [uri]: [{
      range: { start: { line: 0, character: -1 }, end: { line: 0, character: 0 } }, newText: "x",
    }] } }, root), /Invalid LSP edit position/);
    await assert.rejects(() => applyWorkspaceEdit({ changes: { [uri]: [{
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 1 } }, newText: "x",
    }] } }, root), /reversed text range/);
    await assert.rejects(() => applyWorkspaceEdit({ changes: { [uri]: [{
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, newText: "x",
    }] } }, root), /outside line 1/);
    await assert.rejects(() => applyWorkspaceEdit({ documentChanges: [
      { kind: "create", uri: "https://example.com/source.ts" },
    ] }, root), /Unsupported WorkspaceEdit URI/);
    assert.equal(await fs.readFile(source, "utf8"), "abc\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
