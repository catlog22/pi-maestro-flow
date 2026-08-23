import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  pad,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
import { getTuiLocale } from "./locale.ts";
import type {
  ModelCircuitBreaker,
  ModelCircuitSnapshot,
} from "pi-maestro-teammate/v1/retry";
import {
  loadModelFailoverConfig,
  saveProjectModelFailoverConfig,
  type ModelFailoverConfig,
} from "../providers/model-failover.ts";

type Pane = "primary" | "fallback" | "default";
type SaveState = "clean" | "dirty" | "saving" | "failed";
type Mode = "edit" | "confirming";

interface FailoverTheme extends FrameTheme {}

const CATALOGS = {
  en: {
    "title": "Model Failover Settings",
    "state.enabled": "● Enabled",
    "state.disabled": "○ Disabled",
    "pane.primary": "Primary model",
    "pane.fallback": "Fallback priority",
    "pane.default": "Default priority",
    "empty.primary": "No matching models",
    "empty.fallback": "No available fallback models",
    "empty.default": "No default fallback models",
    "detail.source": "Source",
    "detail.noPrimary": "None",
    "detail.unobserved": "Unobserved",
    "detail.failures": "failures",
    "detail.fallbackCount": "{count} fallbacks",
    "detail.defaultCount": "{count} defaults",
    "detail.defaultHint": "used when a model has no per-model chain",
    "footer.main": "Esc close · E toggle · Tab/←→ panes · ↑↓ select · Space add/remove · Ctrl+↑↓ reorder · Ctrl+S save · {filter}",
    "filter.active": "filter {query} · Esc cancel",
    "filter.hint": "/ filter",
    "compact.noModel": "No model",
    "compact.on": "on",
    "compact.off": "off",
    "compact.primary": "Primary",
    "compact.fallback": "Fallback",
    "compact.default": "Default",
    "compact.fuse": "Esc · fuse",
    "notice.discardConfirm": "Uncommitted changes · press Esc again to discard",
    "notice.nothingToSave": "No changes to save",
    "notice.saving": "Saving…",
    "notice.saved": "Saved project model failover configuration",
    "notice.saveFailed": "Save failed: {message}",
    "notice.dirty": "Uncommitted changes",
    "confirm.title": "Confirm save",
    "confirm.summary": "{count} change(s)",
    "confirm.enabledOn": "Enable failover",
    "confirm.enabledOff": "Disable failover",
    "confirm.chain": "{primary} → {chain}",
    "confirm.chainAdd": "{primary} → +{model}",
    "confirm.chainRemove": "{primary} → -{model}",
    "confirm.chainReorder": "{primary} → reordered",
    "confirm.defaultChain": "default → {chain}",
    "confirm.defaultAdd": "default → +{model}",
    "confirm.defaultRemove": "default → -{model}",
    "confirm.defaultReorder": "default → reordered",
    "confirm.footer": "Enter confirm save · Esc back",
    "saveLabel.saving": "Saving…",
    "saveLabel.failed": "Save failed",
    "saveLabel.dirty": "Uncommitted changes",
    "saveLabel.clean": "Synced",
  },
  "zh-CN": {
    "title": "模型故障转移",
    "state.enabled": "● 已启用",
    "state.disabled": "○ 已停用",
    "pane.primary": "主模型",
    "pane.fallback": "Fallback 优先级",
    "pane.default": "默认优先级",
    "empty.primary": "没有匹配的模型",
    "empty.fallback": "没有可用 fallback 模型",
    "empty.default": "没有默认回退模型",
    "detail.source": "源",
    "detail.noPrimary": "无",
    "detail.unobserved": "未观测",
    "detail.failures": "failures",
    "detail.fallbackCount": "{count} 个 fallback",
    "detail.defaultCount": "{count} 个默认",
    "detail.defaultHint": "模型无专属链时采用",
    "footer.main": "Esc 关闭 · E 启停 · Tab/←→ 分栏 · ↑↓ 选择 · Space 增删 · Ctrl+↑↓ 排序 · Ctrl+S 保存 · {filter}",
    "filter.active": "筛选 {query} · Esc 取消",
    "filter.hint": "/ 筛选",
    "compact.noModel": "无模型",
    "compact.on": "开",
    "compact.off": "关",
    "compact.primary": "主",
    "compact.fallback": "备",
    "compact.default": "默",
    "compact.fuse": "Esc · 熔断",
    "notice.discardConfirm": "有未保存修改，再按 Esc 放弃",
    "notice.nothingToSave": "配置未变更",
    "notice.saving": "正在保存",
    "notice.saved": "已保存项目模型故障转移配置",
    "notice.saveFailed": "保存失败：{message}",
    "notice.dirty": "未保存",
    "confirm.title": "确认保存",
    "confirm.summary": "{count} 处变更",
    "confirm.enabledOn": "启用故障转移",
    "confirm.enabledOff": "停用故障转移",
    "confirm.chain": "{primary} → {chain}",
    "confirm.chainAdd": "{primary} → +{model}",
    "confirm.chainRemove": "{primary} → -{model}",
    "confirm.chainReorder": "{primary} → 已重排",
    "confirm.defaultChain": "默认 → {chain}",
    "confirm.defaultAdd": "默认 → +{model}",
    "confirm.defaultRemove": "默认 → -{model}",
    "confirm.defaultReorder": "默认 → 已重排",
    "confirm.footer": "Enter 确认保存 · Esc 返回",
    "saveLabel.saving": "保存中",
    "saveLabel.failed": "保存失败",
    "saveLabel.dirty": "未保存",
    "saveLabel.clean": "已同步",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

export interface ModelFailoverOverlayParams {
  cwd: string;
  models: readonly string[];
  multimodalModels?: readonly string[];
  currentModel?: string;
  config: ModelFailoverConfig;
  health: readonly ModelCircuitSnapshot[];
  theme: FailoverTheme;
  requestRender: () => void;
  done: (saved: boolean) => void;
  saveConfig?: (config: ModelFailoverConfig) => Promise<void> | void;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
}

interface FallbackRow {
  model: string;
  included: boolean;
  priority?: number;
}

interface Change {
  key: string;
  label: string;
}

const MAX_VISIBLE = 10;
/** Minimum width for the three-column wide layout; below this it stacks. */
const WIDE_THRESHOLD = 90;

export class ModelFailoverOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private mode: Mode = "edit";
  private pane: Pane = "primary";
  private primarySelected = 0;
  private fallbackSelected = 0;
  private defaultSelected = 0;
  private query = "";
  private filterActive = false;
  private filterOriginPrimary?: string;
  private filterOriginFallback?: string;
  private filterOriginDefault?: string;
  private saveState: SaveState = "clean";
  private notice = "";
  private discardArmed = false;
  private readonly initial: ModelFailoverConfig;
  private readonly config: ModelFailoverConfig;
  private readonly primaries: string[];
  private readonly health = new Map<string, ModelCircuitSnapshot>();
  private readonly multimodalModels = new Set<string>();

  constructor(private readonly params: ModelFailoverOverlayParams) {
    this.locale = getTuiLocale(params.locale);
    this.config = {
      enabled: params.config.enabled,
      fallbackModels: Object.fromEntries(
        Object.entries(params.config.fallbackModels).map(([model, fallbacks]) => [model, [...fallbacks]]),
      ),
      defaultFallbackModels: [...(params.config.defaultFallbackModels ?? [])],
    };
    this.initial = {
      enabled: this.config.enabled,
      fallbackModels: Object.fromEntries(
        Object.entries(this.config.fallbackModels).map(([model, fallbacks]) => [model, [...fallbacks]]),
      ),
      defaultFallbackModels: [...this.config.defaultFallbackModels],
    };
    this.primaries = [...new Set([
      ...(params.currentModel ? [params.currentModel] : []),
      ...Object.keys(params.config.fallbackModels),
      ...params.models,
    ])];
    for (const entry of params.health) this.health.set(entry.model, entry);
    for (const model of params.multimodalModels ?? []) this.multimodalModels.add(model);
  }

  invalidate(): void {}
  dispose(): void {}

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const catalog = CATALOGS[this.locale] ?? CATALOGS.en;
    const template: unknown = catalog[key];
    const text = typeof template === "string" ? template : CATALOGS.en[key] as string;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    if (this.mode === "confirming") {
      const inner = Math.max(1, safeWidth - 2);
      return safeWidth < 20 ? this.confirmRows(inner) : frame(this.confirmRows(inner), safeWidth, this.params.theme);
    }
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    const inner = safeWidth - 2;
    const enabledState = this.config.enabled
      ? this.params.theme.fg("success", this.t("state.enabled"))
      : this.params.theme.fg("dim", this.t("state.disabled"));
    const rows: string[] = [
      headerLine(this.params.theme, this.t("title"), [enabledState, this.saveLabel()], inner),
      rule(inner),
    ];

    if (safeWidth >= WIDE_THRESHOLD) rows.push(...this.renderWide(inner));
    else rows.push(...this.renderStacked(inner));

    if (this.notice) rows.push(this.params.theme.fg(this.saveState === "failed" ? "error" : "warning", fit(this.notice, inner)));
    rows.push(rule(inner), this.footer(inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.saveState === "saving") return;
    if (this.mode === "confirming") {
      if (matchesKey(data, Key.enter) || data === "\r") {
        void this.commitSave();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.mode = "edit";
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
      this.openConfirm();
      return;
    }
    if (this.filterActive) {
      if (matchesKey(data, Key.escape)) {
        this.exitFilter(false);
        return this.refresh();
      }
      if (matchesKey(data, Key.enter) || data === "\r") {
        this.exitFilter(true);
        return this.refresh();
      }
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
        this.query = removeLast(this.query);
        this.resetActiveSelection();
        return this.refresh();
      }
      const printable = printableText(data);
      if (printable) {
        this.query += printable;
        this.resetActiveSelection();
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.isDirty() && !this.discardArmed) {
        this.discardArmed = true;
        this.notice = this.t("notice.discardConfirm");
        return this.refresh();
      }
      this.params.done(false);
      return;
    }
    if (data === "/") {
      this.filterActive = true;
      this.query = "";
      this.filterOriginPrimary = this.selectedPrimary();
      this.filterOriginFallback = this.filteredFallbackRows()[this.fallbackSelected]?.model;
      this.filterOriginDefault = this.filteredDefaultRows()[this.defaultSelected]?.model;
      return this.refresh();
    }
    if (data === "e" || data === "E") {
      this.config.enabled = !this.config.enabled;
      return this.markDirty();
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.nextPane(this.pane);
      this.notice = "";
      return this.refresh();
    }
    if (matchesKey(data, Key.left)) {
      this.pane = this.prevPane(this.pane);
      this.notice = "";
      return this.refresh();
    }
    if (matchesKey(data, Key.right)) {
      this.pane = this.nextPane(this.pane);
      this.notice = "";
      return this.refresh();
    }
    if (matchesKey(data, Key.ctrl("up"))) return this.reorder(-1);
    if (matchesKey(data, Key.ctrl("down"))) return this.reorder(1);
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE);
    if (matchesKey(data, Key.space) || data === " ") {
      if (this.pane === "fallback") this.toggleFallback();
      else if (this.pane === "default") this.toggleDefault();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (this.pane === "primary") {
        this.pane = "fallback";
        this.fallbackSelected = 0;
        this.refresh();
      } else if (this.pane === "fallback") {
        this.toggleFallback();
      } else {
        this.toggleDefault();
      }
    }
  }

  private nextPane(pane: Pane): Pane {
    if (pane === "primary") return "fallback";
    if (pane === "fallback") return "default";
    return "primary";
  }

  private prevPane(pane: Pane): Pane {
    if (pane === "fallback") return "primary";
    if (pane === "default") return "fallback";
    return "default";
  }

  private renderWide(width: number): string[] {
    const colWidth = Math.max(20, Math.floor((width - 2) / 3));
    const lastWidth = Math.max(20, width - colWidth * 2 - 2);
    const cols = [this.primaryRows(colWidth), this.fallbackRows(colWidth), this.defaultRows(lastWidth)];
    const height = Math.max(...cols.map((col) => col.length));
    const panes: Pane[] = ["primary", "fallback", "default"];
    const headerKeys: CatalogKey[] = ["pane.primary", "pane.fallback", "pane.default"];
    const colWidths = [colWidth, colWidth, lastWidth];
    const rows = [
      headerKeys.map((key, index) => {
        const label = this.pane === panes[index] ? this.params.theme.bold(this.t(key)) : this.t(key);
        return pad(label, colWidths[index]);
      }).join(this.params.theme.fg("dim", "│")),
    ];
    for (let index = 0; index < height; index += 1) {
      rows.push([
        pad(cols[0][index] ?? "", colWidth),
        pad(cols[1][index] ?? "", colWidth),
        pad(cols[2][index] ?? "", lastWidth),
      ].join(this.params.theme.fg("dim", "│")));
    }
    rows.push(...this.detail(width));
    return rows;
  }

  private renderStacked(width: number): string[] {
    const titleMap: Record<Pane, CatalogKey> = {
      primary: "pane.primary",
      fallback: "pane.fallback",
      default: "pane.default",
    };
    const rows = [this.params.theme.bold(this.t(titleMap[this.pane]))];
    if (this.pane === "primary") rows.push(...this.primaryRows(width));
    else if (this.pane === "fallback") rows.push(...this.fallbackRows(width));
    else rows.push(...this.defaultRows(width));
    rows.push(rule(width), ...this.detail(width));
    return rows;
  }

  private primaryRows(width: number): string[] {
    const models = this.filteredPrimaries();
    this.primarySelected = clamp(this.primarySelected, models.length);
    if (models.length === 0) return [this.params.theme.fg("warning", fit(this.t("empty.primary"), width))];
    const start = visibleStart(this.primarySelected, models.length);
    return models.slice(start, start + MAX_VISIBLE).map((model, offset) => {
      const selected = start + offset === this.primarySelected;
      const current = model === this.params.currentModel ? " current" : "";
      return fit(`${selected && this.pane === "primary" ? this.params.theme.fg("accent", "›") : " "} ${selected ? this.params.theme.bold(model) : model}${this.params.theme.fg("dim", current)} ${this.capabilityBadge(model)} ${this.healthBadge(model)}`, width);
    });
  }

  private fallbackRows(width: number): string[] {
    const rows = this.filteredFallbackRows();
    this.fallbackSelected = clamp(this.fallbackSelected, rows.length);
    if (rows.length === 0) return [this.params.theme.fg("warning", fit(this.t("empty.fallback"), width))];
    const start = visibleStart(this.fallbackSelected, rows.length);
    return rows.slice(start, start + MAX_VISIBLE).map((row, offset) => {
      const selected = start + offset === this.fallbackSelected;
      const marker = selected && this.pane === "fallback" ? this.params.theme.fg("accent", "›") : " ";
      const state = row.included
        ? this.params.theme.fg("success", `${row.priority}.`)
        : this.params.theme.fg("dim", "○");
      return fit(`${marker} ${state} ${selected ? this.params.theme.bold(row.model) : row.model} ${this.capabilityBadge(row.model)} ${this.healthBadge(row.model)}`, width);
    });
  }

  private defaultRows(width: number): string[] {
    const rows = this.filteredDefaultRows();
    this.defaultSelected = clamp(this.defaultSelected, rows.length);
    if (rows.length === 0) return [this.params.theme.fg("warning", fit(this.t("empty.default"), width))];
    const start = visibleStart(this.defaultSelected, rows.length);
    return rows.slice(start, start + MAX_VISIBLE).map((row, offset) => {
      const selected = start + offset === this.defaultSelected;
      const marker = selected && this.pane === "default" ? this.params.theme.fg("accent", "›") : " ";
      const state = row.included
        ? this.params.theme.fg("success", `${row.priority}.`)
        : this.params.theme.fg("dim", "○");
      return fit(`${marker} ${state} ${selected ? this.params.theme.bold(row.model) : row.model} ${this.capabilityBadge(row.model)} ${this.healthBadge(row.model)}`, width);
    });
  }

  private detail(width: number): string[] {
    if (this.pane === "default") {
      const count = this.config.defaultFallbackModels.length;
      return [fit(`${this.params.theme.fg("dim", this.t("pane.default"))} · ${this.t("detail.defaultCount", { count })} · ${this.t("detail.defaultHint")}`, width)];
    }
    const primary = this.selectedPrimary();
    const chain = primary ? this.config.fallbackModels[primary] ?? [] : [];
    const health = primary ? this.health.get(primary) : undefined;
    const state = health
      ? `${health.state} · ${this.t("detail.failures")} ${health.consecutiveFailures}`
      : this.t("detail.unobserved");
    return [fit(`${this.params.theme.fg("dim", this.t("detail.source"))} ${primary ?? this.t("detail.noPrimary")} · ${state} · ${this.t("detail.fallbackCount", { count: chain.length })}`, width)];
  }

  private confirmRows(width: number): string[] {
    const changes = this.collectChanges();
    const rows = [
      headerLine(this.params.theme, this.t("confirm.title"), [this.t("confirm.summary", { count: changes.length })], width),
      rule(width),
    ];
    if (changes.length === 0) {
      rows.push(this.params.theme.fg("dim", fit(this.t("notice.nothingToSave"), width)));
    } else {
      for (const change of changes) rows.push(`${this.params.theme.fg("dim", "·")} ${fit(change.label, width - 2)}`);
    }
    rows.push(rule(width), fit(this.t("confirm.footer"), width));
    return rows;
  }

  private footer(width: number): string {
    const filter = this.filterActive
      ? this.t("filter.active", { query: this.query || "…" })
      : this.t("filter.hint");
    return fit(this.t("footer.main", { filter }), width);
  }

  private renderCompact(width: number): string {
    const primary = this.selectedPrimary() ?? this.t("compact.noModel");
    const enabled = this.config.enabled ? this.t("compact.on") : this.t("compact.off");
    const paneLabel = this.pane === "primary"
      ? this.t("compact.primary")
      : this.pane === "fallback"
        ? this.t("compact.fallback")
        : this.t("compact.default");
    const paneValue = this.pane === "default"
      ? `${this.config.defaultFallbackModels.length}`
      : primary;
    return fit(`${this.t("compact.fuse")}${enabled} · ${paneLabel} ${paneValue} · ${this.saveLabel()}`, width);
  }

  private filteredPrimaries(): string[] {
    const query = this.pane === "primary" ? this.query.trim().toLowerCase() : "";
    return query ? rankByFilter(this.primaries, query) : this.primaries;
  }

  private fallbackRowsForPrimary(): FallbackRow[] {
    const primary = this.selectedPrimary();
    if (!primary) return [];
    const chain = this.config.fallbackModels[primary] ?? [];
    const available = this.primaries.filter((model) => model !== primary && !chain.includes(model));
    return [
      ...chain.map((model, index) => ({ model, included: true, priority: index + 1 })),
      ...available.map((model) => ({ model, included: false })),
    ];
  }

  private filteredFallbackRows(): FallbackRow[] {
    const query = this.pane === "fallback" ? this.query.trim().toLowerCase() : "";
    const rows = this.fallbackRowsForPrimary();
    return query ? rankRowsByFilter(rows, query) : rows;
  }

  private defaultRowsAll(): FallbackRow[] {
    const chain = this.config.defaultFallbackModels;
    const available = this.primaries.filter((model) => !chain.includes(model));
    return [
      ...chain.map((model, index) => ({ model, included: true, priority: index + 1 })),
      ...available.map((model) => ({ model, included: false })),
    ];
  }

  private filteredDefaultRows(): FallbackRow[] {
    const query = this.pane === "default" ? this.query.trim().toLowerCase() : "";
    const rows = this.defaultRowsAll();
    return query ? rankRowsByFilter(rows, query) : rows;
  }

  private selectedPrimary(): string | undefined {
    return this.filteredPrimaries()[this.primarySelected];
  }

  private move(delta: number): void {
    if (this.pane === "primary") {
      this.primarySelected = clamp(this.primarySelected + delta, this.filteredPrimaries().length);
      this.fallbackSelected = 0;
    } else if (this.pane === "fallback") {
      this.fallbackSelected = clamp(this.fallbackSelected + delta, this.filteredFallbackRows().length);
    } else {
      this.defaultSelected = clamp(this.defaultSelected + delta, this.filteredDefaultRows().length);
    }
    this.notice = "";
    this.refresh();
  }

  private toggleFallback(): void {
    const primary = this.selectedPrimary();
    const row = this.filteredFallbackRows()[this.fallbackSelected];
    if (!primary || !row) return;
    const chain = [...(this.config.fallbackModels[primary] ?? [])];
    const index = chain.indexOf(row.model);
    if (index >= 0) chain.splice(index, 1);
    else chain.push(row.model);
    this.config.fallbackModels[primary] = chain;
    this.fallbackSelected = clamp(this.fallbackRowsForPrimary().findIndex((item) => item.model === row.model), this.fallbackRowsForPrimary().length);
    this.markDirty();
  }

  private toggleDefault(): void {
    const row = this.filteredDefaultRows()[this.defaultSelected];
    if (!row) return;
    const chain = [...this.config.defaultFallbackModels];
    const index = chain.indexOf(row.model);
    if (index >= 0) chain.splice(index, 1);
    else chain.push(row.model);
    this.config.defaultFallbackModels = chain;
    this.defaultSelected = clamp(this.defaultRowsAll().findIndex((item) => item.model === row.model), this.defaultRowsAll().length);
    this.markDirty();
  }

  private reorder(direction: -1 | 1): void {
    if (this.pane === "fallback") {
      const primary = this.selectedPrimary();
      const row = this.filteredFallbackRows()[this.fallbackSelected];
      if (!primary || !row?.included) return;
      const chain = [...(this.config.fallbackModels[primary] ?? [])];
      const index = chain.indexOf(row.model);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= chain.length) return;
      [chain[index], chain[target]] = [chain[target], chain[index]];
      this.config.fallbackModels[primary] = chain;
      this.query = "";
      this.fallbackSelected = target;
      this.markDirty();
    } else if (this.pane === "default") {
      const row = this.filteredDefaultRows()[this.defaultSelected];
      if (!row?.included) return;
      const chain = [...this.config.defaultFallbackModels];
      const index = chain.indexOf(row.model);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= chain.length) return;
      [chain[index], chain[target]] = [chain[target], chain[index]];
      this.config.defaultFallbackModels = chain;
      this.query = "";
      this.defaultSelected = target;
      this.markDirty();
    }
  }

  private collectChanges(): Change[] {
    const changes: Change[] = [];
    if (this.config.enabled !== this.initial.enabled) {
      changes.push({ key: "enabled", label: this.t(this.config.enabled ? "confirm.enabledOn" : "confirm.enabledOff") });
    }
    const primaryModels = new Set([
      ...Object.keys(this.config.fallbackModels),
      ...Object.keys(this.initial.fallbackModels),
    ]);
    for (const primary of primaryModels) {
      const next = this.config.fallbackModels[primary] ?? [];
      const prev = this.initial.fallbackModels[primary] ?? [];
      const added = next.filter((model) => !prev.includes(model));
      const removed = prev.filter((model) => !next.includes(model));
      const reordered = next.length === prev.length && next.some((model, index) => model !== prev[index]);
      for (const model of added) changes.push({ key: `add:${primary}:${model}`, label: this.t("confirm.chainAdd", { primary, model }) });
      for (const model of removed) changes.push({ key: `remove:${primary}:${model}`, label: this.t("confirm.chainRemove", { primary, model }) });
      if (reordered && added.length === 0 && removed.length === 0) changes.push({ key: `reorder:${primary}`, label: this.t("confirm.chainReorder", { primary }) });
    }
    const defaultNext = this.config.defaultFallbackModels;
    const defaultPrev = this.initial.defaultFallbackModels;
    const defaultAdded = defaultNext.filter((model) => !defaultPrev.includes(model));
    const defaultRemoved = defaultPrev.filter((model) => !defaultNext.includes(model));
    const defaultReordered = defaultNext.length === defaultPrev.length && defaultNext.some((model, index) => model !== defaultPrev[index]);
    for (const model of defaultAdded) changes.push({ key: `dadd:${model}`, label: this.t("confirm.defaultAdd", { model }) });
    for (const model of defaultRemoved) changes.push({ key: `dremove:${model}`, label: this.t("confirm.defaultRemove", { model }) });
    if (defaultReordered && defaultAdded.length === 0 && defaultRemoved.length === 0) changes.push({ key: "dreorder", label: this.t("confirm.defaultReorder") });
    return changes;
  }

  private openConfirm(): void {
    if (!this.isDirty()) {
      this.notice = this.t("notice.nothingToSave");
      return this.refresh();
    }
    this.mode = "confirming";
    this.discardArmed = false;
    this.refresh();
  }

  private async commitSave(): Promise<void> {
    this.saveState = "saving";
    this.notice = this.t("notice.saving");
    this.refresh();
    try {
      await this.params.saveConfig?.({
        enabled: this.config.enabled,
        fallbackModels: Object.fromEntries(Object.entries(this.config.fallbackModels).map(([model, chain]) => [model, [...chain]])),
        defaultFallbackModels: [...this.config.defaultFallbackModels],
      });
      this.saveState = "clean";
      this.mode = "edit";
      this.notice = this.t("notice.saved");
      this.discardArmed = false;
      this.params.done(true);
    } catch (error) {
      this.saveState = "failed";
      this.mode = "edit";
      this.notice = this.t("notice.saveFailed", { message: error instanceof Error ? error.message : String(error) });
      this.refresh();
    }
  }

  private isDirty(): boolean {
    return this.saveState !== "clean";
  }

  private markDirty(): void {
    this.saveState = "dirty";
    this.notice = this.t("notice.dirty");
    this.discardArmed = false;
    this.refresh();
  }

  private saveLabel(): string {
    if (this.saveState === "saving") return this.t("saveLabel.saving");
    if (this.saveState === "failed") return this.t("saveLabel.failed");
    if (this.saveState === "dirty") return this.t("saveLabel.dirty");
    return this.t("saveLabel.clean");
  }

  private capabilityBadge(model: string): string {
    return this.multimodalModels.has(model) ? this.params.theme.fg("accent", "[vision]") : "";
  }

  private healthBadge(model: string): string {
    const health = this.health.get(model);
    if (!health) return "";
    if (health.state === "OPEN") return this.params.theme.fg("error", "OPEN");
    if (health.state === "HALF_OPEN") return this.params.theme.fg("warning", "HALF");
    return this.params.theme.fg("success", "CLOSED");
  }

  private resetActiveSelection(): void {
    if (this.pane === "primary") this.primarySelected = 0;
    else if (this.pane === "fallback") this.fallbackSelected = 0;
    else this.defaultSelected = 0;
  }

  private exitFilter(commit: boolean): void {
    const selectedPrimary = commit ? this.selectedPrimary() ?? this.filterOriginPrimary : this.filterOriginPrimary;
    const selectedFallback = commit
      ? this.filteredFallbackRows()[this.fallbackSelected]?.model ?? this.filterOriginFallback
      : this.filterOriginFallback;
    const selectedDefault = commit
      ? this.filteredDefaultRows()[this.defaultSelected]?.model ?? this.filterOriginDefault
      : this.filterOriginDefault;
    this.filterActive = false;
    this.query = "";
    if (selectedPrimary) {
      const primaryIndex = this.primaries.indexOf(selectedPrimary);
      if (primaryIndex >= 0) this.primarySelected = primaryIndex;
    }
    if (selectedFallback) {
      const fallbackIndex = this.fallbackRowsForPrimary().findIndex((row) => row.model === selectedFallback);
      if (fallbackIndex >= 0) this.fallbackSelected = fallbackIndex;
    }
    if (selectedDefault) {
      const defaultIndex = this.defaultRowsAll().findIndex((row) => row.model === selectedDefault);
      if (defaultIndex >= 0) this.defaultSelected = defaultIndex;
    }
    this.filterOriginPrimary = undefined;
    this.filterOriginFallback = undefined;
    this.filterOriginDefault = undefined;
  }

  private refresh(): void {
    this.params.requestRender();
  }
}

export async function showModelFailoverOverlay(
  ctx: ExtensionContext,
  breaker: ModelCircuitBreaker,
  locale?: SupportedSettingsLocale,
): Promise<boolean> {
  const available = ctx.modelRegistry.getAvailable();
  const models = available.map((model) => `${model.provider}/${model.id}`);
  const multimodalModels = available
    .filter((model) => model.input.includes("image"))
    .map((model) => `${model.provider}/${model.id}`);
  const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => new ModelFailoverOverlay({
    cwd: ctx.cwd,
    models,
    multimodalModels,
    currentModel,
    config: loadModelFailoverConfig(ctx.cwd),
    health: breaker.snapshot(),
    locale,
    theme,
    requestRender: () => tui.requestRender(),
    done,
    saveConfig: (config) => saveProjectModelFailoverConfig(ctx.cwd, config),
  }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" },
  });
}

function printableText(data: string): string {
  if (!data || Array.from(data).some((character) => character < " " || character === "\x7f")) return "";
  return data;
}

function removeLast(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function clamp(index: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(index, length - 1));
}

function visibleStart(selected: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - MAX_VISIBLE), selected - Math.floor(MAX_VISIBLE / 2)));
}

/** Stable sort: prefix matches before infix matches, preserving input order within each group. */
function rankByFilter(models: readonly string[], query: string): string[] {
  const lower = query.toLowerCase();
  const matches = models.filter((model) => model.toLowerCase().includes(lower));
  return [...matches].sort((a, b) => {
    const aPrefix = a.toLowerCase().startsWith(lower) ? 0 : 1;
    const bPrefix = b.toLowerCase().startsWith(lower) ? 0 : 1;
    return aPrefix - bPrefix;
  });
}

function rankRowsByFilter(rows: readonly FallbackRow[], query: string): FallbackRow[] {
  const lower = query.toLowerCase();
  const matches = rows.filter((row) => row.model.toLowerCase().includes(lower));
  return [...matches].sort((a, b) => {
    const aPrefix = a.model.toLowerCase().startsWith(lower) ? 0 : 1;
    const bPrefix = b.model.toLowerCase().startsWith(lower) ? 0 : 1;
    return aPrefix - bPrefix;
  });
}
