import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  applyModelRouting,
  getProjectModelRoutingPath,
  inferTaskType,
  loadModelRoutingConfig,
  saveProjectModelMapping,
} from "../src/models/model-routing.ts";

test("task type inference prioritizes explicit phases and specialized prompts", () => {
  assert.equal(inferTaskType({ taskType: "testing", agent: "explorer" }), "testing");
  assert.equal(inferTaskType({ prompt: "analysis-diagnose-bug-root-cause" }), "debug");
  assert.equal(inferTaskType({ prompt: "analysis-review-code-quality" }), "review");
  assert.equal(inferTaskType({ prompt: "analysis-trace-code-execution" }), "analysis");
  assert.equal(inferTaskType({ prompt: "planning-plan-migration-strategy" }), "planning");
  assert.equal(inferTaskType({ prompt: "development-generate-tests" }), "testing");
  assert.equal(inferTaskType({ prompt: "development-implement-feature" }), "development");
  assert.equal(inferTaskType({ agent: "explorer" }), "explore");
  assert.equal(inferTaskType({ task: "Reproduce the crash and find the root cause" }), "debug");
});

test("project model mappings persist and route single tasks", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5");
    assert.equal(loadModelRoutingConfig(cwd).mappings.analysis, "openai/gpt-5");
    assert.equal(fs.existsSync(getProjectModelRoutingPath(cwd)), true);

    const routed = applyModelRouting({
      agent: "delegate",
      prompt: "analysis-trace-code-execution",
      task: "Trace the request",
    }, cwd, ["openai/gpt-5"]);
    assert.equal(routed.model, "openai/gpt-5");

    const explicit = applyModelRouting({
      agent: "delegate",
      taskType: "analysis",
      model: "anthropic/claude-opus",
    }, cwd, ["openai/gpt-5", "anthropic/claude-opus"]);
    assert.equal(explicit.model, "anthropic/claude-opus");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("multi-task routing applies per phase while explicit defaults win", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    saveProjectModelMapping(cwd, "explore", "google/gemini-pro");
    saveProjectModelMapping(cwd, "debug", "openai/gpt-5");

    const routed = applyModelRouting({
      agent: "delegate",
      tasks: [
        { agent: "explorer", task: "Locate auth handlers" },
        { agent: "delegate", prompt: "analysis-diagnose-bug-root-cause", task: "Diagnose auth failure" },
        { agent: "reviewer", task: "Review the fix", model: "anthropic/claude-sonnet" },
      ],
    }, cwd, ["google/gemini-pro", "openai/gpt-5", "anthropic/claude-sonnet"]);
    assert.equal(routed.tasks?.[0].model, "google/gemini-pro");
    assert.equal(routed.tasks?.[1].model, "openai/gpt-5");
    assert.equal(routed.tasks?.[2].model, "anthropic/claude-sonnet");

    const topLevel = applyModelRouting({
      agent: "delegate",
      model: "openai/default",
      tasks: [{ agent: "explorer", task: "Locate routes" }],
    }, cwd, ["google/gemini-pro", "openai/default"]);
    assert.equal(topLevel.tasks?.[0].model, "openai/default");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("unavailable configured models fall back instead of launching invalid model IDs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    saveProjectModelMapping(cwd, "planning", "missing/model");
    const routed = applyModelRouting({
      agent: "delegate",
      taskType: "planning",
      task: "Plan migration",
    }, cwd, ["openai/gpt-5"]);
    assert.equal(routed.model, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
