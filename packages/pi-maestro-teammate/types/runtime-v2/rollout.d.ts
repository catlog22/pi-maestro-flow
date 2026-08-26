export declare const RUNTIME_V2_ROLLOUT_ENV: "PI_TEAMMATE_RUNTIME_V2_MODE";
export type RuntimeV2RolloutMode = "disabled" | "shadow";
/** Fail closed so an absent or misspelled value never enables disk writes. */
export declare function parseRuntimeV2RolloutMode(value: unknown): RuntimeV2RolloutMode;
