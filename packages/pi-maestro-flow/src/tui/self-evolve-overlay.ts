/**
 * Self-evolve panel overlay — read-only status display for the evolution
 * configuration and dry-run candidate collection.
 *
 * Read-only by design: config changes go through `/self-evolve config`
 * (validated + persisted). The panel only refreshes and closes.
 *
 * The panel is theme-aware (host `Theme`), mirroring the Todo/Goal overlay
 * card rendering; `focused` drives a visible focus affordance so the panel
 * reads as interactive (keys: r refresh · q/esc close).
 */

import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
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
    const safeWidth = Math.max(1, Math.min(width, 110));
    const inner = Math.max(1, safeWidth - 2);
    const rows: string[] = [
      this.header(inner),
      this.separator(inner),
      ...this.configRows(inner),
      this.separator(inner),
      ...this.counterRows(inner),
      this.separator(inner),
      ...this.signalRows(inner),
      this.separator(inner),
      this.helpLine(inner),
    ];
    return this.card(rows, safeWidth);
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

  private header(width: number): string {
    const theme = this.params.theme;
    const { config, source } = this.view;
    const state = config.enabled ? theme.fg("success", "● on") : theme.fg("dim", "○ off");
    const focus = this.focused ? theme.fg("accent", "· keys live") : theme.fg("dim", "· not focused");
    return fitLine(
      `${theme.bold("SELF-EVOLVE PANEL")} ${state} · ${theme.fg("dim", source)}${focus}`,
      width,
    );
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
      rows.push(fitLine(`${theme.fg("error", "error")} ${truncateToWidth(counters.lastError, Math.max(1, width - 8))}`, width));
    }
    return rows;
  }

  private signalRows(width: number): string[] {
    const theme = this.params.theme;
    const signals = this.view.recentSignals.slice(-8);
    if (signals.length === 0) {
      return [fitLine(`${theme.fg("dim", "recent signals")} none yet`, width)];
    }
    const rows = [fitLine(`${theme.fg("dim", "recent signals")} ${signals.length}`, width)];
    for (const signal of signals) {
      const time = new Date(signal.createdAt).toLocaleTimeString();
      const type = this.candidateTypeColor(signal.candidateType, signal.candidateType);
      rows.push(fitLine(`  [${theme.fg("dim", time)}] ${signal.source} · ${type}: ${signal.title}`, width));
    }
    return rows;
  }

  private candidateTypeColor(text: string, fallback: string): string {
    const theme = this.params.theme;
    if (text === "knowhow") return theme.fg("success", fallback);
    if (text === "spec") return theme.fg("warning", fallback);
    return theme.fg("dim", fallback);
  }

  private separator(width: number): string {
    return this.params.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
  }

  private helpLine(width: number): string {
    const theme = this.params.theme;
    const focus = this.focused ? theme.fg("accent", "●") : theme.fg("dim", "○");
    return fitSegments(width, [
      `${focus}`,
      theme.fg("dim", "r refresh"),
      theme.fg("dim", "q/esc close"),
      theme.fg("dim", "config via /self-evolve config <key>=<value>"),
    ]);
  }

  /** Rounded card; the border turns accent-colored while the panel has focus. */
  private card(rows: string[], width: number): string[] {
    const theme = this.params.theme;
    const edge = "─".repeat(Math.max(0, width - 2));
    const borderColor = this.focused ? "borderAccent" : "borderMuted";
    const border = (glyph: string) => theme.bg("customMessageBg", theme.fg(borderColor, glyph));
    const out: string[] = [border(`╭${edge}╮`)];
    for (const row of rows) {
      out.push(theme.bg("customMessageBg", pad(` ${row}`, width)));
    }
    out.push(border(`╰${edge}╯`));
    return out;
  }
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "…");
}

function fitSegments(width: number, segments: readonly string[]): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(" · ");
    if (visibleWidth(candidate) > width) break;
    kept.push(segment);
  }
  return kept.length ? kept.join(" · ") : fitLine(segments[0] ?? "", width);
}

function pad(value: string, width: number): string {
  const fitted = fitLine(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
