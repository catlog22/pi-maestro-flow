/**
 * Built-in classification domains owned by the teammate package.
 *
 * - `retry-error`: provider failure → RetryErrorKind. The L0 rules are the
 *   existing `classifyRetryErrorDetailed` chain; JEV's role is judging the
 *   default (unrecognized) branch. Shadow-only in this increment — the sync
 *   retry boundary cannot await an HTTP call, so adjudication is deferred
 *   until a shadow corpus validates agreement.
 * - `file-value`: new-context handoff file annotation →
 *   required|conditional|skip|unknown. JEV-primary (no rule opinion); the
 *   `unknown` fallback keeps unannotated references honest.
 */

import { classifyRetryErrorDetailed, type RetryErrorKind } from "../runs/retry.ts";
import { registerClassifyDomain } from "./engine.ts";
import type { ClassifyDomain } from "./types.ts";

// ---------------------------------------------------------------------------
// retry-error
// ---------------------------------------------------------------------------

export interface RetryErrorInput {
  message?: string;
  status?: number;
}

const RETRY_ERROR_CRITERIA: Record<RetryErrorKind, string> = {
  network:
    "Transport-level failure: connection reset/refused/timeout, DNS, socket, TLS, broken stream, fetch failed. Retrying the same model may succeed.",
  provider:
    "Provider-side transient failure: HTTP 408/429/5xx, rate limit, concurrency limit, overloaded, capacity, temporary upstream outage. Retrying the same model may succeed.",
  "fallback-only":
    "The request can only succeed on a different model/account: insufficient quota/billing (402), model unavailable/retired/not found for this account. Retrying the same model will NOT help, switching may.",
  auth:
    "Authentication or permission failure: 401/403, invalid/expired/revoked API key or token, unauthorized, forbidden. Retrying the same credential cannot help.",
  "non-retryable":
    "Permanent or non-model failure: user/lifecycle abort or cancellation, malformed request (400/404/422), context length exceeded, validation error, local infrastructure failure (spawn, child process). Neither retrying nor switching models addresses it.",
};

export const retryErrorDomain: ClassifyDomain<RetryErrorKind, RetryErrorInput> = {
  name: "retry-error",
  // Sync-only: the retry boundary cannot await. "jev" is intentionally absent —
  // adjudication arrives only after the shadow corpus validates agreement.
  modes: ["off", "shadow"],
  rules(input) {
    const { kind, defaulted } = classifyRetryErrorDetailed(input.message, input.status);
    return { label: kind, terminal: !defaulted };
  },
  state(input) {
    const parts: string[] = [];
    if (input.status !== undefined) parts.push(`HTTP status: ${input.status}`);
    parts.push(`Provider error message: ${input.message ?? "(none)"}`);
    return parts.join("\n").slice(0, 2_000);
  },
  questions: () => ({
    kind: {
      type: "choice",
      instructions:
        "Classify this model/provider request failure for retry and fallback decisions. Choose the single best bucket.",
      criteria: RETRY_ERROR_CRITERIA,
    },
  }),
  decide(answers) {
    const answer = answers.kind;
    if (answer?.type !== "choice") return undefined;
    const label = answer.choice as RetryErrorKind;
    if (!Object.hasOwn(RETRY_ERROR_CRITERIA, label)) return undefined;
    return {
      label,
      confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0.5,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    };
  },
  fallback: () => ({ label: "provider", confidence: 0 }),
};

// ---------------------------------------------------------------------------
// file-value (new-context handoff annotation)
// ---------------------------------------------------------------------------

export type FileValueLabel = "required" | "conditional" | "skip" | "unknown";

export interface FileValueInput {
  /** The referenced path/URI being annotated. */
  path: string;
  /** The next action the handoff recommends (context for relevance). */
  nextAction?: string;
  /** Why the annotator thought it matters, when present. */
  reason?: string;
  /** Prior role: modified | read | referenced, when known. */
  role?: string;
}

const FILE_VALUE_CRITERIA: Record<FileValueLabel, string> = {
  required: "Needed for the named next action — the action cannot proceed correctly without loading it.",
  conditional:
    "Load only when a named trigger occurs (e.g. touching that subsystem); not needed for the default next action.",
  skip: "No incremental value now: unrelated background, superseded material, or content already preserved elsewhere.",
  unknown: "Relevance to the next action is not established from the given context.",
};

export const fileValueDomain: ClassifyDomain<FileValueLabel, FileValueInput> = {
  name: "file-value",
  modes: ["off", "shadow", "jev"],
  // No L0 opinion: filename/recency are not relevance evidence (handoff rule).
  rules: () => undefined,
  state(input) {
    return [
      `File reference: ${input.path}`,
      `Next action: ${input.nextAction ?? "(unspecified)"}`,
      `Annotation reason: ${input.reason ?? "(none)"}`,
      `Prior role: ${input.role ?? "(unknown)"}`,
    ].join("\n").slice(0, 1_500);
  },
  questions: () => ({
    value: {
      type: "choice",
      instructions:
        "Judge the loading value of this file for the stated next action. Easy to load does not mean useful to load; relevance must be tied to the next action, not to filename, recency, or prior reads.",
      criteria: FILE_VALUE_CRITERIA,
    },
  }),
  decide(answers) {
    const answer = answers.value;
    if (answer?.type !== "choice") return undefined;
    const label = answer.choice as FileValueLabel;
    if (!Object.hasOwn(FILE_VALUE_CRITERIA, label)) return undefined;
    return {
      label,
      confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0.5,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    };
  },
  // "unknown" is the honest default: an unjudged reference has unknown value.
  fallback: () => ({ label: "unknown", confidence: 0 }),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Register the teammate-owned domains (idempotent — re-registering overwrites). */
export function registerBuiltinClassifyDomains(): void {
  registerClassifyDomain(retryErrorDomain);
  registerClassifyDomain(fileValueDomain);
}
