/**
 * SOP registry — merges embedded baseline SOPs with knowhow-directory SOPs.
 *
 * Merge semantics (decided in the plan): for a given `(tool, topic)` pair, the
 * document with the highest `sop_order` wins, and among equal orders the
 * knowhow (external) document wins over the embedded baseline. This keeps the
 * embedded constants as a zero-dependency fallback while letting curated
 * knowhow entries override or extend them through the normal stage→promote
 * governance flow.
 */

import type { SopDoc, SopLoaderOptions, SopSource } from "./sop-types.ts";
import { SopLoader } from "./sop-loader.ts";

export interface MergedSop {
  readonly title: string;
  readonly body: string;
  readonly source: SopSource;
  readonly filePath?: string;
}

/**
 * Registry of embedded baselines keyed by tool name. Each tool maps topic ->
 * `{title, body}`. The embedded constants are the former hardcoded
 * `BROWSER_SOPS` / `COMPUTER_USE_SOPS`, moved verbatim so a missing knowhow
 * dir still serves the full SOP set.
 */
export type EmbeddedBaselines = Readonly<Record<string, Readonly<Record<string, { title: string; body: string }>>>>;

export interface SopRegistryOptions extends SopLoaderOptions {
  /** Embedded baseline map; defaults to none (tools must register theirs). */
  readonly embedded?: EmbeddedBaselines;
}

export class SopRegistry {
  private readonly loader: SopLoader;
  private readonly embedded: EmbeddedBaselines;
  /** tool -> topic -> merged doc. */
  private merged = new Map<string, Map<string, MergedSop>>();
  private refreshPromise: Promise<void> | undefined;
  private loaded = false;

  constructor(options: SopRegistryOptions) {
    this.embedded = options.embedded ?? {};
    this.loader = new SopLoader(options);
  }

  /** Load + merge embedded baselines with knowhow docs. Idempotent; safe to call again. */
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const external = await this.loader.loadAll().catch(() => [] as SopDoc[]);
      this.merged = this.buildMerged(external);
      this.loaded = true;
      this.refreshPromise = undefined;
    })();
    return this.refreshPromise;
  }

  /** Ensure a one-time load has happened (used by tools on first `guide`). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.refresh();
  }

  /** Drop caches and force a reload on next access. */
  invalidate(): void {
    this.loader.clearCache();
    this.merged.clear();
    this.loaded = false;
  }

  /** List topics available for a tool (embedded + external, deduped, sorted). */
  topics(tool: string): string[] {
    const map = this.merged.get(tool);
    if (!map) return [];
    return [...map.keys()].sort();
  }

  /** Get the merged document for a tool+topic, or undefined. */
  get(tool: string, topic: string): MergedSop | undefined {
    const map = this.merged.get(tool);
    return map?.get(topic);
  }

  /**
   * Render the guide index for a tool, mirroring the former
   * `renderSopIndex` / `renderComputerUseSopIndex` output shape.
   */
  renderIndex(tool: string, header: (count: number) => string, helperQuickref?: string): string {
    const topics = this.topics(tool);
    const lines = topics.map((topic) => {
      const doc = this.get(tool, topic);
      return `  ${topic.padEnd(26)}${doc?.title ?? ""}`;
    });
    const parts = [header(topics.length), ...lines];
    if (helperQuickref) {
      parts.push("", helperQuickref);
    }
    return parts.join("\n");
  }

  /** Raw cache stats passthrough for diagnostics. */
  get cacheStats(): Readonly<{ size: number; hits: number; misses: number }> {
    return this.loader.cacheStats;
  }

  private buildMerged(external: readonly SopDoc[]): Map<string, Map<string, MergedSop>> {
    // Track order alongside the merged doc so external-vs-external comparisons
    // use the real `sop_order` instead of guessing from the merged entry.
    interface Slot { doc: MergedSop; order: number; }
    const slots = new Map<string, Map<string, Slot>>();
    const put = (tool: string, topic: string, doc: MergedSop, order: number): void => {
      let map = slots.get(tool);
      if (!map) {
        map = new Map();
        slots.set(tool, map);
      }
      map.set(topic, { doc, order });
    };

    // 1. Embedded baselines first (order 0, lowest priority).
    for (const [tool, topics] of Object.entries(this.embedded)) {
      for (const [topic, entry] of Object.entries(topics)) {
        put(tool, topic, { title: entry.title, body: entry.body, source: "embedded" }, 0);
      }
    }

    // 2. External knowhow overrides. Higher order wins; on equal order the
    // external document wins over embedded, and later external docs win over
    // earlier ones (stable last-writer-wins for equal orders).
    for (const doc of external) {
      const existing = slots.get(doc.tool)?.get(doc.topic);
      if (existing && existing.doc.source !== "embedded" && doc.order < existing.order) {
        continue;
      }
      const merged: MergedSop = {
        title: doc.title,
        body: doc.body,
        source: doc.source,
        ...(doc.filePath ? { filePath: doc.filePath } : {}),
      } as MergedSop;
      put(doc.tool, doc.topic, merged, doc.order);
    }

    // Flatten slots into tool -> topic -> MergedSop.
    const merged = new Map<string, Map<string, MergedSop>>();
    for (const [tool, topicMap] of slots) {
      const out = new Map<string, MergedSop>();
      for (const [topic, slot] of topicMap) out.set(topic, slot.doc);
      merged.set(tool, out);
    }
    return merged;
  }
}
