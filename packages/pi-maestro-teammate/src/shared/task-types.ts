export const TEAMMATE_TASK_TYPES = [
  "explore",
  "analysis",
  "debug",
  "planning",
  "development",
  "review",
  "testing",
] as const;

/** Built-in types remain ordered defaults; custom agents may declare more. */
export type TeammateTaskType = string;

const TASK_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export function parseTeammateTaskType(value: unknown): TeammateTaskType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return TASK_TYPE_PATTERN.test(normalized) ? normalized : undefined;
}
