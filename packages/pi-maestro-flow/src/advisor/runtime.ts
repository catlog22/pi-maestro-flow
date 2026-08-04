/**
 * Advisor runtime — pure logic for turn-level quality supervision.
 *
 * The advisor is a low-frequency second-model reviewer attached to the main
 * session: at each `agent_end` it reviews a compact tail of the turn
 * transcript, produces a verdict (on-track / concern / blocker), and — when a
 * concern or blocker is raised — injects an `<advisory>` message back into
 * the primary session through the shared supervision DeliveryGate (cooldown,
 * normalized dedupe, interrupt downgrade).
 *
 * This module is host-free and unit-testable; host wiring (events, model
 * dispatch, message delivery) lives in `extension.ts`.
 */

import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdvisorConfig {
  /** Master switch; the advisor only evaluates while enabled. */
  enabled: boolean;
  /** Project-specific review priorities appended to the evaluation prompt. */
  guide: string;
  /** Cooldown between interrupting deliveries (ms). Default 300_000 (5 min). */
  cooldownMs: number;
  /** Max transcript tail messages included in the evaluation prompt. Default 8. */
  maxTailMessages: number;
  /** Max serialized transcript tail characters. Default 4_000. */
  maxTailChars: number;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  guide: "",
  cooldownMs: 300_000,
  maxTailMessages: 8,
  maxTailChars: 4_000,
};

export type AdvisorVerdictStatus = "on-track" | "concern" | "blocker";

export interface AdvisorVerdict {
  status: AdvisorVerdictStatus;
  reason?: string;
  message?: string;
}

export interface AdvisorRuntimeState {
  /** Last evaluation time (ms epoch) or undefined before the first run. */
  lastEvaluatedAt?: number;
  /** Last verdict status. */
  lastStatus?: AdvisorVerdictStatus;
  /** Number of deliveries actually sent. */
  deliveries: number;
  /** Number of deliveries suppressed by the gate (cooldown/dedupe/downgrade). */
  suppressed: number;
  /** Number of evaluations that produced no actionable verdict. */
  uneventful: number;
}

export function createAdvisorRuntimeState(): AdvisorRuntimeState {
  return { deliveries: 0, suppressed: 0, uneventful: 0 };
}

/** Project-scoped config path (`.pi/advisor.json`), matching the hooks layout. */
export function advisorConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".pi", "advisor.json");
}

// ---------------------------------------------------------------------------
// Transcript tail serialization
// ---------------------------------------------------------------------------

interface SerializableMessage {
  role?: string;
  content?: unknown;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  customType?: string;
}

function messageText(message: SerializableMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      const blockText = (block as { text?: unknown } | null)?.text;
      if (typeof blockText === "string") text += blockText;
    }
    return text;
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Compact one-line-per-message serialization of the transcript tail, bounded
 * by message count and total characters. Tool results collapse to a tool
 * name + short text preview; custom entries to their type + short preview.
 */
export function serializeTranscriptTail(
  messages: AgentMessage[],
  maxMessages = DEFAULT_ADVISOR_CONFIG.maxTailMessages,
  maxChars = DEFAULT_ADVISOR_CONFIG.maxTailChars,
): string {
  const tail = messages.slice(-maxMessages);
  const lines: string[] = [];
  let budget = maxChars;

  for (const message of tail) {
    if (budget <= 0) break;
    const record = message as unknown as SerializableMessage;
    const role = record.role ?? "";
    const text = messageText(record);
    let line: string;
    if (role === "user") {
      line = `USER: ${text}`;
    } else if (role === "assistant") {
      line = `ASSISTANT: ${text}`;
    } else if (role === "tool") {
      const name = record.name ?? record.toolName ?? "tool";
      line = `TOOL ${name}: ${text}`;
    } else if (record.customType) {
      line = `CUSTOM ${record.customType}: ${text}`;
    } else {
      line = `${role || "MESSAGE"}: ${text}`;
    }
    const normalized = line.replace(/\s*\n+/g, "\n").trim();
    if (!normalized) continue;
    const truncated = truncate(normalized, budget);
    lines.push(truncated);
    // Reserve one char for the join separator so the serialized tail stays
    // within maxChars even after lines are joined with "\n".
    budget -= truncated.length + 1;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Evaluation prompt
// ---------------------------------------------------------------------------

export const ADVISOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { enum: ["on-track", "concern", "blocker"] },
    reason: { type: "string" },
    message: { type: "string" },
  },
  required: ["status"],
};

export function buildAdvisorPrompt(config: AdvisorConfig, tail: string): string {
  const guideBlock = config.guide.trim()
    ? `\nEspecially pay attention to:\n<attention>\n${config.guide.trim()}\n</attention>`
    : "";
  return [
    "You are the advisor: a passive second-model reviewer of the primary coding agent.",
    "Review the transcript tail below and decide whether the agent is on track.",
    "Raise a concern for material risk, wrong direction, missing constraints, or hallucinated APIs.",
    "Raise a blocker only when continuing would clearly waste work or produce broken output.",
    "Prefer concise, specific, actionable notes. Say nothing when on track.",
    "Return ONLY a JSON object: { \"status\": \"on-track\" | \"concern\" | \"blocker\", \"reason\": \"...\", \"message\": \"short corrective note\" }",
    "If on-track, message should be empty.",
    guideBlock,
    "",
    "<transcript-tail>",
    tail || "(no transcript tail available)",
    "</transcript-tail>",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Verdict normalization
// ---------------------------------------------------------------------------

export function normalizeAdvisorVerdict(value: unknown): AdvisorVerdict | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "on-track" && status !== "concern" && status !== "blocker") return undefined;
  return {
    status,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

/** Legacy JSON-text fallback for the shared evaluator's fallbackTextParser. */
export function parseAdvisorVerdictText(raw: string): AdvisorVerdict | undefined {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return undefined;
    return normalizeAdvisorVerdict(JSON.parse(jsonMatch[0]));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Advisory delivery formatting
// ---------------------------------------------------------------------------

/** Maps a verdict severity to the shared delivery mode. */
export function verdictDeliveryMode(verdict: AdvisorVerdict): "interrupt" | "batch" | undefined {
  if (verdict.status === "blocker" || verdict.status === "concern") return "interrupt";
  return undefined; // on-track: no delivery
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Renders an advisory note into the `<advisory>` element the primary agent
 * sees. The primary system prompt never mentions advisories, so the
 * `guidance` attribute is the only cue that the note is advice to weigh,
 * not an instruction to obey.
 */
export function formatAdvisory(message: string, severity: "nit" | "concern" | "blocker"): string {
  const body = xmlEscape(message.trim());
  return [
    `<advisory severity="${severity}" guidance="weigh, don't blindly obey">`,
    body,
    "</advisory>",
  ].join("\n");
}

export function deliverySeverityFor(verdict: AdvisorVerdict): "concern" | "blocker" {
  return verdict.status === "blocker" ? "blocker" : "concern";
}
