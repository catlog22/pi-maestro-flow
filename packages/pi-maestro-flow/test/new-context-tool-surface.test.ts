import assert from "node:assert/strict";
import test from "node:test";

import { createNewContextToolSurface } from "../src/compaction/new-context-tool-surface.ts";

test("New Context tools register only after enable and leave the active surface on disable", () => {
  const active = ["todo", "resource"];
  let registrations = 0;
  const surface = createNewContextToolSurface({
    getActiveTools: () => [...active],
    setActiveTools(names) {
      active.splice(0, active.length, ...names);
    },
  }, () => {
    registrations += 1;
    active.push("compact_history", "new_context");
  });

  assert.equal(surface.registered, false);
  surface.sync(false);
  assert.equal(registrations, 0);
  assert.deepEqual(active, ["todo", "resource"]);

  surface.sync(true);
  assert.equal(surface.registered, true);
  assert.equal(registrations, 1);
  assert.deepEqual(active, ["todo", "resource", "compact_history", "new_context"]);

  surface.sync(false);
  assert.deepEqual(active, ["todo", "resource"]);

  surface.sync(true);
  assert.equal(registrations, 1, "re-enable must reuse the existing definitions");
  assert.deepEqual(active, ["todo", "resource", "compact_history", "new_context"]);

  surface.deactivate();
  assert.deepEqual(active, ["todo", "resource"]);
});
