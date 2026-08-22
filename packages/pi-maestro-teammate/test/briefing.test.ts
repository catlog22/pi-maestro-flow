import assert from "node:assert/strict";
import test from "node:test";
import { assembleTaskPrompt, parseBriefingEntry } from "../src/runs/briefing.ts";
import { normalizeTeammateParams } from "../src/runs/execution.ts";

test("briefing entries parse into agent/file/text kinds by prefix", () => {
  assert.deepEqual(parseBriefingEntry("agent://abc-123"), { kind: "agent", value: "abc-123" });
  assert.deepEqual(parseBriefingEntry("file:docs/design.md"), { kind: "file", value: "docs/design.md" });
  assert.deepEqual(parseBriefingEntry("file:C:/repo/a.ts"), { kind: "file", value: "C:/repo/a.ts" });
  assert.deepEqual(parseBriefingEntry("plain red line"), { kind: "text", value: "plain red line" });
});

test("assembleTaskPrompt appends a lazy reference list and never expands entries", () => {
  const prompt = assembleTaskPrompt("Do the thing.", [
    "agent://abc-123",
    "file:docs/design.md",
    "single authoring manifest",
  ]);
  assert.match(prompt, /^Do the thing\./);
  assert.match(prompt, /## Briefing\nAgent entries use the resource tool; file paths are relative to your cwd\. Load references only when needed; text entries are already inline\.\n/);
  assert.match(prompt, /- \[agent\] agent:\/\/abc-123/);
  assert.match(prompt, /- \[file\] docs\/design\.md/);
  assert.match(prompt, /- \[text\] single authoring manifest/);
  assert.doesNotMatch(prompt, /read with your resource tool if needed/);
  assert.doesNotMatch(prompt, /relative to your cwd; read if needed/);
  // References stay unexpanded: the id is the whole payload.
  assert.ok(!prompt.includes("## Briefing\n\n"));
});

test("assembleTaskPrompt returns the prompt unchanged without briefing", () => {
  assert.equal(assembleTaskPrompt("Do the thing.", undefined), "Do the thing.");
  assert.equal(assembleTaskPrompt("Do the thing.", []), "Do the thing.");
});

test("normalization dedupes briefing entries and drops empties", () => {
  const result = normalizeTeammateParams({
    tasks: [{ prompt: "p", briefing: ["agent://a", " agent://a ", "", "text x"] }],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tasks[0]?.briefing, ["agent://a", "text x"]);
});

test("an all-empty briefing collapses to undefined", () => {
  const result = normalizeTeammateParams({ tasks: [{ prompt: "p", briefing: ["", "  "] }] });
  assert.equal(result.error, undefined);
  assert.equal(result.tasks[0]?.briefing, undefined);
});
