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
    cachedInternals = (async () => {
      const packageEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const distRoot = dirname(fileURLToPath(packageEntryUrl));
      const module = await import(pathToFileURL(join(distRoot, "core", "compaction", "compaction.js")).href);
      if (typeof module.prepareCompaction !== "function") {
        throw new Error("Pi prepareCompaction() is unavailable");
      }
      return { prepareCompaction: module.prepareCompaction };
    })();
  }
  return cachedInternals;
}
