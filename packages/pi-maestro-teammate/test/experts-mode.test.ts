import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  classifyIntent,
  ensureExpertsDispatch,
  evaluateHardGate,
  getMode,
  setMode,
  buildTurnReminder,
  injectTurnReminder,
  setLeaderWaiting,
  clearLeaderWaiting,
  getLeaderWaiting,
  getStatus,
  formatExpertResult,
  parseExpertResultAgentId,
  noteExpertsSettled,
  type TeammateParamsLike,
} from "../src/experts-mode/index.ts";

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "experts-mode-wire-"));
}

test("ensureExpertsDispatch fills taskType only in experts mode", () => {
  // P4.1/P5.1: host may export MAESTRO_STAGE=execute which would force development
  // over keyword triage — isolate env for this keyword-only assertion.
  withCleanMaestroEnv(() => {
    const cwd = tempCwd();
    const params: TeammateParamsLike = {
      tasks: [{ prompt: "搜索 PositionManager 调用链" }],
    };

    const normal = ensureExpertsDispatch(params, { cwd, mode: "normal", record: false });
    assert.equal(normal.tasks?.[0]?.taskType, undefined);

    setMode("experts", cwd);
    const experts = ensureExpertsDispatch(params, { cwd, mode: "experts", record: false });
    assert.equal(experts.tasks?.[0]?.taskType, "explore");
    assert.equal(experts.tasks?.[0]?.agent, "explorer");
    assert.equal(experts.__experts?.forced, true);
  });
});

test("ensureExpertsDispatch does not override explicit taskType", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  const kept = ensureExpertsDispatch({
    tasks: [{ prompt: "anything", taskType: "testing", agent: "general" }],
  }, { cwd, mode: "experts", record: false });
  assert.equal(kept.tasks?.[0]?.taskType, "testing");
  assert.equal(kept.tasks?.[0]?.agent, "general");
});

test("ensureExpertsDispatch does not set model (routing owns models)", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  const out = ensureExpertsDispatch({
    tasks: [{ prompt: "实现 JWT middleware 并改代码" }],
  } as TeammateParamsLike, { cwd, mode: "experts", record: false });
  assert.equal(out.tasks?.[0]?.taskType, "development");
  assert.equal(out.tasks?.[0]?.model, undefined);
});

test("hard-gate denies write under experts (P5), allows under normal", () => {
  const cwd = tempCwd();
  assert.equal(evaluateHardGate("write", { cwd, mode: "normal" }).decision, "allow");
  // Business path write is denied for Leader under experts (P5 strict).
  const denied = evaluateHardGate("write", {
    cwd,
    mode: "experts",
    toolInput: { path: "src/app.ts" },
    stage: "execute",
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.rewriteSuggestion?.taskType);
  assert.equal(evaluateHardGate("teammate", { cwd, mode: "experts" }).decision, "allow");
});

test("classifyIntent maps planning and debug", () => {
  assert.equal(classifyIntent("设计 Experts Mode 架构方案").taskType, "planning");
  assert.equal(classifyIntent("这个 bug 报错 stack 怎么调试").taskType, "debug");
});

test("mode state persists under cwd", () => {
  const cwd = tempCwd();
  assert.equal(getMode(cwd), "normal");
  setMode("experts", cwd);
  assert.equal(getMode(cwd), "experts");
  assert.ok(fs.existsSync(path.join(cwd, ".experts-mode.json")));
});

test("source wiring: runTeammate and teammate tool call ensure before routing", () => {
  // Static contract: patch must keep this order in monorepo sources.
  const execution = fs.readFileSync(
    path.resolve("src/runs/execution.ts"),
    "utf8",
  );
  const extension = fs.readFileSync(
    path.resolve("src/extension/index.ts"),
    "utf8",
  );
  const preparedIdx = execution.indexOf("const prepared = ensureExpertsDispatch");
  const routeIdx = execution.indexOf("applyModelRouting(", preparedIdx);
  assert.ok(preparedIdx > 0, "runTeammate must call ensureExpertsDispatch");
  assert.ok(routeIdx > preparedIdx, "runTeammate must applyModelRouting after ensure");
  assert.ok(
    execution.slice(routeIdx, routeIdx + 80).includes("prepared"),
    "applyModelRouting must receive prepared params",
  );

  const ensureIdx = extension.indexOf("params = ensureExpertsDispatch");
  const applyIdx = extension.indexOf("params = applyModelRouting", ensureIdx);
  assert.ok(ensureIdx > 0, "teammate tool must call ensureExpertsDispatch");
  assert.ok(applyIdx > ensureIdx, "teammate tool must applyModelRouting after ensure");
});

// --- G4 team-worker taskType force (frontmatter + spawn templates) ---
import { resolveAgent } from "../src/agents/agents.ts";

const TEAM_SKILLS = [
  "team-arch-opt",
  "team-coordinate",
  "team-issue",
  "team-lifecycle-v4",
  "team-perf-opt",
  "team-review",
  "team-swarm",
  "team-testing",
];

test("G4 team-worker frontmatter taskType reaches resolveAgent", () => {
  // applyModelRouting falls back to resolveAgent(cwd, agent).taskType when the
  // spawn omits taskType; the team-worker agent must carry a development default
  // so team skill spawns never skip teammate-models routing.
  const agent = resolveAgent(process.cwd(), "team-worker");
  assert.ok(agent, "team-worker must be discoverable from repo cwd");
  assert.equal(agent!.taskType, "development");
});

test("G4 team skill spawn templates carry taskType at top and task level", () => {
  const expected = 'teammate({ agent: "team-worker", taskType: "development", tasks: [{ name: ';
  for (const skill of TEAM_SKILLS) {
    const file = path.resolve(`../../.pi/skills/${skill}/SKILL.md`);
    assert.ok(fs.existsSync(file), `${skill}/SKILL.md must exist`);
    const content = fs.readFileSync(file, "utf8");
    const matches = content.split(expected).length - 1;
    // team-issue documents serial + parallel spawns; others at least one.
    assert.equal(matches, skill === "team-issue" ? 2 : 1, `${skill} must carry taskType on every team-worker spawn`);
  }
});

test("G4 team-worker.md frontmatter declares taskType: development", () => {
  const file = path.resolve("../../.pi/agents/team-worker.md");
  assert.ok(fs.existsSync(file), "team-worker.md must exist");
  const frontmatter = fs.readFileSync(file, "utf8").split("---")[1] ?? "";
  assert.match(frontmatter, /taskType:\s*development/);
});

// --- G5 hard-deny probe (UNPROVEN cell -> PROVEN at library + adapter) ---
test("G5 hard-deny probe: write src/hard-deny-probe.ts denied with rewrite", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const gate = evaluateHardGate("write", {
    cwd,
    mode: "experts",
    stage: "execute",
    toolInput: { path: "src/hard-deny-probe.ts", content: "export const x = 1;" },
  });
  assert.equal(gate.decision, "deny");
  assert.ok(gate.rewriteSuggestion, "deny must carry rewriteSuggestion");
  assert.equal(gate.rewriteSuggestion!.action, "teammate");
  assert.equal(gate.rewriteSuggestion!.taskType, "development");
  assert.equal(gate.rewriteSuggestion!.agent, "general-executor");
  assert.ok(String(gate.rewriteSuggestion!.pathHint).includes("hard-deny-probe.ts"));
  // Same probe outside experts mode must allow (control).
  assert.equal(evaluateHardGate("write", { cwd, mode: "normal", toolInput: { path: "src/hard-deny-probe.ts" } }).decision, "allow");
});

test("G5 adapter contract: pi-adapter deny branch returns block:true with rewrite", () => {
  // Static contract (same style as source wiring): the host adapter must turn a
  // hard-gate deny into a blocking pre-tool result carrying teammate rewrite.
  const adapter = fs.readFileSync(
    path.resolve("../pi-maestro-flow/src/hooks/pi-adapter.ts"),
    "utf8",
  );
  const denyIdx = adapter.indexOf('gate.decision === "deny"');
  assert.ok(denyIdx > 0, "pi-adapter must branch on hard-gate deny");
  const branch = adapter.slice(denyIdx, denyIdx + 500);
  assert.ok(branch.includes("block: true"), "deny branch must return block:true");
  assert.ok(branch.includes("reason"), "deny branch must return a reason");
  assert.ok(branch.includes("rewrite"), "deny branch must embed teammate rewrite guidance");
  const callIdx = adapter.indexOf("evaluateHardGate(event.toolName");
  assert.ok(callIdx > 0 && callIdx < denyIdx, "adapter must call evaluateHardGate before the deny branch");
});


test("P2-1 buildTurnReminder only in experts mode", () => {
  assert.equal(buildTurnReminder("normal"), "");
  const r = buildTurnReminder("experts");
  assert.match(r, /experts_mode_reminder/);
  assert.match(r, /taskType/);
  assert.match(r, /Do NOT hardcode model/);
  const injected = injectTurnReminder("BASE PROMPT", { mode: "experts" });
  assert.match(injected, /BASE PROMPT/);
  assert.match(injected, /experts_mode_reminder/);
  const stripped = injectTurnReminder(injected, { mode: "normal" });
  assert.ok(!stripped.includes("experts_mode_reminder"));
});

test("P2-2 leader waiting state machine", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  assert.equal(getLeaderWaiting(cwd).leaderWaiting, false);
  setLeaderWaiting(true, { cwd, activeDelta: 2, agentIds: ["a", "b"] });
  let w = getLeaderWaiting(cwd);
  assert.equal(w.leaderWaiting, true);
  assert.equal(w.activeCount, 2);
  setLeaderWaiting(true, { cwd, activeDelta: -1 });
  w = getLeaderWaiting(cwd);
  assert.equal(w.activeCount, 1);
  clearLeaderWaiting(cwd, { reason: "test-done" });
  w = getLeaderWaiting(cwd);
  assert.equal(w.leaderWaiting, false);
  assert.equal(w.activeCount, 0);
  const st = getStatus(cwd);
  assert.equal(st.leaderWaiting, false);
});

test("P2-2 ensureExpertsDispatch sets leaderWaiting", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  ensureExpertsDispatch({ tasks: [{ prompt: "实现 feature X", name: "dev-1" }] }, { cwd, mode: "experts", record: true });
  assert.equal(getLeaderWaiting(cwd).leaderWaiting, true);
  assert.ok(getLeaderWaiting(cwd).activeCount >= 1);
});

test("P2-3 formatExpertResult envelope", () => {
  const text = formatExpertResult({
    agentId: "abc-123",
    agentName: "Lee",
    content: "done work",
    taskType: "development",
    exitCode: 0,
  });
  assert.match(text, /Agent Lee has completed/);
  assert.match(text, /agentId: abc-123/);
  assert.match(text, /--- RESULT ---/);
  assert.match(text, /done work/);
  assert.equal(parseExpertResultAgentId(text), "abc-123");
  const again = formatExpertResult({ agentId: "x", content: text, skipIfPresent: true });
  assert.ok(again.includes("--- RESULT ---"));
  // should not double-wrap
  assert.equal(again.match(/--- RESULT ---/g)?.length, 1);
});

test("P2-4 role is not model — ensure never assigns model", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  const out = ensureExpertsDispatch({
    tasks: [{ prompt: "实现 JWT middleware 并改代码", agent: "general-executor" }],
  } as TeammateParamsLike, { cwd, mode: "experts", record: false });
  assert.equal(out.tasks?.[0]?.taskType, "development");
  assert.equal(out.tasks?.[0]?.agent, "general-executor");
  assert.equal(out.tasks?.[0]?.model, undefined);
  // agent name must not look like provider/model
  assert.ok(!String(out.tasks?.[0]?.agent).includes("/"));
});

test("P3 noteExpertsSettled decrements and clears at zero", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  setLeaderWaiting(true, { cwd, activeDelta: 2, agentIds: ["a", "b"] });
  noteExpertsSettled(cwd, { settledCount: 1, agentId: "a", reason: "one-done" });
  let w = getLeaderWaiting(cwd);
  assert.equal(w.activeCount, 1);
  assert.equal(w.leaderWaiting, true);
  assert.ok(!w.lastAgentIds.includes("a"));
  noteExpertsSettled(cwd, { settledCount: 1, reason: "two-done" });
  w = getLeaderWaiting(cwd);
  assert.equal(w.activeCount, 0);
  assert.equal(w.leaderWaiting, false);
});

test("P3 noteExpertsSettled is no-op when not waiting", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  const before = getLeaderWaiting(cwd);
  const after = noteExpertsSettled(cwd, { settledCount: 3, reason: "noop" });
  assert.equal(after.activeCount, before.activeCount);
  assert.equal(after.leaderWaiting, false);
});

test("P3 source wiring: runTeammate finally notes settle", () => {
  const execution = fs.readFileSync(path.resolve("src/runs/execution.ts"), "utf8");
  assert.ok(execution.includes("noteExpertsSettled"), "runTeammate must call noteExpertsSettled");
  assert.ok(execution.includes("runTeammate-settled"), "must use settle reason");
  const extension = fs.readFileSync(path.resolve("src/extension/index.ts"), "utf8");
  assert.ok(extension.includes("extension-graph-settled") || extension.includes("noteExpertsSettled"));
  assert.ok(extension.includes("extension-single-settled"));
});


// --- P4 Stage Experts Policy ---
import {
  resolveStageExpertsPlan,
  resolveStageName,
  getStagePolicy,
  primaryStageAssignment,
  clearRulesCache,
} from "../src/experts-mode/index.ts";

test("P4 resolveStageName aliases maestro-execute → execute", () => {
  clearRulesCache();
  assert.equal(resolveStageName("maestro-execute"), "execute");
  assert.equal(resolveStageName("quality-review"), "review");
  assert.equal(resolveStageName("analyze-macro"), "analyze");
});

test("P4 getStagePolicy returns execute development pipeline", () => {
  clearRulesCache();
  const found = getStagePolicy("execute");
  assert.ok(found);
  assert.equal(found!.stage, "execute");
  assert.equal(found!.policy.pipeline[0]?.taskType, "development");
});

test("P4 resolveStageExpertsPlan empty in normal mode", () => {
  const cwd = tempCwd();
  setMode("normal", cwd);
  clearRulesCache();
  const plan = resolveStageExpertsPlan("execute", "实现 JWT", { cwd, mode: "normal", record: false });
  assert.equal(plan.mode, "normal");
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.source, "none");
});

test("P4 resolveStageExpertsPlan uses stagePolicies for analyze", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const plan = resolveStageExpertsPlan("analyze", "理解认证流程", { cwd, mode: "experts", record: true });
  assert.equal(plan.mode, "experts");
  assert.equal(plan.source, "stage-policy");
  assert.equal(plan.stage, "analyze");
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0]?.taskType, "explore");
  assert.equal(plan.tasks[0]?.agent, "explorer");
  assert.equal(plan.tasks[1]?.taskType, "analysis");
  assert.equal(plan.tasks[1]?.agent, "analyst");
  assert.ok(Array.isArray(plan.tasks[1]?.dependsOn));
  assert.ok(plan.leaderInstructions.includes("stage=\"analyze\""));
  const status = getStatus(cwd);
  assert.equal(status.activeStage?.stage, "analyze");
});

test("P4 ensureExpertsDispatch stage beats keyword triage", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  // Prompt looks like explore, but stage=execute must force development
  const out = ensureExpertsDispatch(
    { tasks: [{ prompt: "搜索 PositionManager 调用链" }] } as TeammateParamsLike,
    { cwd, mode: "experts", record: false, stage: "execute" },
  );
  assert.equal(out.tasks?.[0]?.taskType, "development");
  assert.equal(out.tasks?.[0]?.agent, "general-executor");
  assert.equal(out.__experts?.stageForced, true);
  assert.equal(out.__experts?.stage, "execute");
});

test("P4 ensureExpertsDispatch params.stage works without opts.stage", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const out = ensureExpertsDispatch(
    { tasks: [{ prompt: "随便" }], stage: "review" } as TeammateParamsLike,
    { cwd, mode: "experts", record: false },
  );
  assert.equal(out.tasks?.[0]?.taskType, "review");
  assert.equal(out.tasks?.[0]?.agent, "analyst");
});

test("P4 explicit taskType still wins over stage", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const out = ensureExpertsDispatch(
    { tasks: [{ prompt: "x", taskType: "testing", agent: "general" }] },
    { cwd, mode: "experts", record: false, stage: "execute" },
  );
  assert.equal(out.tasks?.[0]?.taskType, "testing");
  assert.equal(out.tasks?.[0]?.agent, "general");
  assert.equal(out.__experts?.stageForced, false);
});

test("P4 primaryStageAssignment and reminder mention stage", () => {
  clearRulesCache();
  const a = primaryStageAssignment("plan");
  assert.equal(a?.taskType, "planning");
  assert.equal(a?.agent, "planner");
  const r = buildTurnReminder("experts", { stage: "execute" });
  assert.ok(r.includes("execute"));
  assert.ok(r.includes("stagePolicies") || r.includes("stage="));
});

test("P4 resolveStageExpertsPlan never sets model", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const plan = resolveStageExpertsPlan("debug", "修 bug", { cwd, mode: "experts", record: false });
  assert.equal(plan.tasks[0]?.taskType, "debug");
  assert.equal(plan.tasks[0]?.model, undefined);
});

// --- P5 Lead discipline ---
import {
  buildRewriteSuggestion,
  matchPathPattern,
  isHeavyMutationTool,
} from "../src/experts-mode/index.ts";

test("P5 denies business write with rewrite suggestion", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const gate = evaluateHardGate("write", {
    cwd,
    mode: "experts",
    stage: "execute",
    toolInput: { path: "packages/foo/src/index.ts", content: "x" },
  });
  assert.equal(gate.decision, "deny");
  assert.ok(gate.reason.includes("DENIES") || gate.reason.includes("denies") || gate.reason.includes("teammate"));
  assert.equal(gate.rewriteSuggestion?.action, "teammate");
  assert.equal(gate.rewriteSuggestion?.taskType, "development");
  assert.equal(gate.rewriteSuggestion?.agent, "general-executor");
  assert.equal(gate.rewriteSuggestion?.stage, "execute");
  assert.ok(String(gate.rewriteSuggestion?.pathHint || "").includes("index.ts"));
});

test("P5 allows leader write to report.md and outputs/**", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  assert.equal(
    evaluateHardGate("write", {
      cwd,
      mode: "experts",
      toolInput: { path: "report.md" },
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateHardGate("write", {
      cwd,
      mode: "experts",
      toolInput: { path: "outputs/execution.json" },
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateHardGate("edit", {
      cwd,
      mode: "experts",
      toolInput: { path: ".workflow/sessions/x/run.json" },
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateHardGate("write", {
      cwd,
      mode: "experts",
      toolInput: { path: "notes/scratch.md" },
    }).decision,
    "allow",
  );
});

test("P5 bash: deny destructive, allow maestro/git status", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const denied = evaluateHardGate("bash", {
    cwd,
    mode: "experts",
    stage: "execute",
    toolInput: { command: "rm -rf src" },
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.rewriteSuggestion?.taskType);

  assert.equal(
    evaluateHardGate("bash", {
      cwd,
      mode: "experts",
      toolInput: { command: "maestro session status foo" },
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateHardGate("bash", {
      cwd,
      mode: "experts",
      toolInput: { command: "git status" },
    }).decision,
    "allow",
  );
});

test("P5 stage influences rewrite taskType (review vs execute)", () => {
  clearRulesCache();
  const exec = buildRewriteSuggestion("write", { path: "src/a.ts" }, "execute");
  assert.equal(exec.taskType, "development");
  const rev = buildRewriteSuggestion("write", { path: "src/a.ts" }, "review");
  assert.equal(rev.taskType, "review");
  const ana = buildRewriteSuggestion("edit", { path: "src/a.ts" }, "analyze");
  assert.equal(ana.taskType, "explore");
});

test("P5 matchPathPattern globs", () => {
  const cwd = tempCwd();
  assert.equal(matchPathPattern("outputs/a.json", "outputs/**", cwd), true);
  assert.equal(matchPathPattern("src/a.ts", "outputs/**", cwd), false);
  assert.equal(matchPathPattern("report.md", "report.md", cwd), true);
  assert.equal(matchPathPattern("runs/x/report.md", "**/report.md", cwd), true);
  assert.equal(isHeavyMutationTool("write"), true);
  assert.equal(isHeavyMutationTool("read"), false);
});

test("P5 normal mode never denies", () => {
  const cwd = tempCwd();
  setMode("normal", cwd);
  clearRulesCache();
  assert.equal(
    evaluateHardGate("write", {
      cwd,
      mode: "normal",
      toolInput: { path: "src/secret.ts" },
    }).decision,
    "allow",
  );
});

// --- P6 roster + observability ---
import {
  getRoster,
  resolveRosterEntry,
  agentForTaskTypeFromRoster,
  buildCanvasSnapshot,
  getInFlight,
  trackInFlight,
  settleInFlight,
  clearInFlight,
} from "../src/experts-mode/index.ts";

test("P6 getRoster returns default roles without models", () => {
  clearRulesCache();
  const roster = getRoster();
  assert.ok(roster.length >= 4);
  const exec = roster.find((r) => r.id === "general-executor" || r.defaultTaskType === "development");
  assert.ok(exec);
  assert.equal(exec!.agent, "general-executor");
  assert.equal(exec!.defaultTaskType, "development");
  for (const r of roster) {
    assert.ok(r.agent);
    assert.ok(r.defaultTaskType);
    assert.equal((r as { model?: string }).model, undefined);
  }
});

test("P6 resolveRosterEntry by id/agent/taskType", () => {
  clearRulesCache();
  assert.equal(resolveRosterEntry("explorer")?.agent, "explorer");
  assert.equal(resolveRosterEntry("development")?.agent, "general-executor");
  assert.equal(resolveRosterEntry("planner")?.defaultTaskType, "planning");
  assert.equal(agentForTaskTypeFromRoster("review"), "reviewer");
});

test("P6 getStatus includes roster, inFlight, activeStage", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearInFlight(cwd);
  ensureExpertsDispatch(
    { tasks: [{ name: "dev-1", prompt: "实现 x" }], stage: "execute" },
    { cwd, mode: "experts", record: true },
  );
  const status = getStatus(cwd);
  assert.equal(status.mode, "experts");
  assert.ok(Array.isArray(status.roster) && status.roster.length > 0);
  assert.ok(status.inFlight.some((e) => e.name === "dev-1" || e.id === "dev-1"));
  assert.equal(status.activeStage?.stage, "execute");
  assert.equal(status.leaderWaiting, true);
});

test("P6 settle clears inFlight with noteExpertsSettled", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearInFlight(cwd);
  ensureExpertsDispatch(
    { tasks: [{ name: "r1", agent: "general-executor", prompt: "x" }], stage: "execute" },
    { cwd, mode: "experts", record: true },
  );
  assert.ok(getInFlight(cwd).length >= 1);
  noteExpertsSettled(cwd, { agentId: "r1", settledCount: 1 });
  const left = getInFlight(cwd);
  assert.equal(left.find((e) => e.id === "r1" || e.name === "r1"), undefined);
});

test("P6 buildCanvasSnapshot schema", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  trackInFlight([{ id: "c1", agent: "analyst", taskType: "analysis", correlationId: "corr-1" }], { cwd, stage: "review" });
  const snap = buildCanvasSnapshot(cwd);
  assert.equal(snap.schema, "experts-canvas/1.0");
  assert.equal(snap.mode, "experts");
  assert.ok(snap.roster.length > 0);
  assert.ok(snap.inFlight.some((e) => e.correlationId === "corr-1"));
  assert.equal(typeof snap.updatedAt, "string");
});

test("P6 track/settle/clear inFlight helpers", () => {
  const cwd = tempCwd();
  clearInFlight(cwd);
  trackInFlight([
    { id: "a", agent: "explorer", taskType: "explore" },
    { id: "b", agent: "analyst", taskType: "analysis", correlationId: "cid-b" },
  ], { cwd });
  assert.equal(getInFlight(cwd).length, 2);
  settleInFlight("cid-b", { cwd });
  assert.equal(getInFlight(cwd).length, 1);
  settleInFlight("a", { cwd });
  assert.equal(getInFlight(cwd).length, 0);
});

// --- P7 settle → knowledge harvest ---
import {
  harvestKnowledgeOnSettle,
  assessKnowledgeCandidate,
  getKnowledgeSuggestions,
  clearKnowledgeSuggestions,
  buildStageCommand,
} from "../src/experts-mode/index.ts";

const GOOD_PITFALL = [
  "PITFALL: When doing experts hard-gate path matching on Windows,",
  "normalize separators before glob match because mixed slash styles",
  "silently miss allowlist entries and over-deny orchestration writes.",
].join(" ");

const RAW_TRACE = [
  "tool_call write path=src/x.ts",
  "Observation: wrote 12 bytes",
  "teammate-complete correlationId=abc",
].join("\n");

test("P7 assess rejects raw traces and trivial text", () => {
  assert.equal(assessKnowledgeCandidate("ok").ok, false);
  assert.equal(assessKnowledgeCandidate(RAW_TRACE).ok, false);
  assert.equal(assessKnowledgeCandidate(GOOD_PITFALL).ok, true);
  assert.equal(assessKnowledgeCandidate(GOOD_PITFALL).kind, "pitfall");
});

test("P7 harvest extracts PITFALL and builds stage command", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearKnowledgeSuggestions(cwd);
  const body = [
    "Agent general-executor has completed.",
    "--- RESULT ---",
    GOOD_PITFALL,
    "",
    "Also: const x = 1; function foo(){ return x; }",
  ].join("\n");
  const result = harvestKnowledgeOnSettle(
    {
      content: body,
      agentId: "general-executor",
      taskType: "development",
      stage: "execute",
      sessionId: "sess-p7",
      runId: "run-p7",
    },
    { cwd, record: true },
  );
  assert.ok(result.suggestions.length >= 1);
  assert.equal(result.suggestions[0]?.target, "knowhow");
  assert.ok(result.suggestions[0]?.content.includes("hard-gate") || result.suggestions[0]?.kind === "pitfall");
  assert.ok(result.stageCommands[0]?.shell.includes("maestro knowledge stage"));
  assert.ok(!result.stageCommands[0]?.shell.includes("promote"));
  const stored = getKnowledgeSuggestions(cwd);
  assert.ok(stored.length >= 1);
  const status = getStatus(cwd);
  assert.ok(status.knowledgeSuggestions.length >= 1);
});

test("P7 harvest dedups by fingerprint", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearKnowledgeSuggestions(cwd);
  const input = { content: GOOD_PITFALL, agentId: "a", force: true as const };
  const a = harvestKnowledgeOnSettle(input, { cwd, record: true });
  const b = harvestKnowledgeOnSettle(input, { cwd, record: true });
  assert.ok(a.suggestions.length >= 1);
  assert.equal(b.suggestions.length, 0);
  assert.ok(b.skipped.some((s) => /duplicate/i.test(s.reason)));
});

test("P7 noteExpertsSettled harvests when content provided", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearKnowledgeSuggestions(cwd);
  setLeaderWaiting(true, { cwd, activeDelta: 1, agentIds: ["dev"] });
  const out = noteExpertsSettled(cwd, {
    settledCount: 1,
    agentId: "dev",
    content: GOOD_PITFALL,
    taskType: "development",
    stage: "execute",
  });
  assert.equal(out.leaderWaiting, false);
  assert.ok(out.knowledgeHarvest);
  assert.ok((out.knowledgeHarvest?.suggestions.length ?? 0) >= 1);
});

test("P7 rejects code-only dump without lesson", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const code = "function f(a,b){return a+b;} const o={x:1,y:2,z:3}; export default f;";
  const r = harvestKnowledgeOnSettle({ content: code.repeat(3), force: true }, { cwd, record: false });
  assert.equal(r.suggestions.length, 0);
});

test("P7 buildStageCommand never promotes", () => {
  const cmd = buildStageCommand({
    id: "kh-1",
    target: "knowhow",
    kind: "pitfall",
    title: "path normalize",
    content: GOOD_PITFALL,
    fingerprint: "abc",
    score: 5,
    evidence: [],
    at: new Date().toISOString(),
    source: "experts-settle",
    sessionId: "s1",
  });
  assert.ok(cmd.shell.includes("knowledge stage"));
  assert.equal(cmd.shell.includes("promote"), false);
});

// --- P7b cockpit status + autoStage self-evolve pool ---
import {
  formatExpertsHarvestStatus,
  EXPERTS_HARVEST_STATUS_KEY,
  depositHarvestToSelfEvolvePool,
  harvestToSelfEvolveSignal,
  dailySuggestionFileName,
} from "../src/experts-mode/index.ts";
import { loadRules as loadExpertsRules } from "../src/experts-mode/rules.ts";

test("P7b formatExpertsHarvestStatus", () => {
  assert.equal(formatExpertsHarvestStatus([]), "");
  assert.equal(formatExpertsHarvestStatus(3), "HARVEST 3");
  assert.equal(EXPERTS_HARVEST_STATUS_KEY, "experts-harvest");
  const sample = [{
    id: "kh-1",
    target: "knowhow" as const,
    kind: "pitfall" as const,
    title: "t",
    content: "c",
    fingerprint: "f",
    score: 3,
    evidence: [],
    at: new Date().toISOString(),
    source: "experts-settle" as const,
  }];
  const text = formatExpertsHarvestStatus(sample);
  assert.ok(text.startsWith("HARVEST 1"));
  assert.ok(text.includes("pitfall"));
});

test("P7b depositHarvestToSelfEvolvePool writes se- signal + evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-pool-"));
  const suggestion = {
    id: "kh-abc",
    target: "knowhow" as const,
    kind: "pitfall" as const,
    title: "path normalize on windows",
    content: GOOD_PITFALL,
    fingerprint: "deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d",
    score: 5,
    evidence: ["notes/x.md"],
    at: new Date().toISOString(),
    source: "experts-settle" as const,
    sessionId: "sess-1",
    runId: "run-1",
    agentId: "general-executor",
  };
  const r = depositHarvestToSelfEvolvePool([suggestion], {
    outputRoot: root,
    sessionId: "sess-1",
    runId: "run-1",
    project: "expert",
  });
  assert.equal(r.written, 1);
  assert.ok(r.filePath);
  assert.ok(fs.existsSync(r.filePath!));
  const line = fs.readFileSync(r.filePath!, "utf8").trim();
  const row = JSON.parse(line);
  assert.ok(String(row.id).startsWith("se-"));
  assert.equal(row.kind, "candidate");
  assert.equal(row.dryRun, true);
  assert.equal(row.skill, "experts-harvest");
  assert.ok(row.suggestion.includes("knowledge stage"));
  assert.equal(row.suggestion.includes("promote"), false);
  const evidenceFile = path.join(root, "evidence", `${row.id}.md`);
  assert.ok(fs.existsSync(evidenceFile));
  // dedupe second write
  const r2 = depositHarvestToSelfEvolvePool([suggestion], { outputRoot: root });
  assert.equal(r2.written, 0);
  assert.equal(r2.skipped, 1);
});

test("P7b autoStage deposits when rules.settle.autoStage true", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  clearKnowledgeSuggestions(cwd);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "se-auto-"));
  const rules = {
    ...loadExpertsRules(),
    settle: {
      knowledgeHarvest: true,
      autoStage: true,
      selfEvolveOutputRoot: root,
      maxSuggestions: 5,
    },
  };
  const result = harvestKnowledgeOnSettle(
    {
      content: GOOD_PITFALL,
      agentId: "dev",
      sessionId: "s-auto",
      runId: "r-auto",
      force: true,
    },
    { cwd, record: true, rules },
  );
  assert.ok(result.suggestions.length >= 1);
  assert.ok(result.poolDeposit);
  assert.equal(result.poolDeposit?.written, 1);
  assert.ok(result.poolDeposit?.filePath && fs.existsSync(result.poolDeposit.filePath));
});

// --- P4.1 Maestro stage auto-injection ---
import {
  resolveMaestroStageFromWorkspace,
  syncActiveStageFromMaestro,
  formatStageBirthPacket,
} from "../src/experts-mode/index.ts";

/** Write a fake Maestro session.json under cwd/.workflow/sessions/<id>/. */
function writeSessionFixture(
  cwd: string,
  sessionId: string,
  opts: {
    intent?: string;
    status?: string;
    activeRunId?: string | null;
    chain?: Array<Record<string, unknown>>;
    sealed?: boolean;
  } = {},
): string {
  const dir = path.join(cwd, ".workflow", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const chain = opts.chain ?? [
    { step_id: "step-1", command: "execute", status: "running", run_id: "run-1", stage: "execute" },
  ];
  const session: Record<string, unknown> = {
    session_id: sessionId,
    intent: opts.intent ?? "P4.1 test intent",
    status: opts.status ?? (opts.sealed ? "sealed" : "running"),
    active_run_id: opts.activeRunId === null ? undefined : (opts.activeRunId ?? "run-1"),
    orchestration: { chain },
    lifecycle: opts.sealed ? { sealed_at: "2026-08-10T00:00:00.000Z" } : { sealed_at: null },
  };
  fs.writeFileSync(path.join(dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return dir;
}

/** Run fn with MAESTRO_SESSION_ID / MAESTRO_STAGE unset, restoring afterwards. */
function withCleanMaestroEnv<T>(fn: () => T): T {
  const prevId = process.env.MAESTRO_SESSION_ID;
  const prevStage = process.env.MAESTRO_STAGE;
  delete process.env.MAESTRO_SESSION_ID;
  delete process.env.MAESTRO_STAGE;
  try {
    return fn();
  } finally {
    if (prevId === undefined) delete process.env.MAESTRO_SESSION_ID;
    else process.env.MAESTRO_SESSION_ID = prevId;
    if (prevStage === undefined) delete process.env.MAESTRO_STAGE;
    else process.env.MAESTRO_STAGE = prevStage;
  }
}

test("P4.1 resolveMaestroStageFromWorkspace finds running session stage=execute", () => {
  const cwd = tempCwd();
  writeSessionFixture(cwd, "sess-run-1", { intent: "实现 JWT 中间件" });
  withCleanMaestroEnv(() => {
    const info = resolveMaestroStageFromWorkspace(cwd);
    assert.ok(info);
    assert.equal(info!.sessionId, "sess-run-1");
    assert.equal(info!.stage, "execute");
    assert.equal(info!.command, "execute");
    assert.equal(info!.runId, "run-1");
    assert.equal(info!.stepId, "step-1");
    assert.equal(info!.intent, "实现 JWT 中间件");
    assert.equal(info!.source, "workspace");
  });
});

test("P4.1 stage falls back to step.command and alias mapping", () => {
  const cwd = tempCwd();
  writeSessionFixture(cwd, "sess-cmd", {
    chain: [{ step_id: "s1", command: "maestro-execute", status: "running", run_id: "r1" }],
  });
  withCleanMaestroEnv(() => {
    const info = resolveMaestroStageFromWorkspace(cwd);
    assert.ok(info);
    assert.equal(info!.stage, "execute"); // alias maestro-execute → execute
  });
});

test("P4.1 MAESTRO_SESSION_ID env wins over workspace scan", () => {
  const cwd = tempCwd();
  writeSessionFixture(cwd, "env-sess", {
    intent: "env intent",
    activeRunId: "r-env",
    chain: [{ step_id: "s1", command: "review", status: "running", run_id: "r-env", stage: "review" }],
  });
  // decoy running session — env must beat the scan
  writeSessionFixture(cwd, "decoy-run", { intent: "decoy", activeRunId: "r-decoy" });
  const prevId = process.env.MAESTRO_SESSION_ID;
  const prevStage = process.env.MAESTRO_STAGE;
  process.env.MAESTRO_SESSION_ID = "env-sess";
  delete process.env.MAESTRO_STAGE;
  try {
    const info = resolveMaestroStageFromWorkspace(cwd);
    assert.ok(info);
    assert.equal(info!.source, "env");
    assert.equal(info!.sessionId, "env-sess");
    assert.equal(info!.stage, "review");
  } finally {
    if (prevId === undefined) delete process.env.MAESTRO_SESSION_ID;
    else process.env.MAESTRO_SESSION_ID = prevId;
    if (prevStage === undefined) delete process.env.MAESTRO_STAGE;
    else process.env.MAESTRO_STAGE = prevStage;
  }
});

test("P4.1 ensureExpertsDispatch auto-detects stage from workspace", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  writeSessionFixture(cwd, "sess-exec");
  withCleanMaestroEnv(() => {
    // Prompt looks like explore; stage=execute from session.json must force development.
    const out = ensureExpertsDispatch(
      { tasks: [{ prompt: "搜索 PositionManager 调用链" }] } as TeammateParamsLike,
      { cwd, mode: "experts", record: false },
    );
    assert.equal(out.tasks?.[0]?.taskType, "development");
    assert.equal(out.tasks?.[0]?.agent, "general-executor");
    assert.equal(out.__experts?.stageForced, true);
    assert.equal(out.__experts?.stage, "execute");
  });
});

test("P4.1 syncActiveStageFromMaestro writes activeStage", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  writeSessionFixture(cwd, "sess-sync", { intent: "实现 JWT 中间件" });
  withCleanMaestroEnv(() => {
    const plan = syncActiveStageFromMaestro(cwd);
    assert.ok(plan);
    assert.equal(plan!.mode, "experts");
    assert.equal(plan!.stage, "execute");
    assert.equal(plan!.source, "stage-policy");
    assert.ok(plan!.tasks.length >= 1);
    assert.equal(plan!.tasks[0]?.taskType, "development");
    const status = getStatus(cwd);
    assert.equal(status.activeStage?.stage, "execute");
    assert.equal(status.activeStage?.source, "maestro-session");
    assert.equal(status.activeStage?.sessionId, "sess-sync");
    assert.equal(status.activeStage?.runId, "run-1");
    assert.ok((status.activeStage?.taskTypes ?? []).includes("development"));
    // env backfill: MAESTRO_STAGE set once when unset
    assert.equal(process.env.MAESTRO_STAGE, "execute");
    // second sync does not clobber an explicit env stage
    process.env.MAESTRO_STAGE = "review";
    const again = syncActiveStageFromMaestro(cwd);
    assert.ok(again);
    assert.equal(process.env.MAESTRO_STAGE, "review");
  });
});

test("P4.1 formatStageBirthPacket is a short leader-facing fragment", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearRulesCache();
  const plan = resolveStageExpertsPlan("execute", "实现 JWT", { cwd, mode: "experts", record: false });
  const packet = formatStageBirthPacket(plan);
  assert.match(packet, /Stage birth: "execute"/);
  assert.match(packet, /Pipeline: development/);
  assert.match(packet, /Agents: general-executor/);
  assert.ok(packet.split("\n").length <= 6);
});

test("P4.1 missing sessions → null / no throw", () => {
  const cwd = tempCwd();
  withCleanMaestroEnv(() => {
    // no .workflow at all
    assert.equal(resolveMaestroStageFromWorkspace(cwd), null);
    // .workflow/sessions exists but is empty
    fs.mkdirSync(path.join(cwd, ".workflow", "sessions"), { recursive: true });
    assert.equal(resolveMaestroStageFromWorkspace(cwd), null);
    // broken json session file is skipped, no throw
    writeSessionFixture(cwd, "bad");
    fs.writeFileSync(
      path.join(cwd, ".workflow", "sessions", "bad", "session.json"),
      "not json {{",
      "utf8",
    );
    assert.equal(resolveMaestroStageFromWorkspace(cwd), null);
    // sealed sessions are ignored (no active step)
    writeSessionFixture(cwd, "sealed-1", { sealed: true });
    assert.equal(resolveMaestroStageFromWorkspace(cwd), null);
    // sync in normal mode: found session → normal plan, no state written
    writeSessionFixture(cwd, "normal-1");
    const plan = syncActiveStageFromMaestro(cwd, { mode: "normal" });
    assert.ok(plan);
    assert.equal(plan!.mode, "normal");
    assert.equal(getStatus(cwd).activeStage, null);
  });
});

// --- P5.1 Orchestrator discipline ---
import {
  ORCHESTRATOR_DISCIPLINE_MARK,
  buildOrchestratorDisciplineFragment,
  buildViceLeadDispatchHint,
  shouldSuggestViceLead,
  mergeRules,
} from "../src/experts-mode/index.ts";

test("P5.1 discipline fragment mentions session/run and dispatch", () => {
  const f = buildOrchestratorDisciplineFragment();
  assert.match(f, /session\/run/);
  assert.match(f, /dispatch/);
  assert.match(f, /NEVER implement business code/);
  assert.match(f, /outputs\/\*\*/);
  assert.ok(f.includes(ORCHESTRATOR_DISCIPLINE_MARK));
  // no vice-lead guidance for a single-task pipeline
  assert.ok(!f.includes("vice-lead"));
  assert.ok(f.split("\n").length < 12);
});

test("P5.1 viceLead lines appear when taskTypes length >= 2", () => {
  const f = buildOrchestratorDisciplineFragment({
    taskTypes: ["explore", "planning", "development", "review"],
  });
  assert.match(f, /vice-lead/);
  assert.match(f, /agent=workflow/);
  assert.match(f, /taskType=planning/);
  assert.ok(shouldSuggestViceLead({ taskTypes: ["explore", "planning"] }));
  assert.ok(shouldSuggestViceLead({ agents: ["a", "b"] }));
  assert.ok(!shouldSuggestViceLead({ taskTypes: ["development"] }));
  assert.ok(!shouldSuggestViceLead({}));
  // force includes vice-lead even for single-step
  assert.ok(shouldSuggestViceLead({ taskTypes: ["development"], force: true }));
});

test("P5.1 viceLead suppressed when rules.orchestrator.viceLead=false", () => {
  const rules = { orchestrator: { viceLead: false } };
  const f = buildOrchestratorDisciplineFragment({
    taskTypes: ["explore", "planning", "development", "review"],
    rules,
  });
  assert.ok(!f.includes("vice-lead"));
  assert.equal(shouldSuggestViceLead({ taskTypes: ["a", "b"], rules }), false);
  // rules-level off cannot be overridden by force
  assert.equal(shouldSuggestViceLead({ taskTypes: ["a", "b"], rules, force: true }), false);
  // explicit opts.viceLead=false also suppresses
  const g = buildOrchestratorDisciplineFragment({
    taskTypes: ["a", "b"],
    viceLead: false,
  });
  assert.ok(!g.includes("vice-lead"));
});

test("P5.1 buildTurnReminder includes orchestrator discipline markers when experts", () => {
  const r = buildTurnReminder("experts", {
    stage: "execute",
    taskTypes: ["development"],
  });
  assert.match(r, /Orchestrator discipline \(P5\.1\)/);
  assert.match(r, /session\/run/);
  assert.match(r, /dispatch/);
  assert.ok(r.indexOf("Orchestrator discipline") > r.indexOf("<experts_mode_reminder>"));
  assert.ok(r.indexOf("Orchestrator discipline") < r.indexOf("</experts_mode_reminder>"));
  // normal mode stays empty
  assert.equal(buildTurnReminder("normal", { stage: "execute" }), "");
  // injectTurnReminder passthrough
  const injected = injectTurnReminder("BASE", {
    mode: "experts",
    stage: "execute",
    taskTypes: ["development"],
  });
  assert.match(injected, /Orchestrator discipline/);
  assert.match(injected, /BASE/);
});

test("P5.1 disciplineReminder=false omits discipline fragment", () => {
  const r = buildTurnReminder("experts", {
    rules: { orchestrator: { disciplineReminder: false } },
  });
  assert.ok(!r.includes("Orchestrator discipline"));
  assert.ok(r.includes("experts_mode_reminder"));
  // explicit opts.discipline=false also suppresses
  const r2 = buildTurnReminder("experts", { discipline: false });
  assert.ok(!r2.includes("Orchestrator discipline"));
  assert.ok(r2.includes("experts_mode_reminder"));
});

test("P5.1 vice-lead dispatch hint is role-based, never a model", () => {
  const hint = buildViceLeadDispatchHint("execute", "multi-step feature");
  assert.equal(hint.agent, "workflow");
  assert.equal(hint.taskType, "planning");
  assert.equal(hint.model, undefined);
  assert.ok(String(hint.prompt).includes("vice-lead"));
  assert.ok(!String(hint.agent).includes("/"));
});

test("P5.1 mergeRules merges orchestrator shallowly", () => {
  const merged = mergeRules(
    { orchestrator: { disciplineReminder: true, viceLead: true } },
    { orchestrator: { viceLead: false } },
  );
  assert.equal(merged.orchestrator?.disciplineReminder, true);
  assert.equal(merged.orchestrator?.viceLead, false);
  // absent overlay keeps base
  const kept = mergeRules(
    { orchestrator: { disciplineReminder: true, viceLead: true } },
    {},
  );
  assert.equal(kept.orchestrator?.viceLead, true);
});

// --- A2 experts status panel ---
import {
  formatExpertsStatusPanel,
  formatExpertsStatusPanelFromStatus,
  recordLastDispatch,
} from "../src/experts-mode/index.ts";

test("A2 status panel renders normal mode without throwing", () => {
  const cwd = tempCwd();
  const panel = formatExpertsStatusPanel(cwd);
  assert.match(panel, /Mode: normal/);
  assert.match(panel, /LeaderWaiting: no/);
  assert.match(panel, /ActiveStage: \(none\)/);
  assert.match(panel, /LastDispatch: \(none\)/);
  assert.match(panel, /InFlight: 0/);
  assert.match(panel, /Harvest: \(none\)/);
  assert.ok(panel.includes(".experts-mode.json"), "panel must show the state path");
  // pure formatter path from an already-built status object
  const direct = formatExpertsStatusPanelFromStatus(getStatus(cwd));
  assert.match(direct, /Mode: normal/);
  assert.match(direct, /Path:/);
});

test("A2 status panel shows experts mode and leader waiting", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  setLeaderWaiting(true, { cwd, activeDelta: 2, agentIds: ["general-executor", "explorer"] });
  const panel = formatExpertsStatusPanel(cwd);
  assert.match(panel, /Mode: experts/);
  assert.match(panel, /LeaderWaiting: yes \(2\)/);
  assert.match(panel, /agents=\[general-executor, explorer\]/);
  assert.ok(!panel.includes("model"), "panel must never contain model ids");
});

test("A2 LastDispatch shows taskType/stage without a model line", () => {
  const cwd = tempCwd();
  setMode("experts", cwd);
  clearInFlight(cwd);
  recordLastDispatch({
    mode: "experts",
    taskType: "development",
    agent: "general-executor",
    model: "sub2-responses/gpt-5.4", // routing-only — must never render
    forced: true,
    stage: "execute",
    at: "2026-08-10T00:00:00.000Z",
    promptPreview: `preview-${"x".repeat(100)}`, // longer than 80 → truncated
  }, cwd);
  trackInFlight([
    { id: "dev-1", name: "dev-1", agent: "general-executor", taskType: "development" },
  ], { cwd });
  const panel = formatExpertsStatusPanel(cwd);
  assert.match(panel, /LastDispatch:/);
  assert.match(panel, /taskType=development/);
  assert.match(panel, /agent=general-executor/);
  assert.match(panel, /stage=execute/);
  assert.match(panel, /forced=true/);
  assert.match(panel, /at=2026-08-10T00:00:00\.000Z/);
  assert.match(panel, /prompt="preview-/);
  assert.ok(panel.includes("…"), "over-80 preview must be truncated");
  assert.ok(!panel.includes("model"), "panel must never leak model ids");
  assert.match(panel, /InFlight: 1/);
  assert.match(panel, /name=dev-1/);
  assert.match(panel, /taskType=development/);
});
