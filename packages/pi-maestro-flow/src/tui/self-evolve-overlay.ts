/**
 * Self-evolve panel overlay — read-only status display for the evolution
 * configuration and dry-run candidate collection.
 *
 * Read-only by design: config changes go through `/self-evolve config`
 * (validated + persisted). The panel only refreshes and closes.
 *
 * Rendering follows the Maestro settings visual language (shared
 * `frame`/`headerLine`/`rule`/`pad` primitives from pi-cockpit): the
 * panel computes a row budget from the terminal height (matching the overlay
 * `maxHeight: 90%`), reserves the fixed chrome, and caps the signals list with
 * a "… +N more" overflow marker so the trailing help line always stays
 * visible — never clipped by the host. `focused` drives a visible non-color
 * focus affordance (keys: r refresh · q/esc close).
 */

import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fit, frame, headerLine, pad, rule } from "pi-cockpit/src/settings/ui-primitives.ts";
import {
  type SelfEvolveConfig,
  type SelfEvolveCounters,
  type SelfEvolveSignal,
  formatDurationMs,
} from "../self-evolve/runtime.ts";

export type SelfEvolveOverlayAction = "refresh" | "close";

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

export class SelfEvolveOverlay implements Component, Focusable {
  focused = false;

  private readonly params: SelfEvolveOverlayParams;
  private view: SelfEvolveOverlayView;

  constructor(params: SelfEvolveOverlayParams) {
    this.params = params;
    this.view = params.view;
  }

  invalidate(): void {}
  dispose(): void {}

  update(view: SelfEvolveOverlayView): void {
    this.view = view;
    this.params.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < NARROW_WIDTH) return [this.renderCompact(safeWidth)];
    const inner = safeWidth - 2;
    return frame(this.buildRows(inner), safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      void this.params.onAction("close");
      return;
    }
    if (matchesKey(data, "r")) {
      void this.params.onAction("refresh");
    }
  }

  /** Full content rows (frame borders added by `frame`). */
  private buildRows(inner: number): string[] {
    const theme = this.params.theme;
    const configRows = this.configRows(inner);
    const counterRows = this.counterRows(inner);
    const entries = this.view.recentSignals.slice(-SIGNAL_ENTRY_CAP);
    const signalHeader = fitLine(`${theme.fg("dim", "recent signals")} ${entries.length}`, inner);

    // Row budget: total overlay rows ≤ floor(terminalRows × factor). Fixed
    // chrome = borders (2) + header/rule + config + rule + counters + rule +
    // signal header + rule + help; the remainder belongs to signal entries.
    const terminalRows = process.stdout?.rows ?? 30;
    const overlayMax = Math.max(8, Math.floor(terminalRows * OVERLAY_MAX_HEIGHT_FACTOR));
    const fixedChrome = 2 + 1 + 1 + configRows.length + 1 + counterRows.length + 1 + 1 + 1 + 1;
    const entryBudget = Math.max(0, overlayMax - fixedChrome);

    const truncated = entries.length > entryBudget;
    const visibleCount = truncated ? Math.max(0, entryBudget - 1) : Math.min(entries.length, entryBudget);
    const visible = entries.slice(0, visibleCount);
    const marker = truncated && entryBudget >= 1
      ? [theme.fg("dim", fitLine(`  … +${entries.length - visibleCount} more`, inner))]
      : [];

    const rows: string[] = [this.header(inner), rule(inner), ...configRows, rule(inner), ...counterRows];
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
    return headerLine(theme, "SELF-EVOLVE PANEL", [state, theme.fg("dim", source), focus], width);
  }

  private configRows(width: number): string[] {
    const theme = this.params.theme;
    const { config } = this.view;
    const model = config.model ?? "auto";
    const resolved = this.view.resolvedModel && this.view.resolvedModel !== model
      ? ` → ${this.view.resolvedModel}`
      : "";
    const rows = [
      fitLine(`${theme.fg("dim", "mode")} dry-run — candidate signals only, never stages or promotes knowledge`, width),
      fitLine(`${theme.fg("dim", "model")} ${theme.fg("accent", model)}${theme.fg("dim", resolved)} (Phase 2B LLM steps)`, width),
      fitLine(
        `${theme.fg("dim", "cooldown")} ${theme.fg("accent", formatDurationMs(config.cooldownMs))} · ` +
        `${theme.fg("dim", "budget")} ${theme.fg("accent", String(config.maxSignalsPerSession))} signals/session`,
        width,
      ),
      fitLine(
        `${theme.fg("dim", "trace")} ${theme.fg("accent", String(config.maxTraceMessages))} msgs / ` +
        `${theme.fg("accent", String(config.maxTraceChars))} chars · ` +
        `${theme.fg("dim", "evidence")} ${theme.fg("accent", String(config.maxEvidence))} refs`,
        width,
      ),
    ];
    const retention = `${theme.fg("dim", "retention")} ${theme.fg("accent", String(config.maxFiles))} daily files`;
    if (this.view.suggestionsDir) {
      rows.push(fitLine(`${retention} · ${theme.fg("dim", this.view.suggestionsDir)}`, width));
    } else {
      rows.push(fitLine(retention, width));
    }
    return rows;
  }

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
    const time = new Date(signal.createdAt).toLocaleTimeString();
    const type = this.candidateTypeColor(signal.candidateType, signal.candidateType);
    return fitLine(`  [${theme.fg("dim", time)}] ${signal.source} · ${type}: ${signal.title}`, width);
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
    const text = `${focus} ${theme.fg("dim", "r refresh · q/esc close · config via /self-evolve config <key>=<value>")}`;
    return fit(text, width);
  }

  /** Narrow terminals: collapse to a single read-only status line. */
  private renderCompact(width: number): string {
    const theme = this.params.theme;
    const { config, counters } = this.view;
    const state = config.enabled ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
    const text = `${state} SELF-EVOLVE · ${counters.signals}·${counters.deduped}·${counters.suppressed} · r refresh · q close`;
    return theme.bg("customMessageBg", pad(fit(text, width), width));
  }
}

function fitLine(value: string, width: number): string {
  return fit(value, Math.max(1, width));
}
