/**
 * Self-evolve panel overlay — read-only status display + in-panel config
 * editing for the evolution runtime.
 *
 * Read-only by default: `r` refresh / `q`/`Esc` close. Editing is a first-class
 * interaction: `↑`/`↓` select a field, `Enter` toggles `enabled` or opens an
 * inline editor for the other keys, `Space` toggles the master switch,
 * `Ctrl+S` persists through the host (`onAction save`), `Esc` cancels an edit
 * or (when armed) discards uncommitted changes. `mode` is editable and toggles
 * between `dry-run` (review only) and `auto-deposit` (gate-passing candidates
 * auto-staged via the explicit CLI; never auto-promoted).
 *
 * Rendering follows the Maestro settings visual language (shared
 * `frame`/`headerLine`/`rule`/`pad` primitives from pi-cockpit): the panel
 * computes a row budget from the terminal height (matching the overlay
 * `maxHeight: 90%`), reserves the fixed chrome, and caps the signals list with
 * a "… +N more" overflow marker so the trailing help line always stays
 * visible — never clipped by the host. `focused` drives a visible non-color
 * focus affordance.
 */

import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fit, frame, headerLine, pad, rule } from "pi-cockpit/src/settings/ui-primitives.ts";
import {
  SELF_EVOLVE_MODES,
  formatDurationMs,
  setConfigValue,
  type SelfEvolveConfig,
  type SelfEvolveCounters,
  type SelfEvolveSignal,
} from "../self-evolve/runtime.ts";

export type SelfEvolveOverlayAction =
  | { type: "refresh" }
  | { type: "close" }
  | { type: "save"; config: SelfEvolveConfig };

export interface SelfEvolveOverlayView {
  source: string;
  config: SelfEvolveConfig;
  counters: SelfEvolveCounters;
  recentSignals: SelfEvolveSignal[];
  /** Resolved Phase 2B model (`provider/id`), shown in the config block. */
  resolvedModel?: string;
  /** One-line path to the suggestion dir (display only). */
  suggestionsDir?: string;
}

export interface SelfEvolveOverlayParams {
  view: SelfEvolveOverlayView;
  requestRender: () => void;
  close: () => void;
  onAction: (action: SelfEvolveOverlayAction) => void | Promise<void>;
  /** Host theme; drives all panel colors (border, status, focus). */
  theme: Theme;
}

/** Cap on signal entries shown before the overflow marker. */
const SIGNAL_ENTRY_CAP = 8;
/** Row-budget factor — must match the overlay `maxHeight` in the extension. */
const OVERLAY_MAX_HEIGHT_FACTOR = 0.9;
/** Below this width the panel collapses to a single status line. */
const NARROW_WIDTH = 20;

/** Config fields editable from the panel, in display order. */
type MenuField =
  | "enabled"
  | "mode"
  | "model"
  | "cooldownMs"
  | "maxSignalsPerSession"
  | "maxTraceChars"
  | "maxTraceMessages"
  | "maxEvidence"
  | "maxFiles"
  | "maxReviewFiles"
  | "reviewScoreThreshold";

const MENU_FIELDS: readonly MenuField[] = [
  "enabled",
  "mode",
  "model",
  "cooldownMs",
  "maxSignalsPerSession",
  "maxTraceChars",
  "maxTraceMessages",
  "maxEvidence",
  "maxFiles",
  "maxReviewFiles",
  "reviewScoreThreshold",
];

type SaveState = "clean" | "dirty" | "saving" | "saved" | "failed";

export class SelfEvolveOverlay implements Component, Focusable {
  focused = false;

  private readonly params: SelfEvolveOverlayParams;
  private view: SelfEvolveOverlayView;
  /** Working copy of the config; committed to the host on Ctrl+S. */
  private draft: SelfEvolveConfig;
  /** Baseline for dirty tracking (initial view config until a successful save). */
  private savedSnapshot: SelfEvolveConfig;
  private selected = 0;
  private editing = false;
  private editValue = "";
  private saveState: SaveState = "clean";
  private notice = "";
  private discardArmed = false;

  constructor(params: SelfEvolveOverlayParams) {
    this.params = params;
    this.view = params.view;
    this.draft = { ...params.view.config };
    this.savedSnapshot = { ...params.view.config };
  }

  invalidate(): void {}
  dispose(): void {}

  private requestRender(): void {
    this.params.requestRender();
  }

  /** Host-driven refresh: reload the view and reset the edit state. */
  update(view: SelfEvolveOverlayView): void {
    this.view = view;
    this.draft = { ...view.config };
    this.savedSnapshot = { ...view.config };
    this.editing = false;
    this.editValue = "";
    this.saveState = "clean";
    this.notice = "";
    this.discardArmed = false;
    this.params.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < NARROW_WIDTH) return [this.renderCompact(safeWidth)];
    const inner = safeWidth - 2;
    return frame(this.buildRows(inner), safeWidth, this.params.theme);
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
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      if (this.isDirty() && !this.discardArmed) {
        this.discardArmed = true;
        this.notice = "uncommitted changes · press Esc/q again to discard";
        this.requestRender();
        return;
      }
      void this.params.onAction({ type: "close" });
      return;
    }
    if (matchesKey(data, "r")) {
      if (this.isDirty() && !this.discardArmed) {
        this.discardArmed = true;
        this.notice = "uncommitted changes · press r again to reload from disk";
        this.requestRender();
        return;
      }
      void this.params.onAction({ type: "refresh" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") {
      const field = this.selectedField();
      if (field === "enabled") this.toggleEnabled();
      else if (field === "mode") this.toggleMode();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      this.activateField(this.selectedField());
    }
  }

  /** Full content rows (frame borders added by `frame`). */
  private buildRows(inner: number): string[] {
    const theme = this.params.theme;
    const configRows = this.configRows(inner);
    const detailRows = this.detailRows(inner);
    const counterRows = this.counterRows(inner);
    const entries = this.view.recentSignals.slice(-SIGNAL_ENTRY_CAP);
    const signalHeader = fitLine(`${theme.fg("dim", "recent signals")} ${entries.length}`, inner);

    // Row budget: total overlay rows ≤ floor(terminalRows × factor). Fixed
    // chrome = borders (2) + header/rule + config menu + rule + detail + rule +
    // counters + rule + signal header + rule + help; the remainder belongs to
    // signal entries.
    const terminalRows = process.stdout?.rows ?? 30;
    const overlayMax = Math.max(8, Math.floor(terminalRows * OVERLAY_MAX_HEIGHT_FACTOR));
    const fixedChrome = 2 + 1 + 1 + configRows.length + 1 + detailRows.length + 1 + counterRows.length + 1 + 1 + 1 + 1;
    const entryBudget = Math.max(0, overlayMax - fixedChrome);

    const truncated = entries.length > entryBudget;
    const visibleCount = truncated ? Math.max(0, entryBudget - 1) : Math.min(entries.length, entryBudget);
    const visible = entries.slice(0, visibleCount);
    const marker = truncated && entryBudget >= 1
      ? [theme.fg("dim", fitLine(`  … +${entries.length - visibleCount} more`, inner))]
      : [];

    const rows: string[] = [this.header(inner), rule(inner), ...configRows, rule(inner), ...detailRows, rule(inner), ...counterRows];
    if (entryBudget >= 1) {
      rows.push(
        rule(inner),
        signalHeader,
        ...visible.map((signal) => this.signalLine(signal, inner)),
        ...marker,
      );
    }
    rows.push(rule(inner), this.helpLine(inner));
    return rows;
  }

  private header(width: number): string {
    const theme = this.params.theme;
    const { config, source } = this.view;
    const state = config.enabled ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
    const focus = this.focused ? theme.fg("accent", "· keys live") : theme.fg("dim", "· not focused");
    const save = this.saveLabel() ? theme.fg("dim", this.saveLabel()) : undefined;
    return headerLine(theme, "SELF-EVOLVE PANEL", [state, theme.fg("dim", source), ...(save ? [save] : []), focus], width);
  }

  // -------------------------------------------------------------------------
  // Config menu
  // -------------------------------------------------------------------------

  private configRows(width: number): string[] {
    return MENU_FIELDS.map((field, index) => this.renderField(field, index === this.selected, width));
  }

  private renderField(field: MenuField, selected: boolean, width: number): string {
    const theme = this.params.theme;
    const marker = selected ? theme.fg("accent", "›") : " ";
    const label = selected ? theme.bold(this.fieldLabel(field)) : this.fieldLabel(field);
    const value = selected ? theme.fg("accent", this.fieldValue(field)) : this.fieldValue(field);
    return fit(`${marker} ${label} ${value}`, width);
  }

  private fieldLabel(field: MenuField): string {
    switch (field) {
      case "enabled": return "enabled";
      case "mode": return "mode";
      case "model": return "model";
      case "cooldownMs": return "cooldown";
      case "maxSignalsPerSession": return "budget";
      case "maxTraceChars": return "trace chars";
      case "maxTraceMessages": return "trace msgs";
      case "maxEvidence": return "evidence";
      case "maxFiles": return "retention";
      case "maxReviewFiles": return "review retention";
      case "reviewScoreThreshold": return "review score gate";
    }
  }

  private fieldValue(field: MenuField): string {
    const theme = this.params.theme;
    const draft = this.draft;
    switch (field) {
      case "enabled":
        return draft.enabled ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
      case "mode":
        return draft.mode;
      case "model": {
        const model = draft.model ?? "auto";
        const resolved = this.view.resolvedModel && this.view.resolvedModel !== model
          ? ` → ${this.view.resolvedModel}`
          : "";
        return `${model}${theme.fg("dim", resolved)}`;
      }
      case "cooldownMs":
        return formatDurationMs(draft.cooldownMs);
      case "maxSignalsPerSession":
        return `${draft.maxSignalsPerSession} signals/session`;
      case "maxTraceChars":
        return `${draft.maxTraceChars} chars`;
      case "maxTraceMessages":
        return `${draft.maxTraceMessages} msgs`;
      case "maxEvidence":
        return `${draft.maxEvidence} refs`;
      case "maxFiles":
        return `${draft.maxFiles} daily files`;
      case "maxReviewFiles":
        return `${draft.maxReviewFiles} daily files`;
      case "reviewScoreThreshold":
        return `${draft.reviewScoreThreshold} (stage below → uncertain)`;
    }
  }

  /** One-line guidance for the selected field (shown under the menu). */
  private fieldHint(field: MenuField): string {
    switch (field) {
      case "enabled":
        return "master switch · Enter/Space toggles collection on/off";
      case "mode":
        return `${SELF_EVOLVE_MODES.join(" | ")} — Enter/Space toggles; dry-run: review only; auto-deposit: gate-passing candidates auto-staged (pending pool, never auto-promoted)`;
      case "model":
        return 'Phase 2B LLM steps (review) · "provider/model" or "auto" to inherit the session model';
      case "cooldownMs":
        return "minimum interval between signals per source (e.g. 300000, 5m, 30s, 1.5h)";
      case "maxSignalsPerSession":
        return "max candidate signals per session (shared evaluation budget)";
      case "maxTraceChars":
        return "max serialized trace characters used for hashing/digests";
      case "maxTraceMessages":
        return "max transcript tail messages included in the digest";
      case "maxEvidence":
        return "max evidence references collected per candidate";
      case "maxFiles":
        return "recent daily suggestion files to keep (oldest archived)";
      case "maxReviewFiles":
        return "recent daily review files to keep (independent of suggestion retention)";
      case "reviewScoreThreshold":
        return "review-gate score: stage verdicts below this are downgraded to uncertain (0..1)";
    }
  }

  private detailRows(width: number): string[] {
    const theme = this.params.theme;
    const field = this.selectedField();
    const rows: string[] = [];
    if (this.editing) {
      rows.push(
        fit(`${theme.fg("dim", "edit")} ${theme.fg("accent", this.fieldLabel(field))} · current ${this.fieldValue(field)}`, width),
        fit(`${theme.fg("accent", "›")} ${this.editValue || "∅"}${theme.fg("dim", "▏")}`, width),
      );
    } else {
      rows.push(theme.fg(field === "mode" ? "warning" : "dim", fit(this.fieldHint(field), width)));
      // Disabled-state guidance: without it a first-time user cannot tell how
      // to enable the extension (review finding: zero discoverability).
      if (!this.view.config.enabled && this.view.source !== "env(PI_SELF_EVOLVE=1)") {
        rows.push(theme.fg("dim", fit(`system disabled — press Enter on enabled · or run /self-evolve on · or start pi with PI_SELF_EVOLVE=1`, width)));
      }
      if (this.view.suggestionsDir) {
        rows.push(theme.fg("dim", fit(`output: ${this.view.suggestionsDir}`, width)));
      }
    }
    if (this.notice) rows.push(this.styledNotice(this.notice, width));
    return rows;
  }

  private styledNotice(notice: string, width: number): string {
    const role = notice.startsWith("!") || notice.startsWith("×") ? "error"
      : notice.startsWith("✓") ? "success"
      : "warning";
    return this.params.theme.fg(role, fit(notice, width));
  }

  // -------------------------------------------------------------------------
  // Counters / signals (read-only sections)
  // -------------------------------------------------------------------------

  private counterRows(width: number): string[] {
    const theme = this.params.theme;
    const { counters } = this.view;
    const failures = counters.failures > 0
      ? theme.fg("error", String(counters.failures))
      : theme.fg("success", String(counters.failures));
    const rows = [
      fitLine(
        `${theme.fg("dim", "counters")} signals=${theme.fg("accent", String(counters.signals))} · ` +
        `deduped=${theme.fg("dim", String(counters.deduped))} · ` +
        `suppressed=${theme.fg("dim", String(counters.suppressed))} · ` +
        `failures=${failures}`,
        width,
      ),
    ];
    const last = `${theme.fg("dim", "last")} ${counters.lastSource ?? "(none)"}` +
      (counters.lastSignalAt ? ` · ${new Date(counters.lastSignalAt).toLocaleTimeString()}` : "");
    rows.push(fitLine(last, width));
    if (counters.lastError) {
      rows.push(fitLine(`${theme.fg("error", "error")} ${fit(counters.lastError, Math.max(1, width - 8))}`, width));
    }
    return rows;
  }

  private signalLine(signal: SelfEvolveSignal, width: number): string {
    const theme = this.params.theme;
    const createdAt = new Date(signal.createdAt);
    const sameDay = createdAt.toDateString() === new Date().toDateString();
    const time = sameDay
      ? createdAt.toLocaleTimeString()
      : createdAt.toLocaleString();
    const shortId = signal.id.startsWith("se-") ? signal.id.slice(0, 10) : signal.id;
    const type = this.candidateTypeColor(signal.candidateType, signal.candidateType);
    const project = signal.project ? theme.fg("dim", ` ${signal.project}`) : "";
    const actionable = (signal as { suggestion?: unknown }).suggestion ? "" : theme.fg("dim", " · not-actionable");
    return fitLine(`  [${theme.fg("dim", time)}] ${theme.fg("dim", shortId)}${project} ${signal.source} · ${type}: ${signal.title}${actionable}`, width);
  }

  private candidateTypeColor(text: string, fallback: string): string {
    const theme = this.params.theme;
    if (text === "knowhow") return theme.fg("success", fallback);
    if (text === "spec") return theme.fg("warning", fallback);
    return theme.fg("dim", fallback);
  }

  private helpLine(width: number): string {
    const theme = this.params.theme;
    const focus = this.focused ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const dirty = this.isDirty() ? theme.fg("warning", "· unsaved") : "";
    const text = `${focus} ${theme.fg("dim", "↑↓ select · Enter edit/toggle · Space toggle · Ctrl+S save · r refresh · q/Esc close")}${dirty}`;
    return fit(text, width);
  }

  /** Narrow terminals: collapse to a single read-only status line. */
  private renderCompact(width: number): string {
    const theme = this.params.theme;
    const { config, counters } = this.view;
    const state = config.enabled ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
    const text = `${state} SELF-EVOLVE · ${counters.signals}·${counters.deduped}·${counters.suppressed} · Ctrl+S save · r refresh · q close`;
    return theme.bg("customMessageBg", pad(fit(text, width), width));
  }

  // -------------------------------------------------------------------------
  // Editing state machine
  // -------------------------------------------------------------------------

  private selectedField(): MenuField {
    return MENU_FIELDS[this.selected] ?? MENU_FIELDS[0]!;
  }

  private move(delta: number): void {
    this.selected = (this.selected + delta + MENU_FIELDS.length) % MENU_FIELDS.length;
    this.discardArmed = false;
    this.notice = "";
    this.requestRender();
  }

  private activateField(field: MenuField): void {
    if (field === "enabled") {
      this.toggleEnabled();
      return;
    }
    if (field === "mode") {
      this.toggleMode();
      return;
    }
    this.editValue = this.editorValue(field);
    this.editing = true;
    this.notice = "";
    this.requestRender();
  }

  private editorValue(field: MenuField): string {
    switch (field) {
      case "cooldownMs": return formatDurationMs(this.draft.cooldownMs);
      case "model": return this.draft.model ?? "";
      case "mode": return this.draft.mode;
      case "reviewScoreThreshold": return String(this.draft.reviewScoreThreshold);
      default: return String(this.draft[field]);
    }
  }

  private toggleEnabled(): void {
    this.draft = { ...this.draft, enabled: !this.draft.enabled };
    this.markDirty();
  }

  /** Cycle the collection mode (dry-run ↔ auto-deposit) — no text editing. */
  private toggleMode(): void {
    const modes = SELF_EVOLVE_MODES;
    const next = modes[(modes.indexOf(this.draft.mode) + 1) % modes.length];
    this.draft = { ...this.draft, mode: next };
    this.markDirty();
  }

  private handleEditInput(data: string): void {
    const field = this.selectedField();
    if (matchesKey(data, Key.escape)) {
      this.editing = false;
      this.editValue = "";
      this.notice = "";
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      const result = setConfigValue(this.draft, field, this.editValue);
      if (result.error) {
        this.notice = `× ${result.error}`;
        this.requestRender();
        return;
      }
      this.draft = result.config;
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
    const stripped = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const printable = Array.from(stripped).filter((ch) => ch >= " " && ch !== "\x7f").join("");
    if (!printable) return;
    if (field === "model") {
      this.editValue += printable;
    } else if (field === "mode") {
      this.editValue += printable.replace(/[^a-z-]/gi, "");
    } else if (field === "cooldownMs") {
      const clean = printable.replace(/[^0-9a-z.]/gi, "");
      if (clean) this.editValue += clean;
    } else if (field === "reviewScoreThreshold") {
      const clean = printable.replace(/[^0-9.]/g, "");
      if (clean) this.editValue += clean;
    } else {
      const digits = printable.replace(/\D/g, "");
      if (digits) this.editValue += digits;
    }
    this.notice = "";
    this.requestRender();
  }

  private async save(): Promise<void> {
    if (!this.isDirty()) {
      this.notice = "no changes to save";
      this.requestRender();
      return;
    }
    this.saveState = "saving";
    this.notice = "… saving";
    this.requestRender();
    try {
      // The host persists the config, updates its in-memory copy and the
      // status bar; it rejects the promise on persistence failure.
      await this.params.onAction({ type: "save", config: this.draft });
      this.savedSnapshot = { ...this.draft };
      this.saveState = "saved";
      this.notice = "✓ saved";
      this.discardArmed = false;
      this.requestRender();
    } catch (error) {
      this.saveState = "failed";
      this.notice = `! save failed · ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender();
    }
  }

  private isDirty(): boolean {
    return JSON.stringify(this.draft) !== JSON.stringify(this.savedSnapshot);
  }

  private markDirty(): void {
    this.saveState = "dirty";
    this.notice = "";
    this.discardArmed = false;
    this.requestRender();
  }

  private saveLabel(): string {
    if (this.saveState === "saving") return "saving…";
    if (this.saveState === "failed") return "! failed";
    if (this.saveState === "dirty") return "△ unsaved";
    if (this.saveState === "saved") return "✓ saved";
    return "";
  }
}

function fitLine(value: string, width: number): string {
  return fit(value, Math.max(1, width));
}
