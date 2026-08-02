import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  TaskSpec,
  TeammateListParams,
  TeammateParams,
  TeammateSendParams,
  TeammateWaitParams,
  TeammateWatchParams,
} from "../src/extension/schemas.ts";
import {
  parseTeammateThinkingLevel,
  TEAMMATE_THINKING_INPUTS,
} from "../src/shared/thinking.ts";

test("teammate schema accepts all thinking depths at top-level and task boundaries", () => {
  for (const thinking of TEAMMATE_THINKING_INPUTS) {
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], thinking }), true);
    assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", thinking }] }), true);
  }
});

test("teammate schema accepts string models at top-level and task boundaries", () => {
  assert.equal(Check(TeammateParams, {
    model: "provider/default",
    tasks: [{ prompt: "work", model: "provider/task" }],
  }), true);
  assert.equal(Check(TeammateParams, { model: 42, tasks: [{ prompt: "work" }] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", model: 42 }] }), false);
});

test("teammate schema requires a non-empty tasks array and required task prompts", () => {
  assert.equal(Check(TeammateParams, {}), false);
  assert.equal(Check(TeammateParams, { tasks: [] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{}] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "" }] }), false);
  // TypeBox cannot express trim semantics; shared normalization rejects this.
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "   " }] }), true);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }] }), true);
});

test("removed public single, chain, template, and promptArgs fields are rejected", () => {
  assert.equal(Check(TeammateParams, { agent: "general", task: "work" }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", task: "legacy" }] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", promptArgs: ["legacy"] }] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], chain: [] }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], prompt: "analysis" }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], name: "dispatch" }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], protocol_version: 1 }), false);
});

test("max is an input alias that canonicalizes to xhigh", () => {
  assert.equal(parseTeammateThinkingLevel("max"), "xhigh");
  assert.equal(parseTeammateThinkingLevel("xhigh"), "xhigh");
});

test("teammate schema rejects unsupported thinking depths", () => {
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work" }], thinking: "ultra" }), false);
  assert.equal(Check(TeammateParams, { tasks: [{ prompt: "work", thinking: "ultra" }] }), false);
});

test("dependsOn and maxAgents descriptions document the runtime guards", () => {
  const dependsOn = (TaskSpec.properties.dependsOn as { description?: string }).description ?? "";
  assert.match(dependsOn, /Unknown names and self-references are rejected/);
  const maxAgents = (TeammateParams.properties.maxAgents as { description?: string }).description ?? "";
  assert.match(maxAgents, /single dispatch \(default: 15\)/);
  assert.match(maxAgents, /PI_TEAMMATE_MAX_ACTIVE_AGENTS/);
});

test("teammate-list schema exposes discovered role listing", () => {
  assert.equal(Check(TeammateListParams, { view: "roles" }), true);
  assert.equal(Check(TeammateListParams, { view: "unknown" }), false);
  assert.equal(Check(TeammateListParams, { view: "active", typo: true }), false);
  assert.equal((TeammateListParams.properties.view as { default?: string }).default, "active");
});

test("teammate auxiliary schemas reject unknown fields and publish wait defaults", () => {
  assert.equal(Check(TeammateSendParams, { to: "worker", message: "continue", extra: true }), false);
  assert.equal(Check(TeammateWatchParams, { name: "worker", extra: true }), false);
  assert.equal(Check(TeammateWaitParams, { name: "worker", extra: true }), false);
  assert.equal((TeammateWaitParams.properties.timeoutMs as { default?: number }).default, 600_000);
  assert.match(
    (TeammateWaitParams.properties.waitMs as { description?: string }).description ?? "",
    /ignored when name is provided/,
  );
});

test("teammate schema exposes model fallback chains at both levels", () => {
  assert.equal(Check(TeammateParams, {
    fallbackModels: ["provider/top"],
    tasks: [{ prompt: "work", fallbackModels: ["provider/task"] }],
  }), true);
});
