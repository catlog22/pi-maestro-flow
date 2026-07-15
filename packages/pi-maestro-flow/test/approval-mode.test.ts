import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_MODES,
  approvalModeStatusValue,
  nextApprovalMode,
} from "../src/extension/index.ts";

test("approval modes cycle through plan and wrap to default", () => {
  assert.deepEqual(APPROVAL_MODES, ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]);
  assert.equal(nextApprovalMode("default"), "acceptEdits");
  assert.equal(nextApprovalMode("acceptEdits"), "plan");
  assert.equal(nextApprovalMode("plan"), "dontAsk");
  assert.equal(nextApprovalMode("dontAsk"), "bypassPermissions");
  assert.equal(nextApprovalMode("bypassPermissions"), "default");
  assert.equal(
    nextApprovalMode("dontAsk", new Set(["bypassPermissions"])),
    "default",
  );
});

test("plan mode owns the mode indicator without a duplicate approval status", () => {
  assert.equal(approvalModeStatusValue(true, "default"), undefined);
  assert.equal(approvalModeStatusValue(true, "plan"), undefined);
  assert.equal(approvalModeStatusValue(false, "default"), "APPROVAL default");
  assert.equal(approvalModeStatusValue(false, "acceptEdits"), "APPROVAL acceptEdits");
});

test("bypassPermissions is presented as the explicit YOLO mode", () => {
  assert.equal(approvalModeStatusValue(false, "bypassPermissions"), "APPROVAL YOLO");
});
