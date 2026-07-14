export const TEAMMATE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type TeammateThinkingLevel = (typeof TEAMMATE_THINKING_LEVELS)[number];

export function parseTeammateThinkingLevel(value: unknown): TeammateThinkingLevel | undefined {
  return typeof value === "string" && TEAMMATE_THINKING_LEVELS.includes(value as TeammateThinkingLevel)
    ? value as TeammateThinkingLevel
    : undefined;
}
