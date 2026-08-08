/**
 * Turn-level quality advisor — lightweight port of the oh-my-pi advisor
 * concept, following the extension decision in
 * docs/advisor-vs-monitor-relationship-20260803.md §6:
 *
 *   - LOW-FREQUENCY: review on `agent_end` (per turn), gated by cooldown —
 *     never a per-turn synchronous second model.
 *   - REUSE monitor channels: DeliveryGate frequency control (cooldown +
 *     dedup + per-window limit) and notifyMain-style delivery.
 *   - REUSE teammate routing: the review runs through the same supervised
 *     analyst evaluation as monitor Phase C.
 *
 * Orthogonal to the fleet Monitor: Monitor watches OTHER sessions/windows on
 * a tick; Advisor reviews THIS session's own turn quality (reasoning,
 * constraint adherence, hallucination risk) on agent_end. Default OFF —
 * experimental, opt-in via /advisor on or settings.
 */
import { DeliveryGate } from "../supervision/delivery.ts";
export type AdvisorSeverity = "on-track" | "concern" | "blocker";
export interface AdvisorVerdict {
    status: AdvisorSeverity;
    reason?: string;
    guidance?: string;
}
/** Transcript slice — duck-typed subset of pi's AgentMessage. */
export interface AdvisorMessageSlice {
    role?: string;
    content?: string;
}
export interface AdvisorConfig {
    /** Master switch — default OFF (experimental). */
    enabled: boolean;
    /** Minimum gap between two reviews (low-frequency guard). */
    cooldownMs: number;
    /** Max reviews per session (bounded budget). */
    maxReviewsPerSession: number;
    /** Number of trailing transcript messages fed to the reviewer. */
    tailMessages: number;
    /** Per-message character cap before truncation. */
    maxMessageChars: number;
}
export interface AdvisorState {
    enabled: boolean;
    reviews: number;
    lastReviewAt: number;
    lastVerdict?: AdvisorVerdict;
    gate: DeliveryGate;
}
export declare const DEFAULT_ADVISOR_CONFIG: AdvisorConfig;
/**
 * Merge settings (`monitor.advisor` section) + env overrides onto defaults.
 * Env: PI_ADVISOR (on/off), PI_ADVISOR_COOLDOWN_MS, PI_ADVISOR_MAX_REVIEWS.
 */
export declare function normalizeAdvisorConfig(input?: unknown, options?: {
    env?: NodeJS.ProcessEnv;
}): AdvisorConfig;
export declare function createAdvisorState(config?: AdvisorConfig): AdvisorState;
export declare function shouldReview(state: AdvisorState, config: AdvisorConfig, now: number): boolean;
export declare function extractAdvisorTranscript(messages: readonly AdvisorMessageSlice[], options?: {
    tailMessages?: number;
    maxMessageChars?: number;
}): {
    objective: string;
    transcript: string[];
};
export declare function buildAdvisorPrompt(objective: string, transcript: string[]): string;
export declare const ADVISOR_VERDICT_SCHEMA: Record<string, unknown>;
export declare function parseAdvisorVerdict(raw: string): AdvisorVerdict | undefined;
