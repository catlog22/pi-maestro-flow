import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ModelCircuitBreaker,
  ModelCircuitSnapshot,
} from "pi-maestro-teammate/v1/retry";
import {
  loadModelFailoverConfig,
  saveProjectModelFailoverConfig,
  type ModelFailoverConfig,
} from "../providers/model-failover.ts";

type Pane = "primary" | "fallback";
type SaveState = "clean" | "dirty" | "saving" | "failed";

interface FailoverTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

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
}

interface FallbackRow {
  model: string;
  included: boolean;
  priority?: number;
}

const MAX_VISIBLE = 10;

export class ModelFailoverOverlay implements Component, Focusable {
  focused = false;
  private pane: Pane = "primary";
  private primarySelected = 0;
  private fallbackSelected = 0;
  private query = "";
  private filterActive = false;
  private filterOriginPrimary?: string;
  private filterOriginFallback?: string;
  private saveState: SaveState = "clean";
  private notice = "";
  private discardArmed = false;
  private readonly config: ModelFailoverConfig;
  private readonly primaries: string[];
  private readonly health = new Map<string, ModelCircuitSnapshot>();
  private readonly multimodalModels = new Set<string>();

  constructor(private readonly params: ModelFailoverOverlayParams) {
    this.config = {
      enabled: params.config.enabled,
      fallbackModels: Object.fromEntries(
        Object.entries(params.config.fallbackModels).map(([model, fallbacks]) => [model, [...fallbacks]]),
      ),
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

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];
    const inner = safeWidth - 2;
    const rows: string[] = [
      fit(`${this.params.theme.bold("模型故障转移")} · ${this.config.enabled ? this.params.theme.fg("success", "● 已启用") : this.params.theme.fg("dim", "○ 已停用")} · ${this.saveLabel()}`, inner),
      rule(inner),
    ];

    if (safeWidth >= 80) rows.push(...this.renderWide(inner));
    else rows.push(...this.renderStacked(inner));

    if (this.notice) rows.push(this.params.theme.fg(this.saveState === "failed" ? "error" : "warning", fit(this.notice, inner)));
    rows.push(rule(inner), this.footer(inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.saveState === "saving") return;
    if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
      void this.save();
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
        this.notice = "有未保存修改，再按 Esc 放弃";
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
      return this.refresh();
    }
    if (data === "e" || data === "E") {
      this.config.enabled = !this.config.enabled;
      return this.markDirty();
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "primary" ? "fallback" : "primary";
      this.notice = "";
      return this.refresh();
    }
    if (matchesKey(data, Key.left)) {
      this.pane = "primary";
      this.notice = "";
      return this.refresh();
    }
    if (matchesKey(data, Key.right)) {
      this.pane = "fallback";
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
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (this.pane === "primary") {
        this.pane = "fallback";
        this.fallbackSelected = 0;
        this.refresh();
      } else this.toggleFallback();
    }
  }

  private renderWide(width: number): string[] {
    const leftWidth = Math.max(28, Math.floor(width * 0.45));
    const rightWidth = Math.max(20, width - leftWidth - 1);
    const left = this.primaryRows(leftWidth);
    const right = this.fallbackRows(rightWidth);
    const height = Math.max(left.length, right.length);
    const rows = [
      `${fit(this.pane === "primary" ? this.params.theme.bold("主模型") : "主模型", leftWidth)}${this.params.theme.fg("dim", "│")}${fit(this.pane === "fallback" ? this.params.theme.bold("Fallback 优先级") : "Fallback 优先级", rightWidth)}`,
    ];
    for (let index = 0; index < height; index += 1) {
      rows.push(`${fit(left[index] ?? "", leftWidth)}${this.params.theme.fg("dim", "│")}${fit(right[index] ?? "", rightWidth)}`);
    }
    rows.push(this.detail(width));
    return rows;
  }

  private renderStacked(width: number): string[] {
    const title = this.pane === "primary" ? this.params.theme.bold("主模型") : this.params.theme.bold("Fallback 优先级");
    const rows = [title];
    rows.push(...(this.pane === "primary" ? this.primaryRows(width) : this.fallbackRows(width)));
    rows.push(rule(width), this.detail(width));
    return rows;
  }

  private primaryRows(width: number): string[] {
    const models = this.filteredPrimaries();
    this.primarySelected = clamp(this.primarySelected, models.length);
    if (models.length === 0) return [this.params.theme.fg("warning", fit("没有匹配的模型", width))];
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
    if (rows.length === 0) return [this.params.theme.fg("warning", fit("没有可用 fallback 模型", width))];
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

  private detail(width: number): string {
    const primary = this.selectedPrimary();
    const chain = primary ? this.config.fallbackModels[primary] ?? [] : [];
    const health = primary ? this.health.get(primary) : undefined;
    const state = health ? `${health.state} · failures ${health.consecutiveFailures}` : "未观测";
    return fit(`${this.params.theme.fg("dim", "源")} ${primary ?? "无"} · ${state} · ${chain.length} 个 fallback`, width);
  }

  private footer(width: number): string {
    const filter = this.filterActive ? `筛选 ${this.query || "…"} · Esc 取消` : "/ 筛选";
    return fit(`Esc 关闭 · E 启停 · Tab/←→ 分栏 · ↑↓ 选择 · Space 增删 · Ctrl+↑↓ 排序 · Ctrl+S 保存 · ${filter}`, width);
  }

  private renderCompact(width: number): string {
    const primary = this.selectedPrimary() ?? "无模型";
    const enabled = this.config.enabled ? "开" : "关";
    return fit(`Esc · 熔断${enabled} · ${this.pane === "primary" ? "主" : "备"} ${primary} · ${this.saveLabel()}`, width);
  }

  private filteredPrimaries(): string[] {
    const query = this.pane === "primary" ? this.query.trim().toLowerCase() : "";
    return query ? this.primaries.filter((model) => model.toLowerCase().includes(query)) : this.primaries;
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
    return query ? rows.filter((row) => row.model.toLowerCase().includes(query)) : rows;
  }

  private selectedPrimary(): string | undefined {
    return this.filteredPrimaries()[this.primarySelected];
  }

  private move(delta: number): void {
    if (this.pane === "primary") {
      this.primarySelected = clamp(this.primarySelected + delta, this.filteredPrimaries().length);
      this.fallbackSelected = 0;
    } else {
      this.fallbackSelected = clamp(this.fallbackSelected + delta, this.filteredFallbackRows().length);
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

  private reorder(direction: -1 | 1): void {
    if (this.pane !== "fallback") return;
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
  }

  private async save(): Promise<void> {
    if (!this.isDirty()) {
      this.notice = "配置未变更";
      return this.refresh();
    }
    this.saveState = "saving";
    this.notice = "正在保存";
    this.refresh();
    try {
      await this.params.saveConfig?.({
        enabled: this.config.enabled,
        fallbackModels: Object.fromEntries(Object.entries(this.config.fallbackModels).map(([model, chain]) => [model, [...chain]])),
      });
      this.saveState = "clean";
      this.notice = "已保存项目模型故障转移配置";
      this.discardArmed = false;
      this.params.done(true);
    } catch (error) {
      this.saveState = "failed";
      this.notice = `保存失败：${error instanceof Error ? error.message : String(error)}`;
      this.refresh();
    }
  }

  private isDirty(): boolean {
    return this.saveState !== "clean";
  }

  private markDirty(): void {
    this.saveState = "dirty";
    this.notice = "未保存";
    this.discardArmed = false;
    this.refresh();
  }

  private saveLabel(): string {
    if (this.saveState === "saving") return "保存中";
    if (this.saveState === "failed") return "保存失败";
    if (this.saveState === "dirty") return "未保存";
    return "已同步";
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
    else this.fallbackSelected = 0;
  }

  private exitFilter(commit: boolean): void {
    const selectedPrimary = commit ? this.selectedPrimary() ?? this.filterOriginPrimary : this.filterOriginPrimary;
    const selectedFallback = commit
      ? this.filteredFallbackRows()[this.fallbackSelected]?.model ?? this.filterOriginFallback
      : this.filterOriginFallback;
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
    this.filterOriginPrimary = undefined;
    this.filterOriginFallback = undefined;
  }

  private refresh(): void {
    this.params.requestRender();
  }
}

export async function showModelFailoverOverlay(
  ctx: ExtensionContext,
  breaker: ModelCircuitBreaker,
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

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "", true);
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: string[], width: number, theme: FailoverTheme): string[] {
  if (width < 2) return rows.map((row) => fit(row, width));
  const inner = width - 2;
  const dim = (value: string) => theme.fg("dim", value);
  return [
    dim(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => `${dim("│")}${pad(` ${row}`, inner)}${dim("│")}`),
    dim(`╰${"─".repeat(inner)}╯`),
  ];
}

function pad(value: string, width: number): string {
  const clipped = fit(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
