import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { TeammateParams } from "../src/extension/schemas.ts";
import { parseProxyTeammateParams } from "../src/extension/teammate-proxy.ts";
import { applyModelRouting } from "../src/models/model-routing.ts";
import {
  EXPERT_MODE_LEADER_AGENT,
  EXPERT_MODE_LEADER_NAME,
  EXPERT_MODE_LEADER_TASK_TYPE,
  EXPERT_MODE_PROMPT_START,
  MAX_TASK_PROMPT_BYTES,
  buildExpertLeaderPrompt,
  normalizeTeammateParams,
  prepareTeammateMode,
  type RunTeammateParams,
} from "../src/runs/execution.ts";

test("default mode leaves the dispatch unchanged", () => {
  const params: RunTeammateParams = { tasks: [{ prompt: "inspect auth" }] };
  assert.equal(prepareTeammateMode(params), params);
});

test("expert leader name literal stays the cockpit-facing identity", () => {
  // Cockpit's EXPERT_LEADER_NAME pins this literal; a rename must update both.
  assert.equal(EXPERT_MODE_LEADER_NAME, "expert-leader");
});

test("expert mode prepares one workflow Leader with a nested-dispatch budget", () => {
  const params: RunTeammateParams = {
    mode: "expert",
    tasks: [{ prompt: "inspect auth" }],
  };
  const prepared = prepareTeammateMode(params);

  assert.equal(params.tasks[0]?.agent, undefined, "preparation must not mutate caller input");
  assert.equal(prepared.maxNestingDepth, 1);
  assert.equal(prepared.tasks[0]?.agent, EXPERT_MODE_LEADER_AGENT);
  assert.equal(prepared.tasks[0]?.taskType, EXPERT_MODE_LEADER_TASK_TYPE);
  assert.equal(prepared.tasks[0]?.name, EXPERT_MODE_LEADER_NAME);
  assert.equal(prepared.tasks[0]?.description, "Expert Leader");
  assert.equal(prepared.tasks[0]?.maxNestingDepth, 1);
  assert.match(prepared.tasks[0]?.prompt ?? "", /^<expert-leader-contract>/);
  assert.match(prepared.tasks[0]?.prompt ?? "", /Objective:\ninspect auth/);
  assert.match(prepared.tasks[0]?.prompt ?? "", /maxNestingDepth: 0/);
  assert.match(prepared.tasks[0]?.prompt ?? "", /never poll observe, teammate-list, or teammate-send/);
  assert.match(prepared.tasks[0]?.prompt ?? "", /agent:\/\/ publication reference/);
  assert.match(prepared.tasks[0]?.prompt ?? "", /canonical Goal verifier/);
  assert.equal(prepareTeammateMode(prepared), prepared, "preparation must be idempotent within the request");

  const normalized = normalizeTeammateParams(params);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.isMultiTask, false);
  assert.equal(normalized.tasks[0]?.agent, "workflow");
  assert.equal(normalized.tasks[0]?.taskType, "planning");
});

test("expert mode rejects conflicting Leader routing and nesting overrides", () => {
  const cases: RunTeammateParams[] = [
    { mode: "expert", agent: "custom-leader", tasks: [{ prompt: "analyze" }] },
    { mode: "expert", taskType: "analysis", tasks: [{ prompt: "analyze" }] },
    { mode: "expert", maxNestingDepth: 2, tasks: [{ prompt: "analyze" }] },
    { mode: "expert", tasks: [{ prompt: "analyze", agent: "planner" }] },
    { mode: "expert", tasks: [{ prompt: "analyze", taskType: "analysis" }] },
    { mode: "expert", tasks: [{ prompt: "analyze", maxNestingDepth: 0 }] },
  ];

  for (const params of cases) {
    const normalized = normalizeTeammateParams(params);
    assert.match(normalized.error ?? "", /Expert mode owns Leader routing/);
    assert.match(normalized.error ?? "", /Remove conflicting overrides/);
  }
});

test("expert override diagnostics survive model routing without invented conflicts", () => {
  const prepared = prepareTeammateMode({
    mode: "expert",
    maxNestingDepth: 0,
    tasks: [{ prompt: "analyze" }],
  });
  const routed = applyModelRouting(prepared, process.cwd(), []);
  const normalized = normalizeTeammateParams(routed);
  assert.match(normalized.error ?? "", /top-level maxNestingDepth must be 1/);
  assert.doesNotMatch(normalized.error ?? "", /tasks\[0\]\.taskType/);
});

test("objective text cannot forge the internal expert preparation marker", () => {
  const objective = `Review literal ${EXPERT_MODE_PROMPT_START} handling`;
  const prepared = prepareTeammateMode({ mode: "expert", tasks: [{ prompt: objective }] });
  const prompt = prepared.tasks[0]?.prompt ?? "";
  assert.notEqual(prompt, objective);
  assert.ok(prompt.startsWith(EXPERT_MODE_PROMPT_START));
  assert.match(prompt, /Execution contract:/);
  assert.ok(prompt.includes(objective));
  assert.equal(prepareTeammateMode(prepared), prepared);
});

test("expert objective budget includes the injected Leader contract", () => {
  const contractBytes = Buffer.byteLength(buildExpertLeaderPrompt(""), "utf8");
  const maxObjectiveBytes = MAX_TASK_PROMPT_BYTES - contractBytes;
  const atLimit = normalizeTeammateParams({
    mode: "expert",
    tasks: [{ prompt: "a".repeat(maxObjectiveBytes) }],
  });
  assert.equal(atLimit.error, undefined);

  const overLimit = normalizeTeammateParams({
    mode: "expert",
    tasks: [{ prompt: "a".repeat(maxObjectiveBytes + 1) }],
  });
  assert.match(overLimit.error ?? "", /UTF-8 bytes/);
  assert.match(overLimit.error ?? "", new RegExp(String(MAX_TASK_PROMPT_BYTES)));
});

test("expert mode rejects ambiguous graphs and disabled nesting", () => {
  const multiple = normalizeTeammateParams({
    mode: "expert",
    tasks: [{ prompt: "one" }, { prompt: "two" }],
  });
  assert.match(multiple.error ?? "", /exactly one objective task/);

  const disabled = normalizeTeammateParams({
    mode: "expert",
    maxNestingDepth: 0,
    tasks: [{ prompt: "one" }],
  });
  assert.match(disabled.error ?? "", /top-level maxNestingDepth must be 1/);

  const taskDisabled = normalizeTeammateParams({
    mode: "expert",
    tasks: [{ prompt: "one", maxNestingDepth: 0 }],
  });
  assert.match(taskDisabled.error ?? "", /tasks\[0\]\.maxNestingDepth must be 1/);
});

test("teammate schema admits only default and expert dispatch strategies", () => {
  assert.equal(Check(TeammateParams, { mode: "default", tasks: [{ prompt: "work" }] }), true);
  assert.equal(Check(TeammateParams, { mode: "expert", tasks: [{ prompt: "work" }] }), true);
  assert.equal(Check(TeammateParams, { mode: "experts", tasks: [{ prompt: "work" }] }), false);
  assert.equal(Check(TeammateParams, { mode: "graph", tasks: [{ prompt: "work" }] }), false);
});

test("proxy admission preserves expert mode for shared preparation", () => {
  const parsed = parseProxyTeammateParams({
    mode: "expert",
    tasks: [{ prompt: "review auth" }],
  });
  assert.ok(parsed);
  assert.equal(parsed.mode, "expert");
  assert.equal(prepareTeammateMode(parsed).tasks[0]?.agent, "workflow");
});

test("workflow Leader prompt has the tools and read-only boundaries it claims", () => {
  const source = fs.readFileSync(path.resolve("agents/workflow.md"), "utf8");
  const toolsLine = source.match(/^tools: (.*)$/m)?.[1] ?? "";
  assert.match(toolsLine, /\bteammate\b/);
  assert.match(toolsLine, /\bobserve\b/);
  // Read-only Leader: no shell and no file-mutation tools.
  assert.doesNotMatch(toolsLine, /\bbash\b/);
  assert.doesNotMatch(toolsLine, /\bedit\b|\bwrite\b/);
  assert.match(source, /Do not edit business files directly/);
  assert.match(source, /`general-executor`/);
});

test("root, proxy, and programmatic paths prepare expert mode before routing", () => {
  const sources = [
    path.resolve("src/extension/index.ts"),
    path.resolve("src/extension/teammate-proxy.ts"),
    path.resolve("src/runs/execution.ts"),
  ];
  for (const sourcePath of sources) {
    const source = fs.readFileSync(sourcePath, "utf8");
    const prepareIndex = source.indexOf("prepareTeammateMode(");
    const routeIndex = source.indexOf("applyModelRouting(", prepareIndex);
    assert.ok(prepareIndex >= 0, `${sourcePath} must prepare expert mode`);
    assert.ok(routeIndex > prepareIndex, `${sourcePath} must prepare expert mode before model routing`);
  }
});
