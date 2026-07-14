export const TEAMMATE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type TeammateThinkingLevel = (typeof TEAMMATE_THINKING_LEVELS)[number];

export const TEAMMATE_THINKING_INPUTS = [...TEAMMATE_THINKING_LEVELS, "max"] as const;

export type TeammateThinkingInput = (typeof TEAMMATE_THINKING_INPUTS)[number];

export function parseTeammateThinkingLevel(value: unknown): TeammateThinkingLevel | undefined {
  if (value === "max") return "xhigh";
  return typeof value === "string" && TEAMMATE_THINKING_LEVELS.includes(value as TeammateThinkingLevel)
    ? value as TeammateThinkingLevel
    : undefined;
}
