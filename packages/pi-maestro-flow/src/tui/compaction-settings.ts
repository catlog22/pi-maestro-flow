import { constants as fsConstants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  COMPACTION_FIELDS,
  readCompactionSettings,
  resolveEffectiveCompactionSettings,
  resolveProjectSettingsPath,
  saveCompactionScope,
  validateCompactionPatch,
  type CompactionConfigPatch,
  type CompactionScope,
  type CompactionSettingsSnapshot,
  type SoftCompactionConfigPatch,
} from "../compaction/compaction-settings.ts";
import { effectiveReserveTokens, MIN_RESERVE_RATIO } from "../compaction/auto-compaction.ts";

type CompactionField = typeof COMPACTION_FIELDS[number];
type MenuItem = "threshold" | "enabled" | "keepRecentTokens" | "softEnabled";
type SaveState = "clean" | "dirty" | "saving" | "failed";

interface CompactionTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

interface ScopeDraft {
  enabled?: boolean;
  reserveTokens?: string;
  keepRecentTokens?: string;
  soft?: SoftCompactionConfigPatch;
}

export interface CompactionSettingsResult {
  saved: boolean;
}

export interface CompactionSettingsOverlayParams {
  projectRoot: string;
  snapshot: CompactionSettingsSnapshot;
  contextWindow?: number;
  maxTokens?: number;
  projectReadonlyReason?: string;
  theme: CompactionTheme;
  requestRender: () => void;
  done: (result: CompactionSettingsResult) => void;
  saveScope?: (scope: CompactionScope, values: CompactionConfigPatch) => Promise<void>;
}

const MENU_ITEMS: readonly MenuItem[] = ["threshold", "enabled", "keepRecentTokens", "softEnabled"];

const ITEM_LABELS: Record<MenuItem, string> = {
  threshold: "压缩阈值",
  enabled: "自动压缩",
  keepRecentTokens: "保留最近上下文",
  softEnabled: "软压缩开关",
};

const ITEM_DETAILS: Record<MenuItem, string> = {
  threshold: "上下文达到此 Token 数时触发压缩（硬压缩）。",
  enabled: "同时控制 Pi 原生自动压缩与 Maestro 执行中压缩。",
  keepRecentTokens: "清理旧工具结果时，优先保留最近的上下文。",
  softEnabled: "开启后在达到硬阈值前先裁剪陈旧工具结果（软压缩）；比例经 settings 的 compaction.soft 微调。",
};

export class CompactionSettingsOverlay implements Component, Focusable {
  focused = false;
  private scope: CompactionScope;
  private selected = 0;
  private editing = false;
  private editValue = "";
  private saveState: SaveState = "clean";
  private notice = "";
  private discardArmed = false;
  private readonly initialDrafts: Record<CompactionScope, ScopeDraft>;
  private readonly drafts: Record<CompactionScope, ScopeDraft>;

  constructor(private readonly params: CompactionSettingsOverlayParams) {
    this.scope = params.projectReadonlyReason ? "user" : "project";
    this.initialDrafts = {
      project: toDraft(params.snapshot.scopes.project),
      user: toDraft(params.snapshot.scopes.user),
    };
    this.drafts = {
      project: { ...this.initialDrafts.project },
      user: { ...this.initialDrafts.user },
    };
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    if (safeWidth < 20) return [this.renderTiny(safeWidth)];
    if (this.editing) return this.renderEditor(safeWidth);
    const inner = safeWidth - 2;
    const rows = [
      fitLine(`${this.params.theme.bold("Maestro 压缩设置")} · ${this.scopeTabs()}`, inner),
      rule(inner),
      this.params.theme.fg("dim", fitLine("设置菜单", inner)),
      ...MENU_ITEMS.map((item, index) => this.renderMenuItem(item, index === this.selected, inner)),
    ];
    rows.push(rule(inner), ...this.detailRows(inner, safeWidth));
    if (this.params.projectReadonlyReason && this.scope === "project") {
      rows.push(this.params.theme.fg("warning", fitLine(
        `△ 项目配置只读 · ${localizeReadonlyReason(this.params.projectReadonlyReason)}`,
        inner,
      )));
    }
    const validation = this.validation();
    const configField = this.selectedConfigField();
    const fieldIssue = configField
      ? validation.errors.find((message) => message.startsWith(configField))
        ?? validation.warnings.find((message) => message.startsWith(configField))
      : undefined;
    if (fieldIssue) {
      rows.push(this.params.theme.fg(validation.errors.includes(fieldIssue) ? "error" : "warning", fitLine(
        `${validation.errors.includes(fieldIssue) ? "× 无效" : "△ 提醒"} · ${localizeValidation(fieldIssue)}`,
        inner,
      )));
    }
    if (this.notice) rows.push(this.styledNotice(this.notice, inner));
    rows.push(this.menuFooter(inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.saveState === "saving") return;
    if (this.editing) {
      this.handleEditInput(data);
      return;
    }
    if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
      void this.save();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.isDirty() && !this.discardArmed) {
        this.discardArmed = true;
        this.notice = "△ 有未保存的修改 · 再按一次 Esc 放弃修改";
        this.requestRender();
        return;
      }
      this.params.done({ saved: false });
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.scope = this.scope === "project" ? "user" : "project";
      this.discardArmed = false;
      this.notice = this.scope === "project" && this.params.projectReadonlyReason
        ? `△ 项目配置只读 · ${localizeReadonlyReason(this.params.projectReadonlyReason)}`
        : "";
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (data === "u" || data === "U") {
      if (!this.canEdit()) return;
      const item = this.selectedItem();
      if (item === "softEnabled") {
        const soft = this.drafts[this.scope].soft;
        if (soft) {
          delete soft.enabled;
          if (Object.keys(soft).length === 0) delete this.drafts[this.scope].soft;
        }
      } else {
        delete this.drafts[this.scope][configFieldForItem(item)];
      }
      this.markDirty();
      return;
    }
    if ((matchesKey(data, Key.space) || data === " ") && (this.selectedItem() === "enabled" || this.selectedItem() === "softEnabled")) {
      if (!this.canEdit()) return;
      this.toggleEnabledItem(this.selectedItem());
      this.markDirty();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (!this.canEdit()) return;
      const item = this.selectedItem();
      if (item === "enabled" || item === "softEnabled") {
        this.toggleEnabledItem(item);
        this.markDirty();
        return;
      }
      this.editValue = this.editorValue(item);
      this.editing = true;
      this.notice = "";
      this.requestRender();
    }
  }

  private renderTiny(width: number): string {
    const item = this.selectedItem();
    const state = this.saveState === "saving" ? "… 保存中"
      : this.saveState === "failed" ? `! ${this.notice || "保存失败"}`
      : this.isDirty() ? "△ 未保存"
      : "✓ 就绪";
    const prefix = this.editing ? "编辑" : this.scope === "project" ? "项目" : "用户";
    const value = this.editing ? this.formattedEditValue() : this.itemValue(item);
    return fitLine(`${prefix} · ${shortLabel(item)} ${value} · ${state} · Esc`, width);
  }

  private renderMenuItem(item: MenuItem, selected: boolean, width: number): string {
    const marker = selected ? this.params.theme.fg("accent", "›") : " ";
    const label = selected ? this.params.theme.bold(ITEM_LABELS[item]) : ITEM_LABELS[item];
    return fitLine(`${marker} ${label} · ${this.itemValue(item)} · ${this.draftSource(item)}`, width);
  }

  private draftSource(item: MenuItem): string {
    if (item === "softEnabled") {
      return this.drafts[this.scope].soft?.enabled === undefined
        ? `继承自${sourceLabel(this.effective().source.soft)}`
        : sourceLabel(this.scope);
    }
    const field = configFieldForItem(item);
    return this.drafts[this.scope][field] === undefined
      ? `继承自${sourceLabel(this.effective().source[field])}`
      : sourceLabel(this.scope);
  }

  private renderEditor(width: number): string[] {
    const inner = width - 2;
    const item = this.selectedItem();
    const rows = [
      fitLine(`${this.params.theme.bold(`修改${ITEM_LABELS[item]}`)} · ${scopeLabel(this.scope)}`, inner),
      rule(inner),
      fitLine(`当前值 · ${this.itemValue(item)}`, inner),
      this.params.theme.fg("accent", fitLine(`› 新值 · ${this.formattedEditValue()} Token`, inner)),
    ];
    if (item === "threshold") {
      const contextWindow = this.params.contextWindow;
      if (contextWindow) {
        const reserve = contextWindow - Number(this.editValue);
        const validReserve = Number.isSafeInteger(reserve) && reserve > 0;
        rows.push(
          fitLine(`上下文窗口 · ${formatNumber(contextWindow)} Token`, inner),
          fitLine(
            validReserve
              ? `保存后预留输出 · ${formatNumber(reserve)} Token`
              : "保存后预留输出 · 必须大于 0 Token",
            inner,
          ),
        );
        if (validReserve) {
          const ratioPct = Math.round(MIN_RESERVE_RATIO * 100);
          const ratioFloor = Math.floor(contextWindow * MIN_RESERVE_RATIO);
          const maxOutput = this.params.maxTokens ?? 0;
          const effective = effectiveReserveTokens({ reserveTokens: reserve }, contextWindow, this.params.maxTokens);
          const trigger = contextWindow - effective;
          const triggerPct = Math.round((trigger / contextWindow) * 100);
          rows.push(
            fitLine(`最大输出 · ${formatNumber(maxOutput)} Token`, inner),
            this.params.theme.fg("accent", fitLine(
              `公式 · max(配置 ${formatNumber(reserve)}, 窗口${ratioPct}% ${formatNumber(ratioFloor)}, 输出 ${formatNumber(maxOutput)})`,
              inner,
            )),
            fitLine(`有效预留 = ${formatNumber(effective)} · 约 ${formatNumber(trigger)} (${triggerPct}%) 触发压缩`, inner),
          );
        }
      } else {
        rows.push(this.params.theme.fg("warning", fitLine(
          "△ 当前模型缺少上下文窗口，正在编辑预留输出空间",
          inner,
        )));
      }
    } else {
      rows.push(fitLine(ITEM_DETAILS[item], inner));
    }
    rows.push(rule(inner));
    if (this.notice) rows.push(this.styledNotice(this.notice, inner));
    rows.push(inner < 30
      ? fitLine("Esc返回 Enter确认", inner)
      : fitSegments(inner, ["Esc 返回", "Enter 确认", "输入数字", "Backspace 删除"]));
    return frame(rows, width, this.params.theme);
  }

  private handleEditInput(data: string): void {
    const item = this.selectedItem();
    if (item === "enabled" || item === "softEnabled") {
      this.editing = false;
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.editing = false;
      this.editValue = "";
      this.notice = "";
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      const numeric = Number(this.editValue);
      if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        this.notice = "× 请输入大于 0 的整数";
        this.requestRender();
        return;
      }
      const field = this.selectedConfigField();
      if (item === "threshold" && this.params.contextWindow && this.params.contextWindow > 0) {
        const reserveTokens = this.params.contextWindow - numeric;
        if (!Number.isSafeInteger(reserveTokens) || reserveTokens <= 0) {
          this.notice = `× 压缩阈值必须小于上下文窗口 ${formatNumber(this.params.contextWindow)}`;
          this.requestRender();
          return;
        }
        this.drafts[this.scope].reserveTokens = String(reserveTokens);
      } else {
        this.drafts[this.scope][field] = String(numeric);
      }
      this.editing = false;
      this.editValue = "";
      this.markDirty();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.editValue = this.editValue.slice(0, -1);
      this.notice = "";
      this.requestRender();
      return;
    }
    const digits = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\D/g, "");
    if (!digits) return;
    this.editValue = `${this.editValue}${digits}`;
    this.notice = "";
    this.requestRender();
  }

  private async save(): Promise<void> {
    if (!this.isDirty()) {
      this.notice = "✓ 没有需要保存的修改";
      this.requestRender();
      return;
    }
    const validation = this.validation();
    if (validation.errors.length > 0) {
      this.saveState = "dirty";
      this.notice = `× 无法保存 · ${localizeValidation(validation.errors[0]!)}`;
      this.requestRender();
      return;
    }
    this.saveState = "saving";
    this.notice = "… 正在保存";
    this.requestRender();
    try {
      for (const scope of ["user", "project"] as const) {
        if (!draftEqual(this.drafts[scope], this.initialDrafts[scope])) {
          const save = this.params.saveScope
            ?? ((targetScope: CompactionScope, values: CompactionConfigPatch) =>
              saveCompactionScope(targetScope, this.params.projectRoot, values));
          await save(scope, draftToPatch(this.drafts[scope]));
        }
      }
      this.params.done({ saved: true });
    } catch (error) {
      this.saveState = "failed";
      this.notice = `! 保存失败 · ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender();
    }
  }

  private effective() {
    return resolveEffectiveCompactionSettings(
      draftToPatch(this.drafts.user),
      draftToPatch(this.drafts.project),
    );
  }

  private validation() {
    const effective = this.effective();
    return validateCompactionPatch(effective, this.params.contextWindow, this.params.maxTokens);
  }

  private itemValue(item: MenuItem): string {
    const effective = this.effective();
    if (item === "enabled") return effective.enabled ? "已开启" : "已关闭";
    if (item === "softEnabled") return effective.soft.enabled ? "已开启" : "已关闭";
    if (item === "threshold") {
      return this.params.contextWindow
        ? thresholdLabel(this.params.contextWindow, effective.reserveTokens)
        : `预留 ${formatNumber(effective.reserveTokens)} Token`;
    }
    return `${formatNumber(effective.keepRecentTokens)} Token`;
  }

  private editorValue(item: MenuItem): string {
    const effective = this.effective();
    if (item === "threshold" && this.params.contextWindow && this.params.contextWindow > 0) {
      const threshold = this.params.contextWindow - effective.reserveTokens;
      return threshold > 0 ? String(threshold) : "";
    }
    if (item === "softEnabled") return "";
    return String(effective[configFieldForItem(item)]);
  }

  private formattedEditValue(): string {
    const value = Number(this.editValue);
    return Number.isFinite(value) && this.editValue !== "" ? formatNumber(value) : this.editValue || "∅";
  }

  private detailRows(width: number, safeWidth: number): string[] {
    const item = this.selectedItem();
    const rows = [fitLine(ITEM_DETAILS[item], width)];
    if (item !== "threshold") return rows;
    const effective = this.effective();
    if (this.params.contextWindow) {
      rows.push(fitLine(
        `上下文窗口 ${formatNumber(this.params.contextWindow)} · 预留输出 ${formatNumber(effective.reserveTokens)} Token`,
        width,
      ));
      if (safeWidth >= 40) rows.push(fitLine(this.pressurePreview(effective.reserveTokens), width));
    } else {
      rows.push(this.params.theme.fg("warning", fitLine("△ 当前模型缺少上下文窗口，无法计算压缩阈值", width)));
    }
    return rows;
  }

  private pressurePreview(reserveTokens: number): string {
    const contextWindow = this.params.contextWindow;
    if (!contextWindow || reserveTokens >= contextWindow) return "压力区间 · 当前模型上下文不可用";
    const threshold = contextWindow - reserveTokens;
    const percent = (threshold / contextWindow * 100).toFixed(1);
    const soft = this.effective().soft;
    const nudge = Math.round(soft.nudgeRatio * 100);
    const prune = Math.round(soft.pruneRatio * 100);
    return `压力区间 · 正常 <${nudge}% · 提醒 ${nudge}–${prune}% · 清理 ${prune}–${percent}% · 压缩 ≥${percent}%`;
  }

  private styledNotice(notice: string, width: number): string {
    const role = notice.startsWith("!") || notice.startsWith("×") ? "error"
      : notice.startsWith("✓") ? "success"
      : "warning";
    return this.params.theme.fg(role, fitLine(notice, width));
  }

  private scopeTabs(): string {
    return `${this.scope === "project" ? "[项目]" : "项目"}  ${this.scope === "user" ? "[用户]" : "用户"}`;
  }

  private canEdit(): boolean {
    if (this.scope !== "project" || !this.params.projectReadonlyReason) return true;
    this.notice = `△ 项目配置只读 · ${localizeReadonlyReason(this.params.projectReadonlyReason)}`;
    this.requestRender();
    return false;
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + MENU_ITEMS.length) % MENU_ITEMS.length;
    this.discardArmed = false;
    this.notice = "";
    this.requestRender();
  }

  private selectedItem(): MenuItem {
    return MENU_ITEMS[this.selected]!;
  }

  private selectedConfigField(): CompactionField | undefined {
    const item = this.selectedItem();
    return item === "softEnabled" ? undefined : configFieldForItem(item);
  }

  private toggleEnabledItem(item: MenuItem): void {
    if (item === "softEnabled") {
      const current = this.drafts[this.scope].soft ?? {};
      this.drafts[this.scope].soft = { ...current, enabled: !this.effective().soft.enabled };
    } else {
      this.drafts[this.scope].enabled = !this.effective().enabled;
    }
  }

  private menuFooterSegments(): string[] {
    const item = this.selectedItem();
    return [
      "Esc 关闭",
      ...(this.isDirty() ? ["Ctrl+S 保存"] : []),
      `Enter ${item === "enabled" || item === "softEnabled" ? "切换" : "修改"}`,
      "↑↓ 选择",
      "Tab 切换范围",
      ...(item === "enabled" || item === "softEnabled" ? ["Space 切换"] : []),
      "U 恢复继承",
    ];
  }

  private menuFooter(width: number): string {
    if (width < 30) {
      const footer = this.isDirty()
        ? "Esc关闭 Ctrl+S保存"
        : `Esc关闭 Enter${this.selectedItem() === "enabled" || this.selectedItem() === "softEnabled" ? "切换" : "修改"}`;
      return fitLine(footer, width);
    }
    return fitSegments(width, this.menuFooterSegments());
  }

  private markDirty(): void {
    this.saveState = this.isDirty() ? "dirty" : "clean";
    this.discardArmed = false;
    this.notice = "";
    this.requestRender();
  }

  private isDirty(): boolean {
    return !draftEqual(this.drafts.project, this.initialDrafts.project)
      || !draftEqual(this.drafts.user, this.initialDrafts.user);
  }

  private requestRender(): void {
    this.params.requestRender();
  }
}

export function registerCompactionSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("maestro-compaction", {
    description: "配置 Pi 与 Maestro 的自动压缩阈值",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("压缩设置需要在交互式 TUI 中打开。", "error");
        return;
      }
      const result = await showCompactionSettingsOverlay(ctx);
      if (!result.saved) return;
      await ctx.reload();
      return;
    },
  });
}

export async function showCompactionSettingsOverlay(
  ctx: ExtensionCommandContext,
): Promise<CompactionSettingsResult> {
  const snapshot = readCompactionSettings(ctx.cwd);
  const projectReadonlyReason = await projectWriteRestriction(ctx.cwd);
  return ctx.ui.custom<CompactionSettingsResult>((tui, theme, _keybindings, done) =>
    new CompactionSettingsOverlay({
      projectRoot: ctx.cwd,
      snapshot,
      contextWindow: ctx.model?.contextWindow,
      maxTokens: ctx.model?.maxTokens,
      projectReadonlyReason,
      theme,
      requestRender: () => tui.requestRender(),
      done,
    }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}

async function projectWriteRestriction(projectRoot: string): Promise<string | undefined> {
  const settingsPath = resolveProjectSettingsPath(projectRoot);
  try {
    await access(existsSync(settingsPath) ? settingsPath : projectRoot, fsConstants.W_OK);
    return undefined;
  } catch {
    return "workspace is not writable";
  }
}

function toDraft(patch: CompactionConfigPatch): ScopeDraft {
  return {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.reserveTokens !== undefined ? { reserveTokens: String(patch.reserveTokens) } : {}),
    ...(patch.keepRecentTokens !== undefined ? { keepRecentTokens: String(patch.keepRecentTokens) } : {}),
    ...(patch.soft !== undefined ? { soft: { ...patch.soft } } : {}),
  };
}

function draftToPatch(draft: ScopeDraft): CompactionConfigPatch {
  return {
    ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
    ...(draft.reserveTokens !== undefined ? { reserveTokens: Number(draft.reserveTokens) } : {}),
    ...(draft.keepRecentTokens !== undefined ? { keepRecentTokens: Number(draft.keepRecentTokens) } : {}),
    ...(draft.soft !== undefined ? { soft: { ...draft.soft } } : {}),
  };
}

function draftEqual(left: ScopeDraft, right: ScopeDraft): boolean {
  return COMPACTION_FIELDS.every((field) => left[field] === right[field])
    && softDraftEqual(left.soft, right.soft);
}

function softDraftEqual(left?: SoftCompactionConfigPatch, right?: SoftCompactionConfigPatch): boolean {
  const l = left ?? {};
  const r = right ?? {};
  return l.enabled === r.enabled
    && l.nudgeRatio === r.nudgeRatio
    && l.pruneRatio === r.pruneRatio
    && l.pruneTargetRatio === r.pruneTargetRatio;
}

function thresholdLabel(contextWindow: number | undefined, reserveTokens: number): string {
  if (!contextWindow || reserveTokens >= contextWindow) return "当前模型不可用";
  const threshold = contextWindow - reserveTokens;
  return `${formatNumber(threshold)} / ${formatNumber(contextWindow)} (${(threshold / contextWindow * 100).toFixed(1)}%)`;
}

function shortLabel(item: MenuItem): string {
  if (item === "threshold") return "阈值";
  if (item === "enabled") return "自动";
  if (item === "softEnabled") return "软压缩";
  return "保留";
}

function configFieldForItem(item: Exclude<MenuItem, "softEnabled">): CompactionField {
  return item === "threshold" ? "reserveTokens" : item;
}

function sourceLabel(source: CompactionScope | "default"): string {
  if (source === "project") return "项目";
  if (source === "user") return "用户";
  return "默认值";
}

function scopeLabel(scope: CompactionScope): string {
  return scope === "project" ? "项目配置" : "用户配置";
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function localizeReadonlyReason(reason: string): string {
  return reason === "workspace is not writable" ? "工作区不可写" : reason;
}

function localizeValidation(message: string): string {
  const values = [...message.matchAll(/\((\d+)\)/g)].map((match) => formatNumber(Number(match[1])));
  if (message.startsWith("reserveTokens") && message.includes("positive safe integer")) {
    return "预留输出空间必须是大于 0 的整数";
  }
  if (message.startsWith("keepRecentTokens") && message.includes("positive safe integer")) {
    return "保留最近上下文必须是大于 0 的整数";
  }
  if (message.startsWith("reserveTokens") && message.includes("contextWindow")) {
    return `预留输出空间 ${values[0] ?? ""} 必须小于上下文窗口 ${values[1] ?? ""}`.trim();
  }
  if (message.startsWith("keepRecentTokens") && message.includes("thresholdTokens")) {
    return `保留最近上下文 ${values[0] ?? ""} 不应大于或等于压缩阈值 ${values[1] ?? ""}`;
  }
  if (message.startsWith("reserveTokens") && message.includes("maxTokens")) {
    return `预留输出空间 ${values[0] ?? ""} 小于模型单次最大输出 ${values[1] ?? ""}，可能无法完成响应`;
  }
  if (message.startsWith("No model context window")) {
    return "当前模型缺少上下文窗口，已跳过阈值校验";
  }
  return message;
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function fitSegments(width: number, segments: readonly string[]): string {
  let line = "";
  for (const segment of segments) {
    const next = line ? `${line} · ${segment}` : segment;
    if (visibleWidth(next) > width) break;
    line = next;
  }
  return fitLine(line || segments[0] || "", width);
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme: CompactionTheme): string[] {
  if (width < 2) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  return [
    theme.fg("dim", top),
    ...rows.map((row) => {
      const fitted = fitLine(row, inner);
      return `${theme.fg("dim", "│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${theme.fg("dim", "│")}`;
    }),
    theme.fg("dim", bottom),
  ];
}
