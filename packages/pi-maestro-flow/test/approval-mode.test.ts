import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_MODES,
  approvalModeStatusValue,
  effectivePermissionMode,
  nextApprovalMode,
} from "../src/extension/index.ts";

test("approval-mode cycling excludes Plan and wraps to default", () => {
  assert.deepEqual(APPROVAL_MODES, ["default", "acceptEdits", "dontAsk", "bypassPermissions"]);
  assert.equal(nextApprovalMode("default"), "acceptEdits");
  assert.equal(nextApprovalMode("acceptEdits"), "dontAsk");
  assert.equal(nextApprovalMode("dontAsk"), "bypassPermissions");
  assert.equal(nextApprovalMode("bypassPermissions"), "default");
  assert.equal(nextApprovalMode("plan"), "default");
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
  assert.equal(approvalModeStatusValue(false, "bypassPermissions"), "YOLO");
});

test("YOLO is safety-relevant and inherits into plan mode", () => {
  assert.equal(approvalModeStatusValue(true, "bypassPermissions"), "YOLO");
});

test("plan mode is display-only: permission evaluation inherits the prior approval mode", () => {
  // Entering plan mode no longer forces the read-only "plan" permission mode; it
  // keeps whatever approval mode was active before (including YOLO). The legacy
  // "plan" approval-mode carousel entry evaluates as "default".
  assert.equal(effectivePermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(effectivePermissionMode("default"), "default");
  assert.equal(effectivePermissionMode("acceptEdits"), "acceptEdits");
  assert.equal(effectivePermissionMode("dontAsk"), "dontAsk");
  assert.equal(effectivePermissionMode("plan"), "default");
});
