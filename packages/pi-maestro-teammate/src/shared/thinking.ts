export const TEAMMATE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type TeammateThinkingLevel = (typeof TEAMMATE_THINKING_LEVELS)[number];

// "max" is a first-class level, matching the Pi runtime ThinkingLevel; it is
// no longer folded into "xhigh". The input set is identical to the level set.
export const TEAMMATE_THINKING_INPUTS = [...TEAMMATE_THINKING_LEVELS] as const;

export type TeammateThinkingInput = (typeof TEAMMATE_THINKING_INPUTS)[number];

export function parseTeammateThinkingLevel(value: unknown): TeammateThinkingLevel | undefined {
  return typeof value === "string" && TEAMMATE_THINKING_LEVELS.includes(value as TeammateThinkingLevel)
    ? value as TeammateThinkingLevel
    : undefined;
}
