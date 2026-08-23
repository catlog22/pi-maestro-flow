/**
 * Process-wide SopRegistry singleton.
 *
 * Tools (browser, computer_use) share one registry so the knowhow directory is
 * scanned once per refresh. The registry is initialized lazily on first access
 * and invalidated on session boundaries; the embedded baselines are baked in
 * so a missing knowhow dir still serves the full SOP set.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { SopRegistry, type EmbeddedBaselines } from "./sop-registry.ts";
import { BROWSER_SOPS_BASELINE, BROWSER_HELPER_QUICKREF } from "./embedded/browser.ts";
import { COMPUTER_USE_SOPS_BASELINE, COMPUTER_USE_INDEX_FOOTER } from "./embedded/computer-use.ts";

const EMBEDDED_BASELINES: EmbeddedBaselines = {
  browser: BROWSER_SOPS_BASELINE,
  computer_use: COMPUTER_USE_SOPS_BASELINE,
};

function globalKnowhowDir(): string | undefined {
  // Optional global knowhow dir; read-only. Resolved lazily so tests that pin
  // the project dir do not accidentally pull in global entries.
  return join(homedir(), ".maestro", "knowhow");
}

let registry: SopRegistry | undefined;

export function getSopRegistry(cwd: string = process.cwd()): SopRegistry {
  if (!registry) {
    registry = new SopRegistry({
      cwd,
      globalDir: globalKnowhowDir(),
      embedded: EMBEDDED_BASELINES,
    });
  }
  return registry;
}

/** Drop the singleton (used on session boundary / tests). */
export function resetSopRegistry(): void {
  registry = undefined;
}

/** Helper quickref + footer map per tool (passed to SopRegistry.renderIndex). */
export const SOP_INDEX_EXTRAS: Record<string, string> = {
  browser: BROWSER_HELPER_QUICKREF,
  computer_use: COMPUTER_USE_INDEX_FOOTER,
};

/** Header renderer per tool (mirrors the former renderSopIndex signatures). */
export const SOP_INDEX_HEADERS: Record<string, (count: number) => string> = {
  browser: (n) => `Browser SOP Registry — ${n} documents.\nRead BEFORE the matching operation: call browser { action: "guide", topic: "<id>" } to load one document.`,
  computer_use: (n) => `Computer-use SOP Registry — ${n} documents.\nRead before desktop operations: computer_use { action: "guide", topic: "<id>" }.`,
};
