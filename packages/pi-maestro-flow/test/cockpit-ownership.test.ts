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

test("Cockpit ownership also withdraws and restores Flow's live Goal panel", () => {
  const extensionSource = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const goalSource = readFileSync(new URL("../src/tools/goal.ts", import.meta.url), "utf8");
  assert.match(extensionSource, /setGoalPanelOwnership\(ownership\.goal === true, widgetCtx\)/);
  assert.match(goalSource, /export function setGoalPanelOwnership/);
  assert.match(goalSource, /if \(goalPanelOwnedExternally\) return/);
  assert.match(goalSource, /updateGoalWidget\(displayCtx, activeGoal, currentGoalPhase\(\)\)/);
});

test("todo main renderCall uses the shared single-line shell and clears after settlement", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  // Uniqueness/wiring guard (not an output assertion): the main Todo call
  // renderer must use the all-mode compact shell and disappear once the result
  // renderer owns the row, preventing call + result from stacking vertically.
  assert.match(
    source,
    /renderCall\(args, theme, ctx\) \{\s*if \(ctx\?\.isPartial === false\) return new Text\("", 0, 0\);\s*const action = \(args\.action as string\) \?\? "\?";[\s\S]*?return toolCallLine\(theme, "todo"/,
  );
});
