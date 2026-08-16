import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import { TEAMMATE_THINKING_LEVELS, type TeammateThinkingLevel } from "../shared/thinking.ts";
import {
  createTuiTranslator,
  onTuiLocaleChange,
  type SupportedSettingsLocale,
  type TuiTranslator,
} from "./locale.ts";

/** One dispatch task shown in the ask overlay (post-routing resolution). */
export interface ModelAskTask {
  agent: string;
  name?: string;
  /** Resolved model id; undefined means inherit the main session's model. */
  model?: string;
  /** Resolved thinking level; undefined means inherit the Pi default. */
  thinking?: TeammateThinkingLevel;
  /** Resolved working directory; undefined means the session default. */
  cwd?: string;
  prompt: string;
}

/**
 * Per-task override chosen by the user. Absent fields keep the original
 * resolution; `null` explicitly restores inherit (clears the resolved value).
 */
export interface ModelAskOverride {
  model?: string | null;
  thinking?: TeammateThinkingLevel | null;
  /** `null` restores the default workspace; `remote:<id>` references a configured target. */
  cwd?: string | null;
}

export interface ModelAskResult {
  confirmed: boolean;
  /** Index-aligned with the tasks passed in; undefined keeps the task as-is. */
  overrides: Array<ModelAskOverride | undefined>;
}

/** Configured remote target offered as a dispatch location (Monitor mode). */
export interface ModelAskRemoteLocation {
  id: string;
  driver: string;
  host: string;
  cwd: string;
}

interface ModelAskOverlayOptions {
  tasks: readonly ModelAskTask[];
  availableModels: readonly TeammateModelCapability[];
  /** Main session model id, shown as the inherit target when known. */
  sessionModel?: string;
  /** Current workspace shown as the default location (ctx.cwd). */
  defaultCwd?: string;
  /** Configured remote targets offered when Monitor mode is active. */
  remoteLocations?: readonly ModelAskRemoteLocation[];
  /** Whether remote locations may be selected (Monitor mode active). */
  monitorActive?: boolean;
  locale?: SupportedSettingsLocale;
}

interface AskTheme {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

type AskMode = "tasks" | "model" | "thinking" | "location";

const INHERIT_MODEL = "__inherit__";
const INHERIT_THINKING = "__inherit__";
const INHERIT_LOCATION = "__current__";
const CUSTOM_LOCATION = "__custom__";
const MAX_VISIBLE = 10;

function resolveLocationPath(candidate: string, baseCwd?: string): string {
  if (path.isAbsolute(candidate)) return path.normalize(candidate);
  return path.resolve(baseCwd ?? process.cwd(), candidate);
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(path.normalize(base), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "";
}

function modelLabel(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Compact dispatch-time confirm overlay: pick model provider + thinking. */
export class ModelAskOverlay implements Component, Focusable {
  focused = false;
  private mode: AskMode = "tasks";
  private readonly tasks: readonly ModelAskTask[];
  private readonly models: readonly TeammateModelCapability[];
  private readonly sessionModel?: string;
  private readonly t: TuiTranslator;
  private readonly localeDisposer: () => void;
  private readonly overrides: Array<ModelAskOverride | undefined>;
  private cursor = 0;
  private modelQuery = "";
  private modelCursor = 0;
  private thinkingCursor = 0;
  private locationCursor = 0;
  private locationInput = "";
  private locationSubmode: "list" | "input" | "confirm" = "list";
  private locationConfirmPath = "";
  private statusText = "";
  private readonly defaultCwd?: string;
  private readonly remoteLocations: readonly ModelAskRemoteLocation[];
  private readonly monitorActive: boolean;
  private readonly theme: AskTheme;
  private readonly requestRender: () => void;
  private readonly close: (result: ModelAskResult) => void;

  constructor(
    theme: AskTheme,
    options: ModelAskOverlayOptions,
    requestRender: () => void,
    close: (result: ModelAskResult) => void,
  ) {
    this.theme = theme;
    this.tasks = options.tasks;
    this.models = options.availableModels;
    this.sessionModel = options.sessionModel;
    this.defaultCwd = options.defaultCwd;
    this.remoteLocations = options.remoteLocations ?? [];
    this.monitorActive = options.monitorActive ?? false;
    this.t = createTuiTranslator(options.locale);
    this.localeDisposer = options.locale === undefined
      ? onTuiLocaleChange(() => requestRender())
      : () => {};
    this.overrides = options.tasks.map(() => undefined);
    this.requestRender = requestRender;
    this.close = close;
  }

  invalidate(): void {}

  dispose(): void {
    this.localeDisposer();
  }

  private filteredModels(): readonly TeammateModelCapability[] {
    const query = this.modelQuery.toLowerCase();
    if (!query) return this.models;
    return this.models.filter((model) =>
      `${model.id} ${providerOf(model.id)}`.toLowerCase().includes(query)
    );
  }

  private confirm(): void {
    this.close({ confirmed: true, overrides: this.overrides });
  }

  private selectTask(index: number): void {
    const task = this.tasks[index];
    if (!task) return;
    this.mode = "model";
    this.modelQuery = "";
    this.modelCursor = 0;
    this.requestRender();
  }

  private selectThinking(index: number): void {
    const task = this.tasks[index];
    if (!task) return;
    this.mode = "thinking";
    this.thinkingCursor = task.thinking
      ? TEAMMATE_THINKING_LEVELS.indexOf(task.thinking) + 1
      : 0;
    this.requestRender();
  }

  private selectLocation(index: number): void {
    const task = this.tasks[index];
    if (!task) return;
    this.mode = "location";
    this.locationSubmode = "list";
    this.locationInput = "";
    this.statusText = "";
    const options = this.locationOptions(index);
    const activeIndex = options.findIndex((option) => option.active);
    this.locationCursor = activeIndex >= 0 ? activeIndex : 0;
    this.requestRender();
  }

  private applyLocation(index: number, value: string): void {
    const task = this.tasks[index];
    if (!task) return;
    const current = this.overrides[index] ?? {};
    this.overrides[index] = {
      ...current,
      cwd: value === INHERIT_LOCATION ? null : value,
    };
    this.mode = "tasks";
    this.requestRender();
  }

  private effectiveCwd(index: number): string | undefined {
    const override = this.overrides[index];
    if (override?.cwd !== undefined) return override.cwd ?? undefined;
    return this.tasks[index]?.cwd;
  }

  private locationOptions(index: number): Array<{
    value: string;
    label: string;
    badge: string;
    active: boolean;
    disabled?: boolean;
  }> {
    const effective = this.effectiveCwd(index);
    const options: Array<{
      value: string;
      label: string;
      badge: string;
      active: boolean;
      disabled?: boolean;
    }> = [{
      value: INHERIT_LOCATION,
      label: this.t("ask.locationCurrent"),
      badge: this.defaultCwd ?? "",
      active: effective === undefined,
    }];
    if (this.defaultCwd) {
      options.push({
        value: CUSTOM_LOCATION,
        label: this.t("ask.locationCustom"),
        badge: "",
        active: effective !== undefined && !effective.startsWith("remote:"),
      });
    }
    for (const remote of this.remoteLocations) {
      options.push({
        value: `remote:${remote.id}`,
        label: remote.id,
        badge: `${remote.driver} · ${remote.host} · ${remote.cwd}`,
        active: effective === `remote:${remote.id}`,
        ...(this.monitorActive ? {} : { disabled: true }),
      });
    }
    return options;
  }

  private handleLocationInput(data: string): void {
    if (this.locationSubmode === "input") {
      this.handleLocationPathInput(data);
      return;
    }
    if (this.locationSubmode === "confirm") {
      if (data === "y" || data === "Y") {
        this.applyLocation(this.cursor, this.locationConfirmPath);
      } else {
        this.locationSubmode = "list";
        this.statusText = "";
        this.requestRender();
      }
      return;
    }
    const options = this.locationOptions(this.cursor);
    if (matchesKey(data, Key.enter)) {
      const selected = options[this.locationCursor];
      if (!selected) return;
      if (selected.disabled) {
        this.statusText = this.t("ask.locationRemoteDisabled");
        this.requestRender();
        return;
      }
      if (selected.value === CUSTOM_LOCATION) {
        this.locationSubmode = "input";
        this.locationInput = "";
        this.requestRender();
        return;
      }
      this.applyLocation(this.cursor, selected.value);
      return;
    }
    if (data === "a") {
      const selected = options[this.locationCursor];
      if (!selected || selected.disabled || selected.value === CUSTOM_LOCATION) return;
      for (let index = 0; index < this.tasks.length; index++) {
        this.applyLocation(index, selected.value);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.locationCursor = this.locationCursor === 0 ? options.length - 1 : this.locationCursor - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.locationCursor = (this.locationCursor + 1) % options.length;
      this.requestRender();
    }
  }

  private handleLocationPathInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      const candidate = this.locationInput.trim();
      if (!candidate) {
        this.locationSubmode = "list";
        this.requestRender();
        return;
      }
      const resolved = resolveLocationPath(candidate, this.defaultCwd);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        this.statusText = this.t("ask.locationNotFound", { path: resolved });
        this.requestRender();
        return;
      }
      const outside = this.defaultCwd ? !isPathInside(resolved, this.defaultCwd) : true;
      if (outside) {
        this.locationSubmode = "confirm";
        this.locationConfirmPath = resolved;
        this.requestRender();
        return;
      }
      this.applyLocation(this.cursor, resolved);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.locationInput = this.locationInput.slice(0, -1);
      this.requestRender();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.locationInput += data;
      this.requestRender();
    }
  }

  private locationLabel(index: number): string {
    const effective = this.effectiveCwd(index);
    if (effective === undefined) return this.t("ask.locationCurrentShort");
    if (effective.startsWith("remote:")) return effective;
    return truncateToWidth(effective, 32, "…");
  }

  private applyModel(index: number, value: string): void {
    const task = this.tasks[index];
    if (!task) return;
    const current = this.overrides[index] ?? {};
    if (value === INHERIT_MODEL) {
      this.overrides[index] = { ...current, model: null };
    } else {
      this.overrides[index] = { ...current, model: value };
    }
    this.mode = "tasks";
    this.requestRender();
  }

  private applyThinking(index: number, value: string): void {
    const task = this.tasks[index];
    if (!task) return;
    const current = this.overrides[index] ?? {};
    if (value === INHERIT_THINKING) {
      this.overrides[index] = { ...current, thinking: null };
    } else {
      this.overrides[index] = {
        ...current,
        thinking: value as TeammateThinkingLevel,
      };
    }
    this.mode = "tasks";
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "tasks") this.close({ confirmed: false, overrides: [] });
      else if (this.mode === "location") {
        if (this.locationSubmode === "list") this.mode = "tasks";
        else {
          this.locationSubmode = "list";
          this.statusText = "";
        }
        this.requestRender();
      } else {
        this.mode = "tasks";
        this.requestRender();
      }
      return;
    }
    if (this.mode === "model") {
      this.handleModelInput(data);
      return;
    }
    if (this.mode === "thinking") {
      this.handleThinkingInput(data);
      return;
    }
    if (this.mode === "location") {
      this.handleLocationInput(data);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirm();
      return;
    }
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.modelQuery)) {
      this.cursor = this.cursor === 0 ? this.tasks.length - 1 : this.cursor - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.modelQuery)) {
      this.cursor = this.cursor === this.tasks.length - 1 ? 0 : this.cursor + 1;
      this.requestRender();
      return;
    }
    if (data === "m") {
      this.selectTask(this.cursor);
      return;
    }
    if (data === "t") {
      this.selectThinking(this.cursor);
      return;
    }
    if (data === "l") {
      this.selectLocation(this.cursor);
      return;
    }
  }

  private filteredModelEntries(): Array<{
    value: string;
    label: string;
    badge: string;
    current: boolean;
  }> {
    return [
      {
        value: INHERIT_MODEL,
        label: this.t("ask.inheritModel"),
        badge: this.sessionModel ? `session: ${modelLabel(this.sessionModel)}` : "",
        current: this.effectiveModel() === undefined,
      },
      ...this.filteredModels().map((model) => ({
        value: model.id,
        label: modelLabel(model.id),
        badge: providerOf(model.id),
        current: this.effectiveModel() === model.id,
      })),
    ];
  }

  private handleModelInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      const selected = this.filteredModelEntries()[this.modelCursor];
      if (selected) this.applyModel(this.cursor, selected.value);
      return;
    }
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.modelQuery)) {
      this.moveModelCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.modelQuery)) {
      this.moveModelCursor(1);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.modelQuery = this.modelQuery.slice(0, -1);
      this.moveModelCursor(0);
      this.requestRender();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.modelQuery += data;
      this.moveModelCursor(0);
      this.requestRender();
    }
  }

  private moveModelCursor(delta: -1 | 0 | 1): void {
    const count = this.filteredModelEntries().length;
    if (count === 0) return;
    this.modelCursor = delta === 0
      ? Math.min(this.modelCursor, count - 1)
      : (this.modelCursor + delta + count) % count;
    this.requestRender();
  }

  private handleThinkingInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      const options = this.thinkingOptions();
      const selected = options[this.thinkingCursor];
      if (selected) this.applyThinking(this.cursor, selected.value);
      return;
    }
    if (matchesKey(data, Key.up) || (matchesKey(data, "k") && !this.modelQuery)) {
      this.thinkingCursor = this.thinkingCursor === 0
        ? this.thinkingOptions().length - 1
        : this.thinkingCursor - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || (matchesKey(data, "j") && !this.modelQuery)) {
      this.thinkingCursor = (this.thinkingCursor + 1) % this.thinkingOptions().length;
      this.requestRender();
    }
  }

  private thinkingOptions(): Array<{ value: string; label: string; active: boolean }> {
    const task = this.tasks[this.cursor];
    const override = this.overrides[this.cursor];
    const effective = override?.thinking !== undefined
      ? (override.thinking ?? undefined)
      : task?.thinking;
    const options = [
      {
        value: INHERIT_THINKING,
        label: this.t("ask.inheritThinking"),
        active: effective === undefined,
      },
      ...TEAMMATE_THINKING_LEVELS.map((level) => ({
        value: level,
        label: level,
        active: effective === level,
      })),
    ];
    return options;
  }

  private renderTasks(width: number): string[] {
    const w = Math.max(1, width - 2);
    const rows: string[] = [];
    rows.push(`${this.theme.fg("accent", this.theme.bold(this.t("ask.title")))} ${this.theme.fg("dim", this.t("ask.taskCount", { count: this.tasks.length }))}`);
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    const start = Math.max(0, Math.min(this.tasks.length - MAX_VISIBLE, this.cursor - Math.floor(MAX_VISIBLE / 2)));
    const visible = this.tasks.slice(start, start + MAX_VISIBLE);
    for (let offset = 0; offset < visible.length; offset++) {
      const index = start + offset;
      const selected = index === this.cursor;
      const prefix = selected ? this.theme.fg("accent", "▸") : " ";
      const task = visible[offset]!;
      const override = this.overrides[index];
      const marker = override
        ? this.theme.fg("warning", "✎")
        : selected
          ? this.theme.fg("accent", "●")
          : this.theme.fg("dim", "○");
      const model = override?.model !== undefined
        ? (override.model ?? this.t("ask.inheritModel"))
        : (task.model ?? this.t("ask.inheritModel"));
      const thinking = override?.thinking !== undefined
        ? (override.thinking ?? this.t("ask.inheritThinking"))
        : (task.thinking ?? this.t("ask.inheritThinking"));
      const location = this.locationLabel(index);
      const summary = truncateToWidth(
        `${prefix} ${marker} #${index + 1} ${this.theme.bold(task.name ? `@${task.name}` : task.agent)} ${this.theme.fg("dim", `· ${model} · think ${thinking} · ${location}`)}`,
        w,
        "…",
      );
      rows.push(summary);
      if (selected) {
        rows.push(this.theme.fg("muted", truncateToWidth(`  ${sanitizeLine(task.prompt)}`, w, "…")));
      }
    }
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    rows.push(this.theme.fg("dim", [
      this.t("ask.confirm"),
      this.t("ask.cancel"),
      this.t("ask.pickModel"),
      this.t("ask.pickThinking"),
      this.t("ask.pickLocation"),
    ].join(" · ")));
    return this.frame(rows, width);
  }

  private renderModelPicker(width: number): string[] {
    const w = Math.max(1, width - 2);
    const task = this.tasks[this.cursor];
    const rows: string[] = [];
    rows.push(`${this.theme.fg("accent", this.theme.bold(this.t("ask.modelPickerTitle")))} ${this.theme.fg("dim", `#${this.cursor + 1} ${task?.name ? `@${task.name}` : task?.agent ?? ""}`)}`);
    const marker = this.focused ? CURSOR_MARKER : "";
    const queryText = this.modelQuery ? `${this.modelQuery}${marker}` : `${marker}${this.theme.fg("dim", this.t("ask.modelSearch"))}`;
    rows.push(`${this.theme.fg("accent", "›")} ${queryText}`);
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    const entries = this.filteredModelEntries();
    if (entries.length === 1) {
      rows.push(`   ${entries[0]!.label}${entries[0]!.badge ? ` ${this.theme.fg("muted", `[${entries[0]!.badge}]`)}` : ""}${entries[0]!.current ? this.theme.fg("success", " ✓") : ""}`);
      rows.push(this.theme.fg("muted", this.t("ask.noModels")));
    } else {
      const start = Math.max(0, Math.min(entries.length - 1 - MAX_VISIBLE, this.modelCursor - Math.floor(MAX_VISIBLE / 2)));
      const visible = entries.slice(start, start + MAX_VISIBLE);
      for (let offset = 0; offset < visible.length; offset++) {
        const entry = visible[offset]!;
        const index = start + offset;
        const selected = index === this.modelCursor;
        const badge = entry.badge ? ` ${this.theme.fg("muted", `[${entry.badge}]`)}` : "";
        const current = entry.current ? this.theme.fg("success", " ✓") : "";
        const line = selected
          ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", entry.label)}${badge}${current}`
          : `  ${entry.label}${badge}${current}`;
        rows.push(truncateToWidth(line, w, "…"));
      }
    }
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    rows.push(this.theme.fg("dim", [
      this.t("ask.selectModel"),
      this.t("ask.back"),
    ].join(" · ")));
    return this.frame(rows, width);
  }

  private renderThinkingPicker(width: number): string[] {
    const w = Math.max(1, width - 2);
    const task = this.tasks[this.cursor];
    const rows: string[] = [];
    rows.push(`${this.theme.fg("accent", this.theme.bold(this.t("ask.thinkingPickerTitle")))} ${this.theme.fg("dim", `#${this.cursor + 1} ${task?.name ? `@${task.name}` : task?.agent ?? ""}`)}`);
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    const options = this.thinkingOptions();
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === this.thinkingCursor;
      const current = option.active ? this.theme.fg("success", " ✓") : "";
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", option.label)}${current}`
        : `  ${option.label}${current}`;
      rows.push(truncateToWidth(line, w, "…"));
    }
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    rows.push(this.theme.fg("dim", [
      this.t("ask.selectModel"),
      this.t("ask.back"),
    ].join(" · ")));
    return this.frame(rows, width);
  }

  private renderLocationPicker(width: number): string[] {
    const w = Math.max(1, width - 2);
    const task = this.tasks[this.cursor];
    const rows: string[] = [];
    rows.push(`${this.theme.fg("accent", this.theme.bold(this.t("ask.locationPickerTitle")))} ${this.theme.fg("dim", `#${this.cursor + 1} ${task?.name ? `@${task.name}` : task?.agent ?? ""}`)}`);
    if (this.statusText) {
      rows.push(this.theme.fg("warning", truncateToWidth(this.statusText, w, "…")));
    }
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    if (this.locationSubmode === "input") {
      const marker = this.focused ? CURSOR_MARKER : "";
      const queryText = this.locationInput
        ? `${this.locationInput}${marker}`
        : `${marker}${this.theme.fg("dim", this.t("ask.locationInput"))}`;
      rows.push(`${this.theme.fg("accent", "›")} ${queryText}`);
      rows.push(this.theme.fg("dim", this.t("ask.locationInputHint")));
      rows.push(this.theme.fg("dim", [this.t("ask.confirm"), this.t("ask.back")].join(" · ")));
      return this.frame(rows, width);
    }
    if (this.locationSubmode === "confirm") {
      rows.push(this.theme.fg("warning", truncateToWidth(
        this.t("ask.locationOutside", { path: this.locationConfirmPath }),
        w,
        "…",
      )));
      rows.push(this.theme.fg("dim", this.t("ask.locationOutsideConfirm")));
      rows.push(this.theme.fg("dim", [this.t("ask.confirm"), this.t("ask.cancel")].join(" · ")));
      return this.frame(rows, width);
    }
    const options = this.locationOptions(this.cursor);
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === this.locationCursor;
      const current = option.active ? this.theme.fg("success", " ✓") : "";
      const disabled = option.disabled ? this.theme.fg("muted", ` ${this.t("ask.locationRemoteDisabledShort")}`) : "";
      const badge = option.badge ? ` ${this.theme.fg("muted", `[${option.badge}]`)}` : "";
      const line = selected
        ? `${this.theme.fg("accent", "→ ")}${this.theme.fg("accent", option.label)}${badge}${disabled}${current}`
        : `  ${option.label}${badge}${disabled}${current}`;
      rows.push(truncateToWidth(line, w, "…"));
    }
    rows.push(this.theme.fg("dim", "─".repeat(w)));
    rows.push(this.theme.fg("dim", [
      this.t("ask.selectModel"),
      this.t("ask.locationApplyAll"),
      this.t("ask.back"),
    ].join(" · ")));
    return this.frame(rows, width);
  }

  private effectiveModel(): string | undefined {
    const override = this.overrides[this.cursor];
    if (override?.model !== undefined) return override.model ?? undefined;
    return this.tasks[this.cursor]?.model;
  }

  render(width: number): string[] {
    this.width = Math.max(1, Math.min(width, 100));
    if (this.mode === "model") return this.renderModelPicker(this.width);
    if (this.mode === "thinking") return this.renderThinkingPicker(this.width);
    if (this.mode === "location") return this.renderLocationPicker(this.width);
    return this.renderTasks(this.width);
  }

  private width = 80;

  private frame(rows: string[], width: number): string[] {
    const inner = Math.max(1, width - 2);
    const top = `┌${"─".repeat(inner)}┐`;
    const bottom = `└${"─".repeat(inner)}┘`;
    return [
      top,
      ...rows.map((row) => {
        const line = truncateToWidth(row, inner, "…");
        return `│${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}│`;
      }),
      bottom,
    ];
  }
}

/** Ask the user to confirm or adjust model provider/thinking before dispatch. */
export async function showModelAskOverlay(
  ctx: ExtensionContext,
  options: ModelAskOverlayOptions,
): Promise<ModelAskResult | null> {
  return ctx.ui.custom<ModelAskResult | null>(
    (tui, theme, _keybindings, done) => {
      const overlay = new ModelAskOverlay(
        theme as AskTheme,
        options,
        () => tui.requestRender(),
        done,
      );
      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => overlay.handleInput(data),
        invalidate: () => overlay.invalidate(),
        dispose: () => overlay.dispose(),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" } },
  );
}
