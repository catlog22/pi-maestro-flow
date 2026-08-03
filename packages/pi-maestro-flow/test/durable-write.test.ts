import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  fsyncDirectory,
  fsyncDirectorySync,
  writeFileDurable,
  writeFileDurableSync,
} from "../src/settings/durable-write.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "durable-write-"));
}

test("writeFileDurableSync publishes content atomically with no leftover temp files", () => {
  const root = tempDir();
  try {
    const target = path.join(root, "settings.json");
    writeFileDurableSync(target, '{"a":1}\n');
    assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}\n');
    assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeFileDurable publishes content and both writers clean up temp files on failure", async () => {
  const root = tempDir();
  try {
    const target = path.join(root, "settings.json");
    await writeFileDurable(target, '{"b":2}\n');
    assert.equal(fs.readFileSync(target, "utf8"), '{"b":2}\n');

    // Rename onto an existing directory must fail on every platform; the
    // staged temp file must be removed in both the sync and async writers.
    const dirAsTarget = path.join(root, "occupied");
    fs.mkdirSync(dirAsTarget);
    assert.throws(() => writeFileDurableSync(dirAsTarget, "x"));
    await assert.rejects(() => writeFileDurable(dirAsTarget, "y"));
    assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("directory fsync helpers never throw on existing or missing directories", async () => {
  const root = tempDir();
  try {
    assert.doesNotThrow(() => fsyncDirectorySync(root));
    assert.doesNotThrow(() => fsyncDirectorySync(path.join(root, "missing")));
    await fsyncDirectory(root);
    await fsyncDirectory(path.join(root, "missing"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
