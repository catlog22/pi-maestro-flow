import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { TeammateParams } from "../src/extension/schemas.ts";
import { TEAMMATE_THINKING_LEVELS } from "../src/shared/thinking.ts";

test("teammate schema accepts all thinking depths at top-level, task, and chain boundaries", () => {
  for (const thinking of TEAMMATE_THINKING_LEVELS) {
    assert.equal(Check(TeammateParams, { agent: "delegate", task: "work", thinking }), true);
    assert.equal(Check(TeammateParams, { tasks: [{ agent: "delegate", task: "work", thinking }] }), true);
    assert.equal(Check(TeammateParams, { agent: "delegate", task: "work", chain: [{ agent: "reviewer", thinking }] }), true);
  }
});

test("teammate schema rejects unsupported thinking depths", () => {
  assert.equal(Check(TeammateParams, { agent: "delegate", thinking: "ultra" }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ agent: "delegate", thinking: "ultra" }] }), false);
  assert.equal(Check(TeammateParams, { chain: [{ agent: "delegate", thinking: "ultra" }] }), false);
});
