import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { HookLevel } from "maestro-flow/dist/src/commands/hooks.js";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "../tui/locale.ts";
import { sanitizeHookDisplayText } from "./review.ts";
import {
  MAESTRO_HOOK_LEVELS,
  hooksForPreset,
  type MaestroHookDefinition,
  type MaestroHookInstallerSnapshot,
} from "./installer-store.ts";

export type MaestroHookInstallerActionKind = "close" | "apply" | "uninstall";

export interface MaestroHookInstallerUiState {
  query: string;
  selectedName?: string;
  selectedNames: string[];
  basePreset: HookLevel;
  custom: boolean;
}

export interface MaestroHookInstallerAction {
  kind: MaestroHookInstallerActionKind;
  uiState: MaestroHookInstallerUiState;
}

interface InstallerTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface MaestroHookInstallerOverlayParams {
  snapshot: MaestroHookInstallerSnapshot;
  theme: InstallerTheme;
  notice?: string;
  initialState?: Partial<MaestroHookInstallerUiState>;
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
  requestRender: () => void;
  done: (action: MaestroHookInstallerAction) => void;
}

const MAX_VISIBLE = 13;

const CATALOGS = {
  en: {
    "title": "Maestro Flow Hooks Installer",
    "preset.custom": "custom",
    "preset.line": "Presets: 1 None · 2 Minimal · 3 Standard · 4 Full",
    "detail.workspace": "requires a Maestro workspace",
    "detail.advisory": "△ Advisory only in Pi · tool permissions remain controlled by the permission controller",
    "detail.thirdParty": "Preserving {count} non-Maestro Hooks",
    "notice.discard": "△ Unapplied changes · press Esc again to discard",
    "footer": "Esc close · ↑↓ select · / filter · Space toggle · A apply · U uninstall",
    "compact.selected": "selected",
    "compact.unselected": "not selected",
    "compact.prefix": "Esc · Hooks installer · {state} · {name}",
    "compact.empty": "Esc · Hooks installer · no matches",
    "entry.empty": "○ No matching Maestro Hooks",
    "entry.selected": "● Select",
    "entry.skipped": "○ Skip",
    "entry.installed": "installed",
    "filter.active": "Filtering: {query} · Esc cancel",
    "filter.placeholder": "type a name, event, or level",
    "filter.inactive": "Filter: press / and type keywords",
    "filter.count": "showing {count}",
  },
  "zh-CN": {
    "title": "Maestro Flow Hooks 安装",
    "preset.custom": "自定义",
    "preset.line": "预设：1 None · 2 Minimal · 3 Standard · 4 Full",
    "detail.workspace": "需要 Maestro workspace",
    "detail.advisory": "△ Pi 中仅 advisory · 工具权限仍由 permission controller 决定",
    "detail.thirdParty": "保留 {count} 个非 Maestro Hook",
    "notice.discard": "△ 有未应用修改 · 再按一次 Esc 放弃",
    "footer": "Esc 关闭 · ↑↓ 选择 · / 筛选 · Space 切换 · A 应用 · U 卸载",
    "compact.selected": "选",
    "compact.unselected": "未选",
    "compact.prefix": "Esc · Hooks 安装 · {state} · {name}",
    "compact.empty": "Esc · Hooks 安装 · 没有匹配项",
    "entry.empty": "○ 没有匹配的 Maestro Hook",
    "entry.selected": "● 选择",
    "entry.skipped": "○ 跳过",
    "entry.installed": "已安装",
    "filter.active": "筛选中：{query} · Esc 取消",
    "filter.placeholder": "输入名称、事件或级别",
    "filter.inactive": "筛选：按 / 输入关键词",
    "filter.count": "显示 {count} 个",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

export class MaestroHookInstallerOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private query: string;
  private selected = 0;
  private selectedNames: Set<string>;
  private basePreset: HookLevel;
  private custom: boolean;
  private filterActive = false;
  private discardArmed = false;

  constructor(private readonly params: MaestroHookInstallerOverlayParams) {
    this.locale = getTuiLocale(params.locale);
    const initialNames = params.initialState?.selectedNames ?? params.snapshot.suggestedNames;
    this.query = params.initialState?.query ?? "";
    this.selectedNames = new Set(initialNames);
    this.basePreset = params.initialState?.basePreset
      ?? (params.snapshot.installedNames.length === 0
        ? "standard"
        : params.snapshot.installedPreset === "custom" ? "standard" : params.snapshot.installedPreset);
    this.custom = params.initialState?.custom ?? params.snapshot.installedPreset === "custom";
    const selectedName = params.initialState?.selectedName;
    if (selectedName) {
      const index = this.filteredDefinitions().findIndex((definition) => definition.name === selectedName);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  private text(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const template = CATALOGS[this.locale]?.[key] ?? CATALOGS.en[key];
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    const definitions = this.filteredDefinitions();
    this.selected = clampIndex(this.selected, definitions.length);
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];

    const inner = safeWidth - 2;
    const installed = new Set(this.params.snapshot.installedNames);
    const preset = this.custom ? `${this.basePreset} · ${this.text("preset.custom")}` : this.basePreset;
    const rows = [
      fitLine(`${this.params.theme.bold(this.text("title"))} · ${preset} · ${this.selectedNames.size}/${this.params.snapshot.definitions.length}`, inner),
      this.params.theme.fg("dim", fitLine(this.text("preset.line"), inner)),
      rule(inner),
      ...this.definitionRows(definitions, installed, inner),
      this.filterLine(inner, definitions.length),
    ];
    const selected = this.selectedDefinition();
    if (selected) {
      rows.push(rule(inner));
      rows.push(this.params.theme.fg("dim", fitLine(
        `${selected.event}${selected.matcher ? ` [${selected.matcher}]` : ""} · ${selected.level}${selected.requiresWorkspace ? ` · ${this.text("detail.workspace")}` : ""}`,
        inner,
      )));
      rows.push(fitLine(`maestro hooks run ${selected.name}`, inner));
      if (selected.permissionAdvisory) {
        rows.push(this.params.theme.fg("warning", fitLine(this.text("detail.advisory"), inner)));
      }
    }
    if (this.params.snapshot.thirdPartyHandlers > 0) {
      rows.push(this.params.theme.fg("dim", fitLine(this.text("detail.thirdParty", { count: this.params.snapshot.thirdPartyHandlers }), inner)));
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    if (this.discardArmed) {
      rows.push(this.params.theme.fg("warning", fitLine(this.text("notice.discard"), inner)));
    }
    rows.push(fitLine(this.text("footer"), inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filterActive) {
        this.filterActive = false;
        this.query = "";
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      this.close();
      return;
    }
    if (this.filterActive) {
      if (matchesKey(data, Key.up)) return this.move(-1);
      if (matchesKey(data, Key.down)) return this.move(1);
      if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE);
      if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE);
      if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
        this.query = removeLastGrapheme(this.query);
        this.selected = 0;
        this.params.requestRender();
        return;
      }
      // 忽略导航/功能键，避免转义序列残渣混入筛选文本。
      if (data.startsWith("\x1b")) return;
      const printable = sanitizeSingleLineInput(data);
      if (!printable) return;
      this.query += printable;
      this.selected = 0;
      this.params.requestRender();
      return;
    }

    if (data === "/") {
      this.filterActive = true;
      this.params.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.pageUp)) return this.move(-MAX_VISIBLE);
    if (matchesKey(data, Key.pageDown)) return this.move(MAX_VISIBLE);
    if (matchesKey(data, Key.space) || data === " ") return this.toggleSelected();
    if (data === "a" || data === "A") return this.finish("apply");
    if (data === "u" || data === "U") return this.finish("uninstall");
    if (data === "q" || data === "Q") return this.close();
    const presetIndex = Number(data) - 1;
    if (Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < MAESTRO_HOOK_LEVELS.length) {
      this.applyPreset(MAESTRO_HOOK_LEVELS[presetIndex]);
    }
  }

  private renderCompact(width: number): string {
    const selected = this.selectedDefinition() ?? this.filteredDefinitions()[0];
    const text = selected
      ? this.text("compact.prefix", {
          state: this.text(this.selectedNames.has(selected.name) ? "compact.selected" : "compact.unselected"),
          name: selected.name,
        })
      : this.text("compact.empty");
    return fitLine(text, width);
  }

  private definitionRows(
    definitions: readonly MaestroHookDefinition[],
    installed: ReadonlySet<string>,
    width: number,
  ): string[] {
    if (definitions.length === 0) return [this.params.theme.fg("warning", fitLine(this.text("entry.empty"), width))];
    const start = visibleStart(this.selected, definitions.length, MAX_VISIBLE);
    return definitions.slice(start, start + MAX_VISIBLE).map((definition, offset) => {
      const isSelected = start + offset === this.selected;
      const cursor = isSelected ? this.params.theme.fg("accent", "›") : " ";
      const checked = this.selectedNames.has(definition.name);
      const state = checked
        ? this.params.theme.fg("success", this.text("entry.selected"))
        : this.params.theme.fg("dim", this.text("entry.skipped"));
      const name = isSelected ? this.params.theme.bold(definition.name) : definition.name;
      return fitLine(
        `${cursor} ${state} · ${name} · ${definition.event} · ${definition.level}${installed.has(definition.name) ? ` · ${this.text("entry.installed")}` : ""}`,
        width,
      );
    });
  }

  private filterLine(width: number, count: number): string {
    const text = this.filterActive
      ? this.text("filter.active", { query: this.query || this.text("filter.placeholder") })
      : this.text("filter.inactive");
    return this.params.theme.fg("dim", fitLine(`${text} · ${this.text("filter.count", { count })}`, width));
  }

  private styledNotice(notice: string, width: number): string {
    const safeNotice = sanitizeHookDisplayText(notice);
    const role = /(失败|错误|failed|error)/i.test(safeNotice) ? "error"
      : /^(已安装|已卸载|已保存|Installed|Uninstalled|Saved)/i.test(safeNotice) ? "success"
      : "warning";
    return this.params.theme.fg(role, fitLine(safeNotice, width));
  }

  private toggleSelected(): void {
    const selected = this.selectedDefinition();
    if (!selected) return;
    if (this.selectedNames.has(selected.name)) this.selectedNames.delete(selected.name);
    else this.selectedNames.add(selected.name);
    this.custom = true;
    this.discardArmed = false;
    this.params.requestRender();
  }

  private applyPreset(level: HookLevel): void {
    this.basePreset = level;
    this.selectedNames = new Set(hooksForPreset(level));
    this.custom = false;
    this.discardArmed = false;
    this.params.requestRender();
  }

  private move(delta: number): void {
    this.selected = wrapIndex(this.selected + delta, this.filteredDefinitions().length);
    this.discardArmed = false;
    this.params.requestRender();
  }

  private close(): void {
    if (this.isDirty() && !this.discardArmed) {
      this.discardArmed = true;
      this.params.requestRender();
      return;
    }
    this.finish("close");
  }

  private isDirty(): boolean {
    const installed = new Set(this.params.snapshot.installedNames);
    return installed.size !== this.selectedNames.size || [...installed].some((name) => !this.selectedNames.has(name));
  }

  private filteredDefinitions(): MaestroHookDefinition[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [...this.params.snapshot.definitions];
    return this.params.snapshot.definitions.filter((definition) => {
      const haystack = [definition.name, definition.event, definition.matcher ?? "", definition.level]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  private selectedDefinition(): MaestroHookDefinition | undefined {
    return this.filteredDefinitions()[this.selected];
  }

  private finish(kind: MaestroHookInstallerActionKind): void {
    const selected = this.selectedDefinition();
    this.params.done({
      kind,
      uiState: {
        query: this.query,
        ...(selected ? { selectedName: selected.name } : {}),
        selectedNames: [...this.selectedNames],
        basePreset: this.basePreset,
        custom: this.custom,
      },
    });
  }
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index % length + length) % length;
}

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function removeLastGrapheme(value: string): string {
  const segments = graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : [...value];
  segments.pop();
  return segments.join("");
}

function sanitizeSingleLineInput(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\r\n\t\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme: InstallerTheme): string[] {
  if (width < 2) return rows.map((row) => fitLine(row, width));
  const inner = width - 2;
  return [
    theme.fg("dim", `┌${"─".repeat(inner)}┐`),
    ...rows.map((row) => {
      const fitted = fitLine(row, inner);
      return `${theme.fg("dim", "│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${theme.fg("dim", "│")}`;
    }),
    theme.fg("dim", `└${"─".repeat(inner)}┘`),
  ];
}
