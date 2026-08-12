import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager as AppKeybindingsManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import {
  CockpitClaudeEditor,
  historyBanner,
  type CockpitEditorRouteTarget,
  type CockpitClaudeEditorOptions,
} from "../src/claude-editor.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

function fakeEnvironment(): { tui: TUI; theme: EditorTheme; keybindings: AppKeybindingsManager } {
  return {
    tui: { terminal: { rows: 40, columns: 100 }, requestRender() {} } as unknown as TUI,
    theme: { borderColor: (value: string) => value, selectList: {} } as unknown as EditorTheme,
    // Real pi-tui keybindings (resolve cursorUp/Down), plus the app-interrupt
    // mapping the base editor uses to raise onEscape.
    keybindings: {
      matches(data: string, action: string): boolean {
        if (action === "app.interrupt") return data === ESCAPE;
        return new KeybindingsManager(TUI_KEYBINDINGS).matches(data, action as never);
      },
    } as unknown as AppKeybindingsManager,
  };
}

function makeEditor(
  entries: string[],
  overrides: Partial<CockpitClaudeEditorOptions> = {},
): { editor: CockpitClaudeEditor; recorded: string[]; setRoute: (target: CockpitEditorRouteTarget | undefined) => void } {
  const { tui, theme, keybindings } = fakeEnvironment();
  const recorded: string[] = [];
  let routeTarget: CockpitEditorRouteTarget | undefined;
  const editor = new CockpitClaudeEditor(tui, theme, keybindings, {
    doubleEscapeClearInput: true,
    emitEditorMarkers: false,
    getEntries: () => entries,
    record: (text) => recorded.push(text),
    getRouteTarget: () => routeTarget,
    ...overrides,
  });
  return {
    editor,
    recorded,
    setRoute: (target) => {
      routeTarget = target;
    },
  };
}

test("submitted prompts reach the store instead of the built-in history", () => {
  const { editor, recorded } = makeEditor([]);
  editor.addToHistory("delegate the review");
  assert.deepEqual(recorded, ["delegate the review"]);
  editor.handleInput(UP);
  assert.equal(editor.getText(), "");
});

test("up and down walk the persisted history and stop at both ends", () => {
  const { editor } = makeEditor(["newest", "older"]);
  editor.handleInput(UP);
  assert.equal(editor.getText(), "newest");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "older");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "older");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "newest");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "");
});

test("browsing from a half-typed prompt gives it back on the way down", () => {
  const { editor } = makeEditor(["newest"]);
  editor.setText("half typed");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "half typed");

  editor.handleInput("\x1b[H"); // home
  editor.handleInput(UP);
  assert.equal(editor.getText(), "newest");
  editor.handleInput(DOWN);
  assert.equal(editor.getText(), "half typed");
});

test("the history label shows only while browsing", () => {
  const { editor } = makeEditor(["newest", "older"]);
  assert.ok(!editor.render(40).at(-1)?.includes("History"));

  editor.handleInput(UP);
  assert.equal(editor.render(40).at(-1), "History 1/2");
  editor.handleInput(UP);
  assert.equal(editor.render(40).at(-1), "History 2/2");

  editor.handleInput("x");
  assert.ok(!editor.render(40).at(-1)?.includes("History"));
});

test("setText from outside the editor ends browsing", () => {
  const { editor } = makeEditor(["newest"]);
  editor.handleInput(UP);
  assert.ok(editor.render(40).at(-1)?.includes("History"));
  editor.setText("injected by another extension");
  assert.ok(!editor.render(40).at(-1)?.includes("History"));
});

test("route target renders as an immutable prefix inside the editor", () => {
  const { editor, setRoute } = makeEditor([]);
  editor.setText("run focused tests");
  const cursorBefore = editor.getCursor();
  setRoute({ label: "builder", sigil: "@", paint: (text) => `\x1b[33m${text}\x1b[39m` });
  const lines = editor.render(60);
  const routeLine = lines.find((line) => line.includes("@builder:"));
  assert.ok(routeLine);
  assert.ok(routeLine.includes("run focused tests"), "route target stays inline with editable text");
  assert.match(routeLine, /\x1b\[33m@builder:\x1b\[39m/);
  assert.deepEqual(editor.getCursor(), cursorBefore, "render restores the editable cursor");
  assert.equal(editor.getText(), "run focused tests", "prefix is not editor text");

  setRoute({ label: "build", sigil: "#", paint: (text) => text });
  const windowLines = editor.render(60);
  assert.ok(windowLines.some((line) => line.includes("#build:")), "window targets use the distinct window sigil");
  assert.ok(windowLines.every((line) => !line.includes("@build:")), "window targets use the distinct window sigil");

  editor.addToHistory("run focused tests");
  setRoute(undefined);
  assert.ok(editor.render(60).every((line) => !line.includes("@builder:") && !line.includes("#build:")));
});

test("double Escape clears a nonempty draft while empty input stays delegated to Pi", () => {
  let hostEscapes = 0;
  class StubEditor extends CockpitClaudeEditor {
    isShowingAutocomplete(): boolean {
      return false;
    }
  }
  const { tui, theme, keybindings } = fakeEnvironment();
  const editor = new StubEditor(tui, theme, keybindings, {
    doubleEscapeClearInput: true,
    emitEditorMarkers: false,
    getEntries: () => [],
  });
  (editor as unknown as { onEscape?: () => void }).onEscape = () => {
    hostEscapes += 1;
  };

  editor.setText("half typed");
  editor.handleInput(ESCAPE);
  assert.equal(editor.getText(), "half typed");
  assert.equal(hostEscapes, 1);

  editor.handleInput(ESCAPE);
  assert.equal(editor.getText(), "");
  assert.equal(hostEscapes, 1);

  editor.handleInput(ESCAPE);
  editor.handleInput(ESCAPE);
  assert.equal(hostEscapes, 3);
});

test("history banner truncates on narrow terminals without a horizontal rule", () => {
  const painted = historyBanner(3, 100, 30, 2, (text) => text);
  assert.ok(painted.includes("History"));
  assert.ok(!painted.includes("─"));
  const narrow = historyBanner(3, 100, 6, 1, (text) => text);
  assert.ok(visibleWidth(narrow) <= 6);
});
