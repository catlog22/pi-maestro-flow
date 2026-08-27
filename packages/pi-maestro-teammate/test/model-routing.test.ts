import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  ModelCircuitBreaker,
} from "../src/models/model-circuit-breaker.ts";
import {
  applyModelRouting,
  appendTaskTypeRoutingContext,
  clearProjectModelRoutingOverrides,
  createAndActivateGlobalModelRoutingProfile,
  createGlobalModelRoutingProfile,
  deleteGlobalModelRoutingProfile,
  discoverRoutingTaskTypes,
  getGlobalAskBeforeDispatch,
  getSessionModelRoutingPath,
  getProjectModelRoutingPath,
  inferTaskType,
  loadModelRoutingConfig,
  loadModelRoutingState,
  promoteProjectModelRoutingOverrides,
  refreshModelRegistry,
  renameGlobalModelRoutingProfile,
  resolveTaskTypeMeta,
  saveGlobalProfileCustomType,
  saveGlobalProfileFallbackMapping,
  formatModelRoutingConfig,
  unreachableRoutingTargets,
  saveGlobalProfileModelMapping,
  saveGlobalProfileRoleMapping,
  saveGlobalProfileTypeRoles,
  saveGlobalProfileThinkingLevel,
  saveGlobalProfileTypeMeta,
  deleteGlobalProfileCustomType,
  saveProjectFallbackMapping,
  saveProjectModelMapping,
  saveProjectRoleMapping,
  saveProjectThinkingLevel,
  saveSessionModelRoutingOverrides,
  setDefaultGlobalModelRoutingProfile,
  setGlobalAskBeforeDispatch,
  setProjectActiveModelRoutingProfile,
  setProjectModelRoutingOverridesEnabled,
  syncModelCircuitPolicies,
  TEAMMATE_TASK_TYPE_META,
} from "../src/models/model-routing.ts";

const mutableFs = createRequire(import.meta.url)("node:fs") as typeof fs;

function withProjectRenameFailure<T>(projectFilePath: string, action: () => T): T {
  const originalRename = mutableFs.renameSync;
  const replacement: typeof fs.renameSync = (oldPath, newPath) => {
    if (path.resolve(String(newPath)) === path.resolve(projectFilePath)) {
      throw Object.assign(new Error("injected project routing rename failure"), { code: "EACCES" });
    }
    return originalRename(oldPath, newPath);
  };
  Reflect.set(mutableFs, "renameSync", replacement);
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    Reflect.set(mutableFs, "renameSync", originalRename);
    syncBuiltinESMExports();
  }
}

function withProjectPostRenameSyncFailure<T>(projectFilePath: string, action: () => T): T {
  const originalOpen = mutableFs.openSync;
  const originalFsync = mutableFs.fsyncSync;
  let destinationHandle: number | undefined;
  let failed = false;
  const replacementOpen = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const handle = originalOpen(filePath, flags, mode);
    if (path.resolve(String(filePath)) === path.resolve(projectFilePath) && flags === "r+") {
      destinationHandle = handle;
    }
    return handle;
  }) as typeof fs.openSync;
  const replacementFsync: typeof fs.fsyncSync = (handle) => {
    if (!failed && handle === destinationHandle) {
      failed = true;
      throw Object.assign(new Error("injected post-rename project fsync failure"), { code: "EIO" });
    }
    return originalFsync(handle);
  };
  Reflect.set(mutableFs, "openSync", replacementOpen);
  Reflect.set(mutableFs, "fsyncSync", replacementFsync);
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    Reflect.set(mutableFs, "openSync", originalOpen);
    Reflect.set(mutableFs, "fsyncSync", originalFsync);
    syncBuiltinESMExports();
  }
}

function withReadFailure<T>(filePath: string, action: () => T): T {
  const originalRead = mutableFs.readFileSync;
  const replacementRead = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (typeof target !== "number" && path.resolve(String(target)) === path.resolve(filePath)) {
      throw Object.assign(new Error("injected config read failure"), { code: "EACCES" });
    }
    return originalRead(target, options as never);
  }) as typeof fs.readFileSync;
  Reflect.set(mutableFs, "readFileSync", replacementRead);
  syncBuiltinESMExports();
  try {
    return action();
  } finally {
    Reflect.set(mutableFs, "readFileSync", originalRead);
    syncBuiltinESMExports();
  }
}

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
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5", globalPath);
    assert.equal(loadModelRoutingConfig(cwd, globalPath).mappings.analysis, "openai/gpt-5");
    assert.equal(fs.existsSync(getProjectModelRoutingPath(cwd)), true);

    const routed = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["openai/gpt-5"], globalPath);
    assert.equal(routed.tasks[0].model, "openai/gpt-5");

    const explicit = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      model: "anthropic/claude-opus",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["openai/gpt-5", "anthropic/claude-opus"], globalPath);
    assert.equal(explicit.tasks[0].model, "anthropic/claude-opus");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("custom role mappings persist independently from task-type routing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-mapping-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "security-specialist.md"), `---
name: security-specialist
description: Security role
taskType: analysis
---
Review security.
`);
  try {
    saveGlobalProfileRoleMapping(cwd, "default", "security-specialist", {
      model: "provider/role",
      fallbackModels: ["provider/role-backup"],
      thinking: "high",
    }, globalPath);
    assert.equal(loadModelRoutingConfig(cwd, globalPath).roleMappings?.["security-specialist"]?.model, "provider/role");

    const routed = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Review the module" }],
    }, cwd, ["provider/role", "provider/role-backup"], globalPath);
    assert.equal(routed.tasks[0].model, "provider/role");
    assert.deepEqual(routed.tasks[0].fallbackModels, ["provider/role-backup"]);
    assert.equal(routed.tasks[0].thinking, "high");

    saveProjectRoleMapping(cwd, "security-specialist", { model: "provider/project-role" }, globalPath);
    const projectRouted = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Review the module" }],
    }, cwd, ["provider/project-role"], globalPath);
    assert.equal(projectRouted.tasks[0].model, "provider/project-role");
    const persisted = JSON.parse(fs.readFileSync(getProjectModelRoutingPath(cwd), "utf8"));
    assert.equal(persisted.overrides.roleMappings["security-specialist"].model, "provider/project-role");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("role frontmatter taskType routes models below explicit task types", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
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
    saveProjectModelMapping(cwd, "security-audit", "provider/review", globalPath);
    saveProjectModelMapping(cwd, "analysis", "provider/analysis", globalPath);
    saveProjectModelMapping(cwd, "debug", "provider/debug", globalPath);
    const available = ["provider/review", "provider/analysis", "provider/debug"];

    const fromRole = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, available, globalPath);
    assert.equal(fromRole.tasks[0].taskType, "security-audit");
    assert.equal(fromRole.tasks[0].model, "provider/review");
    assert.ok(discoverRoutingTaskTypes(
      cwd,
      [{ taskType: "security-audit" }],
      loadModelRoutingConfig(cwd, globalPath),
    ).includes("security-audit"));

    const fromTopLevel = applyModelRouting({
      taskType: "analysis",
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, available, globalPath);
    assert.equal(fromTopLevel.tasks[0].taskType, "analysis");
    assert.equal(fromTopLevel.tasks[0].model, "provider/analysis");

    const fromTask = applyModelRouting({
      taskType: "analysis",
      tasks: [{ agent: "security-specialist", taskType: "debug", prompt: "Inspect the module" }],
    }, cwd, available, globalPath);
    assert.equal(fromTask.tasks[0].taskType, "debug");
    assert.equal(fromTask.tasks[0].model, "provider/debug");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("role frontmatter model outranks inherited parent model but not task-type mapping", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-model-routing-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "home", "teammate-models.json");
  const agentsDir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "security-specialist.md"), `---
name: security-specialist
description: Security review specialist
model: provider/role
taskType: analysis
---
Review security evidence.
`);
  try {
    const fromRole = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, ["provider/role", "provider/parent"], globalPath, "provider/parent");
    assert.equal(fromRole.tasks[0].model, "provider/role");

    saveProjectModelMapping(cwd, "analysis", "provider/analysis", globalPath);
    const fromTaskType = applyModelRouting({
      tasks: [{ agent: "security-specialist", prompt: "Inspect the module" }],
    }, cwd, ["provider/analysis", "provider/role", "provider/parent"], globalPath, "provider/parent");
    assert.equal(fromTaskType.tasks[0].model, "provider/analysis");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task cwd selects that project's custom role type and routing config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-cwd-routing-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
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
    saveProjectModelMapping(target, "release", "provider/release", globalPath);
    const routed = applyModelRouting({
      tasks: [{ agent: "release-manager", cwd: target, prompt: "Prepare release" }],
    }, root, ["provider/release"], globalPath);
    assert.equal(routed.tasks[0].taskType, "release");
    assert.equal(routed.tasks[0].model, "provider/release");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fallback mappings persist, filter unavailable models, and follow explicit precedence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-fallback-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectFallbackMapping(
      cwd,
      "analysis",
      ["provider/backup-a", "provider/backup-a", "provider/backup-b"],
      globalPath,
    );
    assert.deepEqual(loadModelRoutingConfig(cwd, globalPath).fallbackMappings?.analysis, [
      "provider/backup-a",
      "provider/backup-b",
    ]);

    const mapped = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["provider/primary", "provider/backup-b"], globalPath);
    assert.deepEqual(mapped.tasks[0].fallbackModels, ["provider/backup-b"]);

    const topLevel = applyModelRouting({
      taskType: "analysis",
      fallbackModels: ["provider/top"],
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["provider/top", "provider/task"], globalPath);
    assert.deepEqual(topLevel.tasks[0].fallbackModels, ["provider/top"]);

    const perTask = applyModelRouting({
      taskType: "analysis",
      fallbackModels: ["provider/top"],
      tasks: [{ prompt: "Trace the request", fallbackModels: ["provider/task"] }],
    }, cwd, ["provider/top", "provider/task"], globalPath);
    assert.deepEqual(perTask.tasks[0].fallbackModels, ["provider/task"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("dispatch inherits the main session model when no explicit model is set", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-inherit-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    const routed = applyModelRouting({
      agent: "general",
      tasks: [{ prompt: "Inspect the module" }],
    }, cwd, ["maestro/main-session", "other/model"], globalPath, "maestro/main-session");
    assert.equal(routed.tasks[0].model, "maestro/main-session");

    const emptyCatalog = applyModelRouting({
      tasks: [{ prompt: "Inspect the module" }],
    }, cwd, [], globalPath, "maestro/main-session");
    assert.equal(emptyCatalog.tasks[0].model, "maestro/main-session");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("task-level and top-level models beat the inherited main session model", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-inherit-explicit-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    const topLevel = applyModelRouting({
      model: "provider/top",
      tasks: [{ prompt: "Inspect the module" }],
    }, cwd, ["provider/top", "maestro/main-session"], globalPath, "maestro/main-session");
    assert.equal(topLevel.tasks[0].model, "provider/top");

    const perTask = applyModelRouting({
      tasks: [{ prompt: "Inspect the module", model: "provider/task" }],
    }, cwd, ["provider/task", "maestro/main-session"], globalPath, "maestro/main-session");
    assert.equal(perTask.tasks[0].model, "provider/task");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("configured task-type mappings beat the inherited main session model", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-inherit-mapping-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectModelMapping(cwd, "analysis", "provider/analysis", globalPath);
    const routed = applyModelRouting({
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["provider/analysis", "maestro/main-session"], globalPath, "maestro/main-session");
    assert.equal(routed.tasks[0].model, "provider/analysis");

    // A configured mapping that is not authenticated falls through to inheritance.
    const filtered = applyModelRouting({
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["maestro/main-session"], globalPath, "maestro/main-session");
    assert.equal(filtered.tasks[0].model, "maestro/main-session");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an inherited model absent from the catalog is skipped", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-inherit-stale-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    const routed = applyModelRouting({
      tasks: [{ prompt: "Inspect the module" }],
    }, cwd, ["other/model"], globalPath, "stale/session-model");
    assert.equal(routed.tasks[0].model, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("v1 routing configs migrate without losing models and thinking saves independently", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 1,
      mappings: { analysis: "openai/gpt-5", review: "anthropic/sonnet", testing: null },
    }));
    const migrated = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.mappings.analysis, "openai/gpt-5");
    assert.equal(migrated.mappings.review, "anthropic/sonnet");
    assert.equal(migrated.mappings.testing, null);

    saveProjectThinkingLevel(cwd, "analysis", "high", globalPath);
    const persisted = JSON.parse(fs.readFileSync(getProjectModelRoutingPath(cwd), "utf8"));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.activeProfile, "default");
    assert.equal(persisted.applyOverrides, true);
    assert.deepEqual(persisted.overrides.mappings, {
      analysis: "openai/gpt-5",
      review: "anthropic/sonnet",
      testing: null,
    });
    assert.deepEqual(persisted.overrides.thinkingLevels, { analysis: "high" });
    saveProjectModelMapping(cwd, "analysis", "anthropic/sonnet", globalPath);
    assert.equal(loadModelRoutingConfig(cwd, globalPath).thinkingLevels.analysis, "high");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy routing saves migrate valid custom task routes atomically", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    const configPath = getProjectModelRoutingPath(cwd);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      version: 2,
      mappings: { future: "future/model" },
      fallbackMappings: { future: ["future/backup"] },
      thinkingLevels: {},
    }));
    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5", globalPath);
    saveProjectThinkingLevel(cwd, "analysis", "high", globalPath);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.applyOverrides, true);
    assert.equal(persisted.overrides.mappings.future, "future/model");
    assert.deepEqual(persisted.overrides.fallbackMappings.future, ["future/backup"]);
    assert.equal(persisted.overrides.mappings.analysis, "openai/gpt-5");
    assert.equal(persisted.overrides.thinkingLevels.analysis, "high");
    assert.equal(fs.readdirSync(path.dirname(configPath)).some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("teammate model and thinking saves never mutate the original model configuration", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
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

    saveProjectModelMapping(cwd, "analysis", "openai/gpt-5", globalPath);
    saveProjectThinkingLevel(cwd, "analysis", "xhigh", globalPath);

    assert.equal(fs.readFileSync(originalModelsPath, "utf8"), originalModels);
    assert.equal(fs.readFileSync(originalSettingsPath, "utf8"), originalSettings);
    assert.deepEqual(JSON.parse(fs.readFileSync(getProjectModelRoutingPath(cwd), "utf8")), {
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: {
        mappings: { analysis: "openai/gpt-5" },
        thinkingLevels: { analysis: "xhigh" },
      },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("thinking routing follows per-task, top-level, task type, then agent fallback precedence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectThinkingLevel(cwd, "analysis", "medium", globalPath);
    const routed = applyModelRouting({
      agent: "general",
      thinking: "low",
      tasks: [
        { agent: "general", prompt: "one", taskType: "analysis", thinking: "xhigh" },
        { agent: "general", prompt: "two", taskType: "analysis" },
      ],
    }, cwd, [], globalPath);
    assert.equal(routed.tasks?.[0].thinking, "xhigh");
    assert.equal(routed.tasks?.[1].thinking, "low");

    const mapped = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "work" }],
    }, cwd, [], globalPath);
    assert.equal(mapped.tasks[0].thinking, "medium");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("max is a first-class level that survives routing and persistence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 2,
      mappings: {},
      thinkingLevels: { analysis: "max" },
    }));
    assert.equal(loadModelRoutingConfig(cwd, globalPath).thinkingLevels.analysis, "max");

    const topLevel = applyModelRouting({
      agent: "general",
      thinking: "max",
      tasks: [{ prompt: "work" }],
    }, cwd, [], globalPath);
    assert.equal(topLevel.thinking, "max");
    const tasks = applyModelRouting({
      agent: "general",
      thinking: "low",
      tasks: [{ agent: "general", prompt: "work", thinking: "max" }],
    }, cwd, [], globalPath);
    assert.equal(tasks.tasks?.[0].thinking, "max");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("multi-task routing applies per phase while explicit defaults win", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectModelMapping(cwd, "explore", "google/gemini-pro", globalPath);
    saveProjectModelMapping(cwd, "debug", "openai/gpt-5", globalPath);

    const routed = applyModelRouting({
      agent: "general",
      tasks: [
        { agent: "explorer", prompt: "Locate auth handlers" },
        { agent: "general", prompt: "Diagnose auth failure", taskType: "debug" },
        { agent: "reviewer", prompt: "Review the fix", model: "anthropic/claude-sonnet" },
      ],
    }, cwd, ["google/gemini-pro", "openai/gpt-5", "anthropic/claude-sonnet"], globalPath);
    assert.equal(routed.tasks?.[0].model, "google/gemini-pro");
    assert.equal(routed.tasks?.[1].model, "openai/gpt-5");
    assert.equal(routed.tasks?.[2].model, "anthropic/claude-sonnet");

    const topLevel = applyModelRouting({
      agent: "general",
      model: "openai/default",
      tasks: [{ agent: "explorer", prompt: "Locate routes" }],
    }, cwd, ["google/gemini-pro", "openai/default"], globalPath);
    assert.equal(topLevel.tasks?.[0].model, "openai/default");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("nested teammate routing is deferred to the authoritative root proxy", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf8");
  // The child proxy execute signature dropped the leading underscore on id
  // and now passes id as a fourth proxyCall arg (root-session routing identity).
  assert.match(source, /execute\(id: string, params: RunTeammateParams, signal: AbortSignal\)[\s\S]*?proxyCall<Details>\("teammate", params, signal, id\)/);
  assert.match(source, /const routedParams = applyModelRouting\([\s\S]*?effectiveModelCapabilities\.map[\s\S]*?normalizeTeammateParams\(routedParams\)/);
});

test("unavailable configured models fall back instead of launching invalid model IDs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-routing-"));
  const globalPath = path.join(cwd, "home", "teammate-models.json");
  try {
    saveProjectModelMapping(cwd, "planning", "missing/model", globalPath);
    const routed = applyModelRouting({
      agent: "general",
      taskType: "planning",
      tasks: [{ prompt: "Plan migration" }],
    }, cwd, ["openai/gpt-5"], globalPath);
    assert.equal(routed.tasks[0].model, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("global profiles are shared while each project persists its active selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profiles-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  try {
    const created = createGlobalModelRoutingProfile(firstProject, "Fast Lane", undefined, globalPath);
    const fastId = created.changedProfileId;
    assert.equal(fastId, "fast-lane");
    saveGlobalProfileModelMapping(firstProject, fastId!, "explore", "provider/fast", globalPath);
    saveGlobalProfileFallbackMapping(firstProject, fastId!, "explore", ["provider/backup"], globalPath);
    saveGlobalProfileThinkingLevel(firstProject, fastId!, "explore", "low", globalPath);

    const selected = setProjectActiveModelRoutingProfile(firstProject, fastId!, globalPath);
    assert.equal(selected.config.profileId, fastId);
    assert.equal(selected.config.mappings.explore, "provider/fast");
    assert.deepEqual(selected.config.fallbackMappings?.explore, ["provider/backup"]);
    assert.equal(selected.config.thinkingLevels.explore, "low");
    assert.equal(loadModelRoutingState(secondProject, globalPath).config.profileId, "default");

    setDefaultGlobalModelRoutingProfile(firstProject, fastId!, globalPath);
    assert.equal(loadModelRoutingConfig(secondProject, globalPath).mappings.explore, "provider/fast");
    const routed = applyModelRouting({
      tasks: [{ agent: "explorer", prompt: "Locate files" }],
    }, firstProject, ["provider/fast", "provider/backup"], globalPath);
    assert.equal(routed.tasks[0].model, "provider/fast");
    assert.deepEqual(routed.tasks[0].fallbackModels, ["provider/backup"]);
    assert.equal(routed.tasks[0].thinking, "low");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent processes preserve every global Profile update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-lock-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const markerPath = path.join(root, "start");
  const moduleUrl = new URL("../src/models/model-routing.ts", import.meta.url).href;
  try {
    const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = deadOwner.pid!;
    await new Promise<void>((resolve, reject) => {
      deadOwner.on("error", reject);
      deadOwner.on("exit", () => resolve());
    });
    const staleLockPath = `${globalPath}.lock`;
    fs.mkdirSync(staleLockPath, { recursive: true });
    fs.writeFileSync(path.join(staleLockPath, "owner.json"), JSON.stringify({
      version: 1,
      pid: deadPid,
      token: "00000000-0000-4000-8000-000000000001",
      createdAtMs: Date.now() - 60_000,
      startedAtMs: 0,
      startIdentity: "dead-process",
    }));
    const workers = Array.from({ length: 8 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const script = `
        import fs from "node:fs";
        import { createGlobalModelRoutingProfile } from ${JSON.stringify(moduleUrl)};
        while (!fs.existsSync(${JSON.stringify(markerPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        for (let index = 0; index < 4; index++) {
          createGlobalModelRoutingProfile(${JSON.stringify(path.join(root, "project"))}, \`worker-${worker}-\${index}\`, undefined, ${JSON.stringify(globalPath)});
        }
      `;
      const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`)));
    }));
    fs.writeFileSync(markerPath, "go");
    await Promise.all(workers);
    const state = loadModelRoutingState(path.join(root, "project"), globalPath);
    assert.equal(Object.keys(state.global.profiles).length, 33);
    for (let worker = 0; worker < 8; worker++) {
      for (let index = 0; index < 4; index++) assert.ok(state.global.profiles[`worker-${worker}-${index}`]);
    }
    assert.equal(fs.existsSync(`${globalPath}.lock`), false);
    fs.rmSync(`${staleLockPath}.stale.00000000-0000-4000-8000-000000000001`, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("a recycled live PID cannot keep an abandoned config lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-recycled-pid-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const lockPath = `${globalPath}.lock`;
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000002",
      createdAtMs: Date.now() - 60_000,
      startedAtMs: 0,
      startIdentity: "recycled-owner",
      startObserved: true,
    }));
    const created = createGlobalModelRoutingProfile(root, "Recovered Lock", undefined, globalPath);
    assert.equal(created.changedProfileId, "recovered-lock");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("a weak wall-clock start estimate never reclaims a live lock owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-live-owner-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const lockPath = `${globalPath}.lock`;
  const markerPath = path.join(root, "owner-ready");
  try {
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.mkdirSync(${JSON.stringify(lockPath)}, { recursive: true });
      fs.writeFileSync(path.join(${JSON.stringify(lockPath)}, "owner.json"), JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000003",
        createdAtMs: Date.now() - 60000,
        startedAtMs: 0
      }));
      fs.writeFileSync(${JSON.stringify(markerPath)}, "ready");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    `;
    const owner = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    while (!fs.existsSync(markerPath)) {
      if (owner.exitCode !== null) throw new Error(`lock owner exited early: ${owner.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const startedAt = Date.now();
    const created = createGlobalModelRoutingProfile(root, "Waited For Owner", undefined, globalPath);
    assert.equal(created.changedProfileId, "waited-for-owner");
    assert.ok(Date.now() - startedAt >= 2_500, "live owner was reclaimed from a weak wall-clock estimate");
    if (owner.exitCode === null) {
      await new Promise<void>((resolve, reject) => {
        owner.on("error", reject);
        owner.on("exit", () => resolve());
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("create-and-activate rolls back the global Profile when the project write fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-rollback-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  try {
    fs.mkdirSync(getProjectModelRoutingPath(cwd), { recursive: true });
    assert.throws(
      () => createAndActivateGlobalModelRoutingProfile(cwd, "Must Roll Back", undefined, globalPath),
    );
    assert.equal(fs.existsSync(globalPath), false);
    assert.equal(fs.statSync(getProjectModelRoutingPath(cwd)).isDirectory(), true);
    assert.equal(fs.existsSync(`${globalPath}.lock`), false);
    assert.equal(fs.existsSync(`${getProjectModelRoutingPath(cwd)}.lock`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("promote and active delete roll back when their project write fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-callers-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const promoteProject = path.join(root, "promote-project");
  const deleteProject = path.join(root, "delete-project");
  try {
    saveProjectModelMapping(promoteProject, "analysis", "provider/project", globalPath);
    assert.throws(() => withProjectRenameFailure(
      getProjectModelRoutingPath(promoteProject),
      () => promoteProjectModelRoutingOverrides(promoteProject, "Must Not Persist", globalPath),
    ), /injected project routing rename failure/);
    const afterPromote = loadModelRoutingState(promoteProject, globalPath);
    assert.deepEqual(Object.keys(afterPromote.global.profiles), ["default"]);
    assert.equal(afterPromote.project.applyOverrides, true);
    assert.equal(afterPromote.config.mappings.analysis, "provider/project");

    const created = createAndActivateGlobalModelRoutingProfile(deleteProject, "Delete Target", undefined, globalPath);
    const deleteId = created.changedProfileId!;
    assert.throws(() => withProjectRenameFailure(
      getProjectModelRoutingPath(deleteProject),
      () => deleteGlobalModelRoutingProfile(deleteProject, deleteId, globalPath),
    ), /injected project routing rename failure/);
    const afterDelete = loadModelRoutingState(deleteProject, globalPath);
    assert.equal(afterDelete.project.activeProfile, deleteId);
    assert.ok(afterDelete.global.profiles[deleteId]);
    assert.equal(fs.existsSync(`${globalPath}.transaction.json`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("post-rename project sync failures complete the forward transaction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-post-rename-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  try {
    const created = withProjectPostRenameSyncFailure(
      getProjectModelRoutingPath(cwd),
      () => createAndActivateGlobalModelRoutingProfile(cwd, "Durable Forward", undefined, globalPath),
    );
    assert.equal(created.changedProfileId, "durable-forward");
    const state = loadModelRoutingState(cwd, globalPath);
    assert.equal(state.project.activeProfile, "durable-forward");
    assert.ok(state.global.profiles["durable-forward"]);
    assert.equal(fs.existsSync(`${globalPath}.transaction.json`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("malformed and unreadable stores fail closed without changing their bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-invalid-store-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  const projectPath = getProjectModelRoutingPath(cwd);
  try {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, "{ malformed");
    assert.throws(
      () => createGlobalModelRoutingProfile(cwd, "Must Not Replace", undefined, globalPath),
      /Invalid JSON/,
    );
    assert.equal(fs.readFileSync(globalPath, "utf8"), "{ malformed");

    const invalidGlobal = `${JSON.stringify({ version: 3, defaultProfile: "default", profiles: { broken: null } })}\n`;
    fs.writeFileSync(globalPath, invalidGlobal);
    assert.throws(
      () => createGlobalModelRoutingProfile(cwd, "Still Safe", undefined, globalPath),
      /Invalid v3 global/,
    );
    assert.equal(fs.readFileSync(globalPath, "utf8"), invalidGlobal);

    for (const invalidValue of [
      {
        version: 3,
        defaultProfile: "default",
        profiles: { default: { name: "Default", mappings: "invalid", thinkingLevels: {} } },
      },
      {
        version: 3,
        defaultProfile: "default",
        profiles: { default: { name: "Default", mappings: {}, thinkingLevels: {} } },
        retiredProfileIds: ["not valid"],
      },
      { version: 4, profiles: { future: { preserved: true } } },
    ]) {
      const invalidBytes = `${JSON.stringify(invalidValue)}\n`;
      fs.writeFileSync(globalPath, invalidBytes);
      assert.throws(() => createGlobalModelRoutingProfile(cwd, "No Rewrite", undefined, globalPath));
      assert.equal(fs.readFileSync(globalPath, "utf8"), invalidBytes);
    }

    const validGlobal = `${JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: { default: { name: "Default", mappings: {}, thinkingLevels: {} } },
    }, null, 2)}\n`;
    fs.writeFileSync(globalPath, validGlobal);
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, "{ malformed project");
    assert.throws(
      () => setProjectActiveModelRoutingProfile(cwd, "default", globalPath),
      /Invalid JSON/,
    );
    assert.equal(fs.readFileSync(projectPath, "utf8"), "{ malformed project");

    const invalidProject = `${JSON.stringify({
      version: 3,
      activeProfile: "default",
      applyOverrides: true,
      overrides: { mappings: { analysis: 42 }, thinkingLevels: {} },
    })}\n`;
    fs.writeFileSync(projectPath, invalidProject);
    assert.throws(() => setProjectActiveModelRoutingProfile(cwd, "default", globalPath), /Invalid project overrides mapping/);
    assert.equal(fs.readFileSync(projectPath, "utf8"), invalidProject);

    fs.rmSync(projectPath);
    assert.throws(
      () => withReadFailure(globalPath, () => createGlobalModelRoutingProfile(cwd, "Unreadable", undefined, globalPath)),
      /injected config read failure/,
    );
    assert.equal(fs.readFileSync(globalPath, "utf8"), validGlobal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("Profile lookup uses own IDs and deleted IDs are never reused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-id-safety-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  try {
    const constructorProfile = createGlobalModelRoutingProfile(firstProject, "Constructor", undefined, globalPath);
    assert.equal(constructorProfile.changedProfileId, "constructor");
    setProjectActiveModelRoutingProfile(secondProject, "constructor", globalPath);
    deleteGlobalModelRoutingProfile(firstProject, "constructor", globalPath);

    const missing = loadModelRoutingState(secondProject, globalPath);
    assert.equal(missing.config.profileId, "default");
    assert.equal(missing.missingProfile, "constructor");

    const replacement = createGlobalModelRoutingProfile(firstProject, "Constructor", undefined, globalPath);
    assert.equal(replacement.changedProfileId, "constructor-2");
    const stillMissing = loadModelRoutingState(secondProject, globalPath);
    assert.equal(stillMissing.config.profileId, "default");
    assert.equal(stillMissing.missingProfile, "constructor");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("released lock cleanup failure does not invalidate a committed Profile write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-release-cleanup-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const originalRm = mutableFs.rmSync;
  let injected = false;
  const replacementRm: typeof fs.rmSync = (target, options) => {
    if (!injected && String(target).includes(".released.")) {
      injected = true;
      throw Object.assign(new Error("injected released lock cleanup failure"), { code: "EPERM" });
    }
    return originalRm(target, options);
  };
  try {
    Reflect.set(mutableFs, "rmSync", replacementRm);
    syncBuiltinESMExports();
    const created = createGlobalModelRoutingProfile(root, "Committed", undefined, globalPath);
    assert.equal(created.changedProfileId, "committed");
    assert.ok(loadModelRoutingState(root, globalPath).global.profiles.committed);
  } finally {
    Reflect.set(mutableFs, "rmSync", originalRm);
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("lock candidate initialization failure cleans its private directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-candidate-cleanup-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const originalWrite = mutableFs.writeFileSync;
  const originalRm = mutableFs.rmSync;
  const replacementWrite = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    if (typeof target !== "number" && path.basename(String(target)) === "owner.json") {
      throw Object.assign(new Error("injected owner write failure"), { code: "ENOSPC" });
    }
    return originalWrite(target, data, options as never);
  }) as typeof fs.writeFileSync;
  try {
    Reflect.set(mutableFs, "writeFileSync", replacementWrite);
    syncBuiltinESMExports();
    assert.throws(
      () => createGlobalModelRoutingProfile(root, "No Candidate Leak", undefined, globalPath),
      /injected owner write failure/,
    );
    const entries = fs.existsSync(path.dirname(globalPath)) ? fs.readdirSync(path.dirname(globalPath)) : [];
    assert.equal(entries.some((entry) => entry.includes(".candidate.")), false);

    const failedCleanupRm: typeof fs.rmSync = (target, options) => {
      if (String(target).includes(".candidate.")) {
        throw Object.assign(new Error("injected candidate cleanup failure"), { code: "EBUSY" });
      }
      return originalRm(target, options);
    };
    Reflect.set(mutableFs, "rmSync", failedCleanupRm);
    syncBuiltinESMExports();
    let aggregate: AggregateError | undefined;
    try {
      createGlobalModelRoutingProfile(root, "Reported Candidate Leak", undefined, globalPath);
      assert.fail("expected lock initialization and cleanup to fail");
    } catch (error) {
      assert.ok(error instanceof AggregateError);
      aggregate = error;
    }
    assert.equal(aggregate.errors.length, 2);
    assert.match(String(aggregate.errors[0]), /injected owner write failure/);
    assert.match(String(aggregate.errors[1]), /injected candidate cleanup failure/);
  } finally {
    Reflect.set(mutableFs, "writeFileSync", originalWrite);
    Reflect.set(mutableFs, "rmSync", originalRm);
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test("transaction journals recover interrupted forward and rollback operations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profile-journal-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  const projectPath = getProjectModelRoutingPath(cwd);
  const journalPath = `${globalPath}.transaction.json`;
  const globalBefore = {
    version: 3,
    defaultProfile: "default",
    profiles: { default: { name: "Default", mappings: {}, thinkingLevels: {} } },
  } as const;
  const globalAfter = {
    version: 3,
    defaultProfile: "default",
    profiles: {
      default: { name: "Default", mappings: {}, thinkingLevels: {} },
      recovered: { name: "Recovered", mappings: { analysis: "provider/recovered" }, thinkingLevels: {} },
    },
  } as const;
  const projectAfter = {
    version: 3,
    activeProfile: "recovered",
    applyOverrides: false,
    overrides: { mappings: {}, thinkingLevels: {} },
  } as const;
  try {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify(globalAfter));
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      mode: "forward",
      projectFilePath: projectPath,
      globalBefore,
      globalAfter,
      projectAfter,
    }));
    const recovered = loadModelRoutingState(cwd, globalPath);
    assert.equal(recovered.config.profileId, "recovered");
    assert.equal(recovered.config.mappings.analysis, "provider/recovered");
    assert.equal(fs.existsSync(journalPath), false);

    fs.writeFileSync(globalPath, JSON.stringify(globalAfter));
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 1,
      mode: "rollback",
      projectFilePath: projectPath,
      globalBefore,
      globalAfter,
      projectAfter,
    }));
    const rolledBack = loadModelRoutingState(path.join(root, "other-project"), globalPath);
    assert.deepEqual(Object.keys(rolledBack.global.profiles), ["default"]);
    assert.equal(fs.existsSync(journalPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile CRUD keeps stable IDs and safely repairs active selections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profiles-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  try {
    const first = createGlobalModelRoutingProfile(cwd, "Quality", undefined, globalPath);
    const qualityId = first.changedProfileId!;
    const duplicate = createGlobalModelRoutingProfile(cwd, "Quality", qualityId, globalPath);
    assert.equal(duplicate.changedProfileId, "quality-2");

    renameGlobalModelRoutingProfile(cwd, qualityId, "Deep Review", globalPath);
    const renamed = loadModelRoutingState(cwd, globalPath);
    assert.equal(renamed.global.profiles[qualityId].name, "Deep Review");
    assert.ok(renamed.global.profiles[qualityId]);

    setDefaultGlobalModelRoutingProfile(cwd, qualityId, globalPath);
    assert.throws(
      () => deleteGlobalModelRoutingProfile(cwd, qualityId, globalPath),
      /default.*cannot be deleted/i,
    );
    setProjectActiveModelRoutingProfile(cwd, duplicate.changedProfileId!, globalPath);
    const deleted = deleteGlobalModelRoutingProfile(cwd, duplicate.changedProfileId!, globalPath);
    assert.equal(deleted.config.profileId, qualityId);
    assert.equal(deleted.project.activeProfile, qualityId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy project routing migrates as preserved overrides and can be promoted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profiles-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  try {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({
      version: 2,
      mappings: { analysis: "provider/global" },
      fallbackMappings: { analysis: ["provider/backup"] },
      thinkingLevels: { analysis: "high" },
    }));
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 1,
      mappings: { analysis: "provider/project", review: "provider/review" },
      thinkingLevels: { review: "max" },
    }));

    const legacy = loadModelRoutingState(cwd, globalPath);
    assert.equal(legacy.config.profileId, "default");
    assert.equal(legacy.config.mappings.analysis, "provider/project");
    assert.equal(legacy.config.thinkingLevels.review, "max");
    assert.equal(legacy.project.applyOverrides, true);

    const switched = setProjectActiveModelRoutingProfile(cwd, "default", globalPath);
    assert.equal(switched.project.applyOverrides, false);
    assert.equal(switched.config.mappings.analysis, "provider/global");
    assert.equal(switched.project.overrides.mappings.review, "provider/review");

    const restored = setProjectModelRoutingOverridesEnabled(cwd, true, globalPath);
    assert.equal(restored.config.mappings.analysis, "provider/project");
    const promoted = promoteProjectModelRoutingOverrides(cwd, "Imported Project", globalPath);
    assert.equal(promoted.changedProfileId, "imported-project");
    assert.equal(promoted.project.applyOverrides, false);
    assert.equal(promoted.config.mappings.analysis, "provider/project");
    assert.equal(promoted.config.mappings.review, "provider/review");
    assert.deepEqual(promoted.config.fallbackMappings?.analysis, ["provider/backup"]);

    const cleared = clearProjectModelRoutingOverrides(cwd, globalPath);
    assert.deepEqual(cleared.project.overrides, { mappings: {}, thinkingLevels: {} });
    assert.equal(cleared.project.applyOverrides, false);
    const persistedGlobal = JSON.parse(fs.readFileSync(globalPath, "utf8"));
    assert.equal(persistedGlobal.version, 3);
    assert.equal(persistedGlobal.profiles.default.mappings.analysis, "provider/global");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refreshModelRegistry calls refresh on the registry receiver and coalesces", async () => {
  let calls = 0;
  const registry = {
    runtime: { refreshed: 0 },
    // Mirrors the host ModelRegistry class method: reads `this.runtime`.
    async refresh(): Promise<void> {
      this.runtime.refreshed++;
      calls++;
    },
  };
  await refreshModelRegistry({ modelRegistry: registry as never });
  await refreshModelRegistry({ modelRegistry: registry as never });
  assert.equal(calls, 2, "each awaited call must run the host refresh");
  assert.equal(registry.runtime.refreshed, 2);

  // Concurrent calls coalesce onto one in-flight refresh.
  calls = 0;
  registry.runtime.refreshed = 0;
  await Promise.all([
    refreshModelRegistry({ modelRegistry: registry as never }),
    refreshModelRegistry({ modelRegistry: registry as never }),
    refreshModelRegistry({ modelRegistry: registry as never }),
  ]);
  assert.equal(calls, 1, "concurrent calls must share one in-flight refresh");
  assert.equal(registry.runtime.refreshed, 1);
});

test("refreshModelRegistry coalesces only calls for the same registry", async () => {
  let callsA = 0;
  let callsB = 0;
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const registryA = {
    runtime: { refreshed: 0 },
    async refresh(): Promise<void> {
      this.runtime.refreshed++;
      callsA++;
      await gateA;
    },
  };
  const registryB = {
    runtime: { refreshed: 0 },
    async refresh(): Promise<void> {
      this.runtime.refreshed++;
      callsB++;
    },
  };

  const pendingA = refreshModelRegistry({ modelRegistry: registryA as never });
  const pendingB = refreshModelRegistry({ modelRegistry: registryB as never });
  releaseA?.();
  await Promise.all([pendingA, pendingB]);

  assert.equal(callsA, 1);
  assert.equal(callsB, 1, "a separate registry must not reuse another registry's refresh");
  assert.equal(registryA.runtime.refreshed, 1);
  assert.equal(registryB.runtime.refreshed, 1);
});

test("refreshModelRegistry without a refresh-capable registry is a no-op", async () => {
  await refreshModelRegistry({});
  await refreshModelRegistry({ modelRegistry: undefined });
  await refreshModelRegistry({ modelRegistry: { getAvailable: () => [] } as never });
});

test("missing project profile falls back to the global default with diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-profiles-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  try {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({
      version: 3,
      defaultProfile: "stable",
      profiles: {
        stable: { name: "Stable", mappings: { testing: "provider/stable" }, thinkingLevels: {} },
      },
    }));
    fs.mkdirSync(path.dirname(getProjectModelRoutingPath(cwd)), { recursive: true });
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 3,
      activeProfile: "removed",
      applyOverrides: false,
      overrides: { mappings: {}, thinkingLevels: {} },
    }));
    const state = loadModelRoutingState(cwd, globalPath);
    assert.equal(state.requestedProfile, "removed");
    assert.equal(state.missingProfile, "removed");
    assert.equal(state.config.profileId, "stable");
    assert.equal(state.config.mappings.testing, "provider/stable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("role circuit policies persist, validate, and sync onto a circuit breaker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-circuit-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "breaker-role.md"), `---
name: breaker-role
description: Circuit configured role
---
Work.
`);
  try {
    saveGlobalProfileRoleMapping(cwd, "default", "breaker-role", {
      model: "provider/strict",
      circuit: { threshold: 2, cooldownMs: 30_000 },
    }, globalPath);
    const config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(config.roleMappings?.["breaker-role"]?.circuit, { threshold: 2, cooldownMs: 30_000 });
    assert.equal(config.roleMappings?.["breaker-role"]?.model, "provider/strict");

    // The role's mapped model still routes while the circuit policy is stored.
    const routed = applyModelRouting({
      tasks: [{ agent: "breaker-role", prompt: "Work" }],
    }, cwd, ["provider/strict"], globalPath);
    assert.equal(routed.tasks[0].model, "provider/strict");

    // Runtime sync: the breaker adopts the role's policy for its model.
    let now = 0;
    const breaker = new ModelCircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: () => now });
    syncModelCircuitPolicies(breaker, cwd, globalPath);
    for (let failure = 0; failure < 2; failure += 1) {
      breaker.recordRetryableFailure(breaker.acquireCandidate("provider/strict") as never);
    }
    assert.equal(breaker.snapshot()[0]?.state, "OPEN");
    const rejectedStrict = breaker.acquireCandidate("provider/strict");
    assert.equal(rejectedStrict.allowed, false);
    assert.equal((rejectedStrict as { retryAt?: number }).retryAt, 30_000);

    // Removing the circuit restores the default on the next sync.
    saveGlobalProfileRoleMapping(cwd, "default", "breaker-role", { model: "provider/strict" }, globalPath);
    syncModelCircuitPolicies(breaker, cwd, globalPath);
    for (let failure = 0; failure < 3; failure += 1) {
      breaker.recordRetryableFailure(breaker.acquireCandidate("provider/strict") as never);
    }
    const rejectedDefault = breaker.acquireCandidate("provider/strict");
    assert.equal(rejectedDefault.allowed, false);
    assert.equal((rejectedDefault as { retryAt?: number }).retryAt, now + 60_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid role circuit policies are rejected on write and read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-circuit-invalid-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    assert.throws(
      () => saveGlobalProfileRoleMapping(cwd, "default", "breaker-role", {
        model: "provider/model",
        circuit: { threshold: 0 },
      }, globalPath),
      /positive integer/,
    );
    assert.throws(
      () => saveGlobalProfileRoleMapping(cwd, "default", "breaker-role", {
        model: "provider/model",
        circuit: { cooldownMs: -5 },
      }, globalPath),
      /non-negative/,
    );
    // Unknown circuit keys fail strict validation on load.
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: {
        default: {
          name: "Default",
          mappings: {},
          thinkingLevels: {},
          roleMappings: {
            "breaker-role": { model: "provider/model", circuit: { threshold: 2, reset: true } },
          },
        },
      },
    }));
    assert.throws(() => loadModelRoutingConfig(cwd, globalPath), /Unknown .*circuit field/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("custom agent types register, route-config, and delete via the active profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-custom-type-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    saveGlobalProfileCustomType(cwd, "default", "security-audit", null, globalPath);
    let config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(config.mappings["security-audit"], null);

    // The null marker does not force a model at routing time.
    const routed = applyModelRouting({
      tasks: [{ agent: "general", taskType: "security-audit", prompt: "Work" }],
    }, cwd, [], globalPath);
    assert.equal(routed.tasks[0].model, undefined);

    // Configure the type across all routing sections, then delete them all.
    saveGlobalProfileModelMapping(cwd, "default", "security-audit", "provider/review", globalPath);
    saveGlobalProfileFallbackMapping(cwd, "default", "security-audit", ["provider/backup"], globalPath);
    saveGlobalProfileThinkingLevel(cwd, "default", "security-audit", "high", globalPath);
    deleteGlobalProfileCustomType(cwd, "default", "security-audit", globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(config.mappings["security-audit"], undefined);
    assert.equal(config.fallbackMappings?.["security-audit"], undefined);
    assert.equal(config.thinkingLevels["security-audit"], undefined);

    assert.throws(
      () => saveGlobalProfileCustomType(cwd, "default", "explore", null, globalPath),
      /Cannot register a built-in/,
    );
    assert.throws(
      () => deleteGlobalProfileCustomType(cwd, "default", "review", globalPath),
      /Cannot delete a built-in/,
    );
    assert.throws(
      () => saveGlobalProfileCustomType(cwd, "default", "Not Valid", null, globalPath),
      /Invalid teammate task type/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("appendTaskTypeRoutingContext injects a concise, idempotent routing contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtasktype-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  try {
    const agents = [{ name: "team-worker", taskType: "development" }];
    const first = appendTaskTypeRoutingContext("Base prompt", root, agents, globalPath);
    assert.match(first, /Base prompt/);
    assert.match(first, /teammate-tasktype-routing:start/);
    assert.match(first, /selects configured model, fallback-model, and thinking defaults/);
    assert.match(first, /never changes a chosen agent's role, tools, permissions, or task scope/);
    assert.match(first, /Set `tasks\[\]\.taskType` by the task's actual phase/);
    assert.match(first, /Legal task types/);
    for (const type of ["explore", "analysis", "debug", "planning", "development", "review", "testing"]) {
      assert.match(first, new RegExp(`^  - ${type}$`, "m"));
    }
    assert.doesNotMatch(first, /Role guidance/);
    assert.doesNotMatch(first, /call-chain tracing \(ant, explorer, research\)/);
    assert.match(first, /Current task-type model routing:/);
    assert.match(first, /^  - explore: model=/m);

    // Re-injection replaces the previous block instead of appending a second one.
    const second = appendTaskTypeRoutingContext(first, root, agents, globalPath);
    assert.equal(second.match(/teammate-tasktype-routing:start/g)?.length, 1);
    assert.equal(second.match(/Legal task types/g)?.length, 1);
    assert.match(second, /^Base prompt/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unreachableRoutingTargets flags catalog-missing task-type and role mappings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-unreachable-'));
  const globalPath = path.join(root, 'home', 'teammate-models.json');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    saveGlobalProfileModelMapping(cwd, 'default', 'explore', 'cli/codex', globalPath);
    saveGlobalProfileModelMapping(cwd, 'default', 'review', 'provider/known', globalPath);
    saveGlobalProfileRoleMapping(cwd, 'default', 'security-audit', { model: 'ghost/model' }, globalPath);
    const config = loadModelRoutingConfig(cwd, globalPath);

    // No catalog knowledge => no findings (absence of evidence is not breakage).
    assert.deepEqual(unreachableRoutingTargets(config, []), []);

    const targets = unreachableRoutingTargets(config, ['provider/known']);
    assert.deepEqual(targets, [
      { kind: 'taskType', key: 'explore', model: 'cli/codex' },
      { kind: 'role', key: 'security-audit', model: 'ghost/model' },
    ]);

    // Everything reachable => no findings.
    assert.deepEqual(
      unreachableRoutingTargets(config, ['provider/known', 'cli/codex', 'ghost/model']),
      [],
    );

    // The routing table surfaces the warning only when a catalog is supplied.
    const warned = formatModelRoutingConfig(cwd, [], globalPath, ['provider/known']);
    assert.match(warned, new RegExp('⚠ cli/codex \\(taskType "explore"\\) is not in the current teammate catalog'));
    assert.match(warned, new RegExp('ghost/model \\(role "security-audit"\\)'));
    const quiet = formatModelRoutingConfig(cwd, [], globalPath);
    assert.doesNotMatch(quiet, /not in the current teammate catalog/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("typeMeta keywords round-trip, merge, clear, and normalize", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-type-meta-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    // Custom keywords for a built-in type.
    saveGlobalProfileTypeMeta(cwd, "default", "explore", { keywords: ["Codebase Scan", "definition lookup"] }, globalPath);
    let config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(resolveTaskTypeMeta(config, "explore")?.keywords, ["codebase scan", "definition lookup"]);

    // Clearing removes the override entirely.
    saveGlobalProfileTypeMeta(cwd, "default", "explore", { keywords: null }, globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(config.typeMeta?.explore, undefined);
    assert.equal(resolveTaskTypeMeta(config, "explore"), undefined);

    // Custom type creation carries its keywords; delete removes the meta too.
    saveGlobalProfileCustomType(cwd, "default", "security-audit", { keywords: ["audit", "security evidence"] }, globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(resolveTaskTypeMeta(config, "security-audit")?.keywords, ["audit", "security evidence"]);
    deleteGlobalProfileCustomType(cwd, "default", "security-audit", globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(resolveTaskTypeMeta(config, "security-audit"), undefined);
    assert.equal(config.typeMeta?.["security-audit"], undefined);

    // Project overrides merge typeMeta over the profile.
    saveProjectRoleMapping(cwd, "security-audit", null, globalPath); // no-op marker to enable overrides
    fs.writeFileSync(getProjectModelRoutingPath(cwd), JSON.stringify({
      version: 3,
      applyOverrides: true,
      overrides: {
        mappings: {},
        thinkingLevels: {},
        typeMeta: { explore: { keywords: ["project explore"] } },
      },
    }));
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(resolveTaskTypeMeta(config, "explore")?.keywords, ["project explore"]);

    // Duplicates collapse and empty arrays clear the override.
    saveGlobalProfileTypeMeta(cwd, "default", "security-audit", { keywords: ["audit", "Audit", ""] }, globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(resolveTaskTypeMeta(config, "security-audit")?.keywords, ["audit"]);
    saveGlobalProfileTypeMeta(cwd, "default", "security-audit", { keywords: [] }, globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(config.typeMeta?.["security-audit"], undefined);

    // Unknown fields and bad values fail strict validation.
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, JSON.stringify({
      version: 3,
      defaultProfile: "default",
      profiles: {
        default: {
          name: "Default",
          mappings: {},
          thinkingLevels: {},
          typeMeta: { explore: { keywords: [42] } },
        },
      },
    }));
    assert.throws(() => loadModelRoutingConfig(cwd, globalPath), /typeMeta/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task type keywords are configured but never auto-injected into the routing contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtasktype-kw-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const agents = [{ name: "security-specialist", taskType: "security-audit" }];
    saveGlobalProfileCustomType(cwd, "default", "security-audit", { keywords: ["audit", "security evidence"] }, globalPath);
    saveGlobalProfileTypeMeta(cwd, "default", "explore", { keywords: ["codebase scan"] }, globalPath);

    const injected = appendTaskTypeRoutingContext("Base prompt", cwd, agents, globalPath);
    assert.match(injected, /^  - security-audit$/m);
    assert.match(injected, /^  - explore: model=/m);
    assert.doesNotMatch(injected, /keywords/);
    assert.doesNotMatch(injected, /when to use/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task type keywords auto-infer the type from the task prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtasktype-kw-infer-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    saveGlobalProfileCustomType(cwd, "default", "security-audit", { keywords: ["audit", "security"] }, globalPath);
    const config = loadModelRoutingConfig(cwd, globalPath);

    // Keyword hit infers the custom type when no agent declares a taskType.
    const routed = applyModelRouting({
      tasks: [{ agent: "specialist-helper", prompt: "Run a security audit on the auth module" }],
    }, cwd, ["provider/audit"], globalPath);
    assert.equal(routed.tasks[0].taskType, "security-audit");
    assert.equal(routed.tasks[0].model, undefined); // no mapping configured yet

    // Configured keywords outrank the built-in heuristic regexes.
    const keywordFirst = applyModelRouting({
      tasks: [{ agent: "specialist-helper", prompt: "Review the pull request" }],
    }, cwd, [], globalPath);
    assert.equal(keywordFirst.tasks[0].taskType, "review");

    // Word-boundary matching: "auditor" does not trigger the "audit" keyword.
    const boundary = applyModelRouting({
      tasks: [{ agent: "specialist-helper", prompt: "Interview the auditor about policy" }],
    }, cwd, [], globalPath);
    assert.notEqual(boundary.tasks[0].taskType, "security-audit");

    // Explicit taskType still wins over keyword inference.
    const explicit = applyModelRouting({
      tasks: [{ agent: "specialist-helper", taskType: "analysis", prompt: "Run a security audit now" }],
    }, cwd, [], globalPath);
    assert.equal(explicit.tasks[0].taskType, "analysis");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assigned role taskType persists and outranks the agent frontmatter type", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-type-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "agents", "dual-role.md"), `---
name: dual-role
description: Declares review but is reassigned to analysis
taskType: review
---
Work.
`);
  try {
    saveGlobalProfileRoleMapping(cwd, "default", "dual-role", { taskType: "analysis" }, globalPath);
    const routed = applyModelRouting({
      tasks: [{ agent: "dual-role", prompt: "Trace the call chain" }],
    }, cwd, [], globalPath);
    assert.equal(routed.tasks[0].taskType, "analysis");

    saveGlobalProfileRoleMapping(cwd, "default", "dual-role", { taskType: null }, globalPath);
    const reverted = applyModelRouting({
      tasks: [{ agent: "dual-role", prompt: "Trace the call chain" }],
    }, cwd, [], globalPath);
    assert.equal(reverted.tasks[0].taskType, "review");

    saveGlobalProfileRoleMapping(cwd, "default", "dual-role", { taskType: "debug" }, globalPath);
    const explicit = applyModelRouting({
      tasks: [{ agent: "dual-role", taskType: "planning", prompt: "Trace the call chain" }],
    }, cwd, [], globalPath);
    assert.equal(explicit.tasks[0].taskType, "planning");

    assert.throws(
      () => saveGlobalProfileRoleMapping(cwd, "default", "dual-role", { taskType: "Bad Type" }, globalPath),
      /Invalid role task type/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assigned role type supplies model, fallbacks, thinking, and circuit before role fallbacks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-role-type-route-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    saveGlobalProfileModelMapping(cwd, "default", "analysis", "provider/type", globalPath);
    saveGlobalProfileFallbackMapping(cwd, "default", "analysis", ["provider/type-fallback"], globalPath);
    saveGlobalProfileThinkingLevel(cwd, "default", "analysis", "high", globalPath);
    saveGlobalProfileRoleMapping(cwd, "default", "specialist", {
      taskType: "analysis",
      model: "provider/role",
      fallbackModels: ["provider/role-fallback"],
      thinking: "low",
      circuit: { threshold: 2, cooldownMs: 30_000 },
    }, globalPath);

    const available = ["provider/type", "provider/type-fallback", "provider/role", "provider/role-fallback"];
    const routed = applyModelRouting({
      tasks: [{ agent: "specialist", prompt: "Investigate the failure" }],
    }, cwd, available, globalPath);
    assert.equal(routed.tasks[0].taskType, "analysis");
    assert.equal(routed.tasks[0].model, "provider/type");
    assert.deepEqual(routed.tasks[0].fallbackModels, ["provider/type-fallback"]);
    assert.equal(routed.tasks[0].thinking, "high");

    const breaker = new ModelCircuitBreaker();
    syncModelCircuitPolicies(breaker, cwd, globalPath);
    const first = breaker.acquireCandidate("provider/type");
    const second = breaker.acquireCandidate("provider/type");
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    if (first.allowed) breaker.recordRetryableFailure(first);
    if (second.allowed) breaker.recordRetryableFailure(second);
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/type")?.state, "OPEN");
    assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/role"), undefined);

    saveGlobalProfileModelMapping(cwd, "default", "analysis", null, globalPath);
    saveGlobalProfileFallbackMapping(cwd, "default", "analysis", null, globalPath);
    saveGlobalProfileThinkingLevel(cwd, "default", "analysis", null, globalPath);
    const roleFallback = applyModelRouting({
      tasks: [{ agent: "specialist", prompt: "Investigate the failure" }],
    }, cwd, available, globalPath);
    assert.equal(roleFallback.tasks[0].model, "provider/role");
    assert.deepEqual(roleFallback.tasks[0].fallbackModels, ["provider/role-fallback"]);
    assert.equal(roleFallback.tasks[0].thinking, "low");

    const explicit = applyModelRouting({
      tasks: [{
        agent: "specialist",
        taskType: "testing",
        model: "provider/explicit",
        fallbackModels: ["provider/explicit-fallback"],
        thinking: "xhigh",
        prompt: "Investigate the failure",
      }],
    }, cwd, available, globalPath);
    assert.equal(explicit.tasks[0].taskType, "testing");
    assert.equal(explicit.tasks[0].model, "provider/explicit");
    assert.deepEqual(explicit.tasks[0].fallbackModels, ["provider/explicit-fallback"]);
    assert.equal(explicit.tasks[0].thinking, "xhigh");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("type role assignments update atomically and custom type deletion clears references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-type-roles-"));
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    saveGlobalProfileCustomType(cwd, "default", "security-audit", null, globalPath);
    saveGlobalProfileRoleMapping(cwd, "default", "planner", { model: "provider/planner", taskType: "security-audit" }, globalPath);
    saveGlobalProfileTypeRoles(cwd, "default", "security-audit", ["reviewer", "analyst"], globalPath);

    let config = loadModelRoutingConfig(cwd, globalPath);
    assert.deepEqual(config.roleMappings?.planner, { model: "provider/planner", taskType: null });
    assert.deepEqual(config.roleMappings?.reviewer, { taskType: "security-audit" });
    assert.deepEqual(config.roleMappings?.analyst, { taskType: "security-audit" });
    assert.ok(discoverRoutingTaskTypes(cwd, [], config).includes("security-audit"));

    deleteGlobalProfileCustomType(cwd, "default", "security-audit", globalPath);
    config = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(config.roleMappings?.reviewer?.taskType, null);
    assert.equal(config.roleMappings?.analyst?.taskType, null);
    assert.ok(!discoverRoutingTaskTypes(cwd, [], config).includes("security-audit"));

    assert.throws(
      () => saveGlobalProfileTypeRoles(cwd, "default", "analysis", ["Bad Role"], globalPath),
      /Invalid teammate role mapping/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ask-before-dispatch flag defaults off and persists on the global config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-ask-flag-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    assert.equal(getGlobalAskBeforeDispatch(globalPath), false);
    assert.equal(loadModelRoutingState(cwd, globalPath).askBeforeDispatch, false);

    setGlobalAskBeforeDispatch(true, globalPath);
    assert.equal(getGlobalAskBeforeDispatch(globalPath), true);
    assert.equal(loadModelRoutingState(cwd, globalPath).askBeforeDispatch, true);

    // Unrelated writers round-trip the flag (no silent reset).
    saveGlobalProfileModelMapping(cwd, "default", "explore", "provider/explore", globalPath);
    assert.equal(getGlobalAskBeforeDispatch(globalPath), true);

    setGlobalAskBeforeDispatch(false, globalPath);
    assert.equal(getGlobalAskBeforeDispatch(globalPath), false);
    assert.equal(loadModelRoutingState(cwd, globalPath).askBeforeDispatch, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session overrides stack on top of project overrides and route single tasks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-session-routing-"));
  const globalPath = path.join(root, "home", "teammate-models.json");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    // Baseline: no project mapping, session override alone routes the task.
    const sessionId = "pi-session-abc-123";
    saveSessionModelRoutingOverrides(cwd, sessionId, {
      mappings: { analysis: "openai/gpt-5" },
      thinkingLevels: { analysis: "high" },
    }, globalPath);

    // The session file lives under .pi/ next to the project config and is
    // slugged by the sanitized session id.
    assert.equal(
      fs.existsSync(getSessionModelRoutingPath(cwd, sessionId)),
      true,
    );

    const sessionConfig = loadModelRoutingConfig(cwd, globalPath, sessionId);
    assert.equal(sessionConfig.mappings.analysis, "openai/gpt-5");
    assert.equal(sessionConfig.thinkingLevels.analysis, "high");

    const routed = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["openai/gpt-5"], globalPath, undefined, sessionId);
    assert.equal(routed.tasks[0].model, "openai/gpt-5");
    assert.equal(routed.tasks[0].thinking, "high");

    // Session overrides outrank project overrides on the same task type.
    saveProjectModelMapping(cwd, "analysis", "project/override-model", globalPath);
    assert.equal(
      loadModelRoutingConfig(cwd, globalPath, sessionId).mappings.analysis,
      "openai/gpt-5",
      "session override must outrank project override",
    );

    // Without a session id the routing falls back to the project override.
    assert.equal(
      loadModelRoutingConfig(cwd, globalPath).mappings.analysis,
      "project/override-model",
      "absent session id must use the project override",
    );

    // A different session id is isolated: it sees only the project override.
    assert.equal(
      loadModelRoutingConfig(cwd, globalPath, "pi-session-other-456").mappings.analysis,
      "project/override-model",
      "a different session id must not see the first session's overrides",
    );

    // A corrupted session file is ignored so dispatch never blocks on a bad write.
    const sessionFilePath = getSessionModelRoutingPath(cwd, sessionId);
    fs.writeFileSync(sessionFilePath, "{ not valid json ");
    assert.equal(
      loadModelRoutingConfig(cwd, globalPath, sessionId).mappings.analysis,
      "project/override-model",
      "corrupted session file must fall back to the project override",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session id is sanitized to a filesystem-safe slug in the override path", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-session-sanitize-"));
  try {
    const safe = getSessionModelRoutingPath(cwd, "pi-session.abc_123");
    // Dots are stripped so neither a separator nor a traversal can survive.
    assert.ok(safe.endsWith("teammate-models.session.pi-sessionabc_123.json"));
    assert.ok(!safe.includes(".."));

    // A hostile id with path separators and traversal dots is stripped to a safe slug.
    const hostile = getSessionModelRoutingPath(cwd, "../../etc/passwd");
    assert.ok(!hostile.includes(".."));
    assert.ok(hostile.endsWith("teammate-models.session.etcpasswd.json"));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
