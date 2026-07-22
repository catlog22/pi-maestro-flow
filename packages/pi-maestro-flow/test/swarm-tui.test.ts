import assert from "node:assert/strict";
import test from "node:test";
import type { TeamSwarmProjection } from "../src/swarm/projection.ts";
import { SwarmOverlay, parseMouseWheelDelta, renderSwarmStatusLine } from "../src/tui/swarm-overlay.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function snapshot(): TeamSwarmProjection {
  return {
    source: "team-swarm-json", teamDir: "D:/run/work/team", runDir: "D:/run", outputsDir: "D:/run/outputs",
    sessionId: "run-001", objective: "Analyze project architecture", status: "active", iteration: 2, maxIterations: 5,
    antsPerIteration: 4, activeWorkers: ["ANT-3-1"], completedIterations: [1, 2], nodes: ["a", "b", "c"],
    edges: [{ source: "a", target: "b", pheromone: 1.5 }],
    metrics: [{ iteration: 1, bestScore: 0.7, meanScore: 0.6, entropy: 0.9, tauMax: 1.2, tauMean: 1.0 }],
    best: { antId: "ANT-1-1", iteration: 1, score: 0.7, path: ["a", "b"], summary: "Candidate", evidence: ["src/a.ts:1"] },
    updatedAt: new Date().toISOString(),
  };
}

test("team-swarm JSON overlay renders width-safely", () => {
  const overlay = new SwarmOverlay({ snapshot: snapshot(), requestRender() {}, close() {} });
  for (let width = 1; width <= 120; width++) {
    const rows = overlay.render(width);
    assert.ok(rows.length > 0);
    assert.equal(rows.every((row) => visibleWidth(row) <= width), true, `overflow at width ${width}`);
  }
});

test("team-swarm overlay retains views, scrolling, and mouse input", () => {
  let renders = 0;
  const overlay = new SwarmOverlay({ snapshot: snapshot(), requestRender() { renders += 1; }, close() {} });
  overlay.handleInput("2");
  assert.match(overlay.render(90).join("\n"), /Pheromone leaders/);
  overlay.handleInput("3");
  assert.match(overlay.render(90).join("\n"), /tau-max/);
  overlay.handleInput("4");
  assert.match(overlay.render(90).join("\n"), /Best ANT-1-1/);
  overlay.handleInput("\x1b[<65;10;5M");
  assert.ok(renders >= 4);
  assert.equal(parseMouseWheelDelta("\x1b[<64;10;5M"), -3);
  assert.equal(parseMouseWheelDelta("\x1b[<65;10;5M"), 3);
});

test("status line identifies team-swarm JSON projection", () => {
  assert.match(renderSwarmStatusLine(snapshot(), 120), /TEAM SWARM 2\/5 · ACTIVE · 1 active · BEST 70%/);
});
