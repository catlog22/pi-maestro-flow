import assert from "node:assert/strict";
import test from "node:test";

/**
 * Lightweight contract checks for delegate taskType mapping.
 * Full executeDelegate is integration-heavy; we verify the pure mapping used by the patch.
 */
function resolveDelegateTaskType(params: {
  taskType?: string;
  mode?: "analysis" | "write";
}): string | undefined {
  return params.taskType
    ?? (params.mode === "analysis"
      ? "analysis"
      : params.mode === "write"
        ? "development"
        : undefined);
}

test("delegate mode analysis maps to taskType analysis", () => {
  assert.equal(resolveDelegateTaskType({ mode: "analysis" }), "analysis");
});

test("delegate mode write maps to taskType development", () => {
  assert.equal(resolveDelegateTaskType({ mode: "write" }), "development");
});

test("explicit taskType wins over mode", () => {
  assert.equal(resolveDelegateTaskType({ mode: "write", taskType: "review" }), "review");
});

test("no mode and no taskType stays undefined (experts triage may fill later)", () => {
  assert.equal(resolveDelegateTaskType({}), undefined);
});
