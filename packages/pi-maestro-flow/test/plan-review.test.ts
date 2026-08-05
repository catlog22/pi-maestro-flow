import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FOLLOW_SESSION_LABEL,
  listAvailableReviewModels,
  loadPlanReviewModelSetting,
  registerPlanReviewModelCommand,
  resolvePlanReviewModel,
  saveLocalPlanReviewModelSetting,
} from "../src/tools/plan-review.ts";

interface ReviewHarnessOptions {
  cwd?: string;
  hasUI?: boolean;
  select?: (title: string, labels: string[]) => Promise<string | undefined> | string | undefined;
}

function createReviewHarness(options: ReviewHarnessOptions = {}) {
  const models = [
    { provider: "provider", id: "session" },
    { provider: "provider", id: "reviewer" },
    { provider: "provider", id: "other" },
  ];
  const notifications: string[] = [];
  const ctx = {
    cwd: options.cwd ?? "/workspace",
    hasUI: options.hasUI ?? true,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    isProjectTrusted: () => true,
    ui: {
      notify(message: string) { notifications.push(message); },
      async select(title: string, labels: string[]) {
        return options.select?.(title, labels);
      },
    },
  } as unknown as ExtensionContext;
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const pi = {
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return {
    ctx,
    notifications,
    pi,
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      assert.ok(command, `missing ${name} command`);
      await command.handler(args, ctx);
    },
  };
}

test("Plan review model settings merge user, project, and local overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-review-settings-"));
  const userDir = join(root, "user");
  const cwd = join(root, "workspace");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = userDir;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "settings.json"), JSON.stringify({ plan: { review: { model: "provider/user" } } }));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ plan: { review: { model: "provider/project" } } }));
    assert.equal(loadPlanReviewModelSetting(cwd), "provider/project");
    assert.equal(loadPlanReviewModelSetting(cwd, false), "provider/user");

    await writeFile(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ plan: { review: { model: "provider/local" } } }));
    assert.equal(loadPlanReviewModelSetting(cwd), "provider/local");

    await writeFile(join(cwd, ".pi", "settings.local.json"), JSON.stringify({ plan: { review: { model: null } } }));
    assert.equal(loadPlanReviewModelSetting(cwd), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan review model save preserves the Plan-mode model setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-review-save-"));
  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "settings.local.json"), JSON.stringify({ plan: { model: "provider/plan" } }));
    await saveLocalPlanReviewModelSetting(root, "provider/reviewer");
    const saved = JSON.parse(await readFile(join(root, ".pi", "settings.local.json"), "utf8")) as {
      plan?: { model?: unknown; review?: { model?: unknown } };
    };
    assert.equal(saved.plan?.model, "provider/plan");
    assert.equal(saved.plan?.review?.model, "provider/reviewer");
    assert.equal(loadPlanReviewModelSetting(root), "provider/reviewer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolvePlanReviewModel uses a valid configured model without a picker", async () => {
  const harness = createReviewHarness();
  const resolution = await resolvePlanReviewModel(harness.ctx, { loadModel: () => "provider/reviewer" });
  assert.deepEqual(resolution, { model: "provider/reviewer", label: "provider/reviewer" });
  assert.deepEqual(harness.notifications, []);
});

test("resolvePlanReviewModel warns on an invalid configured model and uses the session model", async () => {
  const harness = createReviewHarness();
  const resolution = await resolvePlanReviewModel(harness.ctx, { loadModel: () => "provider/missing" });
  assert.deepEqual(resolution, { model: "provider/session", label: "provider/session" });
  assert.match(harness.notifications.join("\n"), /provider\/missing/);
});

test("resolvePlanReviewModel falls back to the session model without configuration", async () => {
  const harness = createReviewHarness();
  const resolution = await resolvePlanReviewModel(harness.ctx);
  assert.deepEqual(resolution, { model: "provider/session", label: "provider/session" });
  assert.deepEqual(harness.notifications, []);
});

test("listAvailableReviewModels returns sorted provider/model references", async () => {
  const harness = createReviewHarness();
  const models = await listAvailableReviewModels(harness.ctx);
  assert.deepEqual(models, ["provider/other", "provider/reviewer", "provider/session"]);
  assert.equal(FOLLOW_SESSION_LABEL, "Follow session model");
});

test("/plan-review-model persists a selected model and clears it with off", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-review-command-"));
  try {
    const harness = createReviewHarness({ cwd: root });
    registerPlanReviewModelCommand(harness.pi);
    await harness.runCommand("plan-review-model", "provider/reviewer");
    assert.equal(loadPlanReviewModelSetting(root), "provider/reviewer");
    await harness.runCommand("plan-review-model", "off");
    assert.equal(loadPlanReviewModelSetting(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan-review-model rejects unavailable models and untrusted workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-review-command-validate-"));
  try {
    const harness = createReviewHarness({ cwd: root });
    registerPlanReviewModelCommand(harness.pi);
    await harness.runCommand("plan-review-model", "provider/missing");
    assert.match(harness.notifications.join("\n"), /not available/);
    assert.equal(loadPlanReviewModelSetting(root), undefined);

    (harness.ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted = () => false;
    await harness.runCommand("plan-review-model", "provider/reviewer");
    assert.match(harness.notifications.join("\n"), /Trust this workspace/);
    assert.equal(loadPlanReviewModelSetting(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/plan-review-model shows usage without a UI and no arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-review-command-usage-"));
  try {
    const harness = createReviewHarness({ cwd: root, hasUI: false });
    registerPlanReviewModelCommand(harness.pi);
    await harness.runCommand("plan-review-model", "");
    assert.match(harness.notifications.join("\n"), /Usage: \/plan-review-model/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
