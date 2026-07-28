import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  applyModelRouting,
  discoverRoutingTaskTypes,
  getProjectModelRoutingPath,
  inferTaskType,
  loadModelRoutingConfig,
  saveProjectModelMapping,
  saveProjectThinkingLevel,
  TEAMMATE_TASK_TYPE_META,
} from "../src/models/model-routing.ts";

test("task types expose role metadata for the configuration UI", () => {
  assert.equal(TEAMMATE_TASK_TYPE_META.explore.roles, "explorer");
  assert.match(TEAMMATE_TASK_TYPE_META.development.description, /Implementation/);
  assert.equal(Object.keys(TEAMMATE_TASK_TYPE_META).length, 7);
});

test("task type inference prioritizes explicit phases, roles, and task text", () => {
  assert.equal(inferTaskType({ taskType: "testing", agent: "explorer" }), "testing");
  assert.equal(inferTaskType({ agent: "explorer" }), "explore");
  assert.equal(inferTaskType({ agent: "planner" }), "planning");
  assert.equal(inferTaskType({ agent: "research" }), "analysis");
  assert.equal(inferTaskType({ task: "Reproduce the crash and find the root cause" }), "debug");
  assert.equal(inferTaskType({ task: "Review the authentication security risk" }), "review");
  assert.equal(inferTaskType({ task: "Implement the requested feature" }), "development");
  assert.equal(inferTaskType({ task: "Trace the token refresh flow" }), "analysis");
});

test("project model mappings persist and route single tasks", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5");
    assert.equal(loadModelRoutingConfig(cwd).mappings.analysis, "openai/gpt-5");
    assert.equal(fs.existsSync(getProjectModelRoutingPath(cwd)), true);

    const routed = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["openai/gpt-5"]);
    assert.equal(routed.tasks[0].model, "openai/gpt-5");

    const explicit = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      model: "anthropic/claude-opus",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["openai/gpt-5", "anthropic/claude-opus"]);
    assert.equal(explicit.tasks[0].model, "anthropic/claude-opus");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("role frontmatter taskType routes models below explicit task types", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-routing-"));
  const agentsDir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "security-specialist.md"), `---
name: security-specialist
description: Security review specialist
taskType: security-audit
---
Review security evidence.
`);
  try {
    saveProjectModelMapping(cwd, "security-audit", "provider/review");
    saveProjectModelMapping(cwd, "analysis", "provider/analysis");
    saveProjectModelMapping(cwd, "debug", "provider/debug");
    const available = ["provider/review", "provider/analysis", "provider/debug"];

    const fromRole = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, available);
    assert.equal(fromRole.tasks[0].taskType, "security-audit");
    assert.equal(fromRole.tasks[0].model, "provider/review");
    assert.ok(discoverRoutingTaskTypes(cwd, [{ taskType: "security-audit" }]).includes("security-audit"));

    const fromTopLevel = applyModelRouting({
      taskType: "analysis",
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, available);
    assert.equal(fromTopLevel.tasks[0].taskType, "analysis");
    assert.equal(fromTopLevel.tasks[0].model, "provider/analysis");

    const fromTask = applyModelRouting({
      taskType: "analysis",
      tasks: [{ agent: "security-specialist", taskType: "debug", prompt: "Inspect the module" }],
    }, cwd, available);
    assert.equal(fromTask.tasks[0].taskType, "debug");
    assert.equal(fromTask.tasks[0].model, "provider/debug");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("task cwd selects that project's custom role type and routing config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-cwd-routing-"));
  const target = path.join(root, "target");
  const agentsDir = path.join(target, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "release-manager.md"), `---
name: release-manager
description: Release manager
taskType: release
---
Manage releases.
`);
  try {
    saveProjectModelMapping(target, "release", "provider/release");
    const routed = applyModelRouting({
      tasks: [{ agent: "release-manager", cwd: target, prompt: "Prepare release" }],
    }, root, ["provider/release"]);
    assert.equal(routed.tasks[0].taskType, "release");
    assert.equal(routed.tasks[0].model, "provider/release");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v1 routing configs migrate without losing models and thinking saves independently", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 1,
      mappings: { analysis: "openai/gpt-5", review: "anthropic/sonnet", testing: null },
    }));
    const migrated = loadModelRoutingConfig(cwd);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.mappings.analysis, "openai/gpt-5");
    assert.equal(migrated.mappings.review, "anthropic/sonnet");
    assert.equal(migrated.mappings.testing, null);

    saveProjectThinkingLevel(cwd, "analysis", "high");
    const persisted = JSON.parse(fs.readFileSync(getProjectModelRoutingPath(cwd), "utf8"));
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.mappings, {
      analysis: "openai/gpt-5",
      review: "anthropic/sonnet",
      testing: null,
    });
    assert.deepEqual(persisted.thinkingLevels, { analysis: "high" });
    saveProjectModelMapping(cwd, "analysis", "anthropic/sonnet");
    assert.equal(loadModelRoutingConfig(cwd).thinkingLevels.analysis, "high");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("teammate model and thinking saves never mutate the original model configuration", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    const originalModelsPath = path.join(cwd, ".pi", "models.json");
    const originalSettingsPath = path.join(cwd, ".pi", "settings.json");
    fs.mkdirSync(path.dirname(originalModelsPath), { recursive: true });
    fs.writeFileSync(originalModelsPath, JSON.stringify({
      version: 1,
      modelDefaults: { "openai/gpt-5": "minimal" },
    }));
    fs.writeFileSync(originalSettingsPath, JSON.stringify({ defaultThinkingLevel: "low" }));
    const originalModels = fs.readFileSync(originalModelsPath, "utf8");
    const originalSettings = fs.readFileSync(originalSettingsPath, "utf8");

    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5");
    saveProjectThinkingLevel(cwd, "analysis", "xhigh");

    assert.equal(fs.readFileSync(originalModelsPath, "utf8"), originalModels);
    assert.equal(fs.readFileSync(originalSettingsPath, "utf8"), originalSettings);
    assert.deepEqual(JSON.parse(fs.readFileSync(getProjectModelRoutingPath(cwd), "utf8")), {
      version: 2,
      mappings: { analysis: "openai/gpt-5" },
      thinkingLevels: { analysis: "xhigh" },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("thinking routing follows per-task, top-level, task type, then agent fallback precedence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    saveProjectThinkingLevel(cwd, "analysis", "medium");
    const routed = applyModelRouting({
      agent: "general",
      thinking: "low",
      tasks: [
        { agent: "general", prompt: "one", taskType: "analysis", thinking: "xhigh" },
        { agent: "general", prompt: "two", taskType: "analysis" },
      ],
    }, cwd);
    assert.equal(routed.tasks?.[0].thinking, "xhigh");
    assert.equal(routed.tasks?.[1].thinking, "low");

    const mapped = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "work" }],
    }, cwd);
    assert.equal(mapped.tasks[0].thinking, "medium");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("max aliases canonicalize before routing and persisted max values migrate to xhigh", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  try {
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 2,
      mappings: {},
      thinkingLevels: { analysis: "max" },
    }));
    assert.equal(loadModelRoutingConfig(cwd).thinkingLevels.analysis, "xhigh");

    const topLevel = applyModelRouting({
      agent: "general",
      thinking: "max",
      tasks: [{ prompt: "work" }],
    }, cwd);
    assert.equal(topLevel.thinking, "xhigh");
    const tasks = applyModelRouting({
      agent: "general",
      thinking: "low",
      tasks: [{ agent: "general", prompt: "work", thinking: "max" }],
    }, cwd);
    assert.equal(tasks.tasks?.[0].thinking, "xhigh");
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
      agent: "general",
      tasks: [
        { agent: "explorer", prompt: "Locate auth handlers" },
        { agent: "general", prompt: "Diagnose auth failure", taskType: "debug" },
        { agent: "reviewer", prompt: "Review the fix", model: "anthropic/claude-sonnet" },
      ],
    }, cwd, ["google/gemini-pro", "openai/gpt-5", "anthropic/claude-sonnet"]);
    assert.equal(routed.tasks?.[0].model, "google/gemini-pro");
    assert.equal(routed.tasks?.[1].model, "openai/gpt-5");
    assert.equal(routed.tasks?.[2].model, "anthropic/claude-sonnet");

    const topLevel = applyModelRouting({
      agent: "general",
      model: "openai/default",
      tasks: [{ agent: "explorer", prompt: "Locate routes" }],
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
      agent: "general",
      taskType: "planning",
      tasks: [{ prompt: "Plan migration" }],
    }, cwd, ["openai/gpt-5"]);
    assert.equal(routed.tasks[0].model, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
