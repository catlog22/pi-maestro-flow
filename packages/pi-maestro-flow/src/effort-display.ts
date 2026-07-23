import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const EFFORT_STATUS_KEY = "maestro-effort";

export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const EFFORT_BARS: Record<ThinkingLevel, string> = {
  off: "[░░░░░]",
  minimal: "[█░░░░]",
  low: "[██░░░]",
  medium: "[███░░]",
  high: "[████░]",
  xhigh: "[█████]",
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && EFFORT_LEVELS.includes(value as ThinkingLevel);
}

export function effortProgressBar(level: ThinkingLevel): string {
  return EFFORT_BARS[level];
}

export function formatEffortStatus(value: string | undefined): string {
	if (!isThinkingLevel(value)) return "";
	return value;
}
