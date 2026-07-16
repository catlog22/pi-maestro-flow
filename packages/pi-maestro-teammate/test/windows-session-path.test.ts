import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { correlationSessionDirectoryName } from "../src/runs/execution.ts";

test("correlation ids become deterministic Windows-safe session directory components", () => {
  const correlationId = "SW-分析当前项目-20260716081126-d794b8:ANT-1-1";
  const safe = correlationSessionDirectoryName(correlationId);
  assert.doesNotMatch(safe, /[<>:"/\\|?*\u0000-\u001F]/);
  assert.match(safe, /^SW-分析当前项目-/);
  assert.equal(correlationSessionDirectoryName(correlationId), safe);
  assert.notEqual(
    correlationSessionDirectoryName("SW:test?one"),
    correlationSessionDirectoryName("SW:test*one"),
    "hash suffix must prevent collisions after sanitization",
  );

  const root = mkdtempSync(join(tmpdir(), "pi-teammate-session-"));
  try {
    assert.doesNotThrow(() => mkdirSync(join(root, "--D--pi-maestro-flow--", safe), { recursive: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserved Windows device names are never emitted directly", () => {
  assert.equal(correlationSessionDirectoryName("CON").startsWith("_CON"), true);
  assert.equal(correlationSessionDirectoryName("normal-agent"), "normal-agent");
});
