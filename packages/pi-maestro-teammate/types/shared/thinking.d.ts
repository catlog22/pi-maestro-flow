export declare const TEAMMATE_THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type TeammateThinkingLevel = (typeof TEAMMATE_THINKING_LEVELS)[number];
export declare const TEAMMATE_THINKING_INPUTS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type TeammateThinkingInput = (typeof TEAMMATE_THINKING_INPUTS)[number];
export declare function parseTeammateThinkingLevel(value: unknown): TeammateThinkingLevel | undefined;
