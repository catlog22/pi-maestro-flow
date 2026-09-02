import { constants as fsConstants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
import { getTuiLocale } from "./locale.ts";
import { sanitizeSingleLineInput } from "./input-text.ts";
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
import {
  deriveLinkedCompactionThreshold,
  summaryOutputTokenLimit,
  type CompactionThresholdDerivation,
  type CompactionThresholdReason,
  type LinkedCompactionThresholdModel,
} from "../compaction/compaction-threshold.ts";

type CompactionField = typeof COMPACTION_FIELDS[number];
type EditableCompactionField = Exclude<CompactionField, "enabled" | "newContext">;
type SoftMechanismItem = "softLossless" | "softCacheGate" | "softTimeBased" | "softRelevance" | "softDedup";
type MenuItem = "threshold" | "enabled" | "keepRecentTokens" | "softEnabled" | SoftMechanismItem | "compactModel" | "newContext";
type ConfigFieldItem = Exclude<MenuItem, "softEnabled" | SoftMechanismItem | "newContext">;
type SaveState = "clean" | "dirty" | "saving" | "failed";

interface CompactionTheme extends FrameTheme {}

const CATALOGS = {
  en: {
    "command.description": "Configure Pi and Maestro automatic compaction thresholds",
    "command.needTui": "Compaction settings require an interactive TUI.",
    "title": "Maestro Compaction Settings",
    "menu": "Settings menu",
    "scope.project": "Project",
    "scope.user": "User",
    "scope.projectConfig": "Project configuration",
    "scope.userConfig": "User configuration",
    "state.ready": "Ready",
    "state.dirty": "Uncommitted changes",
    "state.saving": "Saving…",
    "state.failed": "Save failed",
    "state.editing": "Edit",
    "item.threshold": "Hard compaction threshold",
    "item.enabled": "Automatic compaction",
    "item.keepRecentTokens": "Keep recent context",
    "item.softEnabled": "Soft compaction toggle",
    "item.softLossless": "Lossless folding",
    "item.softCacheGate": "Cache economy gate",
    "item.softTimeBased": "Time-based staleness",
    "item.softRelevance": "Relevance ranking",
    "item.softDedup": "Cross-turn dedup",
    "item.compactModel": "Compaction model",
    "item.newContext": "Explicit new-context compaction",
    "item.threshold.short": "Threshold",
    "item.enabled.short": "Auto",
    "item.softEnabled.short": "Soft",
    "item.softLossless.short": "Lossless",
    "item.softCacheGate.short": "Cache",
    "item.softTimeBased.short": "Time",
    "item.softRelevance.short": "Relevance",
    "item.softDedup.short": "Dedup",
    "item.compactModel.short": "Model",
    "item.newContext.short": "New ctx",
    "item.keepRecentTokens.short": "Keep",
    "detail.threshold": "Shows the real runtime threshold; editing changes the configured threshold, converted back to reserved output space on save.",
    "detail.enabled": "Controls both Pi native automatic compaction and Maestro in-flight compaction.",
    "detail.keepRecentTokens": "When cleaning stale tool results, keep the most recent context first.",
    "detail.softEnabled": "Prunes stale tool output before hard compaction; if the hard threshold fires first, the soft stage is marked unreachable.",
    "detail.softLossless": "Folds tool output in a reversible format (duplicate lines, grep headers, diff indexes) without losing information; on by default.",
    "detail.softCacheGate": "Accounts for the cost of invalidated cache prefixes before pruning; skips pruning when the benefit does not pay the cost; on by default.",
    "detail.softTimeBased": "When the last assistant message is older than the threshold, the cache is certain to be stale; skips the cache economy gate and prunes directly; off by default.",
    "detail.softRelevance": "Prioritizes pruning low-relevance output by lexical relevance (BM25/keywords) to the latest user instruction; off by default.",
    "detail.softDedup": "Replaces verbatim duplicates of earlier tool output with context pointers; referenced output stays protected; off by default.",
    "detail.compactModel": "Model used for text-compaction summaries; follows the current session model by default and falls back at runtime when resolution fails.",
    "detail.newContext": "Allows standalone new_context requests and Todo advance transition:new_context. Off by default; this gate never changes threshold-triggered automatic compaction.",
    "value.on": "● On",
    "value.off": "○ Off",
    "value.inherit": "Follow session model",
    "value.inheritPrefix": "Inherited from",
    "value.unconfigured": "Unconfigured, follows the current session model",
    "value.followSession": "Follow session model",
    "value.reservePrefix": "Reserve",
    "editor.title": "Edit",
    "editor.current": "Current value",
    "editor.newValue": "New value",
    "editor.tokens": "tokens",
    "editor.configThreshold": "Configured threshold",
    "editor.configReserve": "Configured reserve",
    "editor.reservePositive": "Configured reserve · must be greater than 0 tokens",
    "editor.floor5pct": "Window 5% floor",
    "editor.outputLimit": "Model output limit",
    "editor.outputLimitShrink": "shrinks dynamically with the remaining window",
    "editor.effectiveReserve": "Effective safe reserve",
    "editor.hardThreshold": "Hard compaction",
    "editor.exceeds": "exceeds",
    "editor.capacitySource": "Capacity source",
    "editor.effectReason": "Effect reason",
    "editor.noContext": "Current model has no context window; editing the reserved output space",
    "editor.noContextDetail": "Current model has no context window; cannot compute the actual compaction threshold",
    "picker.title": "Choose compaction model",
    "picker.current": "current",
    "picker.models": "models",
    "notice.enterPositive": "Enter an integer greater than 0",
    "notice.invalid": "× invalid",
    "notice.warn": "△ notice",
    "notice.notEditable": "This setting is not editable",
    "notice.thresholdBelowContext": "Compaction threshold must be below the context window",
    "notice.nothingToSave": "No changes to save",
    "notice.cannotSave": "Cannot save",
    "notice.saving": "Saving…",
    "notice.saveFailed": "Save failed",
    "notice.readonlyProject": "Project configuration is read-only",
    "notice.readonlyReason.writable": "workspace is not writable",
    "notice.discardConfirm": "Uncommitted changes · press Esc again to discard",
    "confirm.title": "Confirm save",
    "confirm.summary": "{count} change(s)",
    "confirm.scope.project": "[project]",
    "confirm.scope.user": "[user]",
    "confirm.set": "{scope} {field} → {value}",
    "confirm.clear": "{scope} {field} → inherit",
    "confirm.toggleOn": "{scope} {field} → on",
    "confirm.toggleOff": "{scope} {field} → off",
    "confirm.footer": "Enter confirm save · Esc back",
    "filter.hint": "/ filter model",
    "footer.close": "Esc close",
    "footer.closeNarrow": "Esc close",
    "footer.save": "Ctrl+S save",
    "footer.saveNarrow": "Ctrl+S save",
    "footer.toggle": "toggle",
    "footer.choose": "choose",
    "footer.edit": "edit",
    "footer.navigate": "Up/Down select",
    "footer.scope": "Tab switch scope",
    "footer.space": "Space toggle",
    "footer.inherit": "U restore inheritance",
    "footer.escEdit": "Esc back",
    "footer.escEditNarrow": "Esc back",
    "footer.enterConfirm": "Enter confirm",
    "footer.enterConfirmNarrow": "Enter confirm",
    "notice.validation.reservePositive": "Reserved output space must be a positive integer",
    "notice.validation.keepPositive": "Keep-recent context must be a positive integer",
    "notice.validation.reserveCeiling": "Reserved output space {value} must not exceed {ceiling}",
    "notice.validation.reserveContext": "Reserved output space {value} must be smaller than the context window {window}",
    "notice.validation.keepThreshold": "Keep-recent context {value} must not be greater than or equal to the compaction threshold {threshold}",
    "notice.validation.reserveMaxOutput": "Reserved output space {value} is smaller than the model's single max output {max}, the response may not complete",
    "notice.validation.noContext": "Current model has no context window; threshold validation skipped",
    "soft.summary.unconfigured": "Soft stage · not configured",
    "soft.summary.warn": "Soft stage",
    "soft.summary.nudge": "nudge",
    "soft.summary.prune": "prune",
    "soft.summary.reachable": "reachable",
    "soft.summary.unreachable": "unreachable",
    "soft.summary.hardFirst": "hard compaction fires first",
    "soft.units": "soft stage",
    "threshold.actual": "Actual",
    "threshold.configured": "Configured threshold",
    "threshold.effective": "Effective safe reserve",
    "threshold.limiter.compaction": "Compaction model window",
    "threshold.limiter.session": "Current session model window",
    "threshold.reason.configured": "determined by the configured reserve",
    "threshold.reason.ratioFloor": "lowered by the 5% window safety floor",
    "threshold.reason.maxOutput": "lowered by the model max output protection",
    "threshold.reason.selfHosted": "summary model window bootstraps, hard compaction fires early",
    "threshold.reason.capped": "model max output is too large, safe reserve capped at 90% of the window",
    "source.project": "project",
    "source.user": "user",
    "source.default": "default",

    "footer.typeDigits": "Type digits",
    "footer.backspace": "Backspace delete",
    "footer.escChoose": "Esc back",
    "footer.enterChoose": "Enter choose",
    "footer.enterChooseNarrow": "Enter choose",
    "footer.move": "Up/Down move",
    "model.detail.configured": "Configured model",
    "model.detail.source": "source",
    "model.detail.stale": "Configured model is not in the available list; falls back at runtime",
    "model.detail.unconfigured": "Configured model · unconfigured, follows the current session model",
    "model.detail.fallback": "fallback",
  },
  "zh-CN": {
    "command.description": "配置 Pi 与 Maestro 的自动压缩阈值",
    "command.needTui": "压缩设置需要在交互式 TUI 中打开。",
    "title": "Maestro 压缩设置",
    "menu": "设置菜单",
    "scope.project": "项目",
    "scope.user": "用户",
    "scope.projectConfig": "项目配置",
    "scope.userConfig": "用户配置",
    "state.ready": "✓ 就绪",
    "state.dirty": "△ 未保存",
    "state.saving": "… 保存中",
    "state.failed": "保存失败",
    "state.editing": "编辑",
    "item.threshold": "实际硬压缩阈值",
    "item.enabled": "自动压缩",
    "item.keepRecentTokens": "保留最近上下文",
    "item.softEnabled": "软压缩开关",
    "item.softLossless": "无损折叠",
    "item.softCacheGate": "缓存经济门槛",
    "item.softTimeBased": "时间基冷检测",
    "item.softRelevance": "相关性排序",
    "item.softDedup": "跨轮去重",
    "item.compactModel": "压缩模型",
    "item.newContext": "显式新上下文压缩",
    "item.threshold.short": "阈值",
    "item.enabled.short": "自动",
    "item.softEnabled.short": "软压缩",
    "item.softLossless.short": "无损",
    "item.softCacheGate.short": "缓存",
    "item.softTimeBased.short": "时间",
    "item.softRelevance.short": "相关",
    "item.softDedup.short": "去重",
    "item.compactModel.short": "模型",
    "item.newContext.short": "新上下文",
    "item.keepRecentTokens.short": "保留",
    "detail.threshold": "显示运行时真实阈值；编辑的是配置阈值，保存后仍换算为预留输出空间。",
    "detail.enabled": "同时控制 Pi 原生自动压缩与 Maestro 执行中压缩。",
    "detail.keepRecentTokens": "清理旧工具结果时，优先保留最近的上下文。",
    "detail.softEnabled": "开启后在硬压缩前裁剪陈旧工具结果；若硬阈值更早，界面会标记软阶段不可达。",
    "detail.softLossless": "以可逆格式折叠工具输出（重复行、grep 表头、diff 索引），不丢信息；默认开启。",
    "detail.softCacheGate": "裁剪前核算作废缓存前缀的代价，收益不足以支付时不裁剪；默认开启（只拒绝、不触发）。",
    "detail.softTimeBased": "距最后一条助手消息超过阈值时缓存必然过期，跳过缓存经济门槛直接裁剪；默认关闭。",
    "detail.softRelevance": "按最近用户指令的词法相关性（BM25/关键词）优先裁剪低相关输出；默认关闭。",
    "detail.softDedup": "把与更早工具输出逐字重复的片段替换为上下文指针，被引用输出受保护；默认关闭。",
    "detail.compactModel": "用于生成文本压缩摘要的模型；默认跟随当前会话模型，解析失败运行时自动回退。",
    "detail.newContext": "允许 standalone new_context 请求与 Todo advance transition:new_context。默认关闭；此门禁不会改变按阈值触发的自动压缩。",
    "value.on": "● 已开启",
    "value.off": "○ 已关闭",
    "value.inherit": "跟随当前会话模型",
    "value.inheritPrefix": "继承自",
    "value.unconfigured": "未配置，跟随当前会话模型",
    "value.followSession": "跟随会话模型",
    "value.reservePrefix": "预留",
    "editor.title": "修改",
    "editor.current": "当前值",
    "editor.newValue": "新值",
    "editor.tokens": "Token",
    "editor.configThreshold": "配置阈值",
    "editor.configReserve": "配置预留",
    "editor.reservePositive": "配置预留 · 必须大于 0 Token",
    "editor.floor5pct": "窗口 5% 底线",
    "editor.outputLimit": "模型输出上限",
    "editor.outputLimitShrink": "按剩余窗口动态收缩",
    "editor.effectiveReserve": "实际安全预留",
    "editor.hardThreshold": "实际硬压缩",
    "editor.exceeds": "超过",
    "editor.capacitySource": "容量来源",
    "editor.effectReason": "生效原因",
    "editor.noContext": "△ 当前模型缺少上下文窗口，正在编辑预留输出空间",
    "editor.noContextDetail": "△ 当前模型缺少上下文窗口，无法计算实际压缩阈值",
    "picker.title": "选择压缩模型",
    "picker.current": "当前",
    "picker.models": "个模型",
    "notice.enterPositive": "× 请输入大于 0 的整数",
    "notice.invalid": "× 无效",
    "notice.warn": "△ 提醒",
    "notice.notEditable": "× 当前设置不可编辑",
    "notice.thresholdBelowContext": "× 压缩阈值必须小于上下文窗口",
    "notice.nothingToSave": "✓ 没有需要保存的修改",
    "notice.cannotSave": "× 无法保存",
    "notice.saving": "… 正在保存",
    "notice.saveFailed": "! 保存失败",
    "notice.readonlyProject": "△ 项目配置只读",
    "notice.readonlyReason.writable": "工作区不可写",
    "notice.discardConfirm": "△ 有未保存的修改 · 再按一次 Esc 放弃修改",
    "confirm.title": "确认保存",
    "confirm.summary": "{count} 处变更",
    "confirm.scope.project": "[项目]",
    "confirm.scope.user": "[用户]",
    "confirm.set": "{scope} {field} → {value}",
    "confirm.clear": "{scope} {field} → 继承",
    "confirm.toggleOn": "{scope} {field} → 开",
    "confirm.toggleOff": "{scope} {field} → 关",
    "confirm.footer": "Enter 确认保存 · Esc 返回",
    "filter.hint": "/ 筛选模型",
    "notice.validation.reservePositive": "预留输出空间必须是大于 0 的整数",
    "notice.validation.keepPositive": "保留最近上下文必须是大于 0 的整数",
    "notice.validation.reserveCeiling": "预留输出空间 {value} 不得超过 {ceiling}",
    "notice.validation.reserveContext": "预留输出空间 {value} 必须小于上下文窗口 {window}",
    "notice.validation.keepThreshold": "保留最近上下文 {value} 不应大于或等于压缩阈值 {threshold}",
    "notice.validation.reserveMaxOutput": "预留输出空间 {value} 小于模型单次最大输出 {max}，可能无法完成响应",
    "notice.validation.noContext": "当前模型缺少上下文窗口，已跳过阈值校验",
    "soft.summary.unconfigured": "软阶段 · 未配置",
    "soft.summary.warn": "软阶段",
    "soft.summary.nudge": "提醒",
    "soft.summary.prune": "裁剪",
    "soft.summary.reachable": "可达",
    "soft.summary.unreachable": "不可达",
    "soft.summary.hardFirst": "硬压缩会先触发",
    "soft.units": "软阶段",
    "threshold.actual": "实际",
    "threshold.configured": "配置阈值",
    "threshold.effective": "实际安全预留",
    "threshold.limiter.compaction": "压缩模型窗口",
    "threshold.limiter.session": "当前会话模型窗口",
    "threshold.reason.configured": "由配置预留决定",
    "threshold.reason.ratioFloor": "窗口 5% 安全底线下调",
    "threshold.reason.maxOutput": "模型最大输出保护下调",
    "threshold.reason.selfHosted": "摘要模型窗口自举，硬压缩提前触发",
    "threshold.reason.capped": "模型最大输出过大，安全预留封顶为窗口 90%",
    "source.project": "项目",
    "source.user": "用户",
    "source.default": "默认值",
    "footer.close": "Esc 关闭",
    "footer.closeNarrow": "Esc关闭",
    "footer.save": "Ctrl+S 保存",
    "footer.saveNarrow": "Ctrl+S保存",
    "footer.toggle": "切换",
    "footer.choose": "选择",
    "footer.edit": "修改",
    "footer.navigate": "↑↓ 选择",
    "footer.scope": "Tab 切换范围",
    "footer.space": "Space 切换",
    "footer.inherit": "U 恢复继承",
    "footer.escEdit": "Esc 返回",
    "footer.escEditNarrow": "Esc返回",
    "footer.enterConfirm": "Enter 确认",
    "footer.enterConfirmNarrow": "Enter确认",
    "footer.typeDigits": "输入数字",
    "footer.backspace": "Backspace 删除",
    "footer.escChoose": "Esc 返回",
    "footer.enterChoose": "Enter 选择",
    "footer.enterChooseNarrow": "Enter选择",
    "footer.move": "↑↓ 移动",
    "model.detail.configured": "配置模型",
    "model.detail.source": "来源",
    "model.detail.stale": "配置模型不在可用列表中，运行时回退",
    "model.detail.unconfigured": "配置模型 · 未配置，跟随当前会话模型",
    "model.detail.fallback": "当前会话模型",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

function translateCompaction(
  locale: SupportedSettingsLocale,
  key: CatalogKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

interface ScopeDraft {
  enabled?: boolean;
  reserveTokens?: string;
  keepRecentTokens?: string;
  model?: string;
  newContext?: { enabled?: boolean };
  soft?: SoftCompactionConfigPatch;
}

export interface CompactionSettingsResult {
  saved: boolean;
}

/** A selectable compaction model, projected from the model registry. */
export interface CompactionModelOption {
  reference: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CompactionSettingsOverlayParams {
  projectRoot: string;
  snapshot: CompactionSettingsSnapshot;
  contextWindow?: number;
  maxTokens?: number;
  /** Active session model; used when no explicit compaction model is configured. */
  currentModel?: CompactionModelOption;
  /** Models selectable as the compaction model (`provider/id` references). */
  availableModels?: CompactionModelOption[];
  projectReadonlyReason?: string;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
  theme: CompactionTheme;
  requestRender: () => void;
  done: (result: CompactionSettingsResult) => void;
  saveScope?: (scope: CompactionScope, values: CompactionConfigPatch) => Promise<void>;
}

const SOFT_MECHANISM_KEYS: Record<SoftMechanismItem, "lossless" | "cache" | "timeBased" | "relevance" | "crossTurnDedup"> = {
  softLossless: "lossless",
  softCacheGate: "cache",
  softTimeBased: "timeBased",
  softRelevance: "relevance",
  softDedup: "crossTurnDedup",
};

const MENU_ITEMS: readonly MenuItem[] = [
  "threshold", "enabled", "keepRecentTokens", "softEnabled",
  "softLossless", "softCacheGate", "softTimeBased", "softRelevance", "softDedup",
  "compactModel", "newContext",
];

function isSoftMechanismItem(item: MenuItem): item is SoftMechanismItem {
  return item in SOFT_MECHANISM_KEYS;
}

function itemLabel(item: MenuItem): CatalogKey {
  switch (item) {
    case "threshold": return "item.threshold";
    case "enabled": return "item.enabled";
    case "keepRecentTokens": return "item.keepRecentTokens";
    case "softEnabled": return "item.softEnabled";
    case "softLossless": return "item.softLossless";
    case "softCacheGate": return "item.softCacheGate";
    case "softTimeBased": return "item.softTimeBased";
    case "softRelevance": return "item.softRelevance";
    case "softDedup": return "item.softDedup";
    case "compactModel": return "item.compactModel";
    case "newContext": return "item.newContext";
  }
}

function itemDetailKey(item: MenuItem): CatalogKey {
  return `detail.${item}` as CatalogKey;
}

function shortLabel(item: MenuItem): CatalogKey {
  switch (item) {
    case "threshold": return "item.threshold.short";
    case "enabled": return "item.enabled.short";
    case "softEnabled": return "item.softEnabled.short";
    case "softLossless": return "item.softLossless.short";
    case "softCacheGate": return "item.softCacheGate.short";
    case "softTimeBased": return "item.softTimeBased.short";
    case "softRelevance": return "item.softRelevance.short";
    case "softDedup": return "item.softDedup.short";
    case "compactModel": return "item.compactModel.short";
    case "newContext": return "item.newContext.short";
    case "keepRecentTokens": return "item.keepRecentTokens.short";
  }
}

const MODEL_PICKER_MAX_VISIBLE = 10;

export class CompactionSettingsOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private scope: CompactionScope;
  private selected = 0;
  private editing = false;
  private pickingModel = false;
  private modelCursor = 0;
  private modelQuery = "";
  private editValue = "";
  private confirming = false;
  private saveState: SaveState = "clean";
  private notice = "";
  private discardArmed = false;
  private readonly initialDrafts: Record<CompactionScope, ScopeDraft>;
  private readonly drafts: Record<CompactionScope, ScopeDraft>;

  constructor(private readonly params: CompactionSettingsOverlayParams) {
    this.locale = getTuiLocale(params.locale);
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

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    return translateCompaction(this.locale, key, vars);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    if (this.confirming) return this.renderConfirm(safeWidth);
    if (safeWidth < 20) return [this.renderTiny(safeWidth)];
    if (this.pickingModel) return this.renderModelPicker(safeWidth);
    if (this.editing) return this.renderEditor(safeWidth);
    const inner = safeWidth - 2;
    const rows = [
      headerLine(this.params.theme, this.t("title"), [this.scopeTabs()], inner),
      rule(inner),
      this.params.theme.fg("dim", fit(this.t("menu"), inner)),
      ...MENU_ITEMS.map((item, index) => this.renderMenuItem(item, index === this.selected, inner)),
    ];
    rows.push(rule(inner), ...this.detailRows(inner, safeWidth));
    if (this.params.projectReadonlyReason && this.scope === "project") {
      rows.push(this.params.theme.fg("warning", fit(
        `${this.t("notice.readonlyProject")} · ${this.localizeReadonlyReason(this.params.projectReadonlyReason)}`,
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
      rows.push(this.params.theme.fg(validation.errors.includes(fieldIssue) ? "error" : "warning", fit(
        `${validation.errors.includes(fieldIssue) ? this.t("notice.invalid") : this.t("notice.warn")} · ${this.localizeValidation(fieldIssue)}`,
        inner,
      )));
    }
    if (this.notice) rows.push(this.styledNotice(this.notice, inner));
    rows.push(this.menuFooter(inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.saveState === "saving") return;
    if (this.confirming) {
      if (matchesKey(data, Key.enter) || data === "\r") {
        void this.commitSave();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.confirming = false;
        this.requestRender();
      }
      return;
    }
    if (this.pickingModel) {
      this.handleModelPickerInput(data);
      return;
    }
    if (this.editing) {
      this.handleEditInput(data);
      return;
    }
    if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
      this.openConfirm();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.isDirty() && !this.discardArmed) {
        this.discardArmed = true;
        this.notice = this.t("notice.discardConfirm");
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
        ? `${this.t("notice.readonlyProject")} · ${this.localizeReadonlyReason(this.params.projectReadonlyReason)}`
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
      } else if (item === "newContext") {
        const newContext = this.drafts[this.scope].newContext;
        if (newContext) {
          delete newContext.enabled;
          if (Object.keys(newContext).length === 0) delete this.drafts[this.scope].newContext;
        }
      } else if (isSoftMechanismItem(item)) {
        const key = SOFT_MECHANISM_KEYS[item];
        const soft = this.drafts[this.scope].soft;
        if (soft?.[key]) {
          const group = { ...soft[key] };
          delete group.enabled;
          if (Object.keys(group).length === 0) delete soft[key];
          else soft[key] = group;
        }
        if (soft && Object.keys(soft).length === 0) delete this.drafts[this.scope].soft;
      } else {
        delete this.drafts[this.scope][configFieldForItem(item)];
      }
      this.markDirty();
      return;
    }
    if ((matchesKey(data, Key.space) || data === " ") && this.isToggleItem(this.selectedItem())) {
      if (!this.canEdit()) return;
      this.toggleSelectedItem(this.selectedItem());
      this.markDirty();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (!this.canEdit()) return;
      const item = this.selectedItem();
      if (this.isToggleItem(item)) {
        this.toggleSelectedItem(item);
        this.markDirty();
        return;
      }
      if (item === "compactModel") {
        this.openModelPicker();
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
    const state = this.saveState === "saving" ? this.t("state.saving")
      : this.saveState === "failed" ? `! ${this.notice || this.t("state.failed")}`
      : this.isDirty() ? this.t("state.dirty")
      : this.t("state.ready");
    const prefix = this.editing ? this.t("state.editing") : this.scope === "project" ? this.t("scope.project") : this.t("scope.user");
    const value = this.editing ? this.formattedEditValue() : this.itemValue(item);
    return fit(`${prefix} · ${this.t(shortLabel(item))} ${value} · ${state} · Esc`, width);
  }

  private renderMenuItem(item: MenuItem, selected: boolean, width: number): string {
    const marker = selected ? this.params.theme.fg("accent", "›") : " ";
    const label = selected ? this.params.theme.bold(this.t(itemLabel(item))) : this.t(itemLabel(item));
    return fit(`${marker} ${label} · ${this.itemValue(item)} · ${this.draftSource(item)}`, width);
  }

  private draftSource(item: MenuItem): string {
    if (item === "softEnabled") {
      return this.drafts[this.scope].soft?.enabled === undefined
        ? `${this.t("value.inheritPrefix")}${this.sourceLabel(this.effective().source.soft)}`
        : this.sourceLabel(this.scope);
    }
    if (isSoftMechanismItem(item)) {
      const key = SOFT_MECHANISM_KEYS[item];
      return this.drafts[this.scope].soft?.[key]?.enabled === undefined
        ? `${this.t("value.inheritPrefix")}${this.sourceLabel(this.effective().source.soft)}`
        : this.sourceLabel(this.scope);
    }
    if (item === "newContext") {
      return this.drafts[this.scope].newContext?.enabled === undefined
        ? `${this.t("value.inheritPrefix")}${this.sourceLabel(this.effective().source.newContext)}`
        : this.sourceLabel(this.scope);
    }
    const field = configFieldForItem(item);
    return this.drafts[this.scope][field] === undefined
      ? `${this.t("value.inheritPrefix")}${this.sourceLabel(this.effective().source[field])}`
      : this.sourceLabel(this.scope);
  }

  private renderEditor(width: number): string[] {
    const inner = width - 2;
    const item = this.selectedItem();
    const rows = [
      headerLine(this.params.theme, `${this.t("editor.title")}${this.t(itemLabel(item))}`, [this.scopeLabel(this.scope)], inner),
      rule(inner),
      fit(`${this.t("editor.current")} · ${this.itemValue(item)}`, inner),
      this.params.theme.fg("accent", fit(`› ${this.t("editor.newValue")} · ${this.formattedEditValue()} ${this.t("editor.tokens")}`, inner)),
    ];
    if (item === "threshold") {
      const capacity = this.linkedThreshold();
      const contextWindow = capacity.usable ? capacity.contextWindow : undefined;
      if (contextWindow) {
        const configuredThreshold = Number(this.editValue);
        const reserve = contextWindow - configuredThreshold;
        const validReserve = Number.isSafeInteger(reserve) && reserve > 0;
        rows.push(
          fit(`${this.t("editor.configThreshold")} · ${formatNumber(configuredThreshold)} / ${formatNumber(contextWindow)} ${this.t("editor.tokens")}`, inner),
          fit(
            validReserve
              ? `${this.t("editor.configReserve")} · ${formatNumber(reserve)} ${this.t("editor.tokens")}`
              : this.t("editor.reservePositive"),
            inner,
          ),
        );
        if (validReserve) {
          const model = this.linkedThreshold(reserve);
          if (model.usable) {
            const maxTokens = this.thresholdOutputLimit(model, reserve);
            rows.push(
              fit(`${this.t("editor.floor5pct")} · ${formatNumber(model.ratioFloorTokens)} ${this.t("editor.tokens")}`, inner),
              fit(`${this.t("editor.outputLimit")} · ${formatNumber(maxTokens ?? 0)} ${this.t("editor.tokens")} · ${this.t("editor.outputLimitShrink")}`, inner),
              fit(`${this.t("editor.effectiveReserve")} · ${formatNumber(model.effectiveReserveTokens)} ${this.t("editor.tokens")}`, inner),
              this.params.theme.fg("accent", fit(
                `${this.t("editor.hardThreshold")} · ${this.t("editor.exceeds")} ${formatNumber(model.thresholdTokens)} ${this.t("editor.tokens")} (${formatPercent(model.thresholdTokens, contextWindow)})`,
                inner,
              )),
              fit(`${this.t("editor.capacitySource")} · ${this.thresholdLimiterLabel(model)}`, inner),
              fit(`${this.t("editor.effectReason")} · ${this.thresholdReasonLabel(model.reason)}`, inner),
              fit(this.softThresholdSummary(model), inner),
            );
          }
        }
      } else {
        rows.push(this.params.theme.fg("warning", fit(
          this.t("editor.noContext"),
          inner,
        )));
      }
    } else {
      rows.push(fit(this.t(itemDetailKey(item)), inner));
    }
    rows.push(rule(inner));
    if (this.notice) rows.push(this.styledNotice(this.notice, inner));
    rows.push(inner < 30
      ? fit(`${this.t("footer.escEditNarrow")} ${this.t("footer.enterConfirmNarrow")}`, inner)
      : fitSegments(inner, [this.t("footer.escEdit"), this.t("footer.enterConfirm"), this.t("footer.typeDigits"), this.t("footer.backspace")]));
    return frame(rows, width, this.params.theme);
  }

  private handleEditInput(data: string): void {
    const item = this.selectedItem();
    if (item === "enabled" || item === "softEnabled" || item === "newContext") {
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
        this.notice = this.t("notice.enterPositive");
        this.requestRender();
        return;
      }
      const field = this.selectedConfigField();
      if (!field) {
        this.notice = this.t("notice.notEditable");
        this.requestRender();
        return;
      }
      if (item === "threshold") {
        const capacity = this.linkedThreshold();
        const contextWindow = capacity.usable ? capacity.contextWindow : undefined;
        if (contextWindow) {
          const reserveTokens = contextWindow - numeric;
          if (!Number.isSafeInteger(reserveTokens) || reserveTokens <= 0) {
            this.notice = `${this.t("notice.thresholdBelowContext")} ${formatNumber(contextWindow)}`;
            this.requestRender();
            return;
          }
          this.drafts[this.scope].reserveTokens = String(reserveTokens);
        } else {
          this.drafts[this.scope][field] = String(numeric);
        }
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

  private openConfirm(): void {
    if (!this.isDirty()) {
      this.notice = this.t("notice.nothingToSave");
      this.requestRender();
      return;
    }
    const validation = this.validation();
    if (validation.errors.length > 0) {
      this.saveState = "dirty";
      this.notice = `${this.t("notice.cannotSave")} · ${this.localizeValidation(validation.errors[0]!)}`;
      this.requestRender();
      return;
    }
    this.confirming = true;
    this.notice = "";
    this.discardArmed = false;
    this.requestRender();
  }

  private async commitSave(): Promise<void> {
    if (!this.isDirty()) {
      this.notice = this.t("notice.nothingToSave");
      this.requestRender();
      return;
    }
    const validation = this.validation();
    if (validation.errors.length > 0) {
      this.saveState = "dirty";
      this.confirming = false;
      this.notice = `${this.t("notice.cannotSave")} · ${this.localizeValidation(validation.errors[0]!)}`;
      this.requestRender();
      return;
    }
    this.saveState = "saving";
    this.notice = this.t("notice.saving");
    this.requestRender();
    try {
      for (const scope of ["user", "project"] as const) {
        if (!draftEqual(this.drafts[scope], this.initialDrafts[scope])) {
          const save = this.params.saveScope
            ?? ((targetScope: CompactionScope, values: CompactionConfigPatch) =>
              saveCompactionScope(targetScope, this.params.projectRoot, values));
          await save(scope, draftToPatch(this.drafts[scope]));
          this.initialDrafts[scope] = { ...this.drafts[scope] };
        }
      }
      this.saveState = "clean";
      this.confirming = false;
      this.params.done({ saved: true });
    } catch (error) {
      this.saveState = "failed";
      this.confirming = false;
      this.notice = `${this.t("notice.saveFailed")} · ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender();
    }
  }

  private scopeKey(scope: CompactionScope): CatalogKey {
    return scope === "project" ? "confirm.scope.project" : "confirm.scope.user";
  }

  private collectChanges(): string[] {
    const changes: string[] = [];
    const scopes: CompactionScope[] = ["user", "project"];
    for (const scope of scopes) {
      const before = this.initialDrafts[scope];
      const after = this.drafts[scope];
      const scopeTag = this.t(this.scopeKey(scope));
      if (before.enabled !== after.enabled) {
        changes.push(this.t(after.enabled ? "confirm.toggleOn" : "confirm.toggleOff", { scope: scopeTag, field: this.t("item.enabled") }));
      }
      if (before.newContext?.enabled !== after.newContext?.enabled) {
        changes.push(this.t(after.newContext?.enabled ? "confirm.toggleOn" : "confirm.toggleOff", { scope: scopeTag, field: this.t("item.newContext") }));
      }
      const fields: Array<["reserveTokens" | "keepRecentTokens" | "model", MenuItem]> = [
        ["reserveTokens", "threshold"],
        ["keepRecentTokens", "keepRecentTokens"],
        ["model", "compactModel"],
      ];
      for (const [field, item] of fields) {
        if (before[field] !== after[field]) {
          if (after[field] === undefined) {
            changes.push(this.t("confirm.clear", { scope: scopeTag, field: this.t(itemLabel(item)) }));
          } else {
            const value = field === "model" ? (after[field] ?? "") : formatNumber(Number(after[field]));
            changes.push(this.t("confirm.set", { scope: scopeTag, field: this.t(itemLabel(item)), value }));
          }
        }
      }
      for (const change of this.collectSoftChanges(scope, before.soft, after.soft)) changes.push(change);
    }
    return changes;
  }

  private collectSoftChanges(scope: CompactionScope, before: SoftCompactionConfigPatch | undefined, after: SoftCompactionConfigPatch | undefined): string[] {
    const changes: string[] = [];
    const scopeTag = this.t(this.scopeKey(scope));
    const b = before ?? {};
    const a = after ?? {};
    if (b.enabled !== a.enabled) {
      changes.push(this.t(a.enabled ? "confirm.toggleOn" : "confirm.toggleOff", { scope: scopeTag, field: this.t("item.softEnabled") }));
    }
    const mechanisms: Array<["lossless" | "cache" | "timeBased" | "relevance" | "crossTurnDedup", SoftMechanismItem]> = [
      ["lossless", "softLossless"],
      ["cache", "softCacheGate"],
      ["timeBased", "softTimeBased"],
      ["relevance", "softRelevance"],
      ["crossTurnDedup", "softDedup"],
    ];
    for (const [key, item] of mechanisms) {
      const beforeEnabled = b[key]?.enabled;
      const afterEnabled = a[key]?.enabled;
      if (beforeEnabled !== afterEnabled) {
        changes.push(this.t(afterEnabled ? "confirm.toggleOn" : "confirm.toggleOff", { scope: scopeTag, field: this.t(itemLabel(item)) }));
      }
    }
    return changes;
  }

  private renderConfirm(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const changes = this.collectChanges();
    const rows = [
      headerLine(this.params.theme, this.t("confirm.title"), [this.t("confirm.summary", { count: changes.length })], inner),
      rule(inner),
    ];
    if (changes.length === 0) {
      rows.push(this.params.theme.fg("dim", fit(this.t("notice.nothingToSave"), inner)));
    } else {
      for (const change of changes) rows.push(fit(`${this.params.theme.fg("dim", "·")} ${change}`, inner));
    }
    rows.push(rule(inner), fit(this.t("confirm.footer"), inner));
    return frame(rows, width, this.params.theme);
  }

  private effective() {
    return resolveEffectiveCompactionSettings(
      draftToPatch(this.drafts.user),
      draftToPatch(this.drafts.project),
    );
  }

  private validation() {
    const effective = this.effective();
    const capacity = this.linkedThreshold();
    const contextWindow = capacity.usable ? capacity.contextWindow : undefined;
    return validateCompactionPatch(
      effective,
      contextWindow,
      capacity.usable ? this.thresholdOutputLimit(capacity, effective.reserveTokens) : undefined,
    );
  }

  /**
   * Model option the summary request would use: the configured reference when
   * resolvable in the available catalog, otherwise the active session model.
   * `stale` marks a configured reference the catalog cannot resolve.
   */
  private effectiveModelOption(): { option?: CompactionModelOption; stale: boolean } {
    const effective = this.effective();
    if (effective.model) {
      const match = (this.params.availableModels ?? []).find((option) => option.reference === effective.model);
      if (match) return { option: match, stale: false };
      return { option: this.params.currentModel, stale: true };
    }
    return { option: this.params.currentModel, stale: false };
  }

  private linkedThreshold(reserveTokens = this.effective().reserveTokens): LinkedCompactionThresholdModel {
    const effective = this.effective();
    const compactionModel = this.effectiveModelOption().option;
    return deriveLinkedCompactionThreshold({
      reserveTokens,
      sessionContextWindow: this.params.contextWindow,
      sessionMaxTokens: this.params.maxTokens,
      compactionContextWindow: compactionModel?.contextWindow,
      compactionMaxTokens: compactionModel?.maxTokens,
      soft: effective.soft,
    });
  }

  private thresholdOutputLimit(model: LinkedCompactionThresholdModel, reserveTokens: number): number | undefined {
    if (!model.usable || model.limiter === "session") return this.params.maxTokens;
    const compactionModel = this.effectiveModelOption().option;
    return summaryOutputTokenLimit(reserveTokens, compactionModel?.maxTokens);
  }

  private compactModelDetailRows(width: number): string[] {
    const effective = this.effective();
    const rows: string[] = [];
    const { option, stale } = this.effectiveModelOption();
    if (effective.model) {
      rows.push(fit(`${this.t("model.detail.configured")} · ${effective.model} · ${this.t("model.detail.source")}${this.sourceLabel(effective.source.model)}`, width));
      if (stale) {
        rows.push(this.params.theme.fg("warning", fit(
          `${this.t("model.detail.stale")}${option ? ` ${option.reference}` : this.t("model.detail.fallback")}`,
          width,
        )));
      }
    } else {
      rows.push(fit(`${this.t("model.detail.unconfigured")}${option ? ` ${option.reference}` : ""}`, width));
    }
    return rows;
  }

  private itemValue(item: MenuItem): string {
    const effective = this.effective();
    if (item === "enabled") return effective.enabled ? this.t("value.on") : this.t("value.off");
    if (item === "newContext") return effective.newContext.enabled ? this.t("value.on") : this.t("value.off");
    if (item === "softEnabled") return effective.soft.enabled ? this.t("value.on") : this.t("value.off");
    if (isSoftMechanismItem(item)) {
      return effective.soft[SOFT_MECHANISM_KEYS[item]]?.enabled === true ? this.t("value.on") : this.t("value.off");
    }
    if (item === "compactModel") return effective.model ?? this.t("value.followSession");
    if (item === "threshold") {
      const model = this.linkedThreshold();
      return model.usable
        ? this.actualThresholdLabel(model)
        : `${this.t("value.reservePrefix")} ${formatNumber(effective.reserveTokens)} ${this.t("editor.tokens")}`;
    }
    return `${formatNumber(effective.keepRecentTokens)} ${this.t("editor.tokens")}`;
  }

  private editorValue(item: MenuItem): string {
    const effective = this.effective();
    if (item === "threshold") {
      const model = this.linkedThreshold();
      if (model.usable) {
        const threshold = model.contextWindow - effective.reserveTokens;
        return threshold > 0 ? String(threshold) : "";
      }
      return String(effective.reserveTokens);
    }
    if (item === "softEnabled" || item === "newContext") return "";
    if (isSoftMechanismItem(item)) return "";
    return String(effective[configFieldForItem(item)]);
  }

  private formattedEditValue(): string {
    const value = Number(this.editValue);
    return Number.isFinite(value) && this.editValue !== "" ? formatNumber(value) : this.editValue || "∅";
  }

  private detailRows(width: number, safeWidth: number): string[] {
    const item = this.selectedItem();
    const rows = [fit(this.t(itemDetailKey(item)), width)];
    if (item === "compactModel") {
      rows.push(...this.compactModelDetailRows(width));
      return rows;
    }
    if (item !== "threshold") return rows;
    const effective = this.effective();
    const model = this.linkedThreshold();
    if (model.usable) {
      const configuredThreshold = model.contextWindow - model.configuredReserveTokens;
      const maxTokens = this.thresholdOutputLimit(model, effective.reserveTokens);
      rows.push(
        this.params.theme.fg("accent", fit(
          `${this.t("editor.hardThreshold")} · ${this.t("editor.exceeds")} ${formatNumber(model.thresholdTokens)} / ${formatNumber(model.contextWindow)} ${this.t("editor.tokens")} (${formatPercent(model.thresholdTokens, model.contextWindow)})`,
          width,
        )),
        fit(
          `${this.t("editor.configThreshold")} · ${formatNumber(configuredThreshold)} ${this.t("editor.tokens")} (${formatPercent(configuredThreshold, model.contextWindow)}) · ${this.t("editor.configReserve")} ${formatNumber(model.configuredReserveTokens)}`,
          width,
        ),
        fit(
          `${this.t("editor.effectiveReserve")} · ${formatNumber(model.effectiveReserveTokens)} ${this.t("editor.tokens")} · ${this.thresholdReasonLabel(model.reason)}`,
          width,
        ),
        fit(`${this.t("editor.capacitySource")} · ${this.thresholdLimiterLabel(model)}`, width),
        fit(`${this.t("editor.outputLimit")} · ${formatNumber(maxTokens ?? 0)} ${this.t("editor.tokens")} · ${this.t("editor.outputLimitShrink")}`, width),
      );
      if (safeWidth >= 40) rows.push(fit(this.pressurePreview(model), width));
    } else {
      rows.push(this.params.theme.fg("warning", fit(this.t("editor.noContextDetail"), width)));
    }
    return rows;
  }

  private pressurePreview(model: CompactionThresholdDerivation): string {
    return this.softThresholdSummary(model);
  }

  private styledNotice(notice: string, width: number): string {
    const role = notice.startsWith("!") || notice.startsWith("×") ? "error"
      : notice.startsWith("✓") ? "success"
      : "warning";
    return this.params.theme.fg(role, fit(notice, width));
  }

  private scopeTabs(): string {
    return `${this.scope === "project" ? `[${this.t("scope.project")}]` : this.t("scope.project")}  ${this.scope === "user" ? `[${this.t("scope.user")}]` : this.t("scope.user")}`;
  }

  private canEdit(): boolean {
    if (this.scope !== "project" || !this.params.projectReadonlyReason) return true;
    this.notice = `${this.t("notice.readonlyProject")} · ${this.localizeReadonlyReason(this.params.projectReadonlyReason)}`;
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

  private selectedConfigField(): EditableCompactionField | undefined {
    const item = this.selectedItem();
    if (item === "enabled" || item === "newContext" || item === "softEnabled" || isSoftMechanismItem(item)) return undefined;
    return configFieldForItem(item) as EditableCompactionField;
  }

  private isToggleItem(item: MenuItem): boolean {
    return item === "enabled" || item === "newContext" || item === "softEnabled" || isSoftMechanismItem(item);
  }

  private toggleSelectedItem(item: MenuItem): void {
    if (item === "newContext") {
      const current = this.drafts[this.scope].newContext ?? {};
      this.drafts[this.scope].newContext = { ...current, enabled: !this.effective().newContext.enabled };
    } else if (item === "softEnabled") {
      const current = this.drafts[this.scope].soft ?? {};
      this.drafts[this.scope].soft = { ...current, enabled: !this.effective().soft.enabled };
    } else if (isSoftMechanismItem(item)) {
      const key = SOFT_MECHANISM_KEYS[item];
      const current = this.drafts[this.scope].soft ?? {};
      const group = { ...(current[key] ?? {}) };
      group.enabled = !(this.effective().soft[key]?.enabled === true);
      this.drafts[this.scope].soft = { ...current, [key]: group };
    } else {
      this.drafts[this.scope].enabled = !this.effective().enabled;
    }
  }

  private openModelPicker(): void {
    const effectiveModel = this.effective().model;
    this.modelQuery = "";
    const options = this.modelPickerOptions();
    const index = options.findIndex((option) => option.reference === effectiveModel);
    this.modelCursor = index >= 0 ? index : 0;
    this.pickingModel = true;
    this.notice = "";
    this.requestRender();
  }

  /** First entry inherits the session model (undefined reference). */
  private modelPickerOptions(): CompactionModelOption[] {
    return [
      { reference: "" },
      ...(this.params.availableModels ?? []),
    ];
  }

  /** Filtered + prefix-first ranked options for the picker. The inherit entry always stays. */
  private filteredModelPickerOptions(): CompactionModelOption[] {
    const options = this.modelPickerOptions();
    const query = this.modelQuery.trim().toLowerCase();
    if (!query) return options;
    const [inherit, ...rest] = options;
    const matches = rest.filter((option) => option.reference.toLowerCase().includes(query));
    const ranked = [...matches].sort((a, b) => {
      const aPrefix = a.reference.toLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.reference.toLowerCase().startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix;
    });
    return inherit ? [inherit, ...ranked] : ranked;
  }

  private renderModelPicker(width: number): string[] {
    const inner = width - 2;
    const options = this.filteredModelPickerOptions();
    const effectiveModel = this.effective().model;
    const start = visibleStart(this.modelCursor, options.length, MODEL_PICKER_MAX_VISIBLE);
    const visible = options.slice(start, start + MODEL_PICKER_MAX_VISIBLE);
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = this.modelQuery
      ? `${this.modelQuery}${marker}`
      : `${marker}${this.params.theme.fg("dim", this.t("filter.hint"))}`;
    const rows = [
      headerLine(this.params.theme, this.t("picker.title"), [this.scopeLabel(this.scope)], inner),
      rule(inner),
      fit(`${this.params.theme.fg("accent", "›")} ${queryText}`, inner),
      rule(inner),
      ...visible.map((option, index) => {
        const absolute = start + index;
        const marker = absolute === this.modelCursor ? this.params.theme.fg("accent", "›") : " ";
        const current = absolute === 0
          ? !effectiveModel ? this.params.theme.fg("success", "✓") : " "
          : option.reference === effectiveModel ? this.params.theme.fg("success", "✓") : " ";
        const label = absolute === 0
          ? `${this.t("value.inherit")}${this.params.currentModel ? `（${this.t("picker.current")} ${this.params.currentModel.reference}）` : ""}`
          : option.reference;
        const boldLabel = absolute === this.modelCursor ? this.params.theme.bold(label) : label;
        return fit(`${marker} ${current} ${boldLabel}`, inner);
      }),
    ];
    if (options.length > MODEL_PICKER_MAX_VISIBLE) {
      rows.push(this.params.theme.fg("dim", fit(`… ${options.length} ${this.t("picker.models")} · ${start + 1}-${Math.min(start + MODEL_PICKER_MAX_VISIBLE, options.length)}`, inner)));
    }
    rows.push(rule(inner));
    if (this.notice) rows.push(this.styledNotice(this.notice, inner));
    rows.push(inner < 30
      ? fit(`${this.t("footer.escEditNarrow")} ${this.t("footer.enterChooseNarrow")}`, inner)
      : fitSegments(inner, [this.t("footer.escEdit"), this.t("footer.enterChoose"), this.t("footer.move")]));
    return frame(rows, width, this.params.theme);
  }

  private handleModelPickerInput(data: string): void {
    const options = this.filteredModelPickerOptions();
    if (matchesKey(data, Key.escape)) {
      if (this.modelQuery) {
        this.modelQuery = "";
        this.modelCursor = 0;
        this.requestRender();
        return;
      }
      this.pickingModel = false;
      this.notice = "";
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.modelQuery = this.modelQuery.slice(0, -1);
      this.modelCursor = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.modelCursor = (this.modelCursor - 1 + options.length) % options.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.modelCursor = (this.modelCursor + 1) % options.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (!this.canEdit()) return;
      const option = options[this.modelCursor];
      if (option && option.reference) {
        this.drafts[this.scope].model = option.reference;
      } else {
        delete this.drafts[this.scope].model;
      }
      this.pickingModel = false;
      this.markDirty();
      return;
    }
    const printable = sanitizeSingleLineInput(data);
    if (printable) {
      this.modelQuery += printable;
      this.modelCursor = 0;
      this.requestRender();
    }
  }

  private menuFooterSegments(): string[] {
    const item = this.selectedItem();
    return [
      this.t("footer.close"),
      ...(this.isDirty() ? [this.t("footer.save")] : []),
      `Enter ${this.isToggleItem(item) ? this.t("footer.toggle") : item === "compactModel" ? this.t("footer.choose") : this.t("footer.edit")}`,
      this.t("footer.navigate"),
      this.t("footer.scope"),
      ...(this.isToggleItem(item) ? [this.t("footer.space")] : []),
      this.t("footer.inherit"),
    ];
  }

  private menuFooter(width: number): string {
    if (width < 30) {
      const item = this.selectedItem();
      const footer = this.isDirty()
        ? `${this.t("footer.closeNarrow")} ${this.t("footer.saveNarrow")}`
        : `${this.t("footer.closeNarrow")} Enter${this.isToggleItem(item) ? this.t("footer.toggle") : item === "compactModel" ? this.t("footer.choose") : this.t("footer.edit")}`;
      return fit(footer, width);
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

  private actualThresholdLabel(model: CompactionThresholdDerivation): string {
    return `${this.t("threshold.actual")} >${formatNumber(model.thresholdTokens)} / ${formatNumber(model.contextWindow)} (${formatPercent(model.thresholdTokens, model.contextWindow)})`;
  }

  private thresholdLimiterLabel(model: LinkedCompactionThresholdModel): string {
    return model.limiter === "compaction"
      ? this.t("threshold.limiter.compaction")
      : this.t("threshold.limiter.session");
  }

  private thresholdReasonLabel(reason: CompactionThresholdReason): string {
    if (reason === "configured") return this.t("threshold.reason.configured");
    if (reason === "ratio-floor") return this.t("threshold.reason.ratioFloor");
    if (reason === "max-output") return this.t("threshold.reason.maxOutput");
    if (reason === "self-hosted") return this.t("threshold.reason.selfHosted");
    return this.t("threshold.reason.capped");
  }

  private softThresholdSummary(model: CompactionThresholdDerivation): string {
    if (!model.soft) return this.t("soft.summary.unconfigured");
    const nudge = `${this.t("soft.summary.nudge")} ${formatNumber(model.soft.nudgeTokens)} (${formatPercent(model.soft.nudgeTokens, model.contextWindow)})`;
    const prune = `${this.t("soft.summary.prune")} ${formatNumber(model.soft.pruneTokens)} (${formatPercent(model.soft.pruneTokens, model.contextWindow)})`;
    const nudgeState = model.soft.nudgeReachable ? this.t("soft.summary.reachable") : this.t("soft.summary.unreachable");
    const pruneState = model.soft.pruneReachable ? this.t("soft.summary.reachable") : this.t("soft.summary.unreachable");
    const warning = !model.soft.nudgeReachable || !model.soft.pruneReachable ? ` · ${this.t("soft.summary.hardFirst")}` : "";
    return `${this.t("soft.summary.warn")} · ${nudge} ${nudgeState} · ${prune} ${pruneState}${warning}`;
  }

  private sourceLabel(source: CompactionScope | "default"): string {
    if (source === "project") return this.t("source.project");
    if (source === "user") return this.t("source.user");
    return this.t("source.default");
  }

  private scopeLabel(scope: CompactionScope): string {
    return scope === "project" ? this.t("scope.projectConfig") : this.t("scope.userConfig");
  }

  private localizeReadonlyReason(reason: string): string {
    return reason === "workspace is not writable" ? this.t("notice.readonlyReason.writable") : reason;
  }

  private localizeValidation(message: string): string {
    const values = [...message.matchAll(/\((\d+)\)/g)].map((match) => formatNumber(Number(match[1])));
    if (message.startsWith("reserveTokens") && message.includes("positive safe integer")) {
      return this.t("notice.validation.reservePositive");
    }
    if (message.startsWith("keepRecentTokens") && message.includes("positive safe integer")) {
      return this.t("notice.validation.keepPositive");
    }
    if (message.startsWith("reserveTokens") && message.includes("must be <=")) {
      const ceiling = message.match(/must be <= (\d+)/)?.[1];
      return this.t("notice.validation.reserveCeiling", { value: values[0] ?? "", ceiling: ceiling ? formatNumber(Number(ceiling)) : "" });
    }
    if (message.startsWith("reserveTokens") && message.includes("contextWindow")) {
      return this.t("notice.validation.reserveContext", { value: values[0] ?? "", window: values[1] ?? "" });
    }
    if (message.startsWith("keepRecentTokens") && message.includes("thresholdTokens")) {
      return this.t("notice.validation.keepThreshold", { value: values[0] ?? "", threshold: values[1] ?? "" });
    }
    if (message.startsWith("reserveTokens") && message.includes("maxTokens")) {
      return this.t("notice.validation.reserveMaxOutput", { value: values[0] ?? "", max: values[1] ?? "" });
    }
    if (message.startsWith("No model context window")) {
      return this.t("notice.validation.noContext");
    }
    return message;
  }

  private requestRender(): void {
    this.params.requestRender();
  }
}

export function registerCompactionSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("maestro-compaction", {
    description: translateCompaction(getTuiLocale(), "command.description"),
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify(translateCompaction(getTuiLocale(), "command.needTui"), "error");
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
  locale?: SupportedSettingsLocale,
): Promise<CompactionSettingsResult> {
  const snapshot = readCompactionSettings(ctx.cwd);
  const projectReadonlyReason = await projectWriteRestriction(ctx.cwd);
  const toOption = (model: { provider: string; id: string; contextWindow?: number; maxTokens?: number }): CompactionModelOption => ({
    reference: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
  const availableModels = ctx.modelRegistry.getAvailable().map(toOption);
  const currentModel = ctx.model ? toOption(ctx.model) : undefined;
  return ctx.ui.custom<CompactionSettingsResult>((tui, theme, _keybindings, done) =>
    new CompactionSettingsOverlay({
      projectRoot: ctx.cwd,
      snapshot,
      contextWindow: ctx.model?.contextWindow,
      maxTokens: ctx.model?.maxTokens,
      currentModel,
      availableModels,
      projectReadonlyReason,
      locale,
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
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.newContext !== undefined ? { newContext: { ...patch.newContext } } : {}),
    ...(patch.soft !== undefined ? { soft: { ...patch.soft } } : {}),
  };
}

function draftToPatch(draft: ScopeDraft): CompactionConfigPatch {
  return {
    ...(draft.enabled !== undefined ? { enabled: draft.enabled } : {}),
    ...(draft.reserveTokens !== undefined ? { reserveTokens: Number(draft.reserveTokens) } : {}),
    ...(draft.keepRecentTokens !== undefined ? { keepRecentTokens: Number(draft.keepRecentTokens) } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.newContext !== undefined ? { newContext: { ...draft.newContext } } : {}),
    ...(draft.soft !== undefined ? { soft: { ...draft.soft } } : {}),
  };
}

function draftEqual(left: ScopeDraft, right: ScopeDraft): boolean {
  return COMPACTION_FIELDS.filter((field) => field !== "newContext").every((field) => left[field] === right[field])
    && newContextDraftEqual(left.newContext, right.newContext)
    && softDraftEqual(left.soft, right.soft);
}

function newContextDraftEqual(left?: { enabled?: boolean }, right?: { enabled?: boolean }): boolean {
  return left?.enabled === right?.enabled;
}

function softDraftEqual(left?: SoftCompactionConfigPatch, right?: SoftCompactionConfigPatch): boolean {
  const l = left ?? {};
  const r = right ?? {};
  if (l.enabled !== r.enabled) return false;
  if (l.nudgeRatio !== r.nudgeRatio) return false;
  if (l.pruneRatio !== r.pruneRatio) return false;
  if (l.pruneTargetRatio !== r.pruneTargetRatio) return false;
  for (const key of ["lossless", "cache", "timeBased", "relevance", "crossTurnDedup"] as const) {
    if (l[key]?.enabled !== r[key]?.enabled) return false;
    const leftMode = (l[key] as { mode?: string } | undefined)?.mode;
    const rightMode = (r[key] as { mode?: string } | undefined)?.mode;
    if (leftMode !== rightMode) return false;
  }
  return true;
}

function formatPercent(tokens: number, contextWindow: number): string {
  return `${(tokens / contextWindow * 100).toFixed(1)}%`;
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.max(0, Math.min(Math.max(0, length - maxVisible), selected - Math.floor(maxVisible / 2)));
}

function configFieldForItem(item: ConfigFieldItem): CompactionField {
  if (item === "threshold") return "reserveTokens";
  if (item === "compactModel") return "model";
  return item;
}

function formatNumber(value: number): string {
  return value.toLocaleString(getTuiLocale());
}

function fitSegments(width: number, segments: readonly string[]): string {
  let line = "";
  for (const segment of segments) {
    const next = line ? `${line} · ${segment}` : segment;
    if (visibleWidth(next) > width) break;
    line = next;
  }
  return fit(line || segments[0] || "", width);
}
