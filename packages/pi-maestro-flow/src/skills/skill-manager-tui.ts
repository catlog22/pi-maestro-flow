import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ManagedSkill, ManagedSkillGroup } from "./skill-manager-store.ts";

export type SkillManagerActionKind =
  | "close"
  | "toggle-enabled"
  | "toggle-model-invocation"
  | "create-group"
  | "assign-group"
  | "delete-group";

export interface SkillManagerUiState {
  query: string;
  selectedKey?: string;
}

export interface SkillManagerAction {
  kind: SkillManagerActionKind;
  skillPath?: string;
  groupName?: string;
  groupCustom?: boolean;
  uiState: SkillManagerUiState;
}

interface SkillManagerTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface SkillManagerOverlayParams {
  skills: readonly ManagedSkill[];
  groups: readonly ManagedSkillGroup[];
  theme: SkillManagerTheme;
  notice?: string;
  initialState?: Partial<SkillManagerUiState>;
  requestRender: () => void;
  done: (action: SkillManagerAction) => void;
}

const MAX_VISIBLE = 12;

type SkillManagerEntry =
  | { kind: "group"; key: string; group: ManagedSkillGroup }
  | { kind: "skill"; key: string; group: ManagedSkillGroup; skill: ManagedSkill };

export class SkillManagerOverlay implements Component, Focusable {
  focused = false;
  private query: string;
  private selected = 0;
  private filterActive = false;

  constructor(private readonly params: SkillManagerOverlayParams) {
    this.query = params.initialState?.query ?? "";
    const selectedKey = params.initialState?.selectedKey;
    if (selectedKey) {
      const index = this.filteredEntries().findIndex((entry) => entry.key === selectedKey);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate(): void {}
  dispose(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.selected = clampIndex(this.selected, this.filteredEntries().length);
    if (safeWidth < 20) return [this.renderCompact(safeWidth)];

    const inner = safeWidth - 2;
    const entries = this.filteredEntries();
    const rows = [
      fitLine(`${this.params.theme.bold("Skill 管理")} · ${this.params.skills.length} 个 Skill`, inner),
      rule(inner),
      ...this.entryRows(entries, inner),
      this.filterLine(inner, entries.filter((entry) => entry.kind === "skill").length),
    ];
    const selected = this.selectedEntry();
    if (selected?.kind === "skill") {
      rows.push(this.params.theme.fg("dim", fitLine(selected.skill.description || selected.skill.filePath, inner)));
    } else if (selected?.kind === "group") {
      rows.push(this.params.theme.fg(
        "dim",
        fitLine(`${selected.group.custom ? "自定义" : "前缀"}分组 · ${selected.group.skills.length} 个 Skill`, inner),
      ));
    }
    if (this.params.notice) rows.push(this.styledNotice(this.params.notice, inner));
    rows.push(fitSegments(inner, ["Esc 关闭", "↑↓ 选择", "/ 筛选", "空格 加载", "M 模型调用", "N 新建组", "G 移动", "D 删除组"]));
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
    if (data === "n" || data === "N") return this.finish("create-group");
    if (data === "g" || data === "G") return this.finish("assign-group");
    if (data === "d" || data === "D") return this.finish("delete-group");
  }

  private renderCompact(width: number): string {
    const entry = this.selectedEntry() ?? this.filteredEntries()[0];
    const text = entry?.kind === "skill"
      ? `Esc · Skill · ${entry.skill.enabled ? "可用" : "停用"} · ${entry.skill.name}`
      : entry?.kind === "group"
        ? `Esc · Skill 组 · ${entry.group.name}`
      : "Esc · Skill · 没有匹配项";
    return truncateToWidth(text, width, "…");
  }

  private entryRows(entries: readonly SkillManagerEntry[], width: number): string[] {
    if (entries.length === 0) {
      return [this.params.theme.fg("warning", fitLine("○ 没有匹配的 Skill", width))];
    }
    const start = visibleStart(this.selected, entries.length, MAX_VISIBLE);
    return entries.slice(start, start + MAX_VISIBLE).map((entry, offset) => {
      const selected = start + offset === this.selected;
      const prefix = selected ? this.params.theme.fg("accent", "›") : " ";
      if (entry.kind === "group") {
        const availability = groupState(entry.group.skills, (skill) => skill.enabled, "● 全部可用", "○ 全部停用", "◐ 部分可用");
        const invocation = groupState(
          entry.group.skills,
          (skill) => !skill.disableModelInvocation,
          "模型可调用",
          "仅手动",
          "调用混合",
        );
        const label = `${entry.group.custom ? "◆" : "◇"} ${entry.group.name}`;
        const name = selected
          ? this.params.theme.bold(this.params.theme.fg("accent", label))
          : this.params.theme.bold(label);
        return fitLine(`${prefix} ${name} · ${availability} · ${invocation} · ${entry.group.skills.length} 个`, width);
      }
      const skill = entry.skill;
      const name = selected
        ? this.params.theme.bold(this.params.theme.fg("accent", `  ${skill.name}`))
        : `  ${skill.name}`;
      const availability = skill.enabled
        ? this.params.theme.fg("success", "● 可用")
        : this.params.theme.fg("dim", "○ 停用");
      const invocation = skill.disableModelInvocation
        ? this.params.theme.fg("dim", "仅手动")
        : this.params.theme.fg("success", "模型可调用");
      return fitLine(
        `${prefix} ${availability} · ${invocation} · ${name} · ${scopeLabel(skill)}${skill.readOnly ? " · 只读" : ""}`,
        width,
      );
    });
  }

  private filterLine(width: number, count: number): string {
    const prompt = this.filterActive
      ? `筛选中：${this.query || "输入 Skill 名称"} · Esc 取消`
      : "筛选：按 / 输入 Skill 名称";
    return this.params.theme.fg("dim", fitLine(`${prompt} · 显示 ${count} 个`, width));
  }

  private styledNotice(notice: string, width: number): string {
    const role = /(失败|错误|failed|error)/i.test(notice) ? "error"
      : /^(已保存|已启用|已停用|Saved)/.test(notice) ? "success"
      : "warning";
    return this.params.theme.fg(role, fitLine(notice, width));
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
      ...(selected ? { groupName: selected.group.name } : {}),
      ...(selected ? { groupCustom: selected.group.custom } : {}),
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

function scopeLabel(skill: ManagedSkill): string {
  if (skill.origin === "package") return `包:${skill.source}`;
  if (skill.scope === "project") return "项目";
  if (skill.scope === "user") return "用户";
  return "临时";
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

function fitSegments(width: number, segments: string[]): string {
  return fitLine(segments.join(" · "), width);
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme: SkillManagerTheme): string[] {
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
