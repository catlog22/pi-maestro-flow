import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStageCommandArgs,
  buildSuggestion,
  parseSignalLines,
  stageEvidenceRefs,
  type SelfEvolveSignal,
} from "../src/self-evolve/runtime.ts";

function signal(overrides: Partial<SelfEvolveSignal> = {}): SelfEvolveSignal {
  return {
    schemaVersion: 1, id: "se-aaaaaaaaaaaa", kind: "candidate", source: "agent_end",
    dryRun: true, createdAt: "2026-10-26T00:00:00.000Z", sessionId: "pi-chat-session",
    traceHash: "a".repeat(64), candidateType: "knowhow", title: "Fence stale publication",
    summary: "Reject an obsolete generation before mutation.",
    evidence: [
      { type: "tool", ref: "read" },
      { type: "file", ref: "publisher.mjs:1" },
      { type: "tool", ref: "bash" },
      { type: "file", ref: "race.test.mjs:4-7" },
    ],
    ...overrides,
  };
}

test("stage leaves Workflow identity resolution to the CLI, not the Pi chat id", () => {
  const args = buildStageCommandArgs(signal(), "/tmp/staging.md")!;
  assert.deepEqual(args, [
    "knowledge", "stage", "knowhow", "Fence stale publication", "--content-file", "/tmp/staging.md",
    "--evidence", "publisher.mjs:1, race.test.mjs:4-7",
  ]);
  assert.equal(args.includes("--session"), false);
  assert.equal(args.includes("pi-chat-session"), false);
});

test("an explicit Maestro Run remains bound even when the signal has a Pi session id", () => {
  const args = buildStageCommandArgs(signal({ runId: "run-real-workflow" }), "/tmp/staging.md")!;
  assert.equal(args[args.indexOf("--run") + 1], "run-real-workflow");
  assert.equal(args.includes("--session"), false);
});

test("file evidence is selected before applying the eight-reference bound", () => {
  const evidence: SelfEvolveSignal["evidence"] = [
    ...Array.from({ length: 8 }, (_, index) => ({ type: "tool" as const, ref: `tool-${index}` })),
    ...Array.from({ length: 10 }, (_, index) => ({ type: "file" as const, ref: `file-${index}.ts:1` })),
  ];
  assert.deepEqual(stageEvidenceRefs(evidence), Array.from({ length: 8 }, (_, index) => `file-${index}.ts:1`));
  const args = buildStageCommandArgs(signal({ evidence }), "/tmp/staging.md")!;
  assert.equal(args[args.indexOf("--evidence") + 1], stageEvidenceRefs(evidence).join(", "));
});

test("tool-only evidence is not fabricated into a file anchor", () => {
  const args = buildStageCommandArgs(signal({ evidence: [{ type: "tool", ref: "bash" }] }), "/tmp/staging.md")!;
  assert.equal(args.includes("--evidence"), false);
  assert.equal(args.includes("bash"), false);
});

test("legacy signals without evidence remain readable without fabricating anchors", () => {
  const legacy = parseSignalLines([JSON.stringify({ ...signal(), evidence: undefined })])[0];
  const args = buildStageCommandArgs(legacy, "/tmp/staging.md")!;
  assert.equal(args.includes("--evidence"), false);
  assert.equal(args.includes("--session"), false);
});

test("existing heuristic suggestions cannot reintroduce stale identity or tool arguments", () => {
  const args = buildStageCommandArgs(signal({ suggestion: "maestro knowledge stage knowhow old --session pi-chat-session --evidence bash" }), "/tmp/staging.md")!;
  assert.equal(args.includes("--session"), false);
  assert.equal(args.includes("bash"), false);
  assert.equal(args[args.indexOf("--evidence") + 1], "publisher.mjs:1, race.test.mjs:4-7");
});

test("human suggestions omit Pi identity and placeholder sessions while retaining file evidence", () => {
  const command = buildSuggestion("knowhow", "Fence stale publication", {
    evidenceFile: "/tmp/staging.md", sessionId: "pi-chat-session",
    evidenceRefs: stageEvidenceRefs(signal().evidence),
  })!;
  assert.doesNotMatch(command, /--session|pi-chat-session|<session-id>/);
  assert.match(command, /--evidence "publisher\.mjs:1, race\.test\.mjs:4-7"/);
  assert.match(command, /--content-file \/tmp\/staging\.md/);
  assert.match(buildSuggestion("spec", "Explicit run", { runId: "run-real-workflow" })!, /--run run-real-workflow/);
});

test("unknown candidates still have no executable stage command", () => {
  assert.equal(buildStageCommandArgs(signal({ candidateType: "unknown" }), "/tmp/staging.md"), undefined);
  assert.equal(buildSuggestion("unknown", "Unclassified"), undefined);
});
