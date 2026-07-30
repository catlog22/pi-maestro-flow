import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadPlanModelSetting,
  registerPlanModelSelection,
  shouldStartPlanExecutionInNewSession,
} from "../src/tools/plan-model.ts";

type Hook = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type Command = { handler(args: string, ctx: ExtensionContext): Promise<void> | void };

function createHarness(
  loadModel: () => string | undefined,
  selectModel: (model: { provider: string; id: string }) => boolean = () => true,
  cwd = "/workspace",
) {
  let planMode = false;
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, Command>();
  const selected: string[] = [];
  const notifications: string[] = [];
  const models = [
    { provider: "provider", id: "act" },
    { provider: "provider", id: "plan" },
    { provider: "provider", id: "other" },
  ];
  const ctx = {
    cwd,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    isProjectTrusted: () => true,
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on(name: string, hook: Hook) { hooks.set(name, hook); },
    async setModel(model: { provider: string; id: string }) {
      selected.push(`${model.provider}/${model.id}`);
      if (!selectModel(model)) return false;
      (ctx as unknown as { model: typeof model }).model = model;
      return true;
    },
  } as unknown as ExtensionAPI;

  registerPlanModelSelection(pi, {
    isPlanMode: () => planMode,
    loadModel: () => loadModel(),
  });
  return {
    ctx,
    selected,
    notifications,
    setPlanMode(value: boolean) { planMode = value; },
    setTrusted(value: boolean) {
      (ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted = () => value;
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      assert.ok(command, `missing ${name} command`);
      await command.handler(args, ctx);
    },
    async fire(name: string) {
      const hook = hooks.get(name);
      assert.ok(hook, `missing ${name} hook`);
      await hook({}, ctx);
    },
  };
}

test("Plan model settings merge user, project, and local scalar overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-model-settings-"));
  const userDir = join(root, "user");
  const cwd = join(root, "workspace");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = userDir;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "settings.json"), JSON.stringify({ plan: { model: "provider/user" } }));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ plan: { model: "provider/project" } }));
    assert.equal(loadPlanModelSetting(cwd), "provider/project");
    assert.equal(loadPlanModelSetting(cwd, false), "provider/user");

    await writeFile(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ plan: { model: "provider/local" } }));
    assert.equal(loadPlanModelSetting(cwd), "provider/local");

    await writeFile(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ plan: { model: null } }));
    assert.equal(loadPlanModelSetting(cwd), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan-model persists a selected model and off override locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-model-command-"));
  const harness = createHarness(() => undefined, () => true, root);
  try {
    await harness.runCommand("plan-model", "provider/plan");
    assert.equal(loadPlanModelSetting(root), "provider/plan");
    await harness.runCommand("plan-model", "off");
    assert.equal(loadPlanModelSetting(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan-model rejects project-local writes in untrusted workspaces", async () => {
  const harness = createHarness(() => undefined);
  harness.setTrusted(false);
  await harness.runCommand("plan-model", "provider/plan");
  assert.match(harness.notifications.join("\n"), /Trust this workspace/);
});

test("Plan turns select the configured model once and Act restores the prior model", async () => {
  const harness = createHarness(() => "provider/plan");
  await harness.fire("session_start");
  harness.setPlanMode(true);
  await harness.fire("before_agent_start");
  assert.equal(shouldStartPlanExecutionInNewSession(), true);
  await harness.fire("before_agent_start");
  assert.deepEqual(harness.selected, ["provider/plan"]);

  harness.setPlanMode(false);
  await harness.fire("before_agent_start");
  assert.equal(shouldStartPlanExecutionInNewSession(), false);
  assert.deepEqual(harness.selected, ["provider/plan", "provider/act"]);
});

test("invalid Plan model restores the Act model and warns without repeated notifications", async () => {
  let configured = "provider/plan";
  const harness = createHarness(() => configured);
  harness.setPlanMode(true);
  await harness.fire("before_agent_start");
  configured = "provider/missing";
  await harness.fire("before_agent_start");
  await harness.fire("before_agent_start");

  assert.deepEqual(harness.selected, ["provider/plan", "provider/act"]);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0], /unavailable/);
});

test("combined restore and resolution failures warn once per cause", async () => {
  let configured = "provider/plan";
  const harness = createHarness(
    () => configured,
    (model) => model.id !== "act",
  );
  harness.setPlanMode(true);
  await harness.fire("before_agent_start");
  configured = "provider/missing";
  await harness.fire("before_agent_start");
  await harness.fire("before_agent_start");

  assert.equal(harness.notifications.length, 2);
  assert.match(harness.notifications.join("\n"), /restore the Act model/);
  assert.match(harness.notifications.join("\n"), /unavailable/);
});

test("session shutdown retries a failed Act-model restore on the next session start", async () => {
  let allowRestore = false;
  const harness = createHarness(
    () => "provider/plan",
    (model) => model.id !== "act" || allowRestore,
  );
  harness.setPlanMode(true);
  await harness.fire("before_agent_start");
  await harness.fire("session_shutdown");
  assert.deepEqual(harness.selected, ["provider/plan", "provider/act"]);

  allowRestore = true;
  await harness.fire("session_start");
  assert.deepEqual(harness.selected, ["provider/plan", "provider/act", "provider/act"]);
});
