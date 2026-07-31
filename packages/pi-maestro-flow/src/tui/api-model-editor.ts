import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "./input-text.ts";

export type ApiModelFormFieldKind = "readonly" | "text" | "number" | "secret" | "toggle" | "choice" | "section";

export interface ApiModelFormChoice {
  label: string;
  value: string;
}

export interface ApiModelFormField {
  id: string;
  label: string;
  kind: ApiModelFormFieldKind;
  value: string | boolean;
  choices?: readonly ApiModelFormChoice[];
  help?: string;
}

export type ApiModelFormValues = Record<string, string | boolean>;

export interface ApiModelEditorResult {
  values: ApiModelFormValues;
}

interface ApiModelEditorTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

export interface ApiModelEditorOverlayParams {
  title: string;
  fields: readonly ApiModelFormField[];
  theme: ApiModelEditorTheme;
  requestRender: () => void;
  done: (result: ApiModelEditorResult | undefined) => void;
  validate?: (values: ApiModelFormValues) => string[];
}

const MAX_VISIBLE_FIELDS = 12;
const CTRL_S = "\x13";
const CTRL_U = "\x15";

export class ApiModelEditorOverlay implements Component, Focusable {
  focused = false;
  private selected = 0;
  private editing = false;
  private editValue = "";
  private secretClearOnCommit = false;
  private notice = "";
  private discardArmed = false;
  private lastWidth = 80;
  private pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pasteDecoder = new BracketedPasteDecoder();
  private readonly fields: ApiModelFormField[];
  private readonly originalValues: ApiModelFormValues;

  constructor(private readonly params: ApiModelEditorOverlayParams) {
    this.fields = params.fields.map((field) => ({
      ...field,
      choices: field.choices ? [...field.choices] : undefined,
    }));
    this.originalValues = this.values();
    const firstEditable = this.fields.findIndex((field) => field.kind !== "readonly" && field.kind !== "section");
    if (firstEditable >= 0) this.selected = firstEditable;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 140));
    this.lastWidth = safeWidth;
    if (safeWidth < 20) return [truncateToWidth(`API model form · ${this.selected + 1}/${this.fields.length}`, safeWidth, "…")];
    const inner = safeWidth - 2;
    const rows: string[] = [
      fit(this.params.theme.bold(this.params.title), inner),
      rule(inner),
    ];
    const start = visibleStart(this.selected, this.fields.length);
    const visible = this.fields.slice(start, start + MAX_VISIBLE_FIELDS);
    const labelWidth = Math.min(24, Math.max(12, ...visible.map((field) => visibleWidth(field.label))));
    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = start + offset;
      const field = visible[offset];
      if (field.kind === "section") {
        rows.push(fit(this.params.theme.fg("dim", `── ${this.params.theme.bold(field.label)} ──`), inner));
        continue;
      }
      const active = index === this.selected;
      const marker = active ? this.params.theme.fg("accent", "›") : " ";
      const label = pad(field.label, labelWidth);
      const rendered = active && this.editing
        ? this.renderEditValue(field)
        : this.renderFieldValue(field);
      const line = `${marker} ${label}  ${rendered}`;
      rows.push(fit(active ? this.params.theme.bold(line) : line, inner));
    }
    const current = this.fields[this.selected];
    if (current?.help) rows.push(rule(inner), fit(this.params.theme.fg("dim", current.help), inner));
    if (this.notice) rows.push(fit(this.params.theme.fg(this.notice.startsWith("×") ? "error" : "warning", this.notice), inner));
    rows.push(rule(inner), fit(this.footer(), inner));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (this.pasteFlushTimer) clearTimeout(this.pasteFlushTimer);
    for (const token of this.pasteDecoder.feed(data)) this.dispatchToken(token);
    if (this.pasteDecoder.hasPending()) {
      this.pasteFlushTimer = setTimeout(() => {
        this.pasteFlushTimer = undefined;
        for (const token of this.pasteDecoder.flushPending()) this.dispatchToken(token);
        this.params.requestRender();
      }, 16);
    }
    this.params.requestRender();
  }

  private dispatchToken(token: DecodedInputToken): void {
    if (token.kind === "paste") {
      if (this.editing && this.isEditableText(this.currentField())) {
        this.editValue += token.text;
        this.secretClearOnCommit = false;
        this.notice = "";
      }
      return;
    }
    this.handleDecodedInput(token.text);
  }

  private handleDecodedInput(data: string): void {
    if (this.lastWidth < 20) {
      if (matchesKey(data, Key.escape)) this.cancel();
      return;
    }
    if (this.editing) {
      this.handleEditInput(data);
      return;
    }
    if (data === CTRL_S || matchesKey(data, Key.ctrl("s"))) {
      this.submit();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) this.move(1);
    else if (matchesKey(data, Key.pageUp)) this.move(-MAX_VISIBLE_FIELDS);
    else if (matchesKey(data, Key.pageDown)) this.move(MAX_VISIBLE_FIELDS);
    else if (matchesKey(data, Key.left)) this.changeChoice(-1);
    else if (matchesKey(data, Key.right) || data === " ") this.changeChoice(1);
    else if (matchesKey(data, Key.enter) || data === "\r") this.activateCurrent();
  }

  private handleEditInput(data: string): void {
    const field = this.currentField();
    if (!field) return;
    if (matchesKey(data, Key.escape)) {
      this.editing = false;
      this.editValue = "";
      this.secretClearOnCommit = false;
      this.notice = "";
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      if (field.kind === "secret") {
        if (this.secretClearOnCommit) field.value = "";
        else if (this.editValue.length > 0) field.value = this.editValue;
      } else {
        field.value = this.editValue;
      }
      this.editing = false;
      this.editValue = "";
      this.secretClearOnCommit = false;
      this.discardArmed = false;
      this.notice = "";
      return;
    }
    if (data === CTRL_U) {
      this.editValue = "";
      this.secretClearOnCommit = field.kind === "secret";
      this.notice = field.kind === "secret" ? "确认后清空该敏感字段" : "";
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.editValue = removeLastGrapheme(this.editValue);
      this.notice = "";
      return;
    }
    const printable = sanitizeSingleLineInput(data);
    if (!printable) return;
    this.secretClearOnCommit = false;
    this.editValue += field.kind === "number" ? printable.replace(/\D/g, "") : printable;
    this.notice = "";
  }

  private activateCurrent(): void {
    const field = this.currentField();
    if (!field || field.kind === "readonly") return;
    if (field.kind === "toggle" || field.kind === "choice") {
      this.changeChoice(1);
      return;
    }
    this.editing = true;
    this.editValue = field.kind === "secret" ? "" : String(field.value);
    this.secretClearOnCommit = false;
    this.notice = field.kind === "secret" && field.value ? "留空并确认可保留当前值" : "";
  }

  private changeChoice(direction: number): void {
    const field = this.currentField();
    if (!field) return;
    if (field.kind === "toggle") {
      field.value = !field.value;
      this.markChanged();
      return;
    }
    if (field.kind !== "choice" || !field.choices?.length) return;
    const current = field.choices.findIndex((choice) => choice.value === field.value);
    const next = (Math.max(0, current) + direction + field.choices.length) % field.choices.length;
    field.value = field.choices[next].value;
    this.markChanged();
  }

  private move(delta: number): void {
    if (this.fields.length === 0) return;
    let next = this.selected;
    for (let attempt = 0; attempt < this.fields.length; attempt += 1) {
      next = (next + delta + this.fields.length) % this.fields.length;
      if (this.fields[next].kind !== "readonly" && this.fields[next].kind !== "section") break;
    }
    this.selected = next;
    this.notice = "";
  }

  private submit(): void {
    const values = this.values();
    const errors = this.params.validate?.(values) ?? [];
    if (errors.length > 0) {
      this.notice = `× ${errors[0]}`;
      return;
    }
    this.params.done({ values });
  }

  private cancel(): void {
    if (this.isDirty() && !this.discardArmed) {
      this.discardArmed = true;
      this.notice = "有未保存修改，再按 Esc 放弃";
      return;
    }
    this.params.done(undefined);
  }

  private markChanged(): void {
    this.discardArmed = false;
    this.notice = "";
  }

  private currentField(): ApiModelFormField | undefined {
    return this.fields[this.selected];
  }

  private isEditableText(field: ApiModelFormField | undefined): boolean {
    return field?.kind === "text" || field?.kind === "number" || field?.kind === "secret";
  }

  private renderEditValue(field: ApiModelFormField): string {
    if (field.kind === "secret") {
      if (this.secretClearOnCommit) return this.params.theme.fg("warning", "确认后清空");
      return this.editValue ? maskSecret(this.editValue) : this.params.theme.fg("dim", "留空保留当前值");
    }
    return this.editValue || this.params.theme.fg("dim", "空");
  }

  private renderFieldValue(field: ApiModelFormField): string {
    if (field.kind === "secret") return field.value ? maskSecret(String(field.value)) : this.params.theme.fg("warning", "未配置");
    if (field.kind === "toggle") return field.value
      ? this.params.theme.fg("success", "开启")
      : this.params.theme.fg("dim", "关闭");
    if (field.kind === "choice") {
      return field.choices?.find((choice) => choice.value === field.value)?.label ?? String(field.value);
    }
    return String(field.value) || this.params.theme.fg("dim", "未设置");
  }

  private values(): ApiModelFormValues {
    return Object.fromEntries(this.fields
      .filter((field) => field.kind !== "section")
      .map((field) => [field.id, field.value]));
  }

  private isDirty(): boolean {
    const current = this.values();
    return Object.keys(current).some((id) => current[id] !== this.originalValues[id]);
  }

  private footer(): string {
    if (this.editing) return "Enter 确认 · Esc 返回 · Ctrl+U 清空 · Backspace 删除";
    return "↑↓/Tab 选择 · Enter 编辑 · ←→/Space 切换 · Ctrl+S 继续 · Esc 取消";
  }
}

export function showApiModelEditor(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  options: Omit<ApiModelEditorOverlayParams, "theme" | "requestRender" | "done">,
): Promise<ApiModelEditorResult | undefined> {
  if (!ctx.hasUI) return Promise.resolve(undefined);
  return ctx.ui.custom<ApiModelEditorResult | undefined>((tui, theme, _keybindings, done) =>
    new ApiModelEditorOverlay({
      ...options,
      theme,
      requestRender: () => tui.requestRender(),
      done,
    }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "92%", maxHeight: "90%" },
  });
}

function visibleStart(selected: number, length: number): number {
  return Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE_FIELDS / 2), length - MAX_VISIBLE_FIELDS));
}

function maskSecret(value: string): string {
  if (!value) return "未配置";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 3)}${"*".repeat(Math.min(12, value.length - 7))}${value.slice(-4)}`;
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: string[], width: number, theme: ApiModelEditorTheme): string[] {
  const inner = Math.max(0, width - 2);
  const border = (value: string) => theme.fg("dim", value);
  return [
    border(`╭${"─".repeat(inner)}╮`),
    ...rows.map((row) => {
      const content = truncateToWidth(row, inner, "…");
      return `${border("│")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border("│")}`;
    }),
    border(`╰${"─".repeat(inner)}╯`),
  ];
}
