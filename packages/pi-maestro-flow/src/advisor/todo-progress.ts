export interface TodoReviewConfig {
  enabled: boolean;
  mode: "active" | "shadow";
  reviewSteps: number;
  reviewActiveMs: number;
  sameFailureLimit: number;
  reflectionSteps: number;
  unresolvedSteps: number;
  unresolvedActiveMs: number;
  cooldownMs: number;
  maxReviewsPerTask: number;
  maxEscalationsPerTask: number;
}
export const DEFAULT_TODO_REVIEW_CONFIG: TodoReviewConfig = {
  enabled: false, mode: "active", reviewSteps: 12, reviewActiveMs: 480_000,
  sameFailureLimit: 3, reflectionSteps: 6, unresolvedSteps: 24,
  unresolvedActiveMs: 900_000, cooldownMs: 30_000, maxReviewsPerTask: 3,
  maxEscalationsPerTask: 1,
};
export function normalizeTodoReviewConfig(raw: unknown): TodoReviewConfig {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = { ...DEFAULT_TODO_REVIEW_CONFIG };
  if (typeof value.enabled === "boolean") result.enabled = value.enabled;
  if (value.mode === "active" || value.mode === "shadow") result.mode = value.mode;
  for (const key of ["reviewSteps", "reviewActiveMs", "sameFailureLimit", "reflectionSteps", "unresolvedSteps", "unresolvedActiveMs", "cooldownMs", "maxReviewsPerTask", "maxEscalationsPerTask"] as const) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const max = key.endsWith("Ms") ? 86_400_000 : 10_000;
    result[key] = Math.max(key === "cooldownMs" ? 0 : 1, Math.min(max, Math.floor(n)));
  }
  return result;
}

export type TodoProgressLabel = "on-track" | "waiting" | "looping" | "blocked" | "uncertain";

export interface TodoProgressInput {
  task: string;
  steps: number;
  activeMs: number;
  sameFailures: number;
  failureLimit: number;
  outcomes: string[];
  /** Host-only facts, never inferred from tool text. */
  waiting: boolean;
}
