import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FOLLOW_SESSION_LABEL,
  buildReviewPrompt,
  listAvailableReviewModels,
  pickReviewModel,
  type ReviewHistoryEntry,
} from "../src/tools/plan-review.ts";

interface ReviewHarnessOptions {
  hasUI?: boolean;
  /** Programmatic `ctx.ui.custom` resolver: receives the factory, drives it, returns the decision. */
  driveCustom?: (factory: CustomFactory) => string | undefined;
}

type CustomFactory = (
  tui: unknown,
  theme: { fg(name: string, text: string): string; bold(text: string): string },
  keybindings: unknown,
  done: (result: string | undefined) => void,
) => {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
};

function createReviewHarness(options: ReviewHarnessOptions = {}) {
  const models = [
    { provider: "provider", id: "session" },
    { provider: "provider", id: "reviewer" },
    { provider: "provider", id: "other" },
  ];
  const notifications: string[] = [];
  let customFactory: CustomFactory | undefined;
  const ctx = {
    hasUI: options.hasUI ?? true,
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    ui: {
      notify(message: string) { notifications.push(message); },
      async custom<T>(factory: CustomFactory): Promise<T | undefined> {
        customFactory = factory;
        return (options.driveCustom?.(factory) ?? undefined) as T | undefined;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, get lastFactory() { return customFactory; } };
}

test("listAvailableReviewModels returns sorted provider/model references", async () => {
  const harness = createReviewHarness();
  const models = await listAvailableReviewModels(harness.ctx);
  assert.deepEqual(models, ["provider/other", "provider/reviewer", "provider/session"]);
  assert.equal(FOLLOW_SESSION_LABEL, "Follow session model");
});

test("pickReviewModel resolves a chosen provider/model", async () => {
  const harness = createReviewHarness({
    driveCustom: (factory) => {
      const component = factory(undefined as never, minimalTheme(), undefined as never, () => {});
      // Simulate the user selecting the second visible option.
      component.handleInput("\x1b[B"); // down
      component.render(80);
      return "provider/reviewer";
    },
  });
  const choice = await pickReviewModel(harness.ctx, ["provider/other", "provider/reviewer", "provider/session"]);
  assert.deepEqual(choice, { model: "provider/reviewer", label: "provider/reviewer" });
  assert.deepEqual(harness.notifications, []);
});

test("pickReviewModel resolves FOLLOW_SESSION_LABEL to the session model", async () => {
  const harness = createReviewHarness({
    driveCustom: (factory) => {
      const component = factory(undefined as never, minimalTheme(), undefined as never, () => {});
      component.render(80);
      return FOLLOW_SESSION_LABEL;
    },
  });
  const choice = await pickReviewModel(harness.ctx, ["provider/reviewer"]);
  assert.deepEqual(choice, { model: "provider/session", label: FOLLOW_SESSION_LABEL });
});

test("pickReviewModel returns undefined when the picker is cancelled", async () => {
  const harness = createReviewHarness({
    driveCustom: () => undefined,
  });
  const choice = await pickReviewModel(harness.ctx, ["provider/reviewer"]);
  assert.equal(choice, undefined);
});

test("pickReviewModel falls back to the session model without a UI and warns when missing", async () => {
  const harness = createReviewHarness({ hasUI: false });
  const choice = await pickReviewModel(harness.ctx, []);
  assert.deepEqual(choice, { model: "provider/session", label: FOLLOW_SESSION_LABEL });

  const noModel = createReviewHarness({ hasUI: false });
  (noModel.ctx as unknown as { model: undefined }).model = undefined;
  const missing = await pickReviewModel(noModel.ctx, []);
  assert.equal(missing, undefined);
  assert.match(noModel.notifications.join("\n"), /no session model/);
});

test("pickReviewModel warns when FOLLOW_SESSION_LABEL is chosen but no session model exists", async () => {
  const harness = createReviewHarness({
    driveCustom: () => FOLLOW_SESSION_LABEL,
  });
  (harness.ctx as unknown as { model: undefined }).model = undefined;
  const choice = await pickReviewModel(harness.ctx, ["provider/reviewer"]);
  assert.equal(choice, undefined);
  assert.match(harness.notifications.join("\n"), /no session model/);
});

test("buildReviewPrompt omits the history section when there is no prior review", () => {
  const prompt = buildReviewPrompt("# Plan\nbody", []);
  assert.match(prompt, /<plan>/);
  assert.doesNotMatch(prompt, /前次 review 报告/);
});

test("buildReviewPrompt injects prior review reports with model labels", () => {
  const history: ReviewHistoryEntry[] = [
    { report: "## 总体结论\n建议修订。", modelLabel: "provider/reviewer" },
    { report: "## 总体结论\n建议重写。", modelLabel: "Follow session model" },
  ];
  const prompt = buildReviewPrompt("# Plan\nbody", history);
  assert.match(prompt, /前次 review 报告（共 2 份/);
  assert.match(prompt, /前次报告 1（model: provider\/reviewer）/);
  assert.match(prompt, /前次报告 2（model: Follow session model）/);
  assert.match(prompt, /建议修订/);
  assert.match(prompt, /建议重写/);
  assert.match(prompt, /<plan>/);
});

test("buildReviewPrompt truncates long history reports to the budget", () => {
  const longReport = "x".repeat(5000);
  const history: ReviewHistoryEntry[] = [
    { report: longReport, modelLabel: "provider/reviewer" },
  ];
  const prompt = buildReviewPrompt("# Plan", history);
  // Budget is 2000 chars + ellipsis, so the full 5000-char report must not survive.
  assert.ok(!prompt.includes(longReport));
  assert.match(prompt, /…/);
});

function minimalTheme(): { fg(name: string, text: string): string; bold(text: string): string } {
  return {
    fg: (_name, text) => text,
    bold: (text) => text,
  };
}
