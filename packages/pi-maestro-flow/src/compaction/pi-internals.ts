import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PiCompactionInternals {
  prepareCompaction(entries: unknown[], settings: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  }): unknown;
}

let cachedInternals: Promise<PiCompactionInternals> | undefined;

/** Resolve Pi's own preparation logic so the guard cannot abort a non-compactable run. */
export function loadPiCompactionInternals(): Promise<PiCompactionInternals> {
  if (!cachedInternals) {
    const load = (async () => {
      const packageEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const distRoot = dirname(fileURLToPath(packageEntryUrl));
      const module = await import(pathToFileURL(join(distRoot, "core", "compaction", "compaction.js")).href);
      if (typeof module.prepareCompaction !== "function") {
        throw new Error("Pi prepareCompaction() is unavailable");
      }
      return { prepareCompaction: module.prepareCompaction };
    })();
    // A rejected load must not poison the cache: a transient resolution failure
    // (bundled runtime, package path change) would otherwise disable mid-turn
    // compaction for the whole process. Clear the cache so the next call retries.
    cachedInternals = load.catch((error) => {
      cachedInternals = undefined;
      throw error;
    });
  }
  return cachedInternals;
}
