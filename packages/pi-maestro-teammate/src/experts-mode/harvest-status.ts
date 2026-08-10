import type { KnowledgeHarvestSuggestion } from "./types.ts";
import { getKnowledgeSuggestions } from "./knowledge-harvest.ts";

/** Extension status key for cockpit footer + Maestro statusline. */
export const EXPERTS_HARVEST_STATUS_KEY = "experts-harvest";

/**
 * Compact status text for pending experts knowledgeSuggestions.
 * Empty string → clear the status segment.
 *
 * Formats:
 * - 0 → ""
 * - n → "HARVEST n"
 * - with kinds → "HARVEST n · pitfall:1 trade-off:2" (short)
 */
export function formatExpertsHarvestStatus(
  suggestions: readonly KnowledgeHarvestSuggestion[] | number,
): string {
  const list = typeof suggestions === "number" ? null : suggestions;
  const count = typeof suggestions === "number" ? suggestions : suggestions.length;
  if (count <= 0) return "";
  if (!list || list.length === 0) return `HARVEST ${count}`;
  const kinds = new Map<string, number>();
  for (const s of list) {
    kinds.set(s.kind, (kinds.get(s.kind) || 0) + 1);
  }
  const kindText = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k}:${n}`)
    .join(" ");
  return kindText ? `HARVEST ${count} · ${kindText}` : `HARVEST ${count}`;
}

/** Read state file and format status for UI. */
export function expertsHarvestStatusFromCwd(
  cwd = process.cwd(),
  statePath?: string,
): string {
  try {
    return formatExpertsHarvestStatus(getKnowledgeSuggestions(cwd, statePath));
  } catch {
    return "";
  }
}
