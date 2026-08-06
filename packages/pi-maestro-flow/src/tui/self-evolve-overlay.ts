/**
 * Self-evolve panel overlay — read-only status display for the evolution
 * configuration and dry-run candidate collection.
 *
 * Read-only by design: config changes go through `/self-evolve config`
 * (validated + persisted). The panel only refreshes and closes.
 */

import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  type SelfEvolveConfig,
  type SelfEvolveCounters,
  type SelfEvolveSignal,
  formatConfigSummary,
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
    const { view } = this;
    const { config, counters } = view;
    const configText = formatConfigSummary(config, view.source, view.resolvedModel).split("\n");

    const out: string[] = [];
    out.push("── SELF-EVOLVE PANEL ─────────────────────────────────");
    out.push(...configText.map((line) => ` ${line}`));
    out.push("");
    out.push(` counters: signals=${counters.signals} · deduped=${counters.deduped} · suppressed=${counters.suppressed} · failures=${counters.failures}`);
    out.push(` last: ${counters.lastSource ?? "(none)"}${counters.lastSignalAt ? ` · ${new Date(counters.lastSignalAt).toLocaleTimeString()}` : ""}`);
    if (counters.lastError) out.push(` error: ${truncateToWidth(counters.lastError, safeWidth - 8)}`);
    if (view.suggestionsDir) out.push(` dir: ${view.suggestionsDir}`);
    out.push("");
    out.push(` recent signals: ${view.recentSignals.length}`);
    for (const signal of view.recentSignals.slice(-8)) {
      const time = new Date(signal.createdAt).toLocaleTimeString();
      const title = truncateToWidth(signal.title, safeWidth - 14);
      out.push(`  [${time}] ${signal.source} · ${signal.candidateType}: ${title}`);
    }
    out.push("");
    out.push(" keys: r refresh · q/esc close — config changes via /self-evolve config <key>=<value>");
    return out;
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
}
