import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeAdvisorConfig, type AdvisorConfig } from "../src/advisor/runtime.ts";
import { AdvisorTodoSettingsOverlay, showAdvisorTodoSettings, type AdvisorTodoSettingsResult } from "../src/tui/advisor-todo-settings.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(options: { config?: AdvisorConfig; save?: (config: AdvisorConfig) => Promise<void | boolean>; isCurrent?: () => boolean; signal?: AbortSignal; locale?: "en" | "zh-CN" } = {}) {
  const configured = options.config ?? normalizeAdvisorConfig({ guide: "preserve existing priorities", model: "missing/pinned" });
  const saves: AdvisorConfig[] = [];
  let result: AdvisorTodoSettingsResult | undefined;
  const overlay = new AdvisorTodoSettingsOverlay({
    configured, effective: { ...configured, enabled: true }, models: ["provider/reviewer"], theme,
    locale: options.locale ?? "en", signal: options.signal, isCurrent: options.isCurrent,
    requestRender() {}, done(value) { result = value; },
    async save(config) { if (options.save && await options.save(config) === false) return false; saves.push(config); return true; },
  });
  const select = (index: number) => { for (let i = 0; i < index; i++) overlay.handleInput("\x1b[B"); };
  const save = async () => { overlay.handleInput("\x13"); overlay.handleInput("\r"); await flush(); };
  return { overlay, saves, configured, select, save, result: () => result };
}

test("TODO settings render localized controls and configured/effective state within every width", () => {
  const { overlay } = harness({ locale: "zh-CN" });
  for (const width of [1, 3, 12, 40, 80, 120]) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const output = overlay.render(120).join("\n");
  assert.match(output, /TODO 进展监护/);
  assert.match(output, /已配置: false · 实际生效: true/);
  assert.match(output, /不会隐式开启/);
  assert.match(output, /不会中断工具/);
});

test("TODO settings save requires confirmation and preserves unrelated Advisor fields", async () => {
  const h = harness();
  h.select(3); h.overlay.handleInput("\r");
  assert.equal(h.configured.todoReview.enabled, false, "draft never mutates caller configuration");
  h.overlay.handleInput("\x13");
  assert.equal(h.saves.length, 0);
  assert.match(h.overlay.render(120).join("\n"), /Save these changes/);
  h.overlay.handleInput("\r"); await flush();
  assert.equal(h.result(), "saved");
  assert.equal(h.saves[0]?.todoReview.enabled, true);
  assert.equal(h.saves[0]?.enabled, false, "does not implicitly enable Advisor");
  assert.equal(h.saves[0]?.model, "missing/pinned");
  assert.equal(h.saves[0]?.guide, "preserve existing priorities");
  assert.equal(h.saves[0]?.reviewEveryToolResults, 3);
});

test("TODO settings edit and validate numeric bounds, including zero cooldown", async () => {
  const h = harness(); h.select(5); h.overlay.handleInput("\r"); h.overlay.handleInput("\x15");
  h.overlay.handleInput("0"); h.overlay.handleInput("\r");
  assert.match(h.overlay.render(120).join("\n"), /integer in range: 1–10000/);
  h.overlay.handleInput("\x15"); h.overlay.handleInput("18"); h.overlay.handleInput("\r");
  h.select(6); h.overlay.handleInput("\r"); h.overlay.handleInput("\x15"); h.overlay.handleInput("0"); h.overlay.handleInput("\r");
  await h.save();
  assert.equal(h.saves[0]?.todoReview.reviewSteps, 18);
  assert.equal(h.saves[0]?.todoReview.cooldownMs, 0);
});

test("TODO settings rejects malformed, fractional and oversized numeric inputs", () => {
  for (const value of ["NaN", "1.5", "10001", "", "-1"]) {
    const h = harness(); h.select(5); h.overlay.handleInput("\r"); h.overlay.handleInput("\x15");
    h.overlay.handleInput(value); h.overlay.handleInput("\r");
    assert.match(h.overlay.render(120).join("\n"), /integer in range/);
    assert.equal(h.saves.length, 0);
  }
});

test("TODO settings choose shadow, Advisor mode and model explicitly", async () => {
  const h = harness(); h.select(1); h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b[B"); h.overlay.handleInput("\x1b[B"); h.overlay.handleInput("\r");
  h.select(1); h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b[B"); h.overlay.handleInput("\r");
  h.select(2); h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b[B"); h.overlay.handleInput("\r");
  await h.save();
  assert.equal(h.saves[0]?.mode, "hybrid");
  assert.equal(h.saves[0]?.model, "provider/reviewer");
  assert.equal(h.saves[0]?.todoReview.mode, "shadow");
});

test("TODO settings preserves unavailable model pins when opening and accepting selection", () => {
  const h = harness(); h.select(2); h.overlay.handleInput("\r"); h.overlay.handleInput("\r");
  h.overlay.handleInput("\x13");
  assert.match(h.overlay.render(120).join("\n"), /No changes to save/);
  assert.match(h.overlay.render(120).join("\n"), /missing\/pinned: unavailable \(preserved\)/);
});

test("TODO settings layered Escape and reset cancel drafts without writing", async () => {
  const h = harness(); h.overlay.handleInput("\r"); h.overlay.handleInput("\x13"); h.overlay.handleInput("\x1b");
  assert.equal(h.result(), undefined);
  h.overlay.handleInput("\x12");
  assert.match(h.overlay.render(120).join("\n"), /Configured: false/);
  h.overlay.handleInput("\r"); h.overlay.handleInput("\x1b");
  assert.equal(h.result(), undefined);
  h.overlay.handleInput("\x1b");
  assert.equal(h.result(), "cancelled");
  assert.equal(h.saves.length, 0);
  await h.save(); assert.equal(h.saves.length, 0, "closed component cannot save");
});

test("TODO settings retain draft after save failure and can retry", async () => {
  let attempts = 0;
  const h = harness({ async save() { if (++attempts === 1) throw new Error("disk full"); } });
  h.overlay.handleInput("\r"); await h.save();
  assert.match(h.overlay.render(120).join("\n"), /Save failed: disk full/);
  assert.equal(h.result(), undefined);
  await h.save();
  assert.equal(h.result(), "saved"); assert.equal(h.saves[0]?.enabled, true);
});

test("TODO settings do not report saved when the commit callback returns false", async () => {
  const h = harness({ async save() { return false; } });
  h.overlay.handleInput("\r"); await h.save();
  assert.equal(h.result(), undefined);
  assert.equal(h.saves.length, 0);
  assert.match(h.overlay.render(120).join("\n"), /Save failed: Configuration was not saved/);
});

test("TODO settings do not submit stale or aborted drafts", async () => {
  let current = true;
  const h = harness({ isCurrent: () => current });
  h.overlay.handleInput("\r"); h.overlay.handleInput("\x13"); current = false;
  h.overlay.handleInput("\r"); await flush();
  assert.equal(h.saves.length, 0);
  assert.match(h.overlay.render(120).join("\n"), /configuration changed/);
  h.overlay.handleInput("\x1b"); assert.equal(h.result(), "cancelled");
  const controller = new AbortController();
  const aborted = harness({ signal: controller.signal });
  aborted.overlay.handleInput("\r"); controller.abort(); await aborted.save();
  assert.equal(aborted.saves.length, 0);
});

test("successful self-fencing save settles the overlay; disposal ignores pending save completion", async () => {
  const controller = new AbortController();
  const h = harness({ signal: controller.signal, async save() { controller.abort(); } });
  h.overlay.handleInput("\r"); await h.save(); assert.equal(h.result(), "saved");
  let resolve!: () => void;
  const pending = harness({ save: () => new Promise<void>(done => { resolve = done; }) });
  pending.overlay.handleInput("\r"); pending.overlay.handleInput("\x13"); pending.overlay.handleInput("\r");
  pending.overlay.dispose(); resolve(); await flush();
  assert.equal(pending.result(), undefined);
});

test("TODO settings entry opens a TUI overlay but rejects RPC even when custom exists", async () => {
  let opens = 0;
  const config = normalizeAdvisorConfig(undefined);
  const params = { configured: config, effective: config, models: [], async save() { return true; }, locale: "en" as const };
  const ctx = { hasUI: true, mode: "tui", ui: {
    notify() {},
    async custom(factory: (tui: { requestRender(): void }, themeValue: typeof theme, keys: unknown, done: (result: AdvisorTodoSettingsResult) => void) => AdvisorTodoSettingsOverlay) {
      opens++;
      let result: AdvisorTodoSettingsResult | undefined;
      const component = factory({ requestRender() {} }, theme, {}, next => { result = next; });
      assert.match(component.render(120).join("\n"), /TODO progress supervision/);
      component.handleInput("\x1b");
      return result;
    },
  } };
  assert.equal(await showAdvisorTodoSettings(ctx as unknown as ExtensionCommandContext, params), "cancelled");
  assert.equal(opens, 1);
  ctx.mode = "rpc";
  assert.equal(await showAdvisorTodoSettings(ctx as unknown as ExtensionCommandContext, params), "cancelled");
  assert.equal(opens, 1, "RPC must not invoke custom even with hasUI=true");
});

test("TODO settings headless entry reports unsupported without invoking save", async () => {
  let writes = 0;
  const notices: string[] = [];
  const config = normalizeAdvisorConfig(undefined);
  const result = await showAdvisorTodoSettings({ hasUI: false, ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionCommandContext,
    { configured: config, effective: config, models: [], async save() { writes++; return true; }, locale: "en" });
  assert.equal(result, "cancelled"); assert.equal(writes, 0);
  assert.match(notices[0]!, /interactive TUI/);
});
