import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/agents/agents.ts";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
  writePrivateTextFile,
  writeSchemaFile,
  writeSystemPromptFile,
} from "../src/runs/execution.ts";
import {
  STRUCTURED_OUTPUT_FILE_MODE,
  writeStructuredOutputFile,
} from "../src/extension/structured-output.ts";

const promptAgent: AgentConfig = {
  name: "permission-test",
  description: "Permission test",
  tools: ["read"],
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: false,
  systemPrompt: "private prompt",
  source: "builtin",
  filePath: "permission-test.md",
};

function posixMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

test("private teammate helpers tighten existing directory and file modes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-permissions-"));
  const directory = path.join(root, "existing");
  const file = path.join(directory, "existing.txt");
  try {
    fs.mkdirSync(directory, { mode: 0o777 });
    fs.writeFileSync(file, "old", { mode: 0o666 });
    if (process.platform !== "win32") {
      fs.chmodSync(directory, 0o777);
      fs.chmodSync(file, 0o666);
    }

    ensurePrivateDirectory(directory);
    writePrivateTextFile(file, "new private content");

    assert.equal(fs.readFileSync(file, "utf8"), "new private content");
    if (process.platform !== "win32") {
      assert.equal(posixMode(directory), PRIVATE_DIRECTORY_MODE);
      assert.equal(posixMode(file), PRIVATE_FILE_MODE);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prompt schema and reserved result files are private on creation", () => {
  const correlationId = `permission-${randomUUID()}`;
  const promptFile = writeSystemPromptFile(promptAgent, correlationId);
  const { schemaFile, outputFile } = writeSchemaFile({ type: "object" }, correlationId);
  try {
    assert.equal(fs.readFileSync(promptFile, "utf8"), "private prompt");
    assert.deepEqual(JSON.parse(fs.readFileSync(schemaFile, "utf8")), { type: "object" });
    assert.equal(fs.readFileSync(outputFile, "utf8"), "");
    if (process.platform !== "win32") {
      assert.equal(posixMode(path.dirname(promptFile)), PRIVATE_DIRECTORY_MODE);
      assert.equal(posixMode(promptFile), PRIVATE_FILE_MODE);
      assert.equal(posixMode(schemaFile), PRIVATE_FILE_MODE);
      assert.equal(posixMode(outputFile), PRIVATE_FILE_MODE);
    }
  } finally {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(schemaFile, { force: true });
    fs.rmSync(outputFile, { force: true });
  }
});

test("structured output tightens a pre-existing result file before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-structured-permissions-"));
  const outputFile = path.join(root, "result.json");
  try {
    fs.writeFileSync(outputFile, "stale", { mode: 0o666 });
    if (process.platform !== "win32") fs.chmodSync(outputFile, 0o666);

    writeStructuredOutputFile(outputFile, JSON.stringify({ ok: true }));

    assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, "utf8")), { ok: true });
    if (process.platform !== "win32") {
      assert.equal(posixMode(outputFile), STRUCTURED_OUTPUT_FILE_MODE);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private writers refuse pre-existing symbolic-link targets", {
  skip: process.platform === "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-private-symlink-"));
  const target = path.join(root, "target.json");
  const link = path.join(root, "result.json");
  try {
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, link);
    assert.throws(() => writePrivateTextFile(link, "replacement"), /not a regular file/);
    assert.throws(() => writeStructuredOutputFile(link, "replacement"), /not a regular file/);
    assert.equal(fs.readFileSync(target, "utf8"), "original");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
