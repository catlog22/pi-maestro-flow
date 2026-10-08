import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import type { AdvisorConfig } from "../advisor/runtime.ts";
import type { TodoReviewConfig } from "../advisor/todo-review.ts";
import { BracketedPasteDecoder, removeLastGrapheme, sanitizeSingleLineInput } from "./input-text.ts";
import { getTuiLocale } from "./locale.ts";
import { fit, frame, type FrameTheme } from "./ui-primitives.ts";

export type AdvisorTodoSettingsResult = "saved" | "cancelled";
export interface AdvisorTodoSettingsParams {
  configured: AdvisorConfig;
  effective: AdvisorConfig;
  models: readonly string[];
  save(next: AdvisorConfig): Promise<boolean>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  locale?: SupportedSettingsLocale;
}
interface OverlayParams extends AdvisorTodoSettingsParams {
  theme: FrameTheme;
  requestRender(): void;
  done(result: AdvisorTodoSettingsResult): void;
}
type NumericKey = Exclude<keyof TodoReviewConfig, "enabled" | "mode">;
type Row = { key: "advisorEnabled" | "advisorMode" | "model" | "enabled" | "mode" }
  | { key: NumericKey; min: number; max: number };
const ROWS: readonly Row[] = [
  { key: "advisorEnabled" }, { key: "advisorMode" }, { key: "model" },
  { key: "enabled" }, { key: "mode" },
  { key: "reviewSteps", min: 1, max: 10_000 },
  { key: "reviewActiveMs", min: 1, max: 86_400_000 },
  { key: "sameFailureLimit", min: 1, max: 10_000 },
  { key: "reflectionSteps", min: 1, max: 10_000 },
  { key: "unresolvedSteps", min: 1, max: 10_000 },
  { key: "unresolvedActiveMs", min: 1, max: 86_400_000 },
  { key: "cooldownMs", min: 0, max: 86_400_000 },
  { key: "maxReviewsPerTask", min: 1, max: 10_000 },
  { key: "maxEscalationsPerTask", min: 1, max: 10_000 },
];
const CATALOGS = {
  en: {
    title: "Advisor / TODO progress supervision", advisorEnabled: "Advisor enabled",
    advisorMode: "Advisor mode", model: "Advisor model", enabled: "TODO supervision enabled",
    mode: "TODO supervision mode", reviewSteps: "Review after model steps",
    reviewActiveMs: "Review after active time (ms)", sameFailureLimit: "Same failure limit",
    reflectionSteps: "Steps after reflection", unresolvedSteps: "Unresolved model steps",
    unresolvedActiveMs: "Unresolved active time (ms)", cooldownMs: "Task review cooldown (ms)",
    maxReviewsPerTask: "Reviews per task", maxEscalationsPerTask: "Advisor escalations per task",
    inherit: "inherit (session model)", unavailable: "unavailable (preserved)",
    controls: "↑↓ select · Enter edit · Ctrl+S save · Ctrl+R reset · Esc close",
    editing: "Enter accept · Esc back · Ctrl+U clear",
    confirm: "Save these changes to .pi/advisor.json?", confirmControls: "Enter confirm · Esc back",
    notSaved: "Configuration was not saved.",
    dirty: "Unsaved draft", discard: "Unsaved draft · Esc again discards changes",
    clean: "No changes to save", saved: "Saved", saving: "Saving…", failed: "Save failed",
    invalid: "Enter an integer in range", stale: "Session or configuration changed; reopen settings.",
    requirement: "Requires Advisor enabled + automatic/hybrid. No switches are enabled implicitly.",
    shadow: "Shadow records classifications only; no reflection or Advisor escalation.",
    safety: "Advice is not approval. Tools are not aborted and TODO status is not changed.",
    effective: "Effective", configured: "Configured", needTui: "Advisor TODO settings require an interactive TUI.",
  },
  "zh-CN": {
    title: "Advisor / TODO 进展监护", advisorEnabled: "Advisor 总开关",
    advisorMode: "Advisor 模式", model: "建议模型", enabled: "TODO 监护开关",
    mode: "TODO 监护模式", reviewSteps: "轻审查模型步数",
    reviewActiveMs: "轻审查有效时长（毫秒）", sameFailureLimit: "同类连续失败阈值",
    reflectionSteps: "回溯后追加步数", unresolvedSteps: "未收敛模型步数",
    unresolvedActiveMs: "未收敛有效时长（毫秒）", cooldownMs: "任务审查冷却（毫秒）",
    maxReviewsPerTask: "每任务审查预算", maxEscalationsPerTask: "每任务建议模型预算",
    inherit: "跟随会话模型", unavailable: "当前不可用（保留）",
    controls: "↑↓选择 Enter修改 Ctrl+S保存 Ctrl+R还原 Esc关闭",
    editing: "Enter确认 Esc返回 Ctrl+U清空",
    confirm: "将这些修改保存到 .pi/advisor.json？", confirmControls: "Enter确认保存 Esc返回",
    notSaved: "配置未保存。",
    dirty: "未保存草稿", discard: "有未保存修改，再按 Esc 放弃",
    clean: "配置未变更", saved: "已保存", saving: "正在保存…", failed: "保存失败",
    invalid: "请输入范围内的整数", stale: "会话或配置已变更，请重新打开面板。",
    requirement: "需开启 Advisor 且为 automatic/hybrid；不会隐式开启任何开关。",
    shadow: "shadow 仅记录分类，不注入回溯提示、不调用建议 agent。",
    safety: "建议不是授权；不会中断工具或修改 TODO 状态。",
    effective: "实际生效", configured: "已配置", needTui: "Advisor TODO 配置需要交互式 TUI。",
  },
} as const;
type TextKey = keyof typeof CATALOGS.en;

export class AdvisorTodoSettingsOverlay implements Component, Focusable {
  focused = false;
  private draft: AdvisorConfig;
  private selected = 0;
  private mode: "menu" | "edit" | "pick" | "confirm" = "menu";
  private input = "";
  private choices: string[] = [];
  private choiceIndex = 0;
  private notice = "";
  private discardArmed = false;
  private saving = false;
  private closed = false;
  private readonly locale: SupportedSettingsLocale;
  private readonly paste = new BracketedPasteDecoder();
  constructor(private readonly params: OverlayParams) {
    this.draft = structuredClone(params.configured);
    this.locale = getTuiLocale(params.locale);
  }
  invalidate(): void {}
  dispose(): void { this.closed = true; }
  private text(key: TextKey): string { return CATALOGS[this.locale][key]; }
  private current(): boolean { return !this.closed && !this.params.signal?.aborted && (this.params.isCurrent?.() ?? true); }
  private dirty(): boolean { return JSON.stringify(this.draft) !== JSON.stringify(this.params.configured); }
  private value(config: AdvisorConfig, row: Row): string | number | boolean {
    if (row.key === "advisorEnabled") return config.enabled;
    if (row.key === "advisorMode") return config.mode;
    if (row.key === "model") return config.model ?? this.text("inherit");
    return config.todoReview[row.key];
  }
  private label(row: Row): string { return this.text(row.key); }
  render(width: number): string[] {
    const w = Math.max(1, Math.min(width, 120));
    if (w < 4) return [fit(this.text("title"), w)];
    const inner = w - 2;
    const lines = [fit(`${this.text("title")}${this.dirty() ? " *" : ""}`, inner)];
    const row = ROWS[this.selected]!;
    if (this.mode === "confirm") {
      lines.push(fit(this.text("confirm"), inner));
      for (const item of ROWS) {
        if (this.value(this.draft, item) !== this.value(this.params.configured, item)) {
          lines.push(fit(`${this.label(item)}: ${this.value(this.params.configured, item)} → ${this.value(this.draft, item)}`, inner));
        }
      }
      lines.push(fit(this.text("confirmControls"), inner));
    } else if (this.mode === "edit") {
      lines.push(fit(this.label(row), inner), fit(`> ${this.input}`, inner), fit(this.text("editing"), inner));
    } else if (this.mode === "pick") {
      lines.push(fit(this.label(row), inner));
      const start = Math.max(0, this.choiceIndex - 4);
      for (let i = start; i < Math.min(this.choices.length, start + 9); i++) {
        const value = this.choices[i]!;
        const display = row.key === "model" && !value ? this.text("inherit") : value;
        lines.push(fit(`${i === this.choiceIndex ? ">" : " "} ${display}`, inner));
      }
      lines.push(fit(this.text("editing"), inner));
    } else {
      const start = Math.max(0, Math.min(ROWS.length - 10, this.selected - 5));
      ROWS.slice(start, start + 10).forEach((item, i) => {
        lines.push(fit(`${start + i === this.selected ? ">" : " "} ${this.label(item)}: ${this.value(this.draft, item)}`, inner));
      });
      lines.push(fit(`${this.text("configured")}: ${this.value(this.params.configured, row)} · ${this.text("effective")}: ${this.value(this.params.effective, row)}`, inner));
      if (this.draft.model && !this.params.models.includes(this.draft.model)) lines.push(fit(`${this.draft.model}: ${this.text("unavailable")}`, inner));
      lines.push(fit(this.text("requirement"), inner), fit(this.text("shadow"), inner), fit(this.text("safety"), inner), fit(this.text("controls"), inner));
    }
    if (!this.current()) lines.push(fit(this.text("stale"), inner));
    else if (this.notice) lines.push(fit(this.notice, inner));
    return frame(lines, w, this.params.theme);
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (!this.current()) { if (matchesKey(data, Key.escape)) this.finish("cancelled"); return; }
    if (data === "\x1b") { this.handleKey(data); return; }
    for (const token of this.paste.feed(data)) {
      if (token.kind === "paste") {
        if (!this.saving && this.mode === "edit") { this.input = `${this.input}${token.text}`.slice(0, 64); this.redraw(); }
      } else this.handleKey(token.text);
    }
  }
  private handleKey(data: string): void {
    if (!this.current() || this.saving) return;
    if (matchesKey(data, Key.escape)) {
      if (this.mode !== "menu") { this.mode = "menu"; this.redraw(); return; }
      if (this.dirty() && !this.discardArmed) { this.discardArmed = true; this.notice = this.text("discard"); this.redraw(); return; }
      this.finish("cancelled"); return;
    }
    if (this.mode === "confirm") {
      if (matchesKey(data, Key.enter)) void this.save();
      return;
    }
    if (this.mode === "edit") {
      if (matchesKey(data, Key.enter)) {
        const row = ROWS[this.selected]!;
        const value = Number(this.input);
        if (!("min" in row)) return;
        if (!this.input.trim() || !Number.isSafeInteger(value) || value < row.min || value > row.max) {
          this.notice = `${this.text("invalid")}: ${row.min}–${row.max}`;
        } else { this.draft.todoReview[row.key] = value; this.changed(); this.mode = "menu"; }
      } else if (matchesKey(data, Key.ctrl("u"))) this.input = "";
      else if (matchesKey(data, Key.backspace)) this.input = removeLastGrapheme(this.input);
      else this.input = `${this.input}${sanitizeSingleLineInput(data)}`.slice(0, 64);
      this.redraw(); return;
    }
    if (this.mode === "pick") {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.choiceIndex = (this.choiceIndex + this.choices.length + (matchesKey(data, Key.up) ? -1 : 1)) % this.choices.length;
      } else if (matchesKey(data, Key.enter)) {
        const value = this.choices[this.choiceIndex]!;
        const row = ROWS[this.selected]!;
        if (row.key === "advisorMode" && (value === "automatic" || value === "manual" || value === "hybrid")) this.draft.mode = value;
        else if (row.key === "mode" && (value === "active" || value === "shadow")) this.draft.todoReview.mode = value;
        else if (row.key === "model") { if (value) this.draft.model = value; else delete this.draft.model; }
        this.changed(); this.mode = "menu";
      }
      this.redraw(); return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.selected = (this.selected + ROWS.length + (matchesKey(data, Key.up) ? -1 : 1)) % ROWS.length;
      this.discardArmed = false;
    } else if (matchesKey(data, Key.ctrl("r"))) { this.draft = structuredClone(this.params.configured); this.notice = ""; this.discardArmed = false; }
    else if (matchesKey(data, Key.ctrl("s"))) {
      if (this.dirty()) this.mode = "confirm";
      else this.notice = this.text("clean");
    } else if (matchesKey(data, Key.enter) || data === " ") {
      const row = ROWS[this.selected]!;
      if (row.key === "advisorEnabled") { this.draft.enabled = !this.draft.enabled; this.changed(); }
      else if (row.key === "enabled") { this.draft.todoReview.enabled = !this.draft.todoReview.enabled; this.changed(); }
      else if ("min" in row) { this.mode = "edit"; this.input = String(this.value(this.draft, row)); }
      else {
        this.mode = "pick";
        const models = this.draft.model && !this.params.models.includes(this.draft.model)
          ? [this.draft.model, ...this.params.models] : this.params.models;
        this.choices = row.key === "advisorMode" ? ["automatic", "manual", "hybrid"] : row.key === "mode" ? ["active", "shadow"] : ["", ...models];
        const value = row.key === "model" ? this.draft.model ?? "" : String(this.value(this.draft, row));
        this.choiceIndex = Math.max(0, this.choices.indexOf(value));
      }
    }
    this.redraw();
  }
  private changed(): void { this.notice = this.text("dirty"); this.discardArmed = false; }
  private redraw(): void { if (!this.closed) this.params.requestRender(); }
  private finish(result: AdvisorTodoSettingsResult): void { if (!this.closed) { this.closed = true; this.params.done(result); } }
  private async save(): Promise<void> {
    if (!this.current() || this.saving) return;
    this.saving = true; this.notice = this.text("saving"); this.redraw();
    try {
      if (!await this.params.save(structuredClone(this.draft))) throw new Error(this.text("notSaved"));
      if (this.closed) return;
      // A successful commit may fence its own runtime signal.
      this.finish("saved");
    } catch (error) {
      if (!this.closed) { this.mode = "menu"; this.notice = `${this.text("failed")}: ${error instanceof Error ? error.message : String(error)}`; }
    } finally { this.saving = false; this.redraw(); }
  }
}

export async function showAdvisorTodoSettings(
  ctx: ExtensionCommandContext, params: AdvisorTodoSettingsParams,
): Promise<AdvisorTodoSettingsResult> {
  if (!supportsCustomOverlay(ctx)) {
    ctx.ui.notify(CATALOGS[getTuiLocale(params.locale)].needTui, "warning");
    return "cancelled";
  }
  return ctx.ui.custom<AdvisorTodoSettingsResult>((tui, theme, _keybindings, done) =>
    new AdvisorTodoSettingsOverlay({ ...params, theme, requestRender: () => tui.requestRender(), done }), {
      overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" },
    });
}
