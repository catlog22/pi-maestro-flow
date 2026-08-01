import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  applyModelRouting,
  clearProjectModelRoutingOverrides,
  createAndActivateGlobalModelRoutingProfile,
  createGlobalModelRoutingProfile,
  deleteGlobalModelRoutingProfile,
  discoverRoutingTaskTypes,
  getProjectModelRoutingPath,
  inferTaskType,
  loadModelRoutingConfig,
  loadModelRoutingState,
  promoteProjectModelRoutingOverrides,
  renameGlobalModelRoutingProfile,
  saveGlobalProfileFallbackMapping,
  saveGlobalProfileModelMapping,
  saveGlobalProfileThinkingLevel,
  saveProjectFallbackMapping,
  saveProjectModelMapping,
  saveProjectThinkingLevel,
  setDefaultGlobalModelRoutingProfile,
  setProjectActiveModelRoutingProfile,
  setProjectModelRoutingOverridesEnabled,
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

test("fallback mappings persist, filter unavailable models, and follow explicit precedence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-fallback-routing-"));
  try {
    saveProjectFallbackMapping(cwd, "analysis", ["provider/backup-a", "provider/backup-a", "provider/backup-b"]);
    assert.deepEqual(loadModelRoutingConfig(cwd).fallbackMappings?.analysis, [
      "provider/backup-a",
      "provider/backup-b",
    ]);

    const mapped = applyModelRouting({
      agent: "general",
      taskType: "analysis",
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["provider/primary", "provider/backup-b"]);
    assert.deepEqual(mapped.tasks[0].fallbackModels, ["provider/backup-b"]);

    const topLevel = applyModelRouting({
      taskType: "analysis",
      fallbackModels: ["provider/top"],
      tasks: [{ prompt: "Trace the request" }],
    }, cwd, ["provider/top", "provider/task"]);
    assert.deepEqual(topLevel.tasks[0].fallbackModels, ["provider/top"]);

    const perTask = applyModelRouting({
      taskType: "analysis",
      fallbackModels: ["provider/top"],
      tasks: [{ prompt: "Trace the request", fallbackModels: ["provider/task"] }],
    }, cwd, ["provider/top", "provider/task"]);
    assert.deepEqual(perTask.tasks[0].fallbackModels, ["provider/task"]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
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
    assert.equal(migrated.version, 3);
    assert.equal(migrated.mappings.analysis, "openai/gpt-5");
    assert.equal(migrated.mappings.review, "anthropic/sonnet");
    assert.equal(migrated.mappings.testing, null);

    saveProjectThinkingLevel(cwd, "analysis", "high");
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

test("nested teammate routing is deferred to the authoritative root proxy", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf8");
  assert.match(source, /execute\(_id: string, params: RunTeammateParams[\s\S]*?proxyCall<Details>\("teammate", params, signal\)/);
  assert.match(source, /const routedParams = applyModelRouting\([\s\S]*?modelCapabilities\.map[\s\S]*?normalizeTeammateParams\(routedParams\)/);
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
    assert.equal(legacy.config.thinkingLevels.review, "xhigh");
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
