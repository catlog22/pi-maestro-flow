import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPeerGoalObjection,
  buildGoalContextBlock,
  extractGoalClosureContext,
  loadPeerGoalContext,
} from "../src/extension/monitor-goals.ts";

// ---------------------------------------------------------------------------
// Closure-context extraction
// ---------------------------------------------------------------------------

test("extractGoalClosureContext pulls closure gates from a pi-peer goal", () => {
  const context = extractGoalClosureContext("goal-1", {
    id: "goal-1",
    objective: "Ship safer peer coordination",
    status: "open",
    closurePolicy: {
      requiredVotes: 2,
      minIndependentVotes: 1,
      requiredEvidence: ["handoff", "finding"],
    },
    events: [
      { id: "p1", type: "proposal", peerId: "a" },
      { id: "p2", type: "proposal", peerId: "b" },
      { id: "r1", type: "resolve", resolves: "p2", peerId: "a" },
      { id: "c1", type: "claim", peerId: "a", mode: "write" },
      { id: "c2", type: "claim", peerId: "b", mode: "read" },
      { id: "rel1", type: "release", resolves: "c2", peerId: "b" },
    ],
  });
  assert.equal(context?.goalId, "goal-1");
  assert.equal(context?.title, "Ship safer peer coordination");
  assert.equal(context?.status, "open");
  assert.equal(context?.requiredVotes, 2);
  assert.equal(context?.minIndependentVotes, 1);
  assert.deepEqual(context?.requiredEvidence, ["handoff", "finding"]);
  assert.equal(context?.activeClaims, 1, "c1 active, c2 released");
  assert.equal(context?.openProposals, 1, "p2 resolved via resolve event");
});

test("extractGoalClosureContext tolerates missing policy and minVotes alias", () => {
  const context = extractGoalClosureContext("goal-2", {
    objective: "Plain goal",
    events: [],
    metadata: { closurePolicy: { minVotes: 3 } },
  });
  assert.equal(context?.requiredVotes, undefined);
  assert.equal(context?.minIndependentVotes, 3, "minVotes alias maps to minIndependentVotes");
  assert.equal(context?.openProposals, 0, "no events → zero open proposals");
  assert.equal(context?.activeClaims, 0, "no events → zero active claims");
});

test("extractGoalClosureContext returns undefined for garbage", () => {
  assert.equal(extractGoalClosureContext("goal-3", null), undefined);
  assert.equal(extractGoalClosureContext("goal-3", "nope"), undefined);
});

test("buildGoalContextBlock renders closure standards for analysis", () => {
  const block = buildGoalContextBlock({
    goalId: "goal-1",
    title: "Ship safer peer coordination",
    status: "open",
    requiredVotes: 2,
    minIndependentVotes: 1,
    requiredEvidence: ["handoff", "finding"],
    openProposals: 1,
    activeClaims: 2,
  });
  assert.match(block, /Goal: goal-1/);
  assert.match(block, /Title: Ship safer peer coordination/);
  assert.match(block, /Status: open/);
  assert.match(block, /votes >= 2/);
  assert.match(block, /independent votes >= 1/);
  assert.match(block, /evidence: handoff, finding/);
  assert.match(block, /open proposals: 1/);
  assert.match(block, /active claims: 2/);
  assert.match(block, /completion criteria/);

  const minimal = buildGoalContextBlock({ goalId: "g" });
  assert.match(minimal, /Goal: g/);
  assert.doesNotMatch(minimal, /Closure gates/);
});

// ---------------------------------------------------------------------------
// Board loading (pi-peer .pi/peer-goals.json interop)
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "monitor-goals-"));
}

test("loadPeerGoalContext reads a goal from .pi/peer-goals.json", async () => {
  const root = await tempRoot();
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "peer-goals.json"), JSON.stringify({
      goals: {
        "goal-1": {
          id: "goal-1",
          title: "Ship safer peer coordination",
          status: "open",
          closurePolicy: { requiredVotes: 2, requiredEvidence: ["handoff"] },
        },
      },
    }), "utf8");

    const context = await loadPeerGoalContext(root, "goal-1");
    assert.equal(context?.goalId, "goal-1");
    assert.equal(context?.requiredVotes, 2);
    assert.deepEqual(context?.requiredEvidence, ["handoff"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPeerGoalContext returns undefined for missing board or unknown goal", async () => {
  const root = await tempRoot();
  try {
    assert.equal(await loadPeerGoalContext(root, "goal-1"), undefined, "missing board");

    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "peer-goals.json"), "not json {", "utf8");
    assert.equal(await loadPeerGoalContext(root, "goal-1"), undefined, "corrupt board");

    await writeFile(join(root, ".pi", "peer-goals.json"), JSON.stringify({ goals: {} }), "utf8");
    assert.equal(await loadPeerGoalContext(root, "goal-1"), undefined, "unknown goal");
    assert.equal(await loadPeerGoalContext(root, ""), undefined, "empty goal id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractGoalClosureContext end-to-end: full board shape", async () => {
  const context = extractGoalClosureContext("g9", {
    id: "g9",
    summary: "Improve finalization safety",
    status: "open",
    closurePolicy: { requiredVotes: 2, minIndependentVotes: 1 },
    events: [],
  });
  assert.equal(context?.title, "Improve finalization safety", "summary fallback for title");
  assert.equal(context?.activeClaims, 0, "empty events → zero claims");
  const block = buildGoalContextBlock(context!);
  assert.match(block, /active claims: 0/, "zero claims is meaningful — rendered");
});

// ---------------------------------------------------------------------------
// Objection posting — escalation becomes goal-board closure evidence
// ---------------------------------------------------------------------------

test("appendPeerGoalObjection writes a journal event for a known goal", async () => {
  const root = await tempRoot();
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "peer-goals.json"), JSON.stringify({
      goals: { "goal-1": { id: "goal-1", title: "Ship safer peer coordination", events: [] } },
    }), "utf8");

    const ok = await appendPeerGoalObjection(root, "goal-1", {
      peerId: "monitor",
      summary: "worker-window stalled after 2 interventions — monitor escalation.",
    });
    assert.equal(ok, true);

    const journal = await readFile(join(root, ".pi", "peer-goals.journal.jsonl"), "utf8");
    const record = JSON.parse(journal.trim().split("\n").at(-1)!);
    assert.equal(record.type, "event");
    assert.equal(record.goalId, "goal-1");
    assert.equal(record.event.type, "objection");
    assert.equal(record.event.severity, "blocking");
    assert.equal(record.event.peerId, "monitor");
    assert.match(record.event.summary, /stalled after 2 interventions/);
    assert.ok(record.event.id);
    assert.ok(record.event.at);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("appendPeerGoalObjection is best-effort: unknown goal / missing board", async () => {
  const root = await tempRoot();
  try {
    // Missing board → false, no throw.
    assert.equal(await appendPeerGoalObjection(root, "goal-1", { peerId: "monitor", summary: "x" }), false);

    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "peer-goals.json"), JSON.stringify({ goals: { other: {} } }), "utf8");
    assert.equal(await appendPeerGoalObjection(root, "goal-unknown", { peerId: "monitor", summary: "x" }), false);

    await writeFile(join(root, ".pi", "peer-goals.json"), "corrupt{", "utf8");
    assert.equal(await appendPeerGoalObjection(root, "goal-1", { peerId: "monitor", summary: "x" }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
