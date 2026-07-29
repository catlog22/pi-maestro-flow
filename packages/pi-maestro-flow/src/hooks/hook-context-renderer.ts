import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookContextDetails {
  source: string;
  sections?: Array<{ label: string; count: number }>;
  budgetUsed?: number;
  budgetMax?: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Extract structured metadata from a `<maestro-context>` block for rendering.
 */
export function parseMaestroContext(content: string): HookContextDetails {
  const sections: Array<{ label: string; count: number }> = [];

  let budgetUsed: number | undefined;
  let budgetMax: number | undefined;
  const budgetMatch = content.match(/budget="(\d+)\/(\d+)"/);
  if (budgetMatch) {
    budgetUsed = Number(budgetMatch[1]);
    budgetMax = Number(budgetMatch[2]);
  }

  let currentLabel: string | undefined;
  let currentCount = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      if (currentLabel) sections.push({ label: currentLabel, count: currentCount });
      currentLabel = trimmed.slice(3).trim();
      currentCount = 0;
    } else if (currentLabel && trimmed.startsWith("- ")) {
      currentCount++;
    }
  }
  if (currentLabel) sections.push({ label: currentLabel, count: currentCount });

  return { source: "hooks", sections, budgetUsed, budgetMax };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Create a single-line summary component for hook context injection.
 *
 * `⬡ wiki[matched] ×3 · keyword[测试] ×2 · 544/4096`
 */
export function createHookContextComponent(
  _content: string,
  details: HookContextDetails,
  _expanded: boolean,
  theme: Theme,
): Component {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      const parts: string[] = [];
      if (details.sections && details.sections.length > 0) {
        for (const s of details.sections) {
          parts.push(`${s.label} ×${s.count}`);
        }
      }
      const budget =
        details.budgetUsed != null && details.budgetMax != null
          ? `${details.budgetUsed}/${details.budgetMax}`
          : "";
      const icon = theme.fg("accent", "⬡");
      const text = parts.length > 0
        ? `${icon} ${parts.join(theme.fg("dim", " · "))}${budget ? ` ${theme.fg("dim", `· ${budget}`)}` : ""}`
        : `${icon}${budget ? ` ${theme.fg("dim", budget)}` : ""}`;
      return [truncateToWidth(text, safeWidth, "…")];
    },
    invalidate() {},
  };
}
