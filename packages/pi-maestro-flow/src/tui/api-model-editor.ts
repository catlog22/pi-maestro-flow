import {
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type KeyId,
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

interface ApiModelEditorTheme extends FrameTheme {}

export interface ApiModelEditorOverlayParams {
  title: string;
  fields: readonly ApiModelFormField[];
  /** Explicit UI language; otherwise follows the shared runtime TUI locale. */
  locale?: SupportedSettingsLocale;
  theme: ApiModelEditorTheme;
  requestRender: () => void;
  done: (result: ApiModelEditorResult | undefined) => void;
  validate?: (values: ApiModelFormValues) => string[];
}

const CATALOGS = {
  en: {
    "tiny.title": "API model form",
    "notice.error": "×",
    "notice.secretClear": "Clear the sensitive field after confirming",
    "notice.secretKeep": "Leave empty and confirm to keep the current value",
    "notice.discardConfirm": "Unsaved changes · press Esc again to discard",
    "secret.clearConfirm": "Clear after confirm",
    "secret.keepPlaceholder": "Leave empty to keep the current value",
    "value.empty": "empty",
    "value.unconfigured": "Not configured",
    "value.on": "On",
    "value.off": "Off",
    "value.unset": "Not set",
    "footer.edit": "Enter confirm · Esc back · Ctrl+U clear · Backspace delete",
    "footer.normal": "Up/Down/Tab select · Enter edit · ←→/Space toggle · Ctrl+S continue · Esc cancel",
  },
  "zh-CN": {
    "tiny.title": "API model form",
    "notice.error": "×",
    "notice.secretClear": "确认后清空该敏感字段",
    "notice.secretKeep": "留空并确认可保留当前值",
    "notice.discardConfirm": "有未保存修改，再按 Esc 放弃",
    "secret.clearConfirm": "确认后清空",
    "secret.keepPlaceholder": "留空保留当前值",
    "value.empty": "空",
    "value.unconfigured": "未配置",
    "value.on": "开启",
    "value.off": "关闭",
    "value.unset": "未设置",
    "footer.edit": "Enter 确认 · Esc 返回 · Ctrl+U 清空 · Backspace 删除",
    "footer.normal": "↑↓/Tab 选择 · Enter 编辑 · ←→/Space 切换 · Ctrl+S 继续 · Esc 取消",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

const MAX_VISIBLE_FIELDS = 12;
const CTRL_S = "\x13";
const CTRL_U = "\x15";

// 编辑模式下忽略的导航/编辑/功能键：其转义序列（如 `\x1b[A`）若被当作文本追加，
// sanitize 后会把 `[A`、`[3~` 之类残渣混入输入（例如 URL 字段按方向键出现乱码）。
const IGNORED_EDIT_KEYS: readonly KeyId[] = [
  Key.up, Key.down, Key.left, Key.right,
  Key.home, Key.end, Key.pageUp, Key.pageDown,
  Key.delete, Key.insert, Key.clear,
  Key.f1, Key.f2, Key.f3, Key.f4, Key.f5, Key.f6,
  Key.f7, Key.f8, Key.f9, Key.f10, Key.f11, Key.f12,
];

export class ApiModelEditorOverlay implements Component, Focusable {
  focused = false;
  private readonly locale: SupportedSettingsLocale;
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
    this.locale = getTuiLocale(params.locale);
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
    this.lastWidth = safeWidth;
    if (safeWidth < 20) return [fit(`${this.t("tiny.title")} · ${this.selected + 1}/${this.fields.length}`, safeWidth)];
    const inner = safeWidth - 2;
    const rows: string[] = [
      headerLine(this.params.theme, this.params.title, [], inner),
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
    if (current?.help) rows.push(rule(inner), helpLine(this.params.theme, current.help, inner));
    if (this.notice) rows.push(fit(this.params.theme.fg(
      this.notice.startsWith(this.t("notice.error")) ? "error" : "warning",
      this.notice,
    ), inner));
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
      this.notice = field.kind === "secret" ? this.t("notice.secretClear") : "";
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\b" || data === "\x7f") {
      this.editValue = removeLastGrapheme(this.editValue);
      this.notice = "";
      return;
    }
    // 忽略导航/功能键，避免转义序列残渣混入文本。
    if (IGNORED_EDIT_KEYS.some((key) => matchesKey(data, key))) return;
    // 兜底：丢弃以 ESC 开头的未识别序列（拆分到达的 CSI/SS3 残渣）。
    if (data.startsWith("\x1b")) return;
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
    this.notice = field.kind === "secret" && field.value ? this.t("notice.secretKeep") : "";
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
      this.notice = `${this.t("notice.error")} ${errors[0]}`;
      return;
    }
    this.params.done({ values });
  }

  private cancel(): void {
    if (this.isDirty() && !this.discardArmed) {
      this.discardArmed = true;
      this.notice = this.t("notice.discardConfirm");
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
      if (this.secretClearOnCommit) return this.params.theme.fg("warning", this.t("secret.clearConfirm"));
      return this.editValue ? maskSecret(this.editValue) : this.params.theme.fg("dim", this.t("secret.keepPlaceholder"));
    }
    return this.editValue || this.params.theme.fg("dim", this.t("value.empty"));
  }

  private renderFieldValue(field: ApiModelFormField): string {
    if (field.kind === "secret") return field.value ? maskSecret(String(field.value)) : this.params.theme.fg("warning", this.t("value.unconfigured"));
    if (field.kind === "toggle") return field.value
      ? this.params.theme.fg("success", `● ${this.t("value.on")}`)
      : this.params.theme.fg("dim", `○ ${this.t("value.off")}`);
    if (field.kind === "choice") {
      return field.choices?.find((choice) => choice.value === field.value)?.label ?? String(field.value);
    }
    return String(field.value) || this.params.theme.fg("dim", this.t("value.unset"));
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
    if (this.editing) return this.t("footer.edit");
    return this.t("footer.normal");
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
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 3)}${"*".repeat(Math.min(12, value.length - 7))}${value.slice(-4)}`;
}
