import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Alt+T delegates Todo disclosure to Cockpit when Cockpit owns the panel", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_EVENT[\s\S]*?cockpitOwnsTodo = ownership\.todo === true/);
  assert.match(source, /if \(cockpitOwnsTodo\) \{[\s\S]*?setWidget\("todo-panel", undefined\)/);
  assert.match(
    source,
    /registerShortcut\(TODO_TOGGLE_KEY[\s\S]*?pi\.events\.emit\(COCKPIT_TODO_TOGGLE_EVENT, \{ expanded: panelMode === "expanded" \}\)/,
  );
});

test("todo main renderCall compresses under quiet mode via the shared quietToolCall shell", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  // Uniqueness/wiring guard (not an output assertion): the main todo tool's
  // renderCall — identified by its `const action = (args.action as string) ?? "?"`
  // opener — must route quiet mode through quietToolCall so it visually matches
  // every other quiet-aware tool. The two-space + ⋯ + bold name shell itself is
  // guaranteed by quiet-render; this only pins the wiring so it cannot regress.
  assert.match(
    source,
    /renderCall\(args, theme\) \{\s*const action = \(args\.action as string\) \?\? "\?";[\s\S]*?isQuietMode\(\)\) return quietToolCall\(theme, "todo"/,
  );
});
