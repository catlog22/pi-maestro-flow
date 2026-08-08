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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  cooldownMs: 5 * 60_000,
  maxReviewsPerSession: 20,
  tailMessages: 4,
  maxMessageChars: 2_000,
};

const ADVISOR_FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);
const ADVISOR_TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

function parseAdvisorBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const lower = value.trim().toLowerCase();
  if (ADVISOR_FALSE_VALUES.has(lower)) return false;
  if (ADVISOR_TRUE_VALUES.has(lower)) return true;
  return undefined;
}

function advisorPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

/**
 * Merge settings (`monitor.advisor` section) + env overrides onto defaults.
 * Env: PI_ADVISOR (on/off), PI_ADVISOR_COOLDOWN_MS, PI_ADVISOR_MAX_REVIEWS.
 */
export function normalizeAdvisorConfig(input: unknown = {}, options: { env?: NodeJS.ProcessEnv } = {}): AdvisorConfig {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const env = options.env ?? process.env;
  const config: AdvisorConfig = { ...DEFAULT_ADVISOR_CONFIG };
  const cooldown = advisorPositiveInteger(source.cooldownMs);
  if (cooldown !== undefined) config.cooldownMs = cooldown;
  const maxReviews = advisorPositiveInteger(source.maxReviewsPerSession);
  if (maxReviews !== undefined) config.maxReviewsPerSession = maxReviews;
  const tail = advisorPositiveInteger(source.tailMessages);
  if (tail !== undefined) config.tailMessages = tail;
  const chars = advisorPositiveInteger(source.maxMessageChars);
  if (chars !== undefined) config.maxMessageChars = chars;
  const envEnabled = parseAdvisorBoolean(env.PI_ADVISOR);
  if (envEnabled !== undefined) config.enabled = envEnabled;
  else if (typeof source.enabled === "boolean") config.enabled = source.enabled;
  const envCooldown = advisorPositiveInteger(env.PI_ADVISOR_COOLDOWN_MS);
  if (envCooldown !== undefined) config.cooldownMs = envCooldown;
  const envMax = advisorPositiveInteger(env.PI_ADVISOR_MAX_REVIEWS);
  if (envMax !== undefined) config.maxReviewsPerSession = envMax;
  return config;
}

export function createAdvisorState(config: AdvisorConfig = DEFAULT_ADVISOR_CONFIG): AdvisorState {
  return {
    enabled: config.enabled,
    reviews: 0,
    lastReviewAt: 0,
    gate: new DeliveryGate({
      cooldownMs: config.cooldownMs,
      dedup: { scope: "target" },
      perWindowLimit: 1,
    }),
  };
}

export function shouldReview(state: AdvisorState, config: AdvisorConfig, now: number): boolean {
  return state.enabled
    && state.reviews < config.maxReviewsPerSession
    && now - state.lastReviewAt >= config.cooldownMs;
}

// ---------------------------------------------------------------------------
// Transcript extraction + prompt
// ---------------------------------------------------------------------------

export function extractAdvisorTranscript(
  messages: readonly AdvisorMessageSlice[],
  options: { tailMessages?: number; maxMessageChars?: number } = {},
): { objective: string; transcript: string[] } {
  const tail = options.tailMessages ?? DEFAULT_ADVISOR_CONFIG.tailMessages;
  const maxChars = options.maxMessageChars ?? DEFAULT_ADVISOR_CONFIG.maxMessageChars;
  const objective = [...messages].reverse().find((message) => message?.role === "user" && message.content?.trim())
    ?.content?.trim().slice(0, maxChars) ?? "";
  const transcript = messages.slice(-tail).map((message) => {
    const role = message?.role ?? "?";
    const content = (message?.content ?? "").trim().slice(0, maxChars);
    return content ? `${role}: ${content}` : "";
  }).filter(Boolean);
  return { objective, transcript };
}

export function buildAdvisorPrompt(objective: string, transcript: string[]): string {
  return [
    "You are a turn-level quality advisor. Review the main agent's most recent turn for reasoning quality, constraint adherence, and hallucination risk.",
    "",
    ...(objective ? [`Current task: ${objective}`] : []),
    "",
    "Recent turn transcript (role: content):",
    ...(transcript.length > 0 ? transcript : ["(no transcript content available)"]),
    "",
    'Return ONLY a JSON object: { "status": "on-track" | "concern" | "blocker", "reason": "...", "guidance": "..." }',
    'Use "on-track" when the turn is sound. Use "concern" for fixable issues (missing verification, unverified claims, risky shortcuts). Use "blocker" only for severe problems (obvious factual errors presented as fact, constraint violations, destructive actions). Keep guidance under 2 sentences, specific and actionable.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Verdict parsing (structured first, text fallback)
// ---------------------------------------------------------------------------

export const ADVISOR_VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { enum: ["on-track", "concern", "blocker"] },
    reason: { type: "string" },
    guidance: { type: "string" },
  },
  required: ["status"],
};

export function parseAdvisorVerdict(raw: string): AdvisorVerdict | undefined {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const status = parsed.status === "concern" || parsed.status === "blocker" ? parsed.status : "on-track";
    return {
      status,
      ...(typeof parsed.reason === "string" && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
      ...(typeof parsed.guidance === "string" && parsed.guidance.trim() ? { guidance: parsed.guidance.trim() } : {}),
    };
  } catch {
    return undefined;
  }
}
