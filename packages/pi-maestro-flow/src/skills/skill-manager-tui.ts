import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  fit,
  frame,
  headerLine,
  helpLine,
  rule,
  type FrameTheme,
} from "pi-cockpit/src/settings/ui-primitives.ts";
import type { ManagedSkill, ManagedSkillGroup, OptionalSkill } from "./skill-manager-store.ts";

export type SkillManagerActionKind =
  | "close"
  | "toggle-enabled"
  | "toggle-model-invocation"
  | "create-group"
  | "assign-group"
  | "delete-group"
  | "install-optional";

export interface SkillManagerUiState {
  query: string;
  selectedKey?: string;
}

export interface SkillManagerAction {
  kind: SkillManagerActionKind;
  skillPath?: string;
  groupName?: string;
  groupCustom?: boolean;
  optionalName?: string;
  uiState: SkillManagerUiState;
}

interface SkillManagerTheme extends FrameTheme {}

export interface SkillManagerOverlayParams {
  skills: readonly ManagedSkill[];
  groups: readonly ManagedSkillGroup[];
  optionalSkills?: readonly OptionalSkill[];
  theme: SkillManagerTheme;
  notice?: string;
  initialState?: Partial<SkillManagerUiState>;
  /** UI language; defaults to zh-CN when the host exposes no locale signal. */
  locale?: SupportedSettingsLocale;
  requestRender: () => void;
  done: (action: SkillManagerAction) => void;
}

const MAX_VISIBLE = 12;

const CATALOGS = {
  en: {
    "title": "Skill Manager",
    "header.count": "{count} skills",
    "footer.close": "Esc close",
    "footer.navigate": "Up/Down select",
    "footer.filter": "/ filter",
    "footer.load": "Space load",
    "footer.modelInvocation": "M model invocation",
    "footer.createGroup": "N new group",
    "footer.move": "G move",
    "footer.deleteGroup": "D delete group",
    "footer.installOptional": "I install optional",
    "optional.section": "Optional (选装)",
    "optional.installed": "installed",
    "optional.notInstalled": "not installed",
    "optional.hint": "I 安装到项目 .pi/skills/",
    "optional.empty": "○ no optional skills",
    "compact.skill": "Esc · Skill · {state} · {name}",
    "compact.group": "Esc · Skill group · {name}",
    "compact.empty": "Esc · Skill · no matches",
    "value.enabled": "available",
    "value.disabled": "disabled",
    "entry.empty": "○ no matching skills",
    "skill.state.enabled": "● available",
    "skill.state.disabled": "○ disabled",
    "skill.invocation.model": "model invocation",
    "skill.invocation.manual": "manual only",
    "readonly": "read-only",
    "group.state.all": "● all available",
    "group.state.none": "○ all disabled",
    "group.state.mixed": "◐ partly available",
    "group.invocation.all": "model invocation",
    "group.invocation.none": "manual only",
    "group.invocation.mixed": "invocation mixed",
    "group.detail": "{kind} group · {count} skills",
    "group.custom": "custom",
    "group.prefix": "prefix",
    "count.suffix": "{count} items",
    "scope.package": "pkg:{source}",
    "scope.project": "project",
    "scope.user": "user",
    "scope.ephemeral": "temporary",
    "filter.idle": "Filter: press / and type a skill name",
    "filter.active": "Filtering: {query} · Esc cancel",
    "filter.placeholder": "type a skill name",
    "filter.count": "showing {count}",
  },
  "zh-CN": {
    "title": "Skill 管理",
    "header.count": "{count} 个 Skill",
    "footer.close": "Esc 关闭",
    "footer.navigate": "↑↓ 选择",
    "footer.filter": "/ 筛选",
    "footer.load": "空格 加载",
    "footer.modelInvocation": "M 模型调用",
    "footer.createGroup": "N 新建组",
    "footer.move": "G 移动",
    "footer.deleteGroup": "D 删除组",
    "footer.installOptional": "I 安装选装",
    "optional.section": "选装（Optional）",
    "optional.installed": "已安装",
    "optional.notInstalled": "未安装",
    "optional.hint": "I 安装到项目 .pi/skills/",
    "optional.empty": "○ 没有选装 Skill",
    "compact.skill": "Esc · Skill · {state} · {name}",
    "compact.group": "Esc · Skill 组 · {name}",
    "compact.empty": "Esc · Skill · 没有匹配项",
    "value.enabled": "可用",
    "value.disabled": "停用",
    "entry.empty": "○ 没有匹配的 Skill",
    "skill.state.enabled": "● 可用",
    "skill.state.disabled": "○ 停用",
    "skill.invocation.model": "模型可调用",
    "skill.invocation.manual": "仅手动",
    "readonly": "只读",
    "group.state.all": "● 全部可用",
    "group.state.none": "○ 全部停用",
    "group.state.mixed": "◐ 部分可用",
    "group.invocation.all": "模型可调用",
    "group.invocation.none": "仅手动",
    "group.invocation.mixed": "调用混合",
    "group.detail": "{kind}分组 · {count} 个 Skill",
    "group.custom": "自定义",
    "group.prefix": "前缀",
    "count.suffix": "{count} 个",
    "scope.package": "包:{source}",
    "scope.project": "项目",
    "scope.user": "用户",
    "scope.ephemeral": "临时",
    "filter.idle": "筛选：按 / 输入 Skill 名称",
    "filter.active": "筛选中：{query} · Esc 取消",
    "filter.placeholder": "输入 Skill 名称",
    "filter.count": "显示 {count} 个",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["zh-CN"];

type SkillManagerEntry =
  | { kind: "group"; key: string; group: ManagedSkillGroup }
  | { kind: "skill"; key: string; group: ManagedSkillGroup; skill: ManagedSkill }
  | { kind: "optional"; key: string; skill: OptionalSkill };

export class SkillManagerOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
  private query: string;
  private selected = 0;
  private filterActive = false;

  constructor(private readonly params: SkillManagerOverlayParams) {
    this.locale = params.locale ?? "zh-CN";
    this.query = params.initialState?.query ?? "";
    const selectedKey = params.initialState?.selectedKey;
    if (selectedKey) {
      const index = this.filteredEntries().findIndex((entry) => entry.key === selectedKey);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  /** Translate a catalog key with optional {var} substitution. */
  private t(key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string {
    const catalog = CATALOGS[this.locale] ?? CATALOGS["zh-CN"];
    const template: unknown = catalog[key];
    const text = typeof template === "string" ? template : CATALOGS["zh-CN"][key] as string;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.selected = clampIndex(this.selected, this.filteredEntries().length);
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];

    const inner = safeWidth - 2;
    const entries = this.filteredEntries();
    const rows = [
      headerLine(this.params.theme, this.t("title"), [this.t("header.count", { count: this.params.skills.length })], inner),
      rule(inner),
      ...this.entryRows(entries, inner),
      this.filterLine(inner, entries.filter((entry) => entry.kind === "skill").length),
    ];
    const selected = this.selectedEntry();
    if (selected?.kind === "skill") {
      rows.push(helpLine(this.params.theme, selected.skill.description || selected.skill.filePath, inner));
    } else if (selected?.kind === "optional") {
      rows.push(helpLine(this.params.theme, selected.skill.description || this.t("optional.hint"), inner));
    } else if (selected?.kind === "group") {
      rows.push(helpLine(this.params.theme, this.t("group.detail", {
        kind: this.t(selected.group.custom ? "group.custom" : "group.prefix"),
        count: selected.group.skills.length,
      }), inner));
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, [
      this.t("footer.close"),
      this.t("footer.navigate"),
      this.t("footer.filter"),
      this.t("footer.load"),
      this.t("footer.modelInvocation"),
      this.t("footer.createGroup"),
      this.t("footer.move"),
      this.t("footer.deleteGroup"),
      this.t("footer.installOptional"),
    ]));
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
      this.finish("close");
      return;
    }
    if (matchesKey(data, Key.up)) return this.moveSelection(-1);
    if (matchesKey(data, Key.down)) return this.moveSelection(1);
    if (matchesKey(data, Key.pageUp)) return this.moveSelection(-MAX_VISIBLE);
    if (matchesKey(data, Key.pageDown)) return this.moveSelection(MAX_VISIBLE);

    if (this.filterActive) {
      if (matchesKey(data, Key.backspace) || data === "\b") {
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
    if (matchesKey(data, Key.space) || data === " ") return this.finish("toggle-enabled");
    if (data === "m" || data === "M") return this.finish("toggle-model-invocation");
    if (data === "i" || data === "I") return this.finish("install-optional");
    if (data === "n" || data === "N") return this.finish("create-group");
    if (data === "g" || data === "G") return this.finish("assign-group");
    if (data === "d" || data === "D") return this.finish("delete-group");
  }

  private renderCompact(width: number): string {
    const entry = this.selectedEntry() ?? this.filteredEntries()[0];
    const text = entry?.kind === "skill"
      ? this.t("compact.skill", {
          state: this.t(entry.skill.enabled ? "value.enabled" : "value.disabled"),
          name: entry.skill.name,
        })
      : entry?.kind === "group"
        ? this.t("compact.group", { name: entry.group.name })
        : this.t("compact.empty");
    return fit(text, width);
  }

  private entryRows(entries: readonly SkillManagerEntry[], width: number): string[] {
    if (entries.length === 0) {
      return [this.params.theme.fg("warning", fit(this.t("entry.empty"), width))];
    }
    const start = visibleStart(this.selected, entries.length, MAX_VISIBLE);
    return entries.slice(start, start + MAX_VISIBLE).map((entry, offset) => {
      const selected = start + offset === this.selected;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      if (entry.kind === "group") {
        const availability = groupState(
          entry.group.skills,
          (skill) => skill.enabled,
          this.t("group.state.all"),
          this.t("group.state.none"),
          this.t("group.state.mixed"),
        );
        const invocation = groupState(
          entry.group.skills,
          (skill) => !skill.disableModelInvocation,
          this.t("group.invocation.all"),
          this.t("group.invocation.none"),
          this.t("group.invocation.mixed"),
        );
        const label = `${entry.group.custom ? "◆" : "◇"} ${entry.group.name}`;
        const name = selected
          ? this.params.theme.bold(this.params.theme.fg("accent", label))
          : this.params.theme.bold(label);
        return fit(`${prefix} ${name} · ${availability} · ${invocation} · ${this.t("count.suffix", { count: entry.group.skills.length })}`, width);
      }
      if (entry.kind === "optional") {
        const state = entry.skill.installed
          ? this.params.theme.fg("success", this.t("optional.installed"))
          : this.params.theme.fg("dim", this.t("optional.notInstalled"));
        const name = selected
          ? this.params.theme.bold(this.params.theme.fg("accent", `  ${entry.skill.name}`))
          : `  ${entry.skill.name}`;
        return fit(`${prefix} ▸ ${state} · ${name} · ${this.t("optional.hint")}`, width);
      }
      const skill = entry.skill;
      const name = selected
        ? this.params.theme.bold(this.params.theme.fg("accent", `  ${skill.name}`))
        : `  ${skill.name}`;
      const availability = skill.enabled
        ? this.params.theme.fg("success", this.t("skill.state.enabled"))
        : this.params.theme.fg("dim", this.t("skill.state.disabled"));
      const invocation = skill.disableModelInvocation
        ? this.params.theme.fg("dim", this.t("skill.invocation.manual"))
        : this.params.theme.fg("success", this.t("skill.invocation.model"));
      return fit(
        `${prefix} ${availability} · ${invocation} · ${name} · ${this.scopeLabel(skill)}${skill.readOnly ? ` · ${this.t("readonly")}` : ""}`,
        width,
      );
    });
  }

  private filterLine(width: number, count: number): string {
    const prompt = this.filterActive
      ? this.t("filter.active", { query: this.query || this.t("filter.placeholder") })
      : this.t("filter.idle");
    return helpLine(this.params.theme, `${prompt} · ${this.t("filter.count", { count })}`, width);
  }

  private styledNotice(notice: string, width: number): string {
    const role = /(失败|错误|failed|error)/i.test(notice) ? "error"
      : /^(已保存|已启用|已停用|Saved)/.test(notice) ? "success"
      : "warning";
    return this.params.theme.fg(role, fit(notice, width));
  }

  private scopeLabel(skill: ManagedSkill): string {
    if (skill.origin === "package") return this.t("scope.package", { source: skill.source });
    if (skill.scope === "project") return this.t("scope.project");
    if (skill.scope === "user") return this.t("scope.user");
    return this.t("scope.ephemeral");
  }

  private moveSelection(delta: number): void {
    this.selected = wrapIndex(this.selected + delta, this.filteredEntries().length);
    this.params.requestRender();
  }

  private filteredEntries(): SkillManagerEntry[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const entries: SkillManagerEntry[] = [];
    for (const group of this.params.groups) {
      const groupMatches = terms.length === 0 || terms.every((term) => group.name.toLocaleLowerCase().includes(term));
      const matchingSkills = groupMatches
        ? group.skills
        : group.skills.filter((skill) => {
            const haystack = [skill.name, skill.description, skill.scope, skill.source, skill.filePath]
              .join(" ")
              .toLocaleLowerCase();
            return terms.every((term) => haystack.includes(term));
          });
      if (!groupMatches && matchingSkills.length === 0) continue;
      entries.push({ kind: "group", key: `group:${group.custom ? "custom" : "default"}:${group.name}`, group });
      for (const skill of matchingSkills) {
        entries.push({ kind: "skill", key: `skill:${skill.filePath}`, group, skill });
      }
    }
    if ((this.params.optionalSkills?.length ?? 0) > 0) {
      const matchingOptional = (this.params.optionalSkills ?? []).filter((skill) => {
        const haystack = [skill.name, skill.description].join(" ").toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      if (matchingOptional.length > 0) {
        entries.push({ kind: "group", key: "group:default:选装", group: {
          name: this.t("optional.section"), custom: false, skills: [],
        } });
        for (const skill of matchingOptional) {
          entries.push({ kind: "optional", key: `optional:${skill.name}`, skill });
        }
      }
    }
    return entries;
  }

  private selectedEntry(): SkillManagerEntry | undefined {
    return this.filteredEntries()[this.selected];
  }

  private finish(kind: SkillManagerActionKind): void {
    const selected = this.selectedEntry();
    this.params.done({
      kind,
      ...(selected?.kind === "skill" ? { skillPath: selected.skill.filePath } : {}),
      ...(selected?.kind === "optional" ? { optionalName: selected.skill.name } : {}),
      ...(selected?.kind === "skill" || selected?.kind === "group" ? { groupName: selected.group.name } : {}),
      ...(selected?.kind === "skill" || selected?.kind === "group" ? { groupCustom: selected.group.custom } : {}),
      uiState: {
        query: this.query,
        ...(selected ? { selectedKey: selected.key } : {}),
      },
    });
  }
}

function groupState(
  skills: readonly ManagedSkill[],
  predicate: (skill: ManagedSkill) => boolean,
  allLabel: string,
  noneLabel: string,
  mixedLabel: string,
): string {
  if (skills.length === 0) return noneLabel;
  const count = skills.filter(predicate).length;
  if (count === skills.length) return allLabel;
  if (count === 0) return noneLabel;
  return mixedLabel;
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

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return kept.length ? kept.join(" · ") : fit(segments[0] ?? "", width);
}
