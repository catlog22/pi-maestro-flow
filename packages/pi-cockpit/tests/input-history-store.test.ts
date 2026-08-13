import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InputHistoryStore, workspaceStorageId } from "../src/editor/input-history-store.ts";

async function workspace(): Promise<{ cwd: string; rootDir: string; file: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-input-history-"));
  const cwd = join(root, "workspace");
  const rootDir = join(root, "global");
  return {
    cwd,
    rootDir,
    file: join(rootDir, workspaceStorageId(cwd), "input-history.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("history survives the store that wrote it", async () => {
  const { cwd, rootDir, file, cleanup } = await workspace();
  try {
    const first = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    await first.load();
    assert.deepEqual(first.list(), []);
    first.record("run the tests");
    first.record("fix the build");
    await first.flush();

    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      version: 1,
      entries: ["fix the build", "run the tests"],
    });

    const second = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    assert.deepEqual(await second.load(), ["fix the build", "run the tests"]);
  } finally {
    await cleanup();
  }
});

test("each workspace keeps its own history", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const here = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    await here.load();
    here.record("only here");
    await here.flush();

    const elsewhere = new InputHistoryStore(join(cwd, "nested"), { rootDir, debounceMs: 0 });
    assert.deepEqual(await elsewhere.load(), []);
  } finally {
    await cleanup();
  }
});

test("repeated prompts move to the front instead of piling up", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const store = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    await store.load();
    store.record("first");
    store.record("second");
    store.record("  first  ");
    assert.deepEqual(store.list(), ["first", "second"]);

    store.record("first");
    store.record("");
    store.record("   ");
    assert.deepEqual(store.list(), ["first", "second"]);
  } finally {
    await cleanup();
  }
});

test("history is capped at the newest entries", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const store = new InputHistoryStore(cwd, { rootDir, maxEntries: 3, debounceMs: 0 });
    await store.load();
    for (const entry of ["a", "b", "c", "d"]) store.record(entry);
    assert.deepEqual(store.list(), ["d", "c", "b"]);
    await store.flush();

    const reopened = new InputHistoryStore(cwd, { rootDir, maxEntries: 3, debounceMs: 0 });
    assert.deepEqual(await reopened.load(), ["d", "c", "b"]);
  } finally {
    await cleanup();
  }
});

test("entries recorded before load settles are kept ahead of the disk entries", async () => {
  const { cwd, rootDir, file, cleanup } = await workspace();
  try {
    // Long debounce keeps the scheduled save from firing before load() settles,
    // isolating the load/record race from the save timer.
    const store = new InputHistoryStore(cwd, { rootDir, debounceMs: 10_000 });
    // Immediate submit before the initial load resolves (startup race).
    store.record("typed before load");
    await mkdir(join(rootDir, workspaceStorageId(cwd)), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, entries: ["older entry"] }), "utf8");

    await store.load();
    assert.deepEqual(store.list(), ["typed before load", "older entry"]);
    await store.flush();

    const reopened = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    assert.deepEqual(await reopened.load(), ["typed before load", "older entry"]);
  } finally {
    await cleanup();
  }
});

test("a save keeps entries another pi window wrote after we loaded", async () => {
  const { cwd, rootDir, file, cleanup } = await workspace();
  try {
    // A debounce long enough that the save is still pending when the other window writes.
    const store = new InputHistoryStore(cwd, { rootDir, debounceMs: 10_000 });
    await store.load();
    store.record("ours");

    await mkdir(join(rootDir, workspaceStorageId(cwd)), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, entries: ["theirs"] }), "utf8");
    await store.flush();

    assert.deepEqual(store.list(), ["ours", "theirs"]);
  } finally {
    await cleanup();
  }
});

test("a corrupt history file is reported and rebuilt, never fatal", async () => {
  const { cwd, rootDir, file, cleanup } = await workspace();
  try {
    await mkdir(join(rootDir, workspaceStorageId(cwd)), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    const errors: unknown[] = [];
    const store = new InputHistoryStore(cwd, { rootDir, debounceMs: 0, onError: (error) => errors.push(error) });

    assert.deepEqual(await store.load(), []);
    assert.equal(errors.length, 1);
    store.record("after the damage");
    await store.flush();
    assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { entries: string[] }).entries, ["after the damage"]);
  } finally {
    await cleanup();
  }
});

test("a second workspace swaps history behind the same persisted root", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const other = join(cwd, "nested");
    const seeded = new InputHistoryStore(other, { rootDir, debounceMs: 0 });
    await seeded.load();
    seeded.record("nested workspace prompt");
    await seeded.flush();

    const here = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    const there = new InputHistoryStore(other, { rootDir, debounceMs: 0 });
    await here.load();
    await there.load();
    assert.deepEqual(here.list(), []);
    assert.deepEqual(there.list(), ["nested workspace prompt"]);
  } finally {
    await cleanup();
  }
});
