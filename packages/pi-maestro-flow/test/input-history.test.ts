import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  KeybindingsManager,
  TUI,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager as AppKeybindingsManager } from "@earendil-works/pi-coding-agent";

import { workspaceStorageId } from "../src/tools/plan-store.ts";
import { HistoryEditor, historyBanner } from "../src/tui/history-editor.ts";
import {
  InputHistoryStore,
  createInputHistory,
  type InputHistoryContext,
} from "../src/tui/input-history.ts";

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

type EditorFactory = Parameters<InputHistoryContext["ui"]["setEditorComponent"]>[0];

function context(cwd: string, overrides: { hasUI?: boolean; existing?: EditorFactory } = {}) {
  let factory: EditorFactory = overrides.existing;
  const notifications: string[] = [];
  const ctx: InputHistoryContext = {
    cwd,
    hasUI: overrides.hasUI ?? true,
    ui: {
      notify: (message: string) => notifications.push(message),
      getEditorComponent: () => factory,
      setEditorComponent: (next: EditorFactory) => {
        factory = next;
      },
    },
  };
  return {
    ctx,
    notifications,
    /** Build the editor pi would build from whatever factory is installed. */
    build(): HistoryEditor | undefined {
      const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
      const theme = { borderColor: (value: string) => value, selectList: {} } as unknown as EditorTheme;
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AppKeybindingsManager;
      return factory?.(tui, theme, keybindings) as HistoryEditor | undefined;
    },
  };
}

/**
 * Terminal is pi-tui's own public interface, so faking it lets the real TUI —
 * real render loop, real focus dispatch, real keybinding resolution — run
 * headlessly. Everything the other tests reach with a stub editor, this one
 * reaches through the pipeline pi actually renders with.
 */
class FakeTerminal implements Terminal {
  frames: string[] = [];
  columns = 72;
  rows = 30;
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.frames.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  press(data: string): void {
    if (!this.onInput) throw new Error("terminal not started");
    this.onInput(data);
  }
}

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (t: string) => t,
    selectedText: (t: string) => t,
    description: (t: string) => t,
    scrollInfo: (t: string) => t,
    noMatch: (t: string) => t,
  },
} as unknown as EditorTheme;

test("the banner and recalled prompt survive pi's real render pipeline", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const seeded = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    await seeded.load();
    seeded.record("older prompt");
    seeded.record("run the tests please");
    await seeded.flush();

    const host = context(cwd);
    await createInputHistory({ rootDir, debounceMs: 0 }).onSessionStart(host.ctx);

    const terminal = new FakeTerminal();
    const tui = new TUI(terminal, false);
    tui.start();
    const factory = host.ctx.ui.getEditorComponent();
    assert.ok(factory);
    const instance = factory(
      tui,
      editorTheme,
      new KeybindingsManager(TUI_KEYBINDINGS) as unknown as AppKeybindingsManager,
    );
    tui.addChild(instance as never);
    tui.setFocus(instance as never);

    // The render loop is debounced; let its timer fire before reading the frame.
    const frame = async (): Promise<string> => {
      terminal.frames.length = 0;
      tui.requestRender(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return terminal.frames.join("").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    };

    assert.ok(!(await frame()).includes("History"), "no banner before browsing");

    terminal.press(UP);
    const first = await frame();
    assert.match(first, /── History 1\/2 ─/);
    assert.ok(first.includes("run the tests please"));

    terminal.press(UP);
    const second = await frame();
    assert.match(second, /── History 2\/2 ─/);
    assert.ok(second.includes("older prompt"));

    tui.stop();
  } finally {
    await cleanup();
  }
});

test("the installed editor recalls history written by an earlier session", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const earlier = new InputHistoryStore(cwd, { rootDir, debounceMs: 0 });
    await earlier.load();
    earlier.record("from the session before");
    await earlier.flush();

    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd);
    await history.onSessionStart(host.ctx);

    const instance = host.build();
    assert.ok(instance);
    instance.handleInput(UP);
    assert.equal(instance.getText(), "from the session before");
  } finally {
    await cleanup();
  }
});

test("a prompt submitted now is on disk after shutdown", async () => {
  const { cwd, rootDir, file, cleanup } = await workspace();
  try {
    const history = createInputHistory({ rootDir });
    const host = context(cwd);
    await history.onSessionStart(host.ctx);

    host.build()?.addToHistory("typed this session");
    await history.onSessionShutdown();

    assert.deepEqual(
      (JSON.parse(await readFile(file, "utf8")) as { entries: string[] }).entries,
      ["typed this session"],
    );
  } finally {
    await cleanup();
  }
});

test("nothing is installed without a UI", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd, { hasUI: false });
    await history.onSessionStart(host.ctx);
    assert.equal(host.build(), undefined);
  } finally {
    await cleanup();
  }
});

test("an editor another extension already owns is left alone", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const theirs = (() => ({ marker: "theirs" })) as unknown as EditorFactory;
    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd, { existing: theirs });
    await history.onSessionStart(host.ctx);
    assert.equal(host.ctx.ui.getEditorComponent(), theirs);
  } finally {
    await cleanup();
  }
});

test("pi restoring the default editor on session switch lets the next session reinstall", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd);
    await history.onSessionStart(host.ctx);
    host.build()?.addToHistory("typed before the switch");

    // pi 在 /new、/resume、/fork 时会先发 session_shutdown（flush），再通过
    // resetExtensionUI 把自定义编辑器还原成默认编辑器（setEditorComponent(undefined)）。
    await history.onSessionShutdown();
    host.ctx.ui.setEditorComponent(undefined);

    // 新 session 的 session_start 必须把 HistoryEditor 重新装回来，而不是永远丢给默认编辑器。
    await history.onSessionStart(host.ctx);
    const reinstalled = host.build();
    assert.ok(reinstalled);
    reinstalled.handleInput(UP);
    assert.equal(reinstalled.getText(), "typed before the switch");
  } finally {
    await cleanup();
  }
});

test("an editor we installed stays ours across session starts", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd);
    await history.onSessionStart(host.ctx);
    const first = host.ctx.ui.getEditorComponent();
    assert.ok(first);

    // /new 到另一个 cwd，但 pi 没有重置编辑器：不得重复替换同一个槽位。
    await history.onSessionStart({ ...host.ctx, cwd: join(cwd, "nested") });
    assert.equal(host.ctx.ui.getEditorComponent(), first);
  } finally {
    await cleanup();
  }
});

test("a second session in another workspace swaps the store behind the same editor", async () => {
  const { cwd, rootDir, cleanup } = await workspace();
  try {
    const other = join(cwd, "nested");
    const seeded = new InputHistoryStore(other, { rootDir, debounceMs: 0 });
    await seeded.load();
    seeded.record("nested workspace prompt");
    await seeded.flush();

    const history = createInputHistory({ rootDir, debounceMs: 0 });
    const host = context(cwd);
    await history.onSessionStart(host.ctx);
    const instance = host.build();
    assert.ok(instance);

    // /new in a different cwd: same editor instance, different history behind it.
    await history.onSessionStart({ ...host.ctx, cwd: other });
    instance.handleInput(UP);
    assert.equal(instance.getText(), "nested workspace prompt");
  } finally {
    await cleanup();
  }
});

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
  assert.ok(!instance.render(40).at(-1)?.includes("History"));

  instance.handleInput(UP);
  assert.match(instance.render(40).at(-1) ?? "", /── History 1\/2 ─+$/);
  instance.handleInput(UP);
  assert.match(instance.render(40).at(-1) ?? "", /── History 2\/2 ─+$/);

  // Typing leaves history behind, so the banner goes with it.
  instance.handleInput("x");
  assert.ok(!instance.render(40).at(-1)?.includes("History"));
});

test("setText from outside the editor ends browsing", () => {
  const { editor: instance } = editor(["newest"]);
  instance.handleInput(UP);
  assert.ok(instance.render(40).at(-1)?.includes("History"));
  instance.setText("injected by another extension");
  assert.ok(!instance.render(40).at(-1)?.includes("History"));
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
