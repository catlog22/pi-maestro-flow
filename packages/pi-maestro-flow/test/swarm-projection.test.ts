import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadLatestTeamSwarmProjection } from "../src/swarm/projection.ts";
import { formatSwarmMonitorStatus, registerSwarmDisplay, resetSwarmDisplayStateForTest } from "../src/tools/swarm.ts";

function fixture(): { base: string; team: string } {
  const base = mkdtempSync(join(tmpdir(), "team-swarm-projection-"));
  const run = join(base, ".workflow", "sessions", "session-a", "runs", "run-001");
  const team = join(run, "work", "team");
  for (const path of [join(team, "pheromone", "history"), join(team, "trails"), join(run, "outputs")]) mkdirSync(path, { recursive: true });
  writeJson(join(team, "team-session.json"), {
    session_id: "run-001", task_description: "Analyze the project", status: "active", team_name: "swarm", skill: "team-swarm",
    iteration: 2, max_iterations: 5, n_ants_per_iter: 4, active_workers: ["ANT-3-1"], completed_iterations: [1, 2],
  });
  writeJson(join(team, "swarm-config.json"), { swarm: { n_ants: 4, max_iterations: 5 }, convergence: { max_iterations: 5 }, ant_prompt: { objective: "Analyze the project" } });
  writeJson(join(team, "task-space.json"), { nodes: ["a", "b", "c"], n_nodes: 3 });
  writeJson(join(team, "pheromone", "current.json"), { iteration: 2, tau: { "a::b": 1.5, "b::c": 0.8 }, stats: { entropy: 0.7, max: 1.5, mean: 1.15 } });
  writeJson(join(team, "pheromone", "history", "1.json"), { iteration: 1, stats: { entropy: 0.9, max: 1.2, mean: 1.0 } });
  writeJson(join(team, "pheromone", "history", "2.json"), { iteration: 2, stats: { entropy: 0.7, max: 1.5, mean: 1.15 } });
  writeFileSync(join(team, "trails", "1.jsonl"), `${JSON.stringify({ ant_id: "ANT-1-1", verified_score: 0.6 })}\n${JSON.stringify({ ant_id: "ANT-1-2", verified_score: 0.8 })}\n`);
  writeFileSync(join(team, "trails", "2.jsonl"), `${JSON.stringify({ ant_id: "ANT-2-1", verified_score: 0.9 })}\n`);
  writeJson(join(team, "best.json"), { ant_id: "ANT-2-1", iteration: 2, score: 0.9, path: ["a", "b"], candidate_solution: { summary: "Best candidate" }, evidence: ["src/a.ts:1"] });
  writeJson(join(run, "outputs", "swarm-report.json"), { status: "ok", best: { ant_id: "ANT-2-1", iteration: 2, score: 0.9 } });
  writeFileSync(join(run, "outputs", "best-solution.md"), "# Best\n");
  return { base, team };
}

test("team-swarm projection reads canonical JSON without native controller state", () => {
  const { base, team } = fixture();
  const projection = loadLatestTeamSwarmProjection(base);
  assert.ok(projection);
  assert.equal(projection.source, "team-swarm-json");
  assert.equal(projection.teamDir, team);
  assert.equal(projection.status, "completed");
  assert.equal(projection.iteration, 2);
  assert.equal(projection.maxIterations, 5);
  assert.deepEqual(projection.activeWorkers, ["ANT-3-1"]);
  assert.deepEqual(projection.nodes, ["a", "b", "c"]);
  assert.equal(projection.edges[0]?.pheromone, 1.5);
  assert.equal(projection.metrics[0]?.meanScore, 0.7);
  assert.equal(projection.metrics[1]?.bestScore, 0.9);
  assert.equal(projection.best?.summary, "Best candidate");
  assert.match(projection.reportPath ?? "", /swarm-report\.json$/);
  assert.match(formatSwarmMonitorStatus(projection), /TEAM SWARM 2\/5 · BEST 90% · COMPLETED/);
});

test("display integration exposes no swarm tool or slash command and keeps hidden status compatibility", async () => {
  const { base } = fixture();
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, Function[]>();
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const api = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  registerSwarmDisplay(api);
  const ctx = { cwd: base, ui: { setStatus(key: string, value: string | undefined) { statuses.set(key, value); }, notify(message: string) { notifications.push(message); } } };
  await handlers.get("session_start")?.[0]?.({}, ctx);
  assert.deepEqual(tools, []);
  assert.deepEqual(commands, []);
  assert.match(statuses.get("maestro-swarm") ?? "", /TEAM SWARM/);
  const result = await handlers.get("input")?.[0]?.({ text: "/swarm status" }, ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.match(notifications.at(-1) ?? "", /TEAM SWARM 2\/5/);
  const rejected = await handlers.get("input")?.[0]?.({ text: "/swarm execute anything" }, ctx);
  assert.deepEqual(rejected, { action: "handled" });
  assert.match(notifications.at(-1) ?? "", /Use \/skill:team-swarm/);
  resetSwarmDisplayStateForTest();
});

test("team-swarm display refresh does not create above-viewport stream components", async () => {
  const { base } = fixture();
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, Function[]>();
  const statuses: string[] = [];
  let customPanels = 0;
  let widgets = 0;
  let messages = 0;
  const api = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    sendMessage() { messages += 1; },
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  registerSwarmDisplay(api);
  const ctx = {
    cwd: base,
    ui: {
      setStatus(_key: string, value: string | undefined) { if (value) statuses.push(value); },
      setWidget() { widgets += 1; },
      async custom() { customPanels += 1; },
      notify() {},
    },
  };

  await handlers.get("session_start")?.[0]?.({}, ctx);
  await handlers.get("turn_start")?.[0]?.({}, ctx);
  await handlers.get("tool_execution_end")?.[0]?.({}, ctx);

  assert.deepEqual(tools, []);
  assert.deepEqual(commands, []);
  assert.equal(messages, 0);
  assert.equal(widgets, 0);
  assert.equal(customPanels, 0);
  assert.equal(statuses.length, 3);
  assert.equal(statuses.every((status) => /^TEAM SWARM /.test(status)), true);
  resetSwarmDisplayStateForTest();
});

function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
