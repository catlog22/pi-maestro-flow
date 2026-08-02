import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const EFFORT_STATUS_KEY = "maestro-effort";

export const EFFORT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && EFFORT_LEVELS.includes(value as ThinkingLevel);
}

export function formatEffortStatus(value: string | undefined): string {
	if (!isThinkingLevel(value)) return "";
	return value;
}
