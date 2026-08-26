export const RUNTIME_V2_ROLLOUT_ENV = "PI_TEAMMATE_RUNTIME_V2_MODE" as const;
export type RuntimeV2RolloutMode = "disabled" | "shadow";

/** Fail closed so an absent or misspelled value never enables disk writes. */
export function parseRuntimeV2RolloutMode(value: unknown): RuntimeV2RolloutMode {
  return typeof value === "string" && value.trim().toLowerCase() === "shadow" ? "shadow" : "disabled";
}
