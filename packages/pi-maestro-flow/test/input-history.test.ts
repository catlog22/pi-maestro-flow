import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager as AppKeybindingsManager } from "@earendil-works/pi-coding-agent";

import { workspaceStorageId } from "../src/tools/plan-store.ts";
import { HistoryEditor, historyBanner } from "../src/tui/history-editor.ts";
import { InputHistoryStore } from "../src/tui/input-history.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

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

function editor(entries: string[]): { editor: HistoryEditor; recorded: string[] } {
  const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
  const theme = { borderColor: (value: string) => value, selectList: {} } as unknown as EditorTheme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AppKeybindingsManager;
  const recorded: string[] = [];
  return {
    editor: new HistoryEditor(tui, theme, keybindings, {
      getEntries: () => entries,
      record: (text) => recorded.push(text),
    }),
    recorded,
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

test("submitted prompts reach the store instead of the built-in history", () => {
  const { editor: instance, recorded } = editor([]);
  instance.addToHistory("delegate the review");
  assert.deepEqual(recorded, ["delegate the review"]);
  // Nothing landed in the base list, so an empty store leaves the editor empty.
  instance.handleInput(UP);
  assert.equal(instance.getText(), "");
});

test("up and down walk the persisted history and stop at both ends", () => {
  const { editor: instance } = editor(["newest", "older"]);
  instance.handleInput(UP);
  assert.equal(instance.getText(), "newest");
  instance.handleInput(UP);
  assert.equal(instance.getText(), "older");
  instance.handleInput(UP);
  assert.equal(instance.getText(), "older");
  instance.handleInput(DOWN);
  assert.equal(instance.getText(), "newest");
  instance.handleInput(DOWN);
  assert.equal(instance.getText(), "");
  instance.handleInput(DOWN);
  assert.equal(instance.getText(), "");
});

test("browsing from a half-typed prompt gives it back on the way down", () => {
  const { editor: instance } = editor(["newest"]);
  instance.setText("half typed");
  // Cursor lands at the end after setText, where Up is a plain cursor move.
  instance.handleInput(UP);
  assert.equal(instance.getText(), "half typed");

  instance.handleInput("\x1b[H"); // home
  instance.handleInput(UP);
  assert.equal(instance.getText(), "newest");
  instance.handleInput(DOWN);
  assert.equal(instance.getText(), "half typed");
});

test("the banner shows only while browsing", () => {
  const { editor: instance } = editor(["newest", "older"]);
  assert.equal(instance.render(40).length, instance.render(40).length);
  assert.ok(!instance.render(40)[0]?.includes("History"));

  instance.handleInput(UP);
  assert.match(instance.render(40)[0] ?? "", /── History 1\/2 ─+$/);
  instance.handleInput(UP);
  assert.match(instance.render(40)[0] ?? "", /── History 2\/2 ─+$/);

  // Typing leaves history behind, so the banner goes with it.
  instance.handleInput("x");
  assert.ok(!instance.render(40)[0]?.includes("History"));
});

test("setText from outside the editor ends browsing", () => {
  const { editor: instance } = editor(["newest"]);
  instance.handleInput(UP);
  assert.ok(instance.render(40)[0]?.includes("History"));
  instance.setText("injected by another extension");
  assert.ok(!instance.render(40)[0]?.includes("History"));
});

test("the banner fills the editor width and degrades on narrow terminals", () => {
  const wide = historyBanner(3, 100, 40, 0, (value) => value);
  assert.equal(wide.length, 40);
  assert.equal(wide, `── History 3/100 ${"─".repeat(23)}`);

  const padded = historyBanner(3, 100, 40, 2, (value) => value);
  assert.equal(padded.length, 38);
  assert.ok(padded.startsWith("  ── History 3/100 "));

  // truncateToWidth adds its own reset codes, so match on the visible text.
  assert.match(historyBanner(3, 100, 10, 0, (value) => value), /^History 3\S*…/);
});
