import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8")
  + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");

test("agent log trimming rejects sparse entries before reading their length", () => {
  assert.match(source, /if \(typeof line !== "string"\) return false;/);
  assert.match(source, /if \(typeof existingLine !== "string"\) continue;/);
});

test("root progress never reuses a streaming cursor after its log entry was trimmed", () => {
  const rootStart = source.indexOf("const pendingByTask = new Map<number, AgentProgress>();");
  const rootEnd = source.indexOf("onChildRequest:", rootStart);
  assert.ok(rootStart >= 0 && rootEnd > rootStart);
  const rootProgress = source.slice(rootStart, rootEnd);

  assert.match(rootProgress, /activeAgent\.outputLog\[logState\.streamingLineIdx\] ===/);
  assert.match(rootProgress, /ownLog\.outputLog\[logState\.childStreamingLineIdx\] ===/);
  assert.match(rootProgress, /logStates\.clear\(\)/);
  assert.doesNotMatch(rootProgress, /if \(logState\.streamingLineIdx >= 0\)/);
});
