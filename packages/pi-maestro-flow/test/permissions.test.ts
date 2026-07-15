import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPermissionController } from "../src/permissions/controller.ts";
import { evaluatePermission, matchesPermissionRule, suggestedAllowRule } from "../src/permissions/policy.ts";
import { loadPermissionSettings } from "../src/permissions/settings.ts";

const empty = { allow: [], ask: [], deny: [] };

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

test("permission modes enforce real default behavior", () => {
  const edit = { toolName: "write", input: { path: "src/app.ts" } };
  const custom = { toolName: "deploy", input: { environment: "prod" } };
  const read = { toolName: "read", input: { path: "README.md" } };

  assert.equal(evaluatePermission(edit, "default", empty).behavior, "ask");
  assert.equal(evaluatePermission(edit, "acceptEdits", empty).behavior, "allow");
  assert.equal(evaluatePermission(custom, "dontAsk", empty).behavior, "deny");
  assert.equal(evaluatePermission(custom, "bypassPermissions", empty).behavior, "allow");
  assert.equal(evaluatePermission(custom, "plan", empty).behavior, "allow");
  assert.equal(evaluatePermission(read, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "ls", input: { path: "." } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "find", input: { pattern: "*.ts" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(evaluatePermission({ toolName: "teammate", input: { agent: "explorer" } }, "dontAsk", empty).behavior, "allow");
  assert.equal(
    suggestedAllowRule({ toolName: "deploy", input: { action: "release", environment: "prod" } }),
    "deploy(action:release)",
  );
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
