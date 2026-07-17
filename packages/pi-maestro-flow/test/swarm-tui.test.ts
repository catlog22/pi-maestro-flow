import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createSwarmGraph } from "../src/swarm/engine.ts";
import { renderSwarmAgentProgress } from "../src/swarm/progress.ts";
import { DEFAULT_SWARM_CONFIG, SWARM_SCHEMA_VERSION, type SwarmRunArtifact } from "../src/swarm/types.ts";
import { createSwarmToolProgressPublisher, formatSwarmMonitorStatus } from "../src/tools/swarm.ts";
import { SwarmOverlay, parseMouseWheelDelta, renderSwarmStatusLine } from "../src/tui/swarm-overlay.ts";

function snapshot(): SwarmRunArtifact {
  const config = { ...DEFAULT_SWARM_CONFIG };
  return {
    schemaVersion: SWARM_SCHEMA_VERSION,
    runId: "SW-test",
    objective: "Visualize teammate topology and convergence without breaking narrow terminals",
    status: "running",
    config,
    skill: { name: "swarm", status: "executing", phase: "explore" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    artifactDir: "D:/workspace/.workflow/swarms/SW-test",
    graph: createSwarmGraph(config),
    currentIteration: 2,
    metrics: [
      { iteration: 1, bestScore: 0.6, meanScore: 0.5, scoreDelta: 0.6, entropy: 0.95, diversity: 0.7, consensus: 0.6, convergence: 0.3, successRate: 1, totalTokens: 400, durationMs: 1000 },
      { iteration: 2, bestScore: 0.8, meanScore: 0.7, scoreDelta: 0.2, entropy: 0.7, diversity: 0.5, consensus: 0.8, convergence: 0.65, successRate: 1, totalTokens: 420, durationMs: 900 },
    ],
    iterations: [],
    preparation: {
      status: "ready",
      steps: [
        { id: "contract", label: "Validate contract", status: "completed", detail: "4 dimensions · 2 evidence rules · 3 weighted scores", durationMs: 2 },
        { id: "roles", label: "Load fixed roles", status: "completed", detail: "ant:swarm-ant · judge:swarm-scorer · analyst:swarm-analyst", durationMs: 3 },
        { id: "prompt", label: "Compile Ant Prompt", status: "completed", detail: "ant#prompt123 · judge#prompt456 · analyst#prompt789", durationMs: 2 },
        { id: "graph", label: "Compile graph", status: "completed", detail: "6 nodes · 15 edges", durationMs: 1 },
      ],
      roles: [
        { id: "ant", stage: "ant", agent: "swarm-ant", taskType: "analysis", mission: "Trace Skill activation and event boundaries.", description: "Generic Ant", source: "builtin", systemPromptMode: "replace", rolePromptHash: "abc123", rolePromptChars: 1200, promptChars: 900, promptHash: "prompt123", layers: ["fixed-role", "skill-contract", "trail-context", "output-contract"] },
        { id: "scorer", stage: "judge", agent: "swarm-scorer", taskType: "review", mission: "Calibrate evidence against visible execution.", description: "Generic scorer", source: "builtin", systemPromptMode: "replace", rolePromptHash: "def456", rolePromptChars: 1400, promptChars: 850, promptHash: "prompt456", layers: ["fixed-role", "skill-contract", "trail-context", "output-contract"] },
        { id: "analyst", stage: "analyst", agent: "swarm-analyst", taskType: "analysis", mission: "Synthesize the converged result.", description: "Generic analyst", source: "builtin", systemPromptMode: "replace", rolePromptHash: "ghi789", rolePromptChars: 1100, promptChars: 780, promptHash: "prompt789", layers: ["fixed-role", "skill-contract", "trail-context", "output-contract"] },
      ],
    },
    feedback: [],
    resumeCount: 0,
    stream: [
      { sequence: 1, timestamp: "2026-07-16T12:00:00.000Z", kind: "preparation", text: "Roles preloaded.", complete: true },
      { sequence: 2, timestamp: "2026-07-16T12:00:01.000Z", kind: "assistant", agentId: "ANT-2-2", iteration: 2, text: "Streaming investigation output with concrete evidence from the workspace." },
      { sequence: 3, timestamp: "2026-07-16T12:00:02.000Z", kind: "tool", agentId: "ANT-2-2", iteration: 2, text: "read · running" },
    ],
    activeAgents: [
      { antId: "ANT-2-1", iteration: 2, path: ["scope", "architecture", "verification"], role: "swarm-ant", stage: "explore", status: "completed", correlationId: "ant-one-correlation", tokens: 210, toolCount: 4, durationMs: 800, score: 0.8, completionSignal: "structured_output", recentTools: [{ name: "structured_output", status: "completed" }] },
      { antId: "ANT-2-2", iteration: 2, path: ["architecture", "risk", "implementation"], role: "swarm-ant", stage: "explore", status: "running", correlationId: "ant-two-correlation", tokens: 150, toolCount: 3, durationMs: 600, lastActivityAt: Date.now(), lastMessage: "Inspecting controller event flow.", recentTools: [{ name: "read", status: "running" }] },
    ],
    stageAgents: [
      { antId: "SCORER", iteration: 2, path: ["score"], role: "swarm-scorer", stage: "score", status: "pending", tokens: 0, toolCount: 0, durationMs: 0 },
      { antId: "ANALYST", iteration: 2, path: ["synthesize"], role: "swarm-analyst", stage: "synthesize", status: "pending", tokens: 0, toolCount: 0, durationMs: 0 },
    ],
    best: {
      antId: "ANT-2-1",
      iteration: 2,
      score: 0.8,
      path: ["scope", "architecture", "verification"],
      candidate: { summary: "Native state machine", details: "details", actions: ["build"], risks: ["cost"] },
      evidence: [{ ref: "src/test.ts:1", claim: "evidence" }],
    },
    convergence: { converged: false, triggeredBy: [], reason: "exploration remains productive" },
  };
}

test("swarm overlay renders all views width-safely from 1 to 120 columns", () => {
  const value = snapshot();
  const overlay = new SwarmOverlay({ snapshot: value, requestRender() {}, close() {} });
  for (const key of ["1", "2", "3", "4", "5"]) {
    overlay.handleInput(key);
    for (let width = 1; width <= 120; width++) {
      for (const line of overlay.render(width)) {
        assert.ok(visibleWidth(line) <= width, `view=${key} width=${width}: ${line}`);
      }
    }
  }
});

test("swarm overlay protects terminal height and exposes scrolling controls", () => {
  const overlay = new SwarmOverlay({ snapshot: snapshot(), requestRender() {}, close() {} });
  const lines = overlay.render(100);
  assert.ok(lines.length <= Math.max(6, Math.min(28, (process.stdout.rows || 30) - 4)));
  assert.match(lines[0] ?? "", /^╭/);
  assert.match(lines.at(-1) ?? "", /^╰/);
  assert.ok(lines.some((line) => /PgUp\/PgDn|rows:/.test(line)));
});

test("swarm overlay maps SGR mouse wheel input to manual scrolling and disposes tracking once", () => {
  const value = snapshot();
  value.activeAgents = Array.from({ length: 8 }, (_, index) => ({
    ...value.activeAgents[index % value.activeAgents.length]!,
    antId: `ANT-wheel-${index + 1}`,
    lastMessage: `Long diagnostic line ${index + 1}`,
  }));
  let renders = 0;
  let disposals = 0;
  const overlay = new SwarmOverlay({
    snapshot: value,
    requestRender() { renders++; },
    close() {},
    onDispose() { disposals++; },
  });
  overlay.update({
    ...value,
    stream: [...value.stream, { sequence: 4, timestamp: new Date().toISOString(), kind: "assistant", agentId: "ANT-wheel-1", text: "new tail" }],
  });
  const atTail = overlay.render(100).find((line) => line.includes("rows:"));
  overlay.handleInput("\x1b[<64;10;5M");
  const scrolled = overlay.render(100).find((line) => line.includes("rows:"));

  assert.equal(parseMouseWheelDelta("\x1b[<64;10;5M"), -3);
  assert.equal(parseMouseWheelDelta("\x1b[<65;10;5M"), 3);
  assert.equal(parseMouseWheelDelta("\x1b[<0;10;5M"), undefined);
  assert.notEqual(scrolled, atTail);
  assert.match(scrolled ?? "", /follow:off/);
  assert.ok(renders >= 2);
  overlay.dispose();
  overlay.dispose();
  assert.equal(disposals, 1);
});

test("swarm tool progress stays live, compact, throttled, and flushes the final snapshot", async () => {
  const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
  const publisher = createSwarmToolProgressPublisher((result) => updates.push(result), 20);
  const first = snapshot();
  publisher.publish(first);
  publisher.publish({
    ...first,
    skill: { ...first.skill, phase: "score" },
    stream: [...first.stream, { sequence: 4, timestamp: new Date().toISOString(), kind: "status", agentId: "SCORER", text: "Scoring candidates" }],
  });

  assert.equal(updates.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(updates.length, 2);
  assert.match(updates[1]!.content[0]!.text ?? "", /score/);
  assert.match(updates[1]!.content[0]!.text ?? "", /Scoring candidates/);
  assert.ok((updates[1]!.content[0]!.text ?? "").split("\n").length <= 4);

  const final = { ...first, status: "completed" as const, skill: { name: "swarm", status: "completed" as const, phase: "complete" } };
  publisher.publish(final, true);
  assert.equal(updates.length, 3);
  assert.match(updates[2]!.content[0]!.text ?? "", /complete · completed/);
  publisher.dispose();
});

test("swarm status line preserves explicit state cues without color", () => {
  const line = renderSwarmStatusLine(snapshot(), 120);
  assert.match(line, /Swarm ▶ running/);
  assert.match(line, /iter 2\/4/);
  assert.match(line, /best 80%/);
  assert.match(line, /conv 65%/);
});

test("swarm footer monitor keeps only iteration and convergence as the primary live signal", () => {
  assert.equal(formatSwarmMonitorStatus(snapshot()), "SWARM 2/4 · CONV 65%");
  assert.equal(
    formatSwarmMonitorStatus({ ...snapshot(), status: "completed" }),
    "SWARM 2/4 · CONV 65% · DONE",
  );
});

test("swarm live view exposes role, status, tool, message, and settlement diagnostics", () => {
  const overlay = new SwarmOverlay({ snapshot: snapshot(), requestRender() {}, close() {} });
  const rendered = overlay.render(120).join("\n");
  assert.match(rendered, /Agent diagnostics/);
  assert.match(rendered, /running @ANT-2-2 \(swarm-ant\)/);
  assert.match(rendered, /executing read/);
  assert.match(rendered, /Inspecting controller event flow/);
});

test("swarm agent diagnostics call out idle and structured-output settlement states", () => {
  const lines = renderSwarmAgentProgress([
    { antId: "ANT-idle", iteration: 1, path: ["runtime"], role: "swarm-ant", stage: "explore", status: "running", tokens: 10, toolCount: 1, durationMs: 20_000, lastActivityAt: Date.now() - 20_000 },
    { antId: "ANT-settled", iteration: 1, path: ["result"], role: "swarm-ant", stage: "explore", status: "completed", tokens: 20, toolCount: 2, durationMs: 500, completionSignal: "structured_output" },
  ], 120, { details: "all" }).join("\n");
  assert.match(lines, /idle 20s/);
  assert.match(lines, /settled via structured_output/);
});
