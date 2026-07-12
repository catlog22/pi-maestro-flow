import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_MODES, nextApprovalMode } from "../src/extension/index.ts";

test("approval modes cycle through plan and wrap to default", () => {
  assert.deepEqual(APPROVAL_MODES, ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]);
  assert.equal(nextApprovalMode("default"), "acceptEdits");
  assert.equal(nextApprovalMode("acceptEdits"), "plan");
  assert.equal(nextApprovalMode("plan"), "dontAsk");
  assert.equal(nextApprovalMode("dontAsk"), "bypassPermissions");
  assert.equal(nextApprovalMode("bypassPermissions"), "default");
});
