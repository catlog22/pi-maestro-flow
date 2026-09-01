import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPermissionController } from "../src/permissions/controller.ts";
import { evaluatePermission, matchesPermissionRule, suggestedAllowRule } from "../src/permissions/policy.ts";
import {
  addPermissionRule,
  loadPermissionSettings,
  setPermissionDefaultMode,
} from "../src/permissions/settings.ts";

const empty = { allow: [], ask: [], deny: [] };

test("permission settings default to YOLO when no scope configures a mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-default-yolo-"));
  try {
    const loaded = await loadPermissionSettings(root, join(root, "missing-user.json"));
    assert.equal(loaded.permissions.defaultMode, "bypassPermissions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabling bypass mode overrides the YOLO default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-disable-yolo-"));
  const userSettingsPath = join(root, "user-settings.json");
  await writeFile(userSettingsPath, JSON.stringify({
    permissions: { disableBypassPermissionsMode: "disable" },
  }));
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  try {
    const controller = createPermissionController({ userSettingsPath });
    assert.equal(await controller.reload(ctx), "default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission rules use deny then ask then allow precedence", () => {
  const call = { toolName: "bash", input: { command: "git push origin main" } };
  const decision = evaluatePermission(call, "default", {
    allow: ["Bash(git *)"],
    ask: ["Bash(git push *)"],
    deny: ["Bash(* origin main)"],
  });
  assert.equal(decision.behavior, "deny");
  assert.equal(decision.rule, "Bash(* origin main)");
  assert.equal(matchesPermissionRule("Bash(git push *)", call), true);
  assert.equal(suggestedAllowRule(call), "Bash(git push origin main)");

  const compound = { toolName: "bash", input: { command: "git status && rm -rf build" } };
  assert.equal(evaluatePermission(compound, "default", {
    allow: ["Bash(git *)"],
    ask: [],
    deny: ["Bash(rm *)"],
  }).behavior, "deny");
  assert.equal(evaluatePermission(compound, "default", {
    allow: ["Bash(git *)"],
    ask: [],
    deny: [],
  }).behavior, "ask");
});

test("bypassPermissions is true YOLO and ignores explicit deny rules", () => {
  const decision = evaluatePermission(
    { toolName: "bash", input: { command: "rm -rf build" } },
    "bypassPermissions",
    { allow: [], ask: ["Bash(*)"], deny: ["Bash(rm *)"] },
  );
  assert.equal(decision.behavior, "allow");
  assert.match(decision.reason, /YOLO/);
});

test("permission modes each enforce their own behavior", () => {
  const edit = { toolName: "write", input: { path: "src/app.ts" } };
  const custom = { toolName: "deploy", input: { environment: "prod" } };
  const read = { toolName: "read", input: { path: "README.md" } };

  assert.equal(evaluatePermission(edit, "default", empty).behavior, "ask");
  assert.equal(evaluatePermission(edit, "acceptEdits", empty).behavior, "allow");
  assert.equal(evaluatePermission(custom, "dontAsk", empty).behavior, "deny");
  assert.equal(evaluatePermission(custom, "bypassPermissions", empty).behavior, "allow");
  // Plan mode also has a hard read-only tool-call boundary; the permission layer
  // independently stays at least as strict as default for unknown tools.
  assert.equal(evaluatePermission(custom, "plan", empty).behavior, "ask");
  assert.equal(evaluatePermission(read, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "ls", input: { path: "." } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "find", input: { pattern: "*.ts" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "ffgrep", input: { pattern: "Todo" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "fffind", input: { pattern: "todo" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "teammate", input: { agent: "explorer" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(
    suggestedAllowRule({ toolName: "deploy", input: { action: "release", environment: "prod" } }),
    "deploy(action:release)",
  );
});

test("plan mode pre-approves only the four built-in read-only planning roles", () => {
  for (const agent of ["analyst", "research", "explorer", "planner"]) {
    const decision = evaluatePermission({
      toolName: "teammate",
      input: { tasks: [{ prompt: "Inspect the bounded planning question", agent }] },
    }, "plan", empty);
    assert.equal(decision.behavior, "allow", agent);
    assert.match(decision.reason, /read-only teammate roles/);
  }

  const inheritedPlanner = evaluatePermission({
    toolName: "teammate",
    input: {
      agent: "planner",
      tasks: [{ prompt: "Inspect one boundary" }, { prompt: "Review the task DAG" }],
    },
  }, "plan", empty);
  assert.equal(inheritedPlanner.behavior, "allow");

  for (const input of [
    { tasks: [{ prompt: "Implement the plan", agent: "general" }] },
    {
      tasks: [
        { prompt: "Explore", agent: "explorer" },
        { prompt: "Implement", agent: "general" },
      ],
    },
    { tasks: [{ prompt: "Use the default role" }] },
  ]) {
    const decision = evaluatePermission({ toolName: "teammate", input }, "plan", empty);
    assert.equal(decision.behavior, "ask");
    assert.match(decision.reason, /analyst, research, explorer, and planner/);
  }
});

// Regression guard for the invariant that was actually violated: plan mode used to return
// `allow` for mutating tools while `default` returned `ask`, so toggling into plan mode
// silently switched the confirmation prompt off. Plan may be as strict as default or
// stricter, never looser. Keep this assertion behaviour-shaped so re-arming a real plan-mode
// block later (deny) still passes.
test("plan mode is never more permissive than default", () => {
  const looseness = { deny: 0, ask: 1, allow: 2 } as const;
  const mutatingCalls = [
    { toolName: "write", input: { path: "src/app.ts" } },
    { toolName: "edit", input: { path: "src/app.ts" } },
    { toolName: "bash", input: { command: "rm -rf build" } },
    { toolName: "deploy", input: { environment: "prod" } },
  ];

  for (const call of mutatingCalls) {
    const inDefault = evaluatePermission(call, "default", empty).behavior;
    const inPlan = evaluatePermission(call, "plan", empty).behavior;
    assert.ok(
      looseness[inPlan] <= looseness[inDefault],
      `plan mode returned "${inPlan}" for ${call.toolName} while default returned "${inDefault}"`,
    );
  }

  // Explicit settings rules are evaluated before any mode branch, so plan must not bypass them.
  const denied = evaluatePermission(
    { toolName: "write", input: { path: "src/app.ts" } },
    "plan",
    { allow: [], ask: [], deny: ["Write(src/app.ts)"] },
  );
  assert.equal(denied.behavior, "deny");
});

test("file permission rules match cwd-relative, absolute, parent and Windows-style paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-paths-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export {};\n");
  try {
    const absolute = resolve(root, "src", "app.ts");
    assert.equal(evaluatePermission(
      { toolName: "read", input: { path: absolute } },
      "dontAsk",
      { allow: [], ask: [], deny: ["Read(src/app.ts)"] },
      root,
    ).behavior, "deny");
    assert.equal(evaluatePermission(
      { toolName: "edit", input: { file_path: "src/../src/app.ts" } },
      "default",
      { allow: [`Edit(${absolute})`], ask: ["Edit(src/app.ts)"], deny: [] },
      root,
    ).behavior, "ask");
    assert.equal(evaluatePermission(
      { toolName: "write", input: { path: "./src/app.ts" } },
      "default",
      { allow: ["Write(src/app.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(matchesPermissionRule(
      "Write(src/app.ts)",
      { toolName: "write", input: { path: "D:\\WORKSPACE\\SRC\\APP.TS" } },
      "D:\\workspace",
    ), true);
    assert.equal(matchesPermissionRule(
      "Write(src/app.ts)",
      { toolName: "write", input: { path: "/workspace/SRC/APP.TS" } },
      "/workspace",
    ), false);
    assert.equal(matchesPermissionRule(
      "Write(src/app.ts)",
      { toolName: "write", input: { path: "src\\app.ts" } },
      "/workspace",
    ), false);
    assert.equal(
      suggestedAllowRule({ toolName: "write", input: { path: absolute } }, root),
      "Write(src/app.ts)",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace-relative wildcard rules do not authorize paths outside cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-permissions-outside-"));
  const aliasDirectory = join(root, "src", "external-link");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(outside, "generated.ts"), "export {};\n");
  try {
    await symlink(outside, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const settings = { allow: ["Write(src/*)"], ask: [], deny: [] };
    assert.notEqual(evaluatePermission(
      { toolName: "write", input: { path: relative(root, join(outside, "generated.ts")) } },
      "default",
      settings,
      root,
    ).behavior, "allow");
    assert.notEqual(evaluatePermission(
      { toolName: "write", input: { path: "src/external-link/generated.ts" } },
      "default",
      settings,
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "write", input: { path: "src/external-link/generated.ts" } },
      "default",
      { allow: ["Write(src/external-link/generated.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "write", input: { path: "src/external-link/generated.ts" } },
      "default",
      {
        allow: ["Write(src/external-link/generated.ts)"],
        ask: [],
        deny: ["Write(src/*)"],
      },
      root,
    ).behavior, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("file permission rules resolve existing symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-symlink-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  await mkdir(realDirectory, { recursive: true });
  await writeFile(join(realDirectory, "app.ts"), "export {};\n");
  try {
    await symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    assert.equal(evaluatePermission(
      { toolName: "edit", input: { path: "alias/app.ts" } },
      "default",
      { allow: ["Edit(real/app.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "edit", input: { path: "real/app.ts" } },
      "default",
      { allow: ["Edit(alias/*.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "write", input: { path: "alias/generated.ts" } },
      "default",
      { allow: ["Write(real/generated.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "write", input: { path: "alias/new/../generated.ts" } },
      "default",
      { allow: ["Write(real/generated.ts)"], ask: [], deny: [] },
      root,
    ).behavior, "allow");
    assert.equal(evaluatePermission(
      { toolName: "read", input: { path: "alias/app.ts" } },
      "default",
      { allow: ["Read(alias/app.ts)"], ask: [], deny: ["Read(real/app.ts)"] },
      root,
    ).behavior, "deny");
    assert.equal(matchesPermissionRule(
      "Read(real/app.ts)",
      { toolName: "read", input: { path: join(aliasDirectory, "app.ts") } },
      root,
    ), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission controller applies cwd path matching to non-existent Write targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-controller-path-"));
  const userPath = join(root, "user-settings.json");
  await writeFile(userPath, JSON.stringify({ permissions: { allow: ["Write(src/generated.ts)"] } }));
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({ userSettingsPath: userPath });
  try {
    await controller.reload(ctx);
    assert.equal(
      await controller.authorize(
        { toolName: "write", input: { path: resolve(root, "src", "generated.ts") } },
        ctx,
        "default",
      ),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell wildcard allows cannot hide substitution, backticks, or redirection", () => {
  const settings = { allow: ["Bash(echo *)"], ask: [], deny: ["Bash(rm *)"] };
  for (const command of [
    "echo $(rm -rf build)",
    "echo `rm -rf build`",
    "echo unsafe > build/output.txt",
  ]) {
    assert.notEqual(
      evaluatePermission({ toolName: "bash", input: { command } }, "default", settings).behavior,
      "allow",
      command,
    );
  }
  assert.equal(
    evaluatePermission({ toolName: "bash", input: { command: "echo safe" } }, "default", settings).behavior,
    "allow",
  );
});

test("PowerShell wildcard allows do not treat backslash as an escape", () => {
  const settings = { allow: ["PowerShell(Write-Output *)"], ask: [], deny: [] };
  for (const command of [
    "Write-Output \\$(Remove-Item build -Recurse)",
    "Write-Output safe \\> build/output.txt",
    "Write-Output safe \\; Remove-Item build -Recurse",
  ]) {
    assert.notEqual(
      evaluatePermission({ toolName: "powershell", input: { command } }, "default", settings).behavior,
      "allow",
      command,
    );
  }
  assert.equal(
    evaluatePermission(
      { toolName: "powershell", input: { command: "Write-Output C:\\temp" } },
      "default",
      settings,
    ).behavior,
    "allow",
  );
});

test("settings merge user, project and local rules with local scalar precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-settings-"));
  const userPath = join(root, "user-settings.json");
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(userPath, JSON.stringify({ permissions: { allow: ["Read"], defaultMode: "default" } }));
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    permissions: {
      allow: ["Bash(npm test)"],
      ask: ["Bash(git push *)"],
      defaultMode: "bypassPermissions",
    },
  }));
  await writeFile(join(root, ".pi", "settings.local.json"), JSON.stringify({
    permissions: { deny: ["Read(./.env)"], defaultMode: "acceptEdits" },
  }));
  try {
    const loaded = await loadPermissionSettings(root, userPath);
    assert.deepEqual(loaded.permissions.allow, ["Read"]);
    assert.deepEqual(loaded.permissions.ask, ["Bash(git push *)"]);
    assert.deepEqual(loaded.permissions.deny, ["Read(./.env)"]);
    assert.equal(loaded.permissions.defaultMode, "acceptEdits");
    assert.equal(loaded.sources.length, 3);
    assert.equal(loaded.warnings.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent permission mutations preserve every update and clean up private temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-concurrent-settings-"));
  const settingsDirectory = join(root, ".pi");
  const settingsPath = join(settingsDirectory, "settings.local.json");
  const settingsAliasDirectory = join(settingsDirectory, "alias");
  const settingsAliasPath = `${settingsAliasDirectory}${sep}..${sep}settings.local.json`;
  await mkdir(settingsDirectory, { recursive: true });
  await mkdir(settingsAliasDirectory);
  await writeFile(settingsPath, JSON.stringify({ marker: "preserve", permissions: { allow: ["Read"] } }));
  try {
    const allowRules = Array.from({ length: 24 }, (_, index) => `Bash(command-${index})`);
    const denyRules = Array.from({ length: 12 }, (_, index) => `Write(secret-${index})`);
    await Promise.all([
      ...allowRules.map((rule, index) => addPermissionRule(
        index % 2 === 0 ? settingsPath : settingsAliasPath,
        "allow",
        rule,
      )),
      ...denyRules.map((rule) => addPermissionRule(settingsPath, "deny", rule)),
      setPermissionDefaultMode(settingsPath, "dontAsk"),
    ]);

    const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(persisted.marker, "preserve");
    assert.deepEqual(persisted.permissions.allow, ["Read", ...allowRules]);
    assert.deepEqual(persisted.permissions.deny, denyRules);
    assert.equal(persisted.permissions.defaultMode, "dontAsk");
    assert.deepEqual((await readdir(settingsDirectory)).filter((entry) => entry.endsWith(".tmp")), []);
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan-model and permissions preserve both sections across concurrent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shared-settings-process-lock-"));
  const settingsDirectory = join(root, ".pi");
  const settingsPath = join(settingsDirectory, "settings.local.json");
  const workerPath = join(root, "settings-worker.mjs");
  const planModulePath = fileURLToPath(new URL("../src/tools/plan-model.ts", import.meta.url));
  const permissionModulePath = fileURLToPath(new URL("../src/permissions/settings.ts", import.meta.url));
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ marker: "preserve" }));
  await writeFile(workerPath, [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const [role, cwd, planModulePath, permissionModulePath, barrierDirectory] = process.argv.slice(2);',
    'const modulePath = role === "plan" ? planModulePath : permissionModulePath;',
    'const settings = await import(pathToFileURL(modulePath).href);',
    'writeFileSync(join(barrierDirectory, `ready-${role}`), "");',
    'while (!existsSync(join(barrierDirectory, "go"))) await new Promise((resolve) => setTimeout(resolve, 5));',
    'if (role === "plan") {',
    '  for (let index = 0; index < 40; index += 1) await settings.saveLocalPlanModelSetting(cwd, `provider/plan-${index}`);',
    '} else {',
    '  const filePath = join(cwd, ".pi", "settings.local.json");',
    '  for (let index = 0; index < 40; index += 1) await settings.addPermissionRule(filePath, "allow", `Bash(command-${index})`);',
    '}',
  ].join("\n"));

  const startWorker = (role: "plan" | "permissions") => {
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      workerPath,
      role,
      root,
      planModulePath,
      permissionModulePath,
      root,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    return new Promise<void>((resolveChild, rejectChild) => {
      child.on("error", rejectChild);
      child.on("close", (code) => code === 0
        ? resolveChild()
        : rejectChild(new Error(`${role} worker exited ${code}: ${output}`)));
    });
  };

  try {
    const planWorker = startWorker("plan");
    const permissionsWorker = startWorker("permissions");
    const deadline = Date.now() + 10_000;
    while ((!existsSync(join(root, "ready-plan")) || !existsSync(join(root, "ready-permissions"))) && Date.now() < deadline) {
      await new Promise((resolveReady) => setTimeout(resolveReady, 10));
    }
    const planReady = existsSync(join(root, "ready-plan"));
    const permissionsReady = existsSync(join(root, "ready-permissions"));
    await writeFile(join(root, "go"), "");
    assert.ok(planReady, "plan worker did not reach the mutation barrier");
    assert.ok(permissionsReady, "permissions worker did not reach the mutation barrier");
    await Promise.all([planWorker, permissionsWorker]);

    const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(persisted.marker, "preserve");
    assert.equal(persisted.plan.model, "provider/plan-39");
    assert.deepEqual(
      persisted.permissions.allow,
      Array.from({ length: 40 }, (_, index) => `Bash(command-${index})`),
    );
    const residue = (await readdir(settingsDirectory)).filter((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock"));
    assert.deepEqual(residue, []);
    if (process.platform !== "win32") assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive permission can be persisted as an exact local allow rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-controller-"));
  const notifications: string[] = [];
  let prompts = 0;
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      notify(message: string) { notifications.push(message); },
      async select() {
        prompts++;
        return "Always allow";
      },
    },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({ userSettingsPath: join(root, "user-settings.json") });
  try {
    await controller.reload(ctx);
    const call = { toolName: "bash", input: { command: "npm test" } };
    assert.equal(await controller.authorize(call, ctx, "default"), undefined);
    assert.equal(prompts, 1);
    assert.equal(await controller.authorize(call, ctx, "default"), undefined);
    assert.equal(prompts, 1);
    const persisted = JSON.parse(await readFile(join(root, ".pi", "settings.local.json"), "utf8"));
    assert.deepEqual(persisted.permissions.allow, ["Bash(npm test)"]);
    assert.match(notifications.join("\n"), /Bash\(npm test\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission mode changes persist as the next session default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-default-mode-"));
  const applied: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({
    userSettingsPath: join(root, "user-settings.json"),
    setMode(mode) { applied.push(mode); },
  });
  try {
    await controller.reload(ctx);
    await controller.setDefaultMode(ctx, "bypassPermissions");

    const persisted = JSON.parse(await readFile(join(root, ".pi", "settings.local.json"), "utf8"));
    assert.equal(persisted.permissions.defaultMode, "bypassPermissions");
    assert.deepEqual(applied, ["bypassPermissions"]);
    assert.equal(await controller.reload(ctx), "bypassPermissions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive and invalid-config permission checks fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-closed-"));
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ permissions: { allow: "Bash" } }));
  const ctx = {
    cwd: root,
    hasUI: false,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({ userSettingsPath: join(root, "missing-user.json") });
  try {
    await controller.reload(ctx);
    assert.match(
      (await controller.authorize({ toolName: "bash", input: { command: "git status" } }, ctx, "default"))?.reason ?? "",
      /invalid/i,
    );
    assert.equal(
      await controller.authorize({ toolName: "read", input: { path: "README.md" } }, ctx, "default"),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PermissionRequest updated input is re-evaluated against deny rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-updated-input-"));
  const userPath = join(root, "user-settings.json");
  await writeFile(userPath, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify() {}, async select() { return "Allow once"; } },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({ userSettingsPath: userPath });
  try {
    await controller.reload(ctx);
    const call = { toolName: "bash", input: { command: "npm test" } };
    const result = await controller.authorize(call, ctx, "default", {
      async requestPermission() {
        return { behavior: "allow", updatedInput: { command: "rm -rf build" } };
      },
    });
    assert.match(result?.reason ?? "", /Matched deny rule/);
    assert.deepEqual(call.input, { command: "rm -rf build" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Permission overview exposes mode, rules and sources structurally", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-overview-"));
  const userPath = join(root, "user-settings.json");
  await writeFile(userPath, JSON.stringify({
    permissions: { defaultMode: "default", allow: ["Read(x)"], ask: ["Bash(git *)"], deny: ["Bash(rm *)"] },
  }));
  const ctx = { cwd: root, ui: { notify() {} } } as unknown as ExtensionContext;
  const controller = createPermissionController({ userSettingsPath: userPath });
  try {
    await controller.reload(ctx);
    const overview = controller.overview("default");
    assert.equal(overview.mode, "default");
    assert.deepEqual([...overview.allow], ["Read(x)"]);
    assert.deepEqual([...overview.ask], ["Bash(git *)"]);
    assert.deepEqual([...overview.deny], ["Bash(rm *)"]);
    assert.ok(overview.sources.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission prompts request user attention before blocking without exposing input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permissions-attention-"));
  const userPath = join(root, "user-settings.json");
  await writeFile(userPath, JSON.stringify({ permissions: { ask: ["Bash(*)"] } }));
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const ctx = {
    cwd: root,
    hasUI: true,
    signal,
    ui: {
      notify() {},
      async select(_title: string, _options: string[], opts?: { signal?: AbortSignal }) {
        calls.push("select");
        assert.equal(opts?.signal, signal);
        return "Allow once";
      },
    },
  } as unknown as ExtensionContext;
  const controller = createPermissionController({
    userSettingsPath: userPath,
    onUserAttention(request) {
      calls.push(`attention:${request.kind}:${request.subject ?? ""}`);
      assert.doesNotMatch(JSON.stringify(request), /secret-value/);
    },
  });
  try {
    await controller.reload(ctx);
    const result = await controller.authorize(
      { toolName: "bash", input: { command: "echo secret-value" } },
      ctx,
      "default",
    );
    assert.equal(result, undefined);
    assert.deepEqual(calls, ["attention:permission:bash", "select"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
