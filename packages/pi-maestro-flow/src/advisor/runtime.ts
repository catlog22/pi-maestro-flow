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

export const ADVISOR_MODES = ["automatic", "manual", "hybrid"] as const;
export type AdvisorMode = typeof ADVISOR_MODES[number];

export const ADVISOR_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AdvisorThinkingLevel = typeof ADVISOR_THINKING_LEVELS[number];

export type AdvisorDisabledForModel = string | {
  model: string;
  minThinking?: AdvisorThinkingLevel;
};

export interface AdvisorConfig {
  /** Master switch for both automatic reviews and manual consultation. */
  enabled: boolean;
  /** Automatic reviews, manual consultation, or both. Legacy files default to automatic. */
  mode: AdvisorMode;
  /** Dedicated `provider/model` for advisor evaluations; unset inherits the main session model. */
  model?: string;
  /** Thinking level for manual consultations. */
  consultThinking: AdvisorThinkingLevel;
  /** Executor models for which the manual advisor tool is hidden. */
  disabledForModels: AdvisorDisabledForModel[];
  /** Project-specific review priorities appended to the evaluation prompt. */
  guide: string;
  /** Cooldown between interrupting deliveries (ms). Default 300_000 (5 min). */
  cooldownMs: number;
  /** Minimum gap between automatic review dispatches (ms). 0 disables the gap. */
  automaticReviewCooldownMs: number;
  /** Automatic review dispatch budget per session. 0 means unlimited. */
  maxAutomaticReviewsPerSession: number;
  /** Max transcript tail messages included in the evaluation prompt. Default 8. */
  maxTailMessages: number;
  /** Max serialized transcript tail characters. Default 4_000. */
  maxTailChars: number;
  /** Evaluate during execution after this many tool results. 0 disables tool-result checkpoints. */
  reviewEveryToolResults: number;
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  mode: "automatic",
  consultThinking: "high",
  disabledForModels: [],
  guide: "",
  cooldownMs: 300_000,
  automaticReviewCooldownMs: 0,
  maxAutomaticReviewsPerSession: 0,
  maxTailMessages: 8,
  maxTailChars: 4_000,
  reviewEveryToolResults: 3,
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
  /** Last valid verdict, or failed when the evaluator produced no usable verdict. */
  lastStatus?: AdvisorVerdictStatus | "failed";
  /** Model reported by the most recent successful teammate result. */
  lastModel?: string;
  /** Total completed evaluation attempts. */
  evaluations: number;
  /** Evaluations that failed or returned no valid verdict. */
  failures: number;
  /** Most recent evaluation failure reason. */
  lastError?: string;
  /** Number of deliveries actually sent. */
  deliveries: number;
  /** Number of deliveries suppressed by the gate (cooldown/dedupe/downgrade). */
  suppressed: number;
  /** Number of valid on-track verdicts that produced no advisory. */
  uneventful: number;
}

export function createAdvisorRuntimeState(): AdvisorRuntimeState {
  return { evaluations: 0, failures: 0, deliveries: 0, suppressed: 0, uneventful: 0 };
}

export type AdvisorConfigSource = "canonical" | "legacy" | "defaults" | "canonical-invalid";

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

/** Normalize the canonical `.pi/advisor.json` format. */
export function normalizeAdvisorConfig(raw: Partial<AdvisorConfig> | undefined): AdvisorConfig {
  const model = typeof raw?.model === "string" && raw.model.trim()
    ? raw.model.trim()
    : undefined;
  const automaticReviewCooldownMs = finiteNonNegative(raw?.automaticReviewCooldownMs);
  const maxAutomaticReviewsPerSession = nonNegativeInteger(raw?.maxAutomaticReviewsPerSession);
  const reviewEveryToolResults = nonNegativeInteger(raw?.reviewEveryToolResults);
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_ADVISOR_CONFIG.enabled,
    mode: isAdvisorMode(raw?.mode) ? raw.mode : DEFAULT_ADVISOR_CONFIG.mode,
    ...(model ? { model } : {}),
    consultThinking: isAdvisorThinkingLevel(raw?.consultThinking)
      ? raw.consultThinking
      : DEFAULT_ADVISOR_CONFIG.consultThinking,
    disabledForModels: normalizeDisabledForModels(raw?.disabledForModels),
    guide: typeof raw?.guide === "string" ? raw.guide : DEFAULT_ADVISOR_CONFIG.guide,
    cooldownMs: finiteNonNegative(raw?.cooldownMs) ?? DEFAULT_ADVISOR_CONFIG.cooldownMs,
    automaticReviewCooldownMs: automaticReviewCooldownMs ?? DEFAULT_ADVISOR_CONFIG.automaticReviewCooldownMs,
    maxAutomaticReviewsPerSession: maxAutomaticReviewsPerSession ?? DEFAULT_ADVISOR_CONFIG.maxAutomaticReviewsPerSession,
    maxTailMessages: positiveInteger(raw?.maxTailMessages) ?? DEFAULT_ADVISOR_CONFIG.maxTailMessages,
    maxTailChars: positiveInteger(raw?.maxTailChars) ?? DEFAULT_ADVISOR_CONFIG.maxTailChars,
    reviewEveryToolResults: reviewEveryToolResults ?? DEFAULT_ADVISOR_CONFIG.reviewEveryToolResults,
  };
}

/** Map the standalone Teammate Advisor settings into the canonical runtime. */
export function normalizeLegacyAdvisorConfig(raw: unknown): AdvisorConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const cooldownMs = positiveInteger(source.cooldownMs) ?? 300_000;
  const maxAutomaticReviewsPerSession = positiveInteger(source.maxReviewsPerSession) ?? 20;
  const maxTailMessages = Math.min(100, positiveInteger(source.tailMessages) ?? 4);
  const maxMessageChars = Math.min(100_000, positiveInteger(source.maxMessageChars) ?? 2_000);
  return normalizeAdvisorConfig({
    enabled: typeof source.enabled === "boolean" ? source.enabled : false,
    mode: "automatic",
    cooldownMs,
    automaticReviewCooldownMs: cooldownMs,
    maxAutomaticReviewsPerSession,
    maxTailMessages,
    maxTailChars: Math.min(100_000, maxTailMessages * maxMessageChars),
    reviewEveryToolResults: 0,
  });
}

const ADVISOR_TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const ADVISOR_FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

/** Apply the legacy `PI_ADVISOR*` environment contract after file/default loading. */
export function applyAdvisorEnvOverrides(
  config: AdvisorConfig,
  env: NodeJS.ProcessEnv = process.env,
): AdvisorConfig {
  let next = config;
  const enabled = env.PI_ADVISOR?.trim().toLowerCase();
  if (enabled && ADVISOR_TRUE_VALUES.has(enabled)) next = { ...next, enabled: true };
  else if (enabled && ADVISOR_FALSE_VALUES.has(enabled)) next = { ...next, enabled: false };

  const cooldownMs = nonNegativeInteger(env.PI_ADVISOR_COOLDOWN_MS);
  if (cooldownMs !== undefined) {
    next = { ...next, cooldownMs, automaticReviewCooldownMs: cooldownMs };
  }
  const maxReviews = nonNegativeInteger(env.PI_ADVISOR_MAX_REVIEWS);
  if (maxReviews !== undefined) next = { ...next, maxAutomaticReviewsPerSession: maxReviews };
  return next;
}

export function isAdvisorMode(value: unknown): value is AdvisorMode {
  return typeof value === "string" && ADVISOR_MODES.includes(value as AdvisorMode);
}

export function isAdvisorThinkingLevel(value: unknown): value is AdvisorThinkingLevel {
  return typeof value === "string" && ADVISOR_THINKING_LEVELS.includes(value as AdvisorThinkingLevel);
}

export function automaticAdvisorEnabled(config: AdvisorConfig): boolean {
  return config.enabled && config.mode !== "manual";
}

export function manualAdvisorEnabled(config: AdvisorConfig): boolean {
  return config.enabled && config.mode !== "automatic";
}

function normalizeModelReference(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.includes("/") ? "/" : ":";
  const index = trimmed.indexOf(separator);
  return index > 0 && index < trimmed.length - 1
    ? `${trimmed.slice(0, index)}/${trimmed.slice(index + 1)}`
    : trimmed;
}

function normalizeDisabledForModels(value: unknown): AdvisorDisabledForModel[] {
  if (!Array.isArray(value)) return [];
  const normalized: AdvisorDisabledForModel[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      normalized.push(normalizeModelReference(entry));
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.model !== "string" || !record.model.trim()) continue;
    if (record.minThinking !== undefined && !isAdvisorThinkingLevel(record.minThinking)) continue;
    normalized.push({
      model: normalizeModelReference(record.model),
      ...(isAdvisorThinkingLevel(record.minThinking) ? { minThinking: record.minThinking } : {}),
    });
  }
  return normalized;
}

export function isAdvisorExecutorBlocked(
  config: AdvisorConfig,
  model: { provider: string; id: string } | undefined,
  thinkingLevel?: string,
): boolean {
  if (!model) return false;
  const reference = `${model.provider}/${model.id}`;
  for (const entry of config.disabledForModels) {
    if (typeof entry === "string") {
      if (normalizeModelReference(entry) === reference) return true;
      continue;
    }
    if (normalizeModelReference(entry.model) !== reference) continue;
    if (!entry.minThinking) return true;
    const current = ADVISOR_THINKING_LEVELS.indexOf(thinkingLevel as AdvisorThinkingLevel);
    const threshold = ADVISOR_THINKING_LEVELS.indexOf(entry.minThinking);
    if (current >= threshold) return true;
  }
  return false;
}

/** Resolve the explicit teammate model, defaulting to the active main-session model. */
export function resolveAdvisorModel(
  config: AdvisorConfig,
  currentModel?: { provider: string; id: string },
): string | undefined {
  return config.model ?? (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
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

/** Redact common credentials before transcript data can cross a model/provider boundary. */
export function redactAdvisorText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*$/gi,
      "[REDACTED]",
    )
    .replace(
      /(^|[\s{,;:])(["']?authorization["']?\s*[:=]\s*["']?)(?:basic|bearer)\s+[^\s"',;}]+["']?/gim,
      "$1$2[REDACTED]",
    )
    .replace(
      /(^|[\s{,;:])(["']?(?:set[-_ ]?cookie|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n}]*)/gim,
      "$1$2[REDACTED]",
    )
    .replace(
      /(^|[\s{,;:])(["']?(?:sessionToken|authToken|idToken|accessToken|refreshToken|apiKey|clientSecret|privateKey|connectionString)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(^|[\s{,;:])(["']?(?:(?:[a-z0-9]+[-_ ])*(?:api[-_ ]?key|password|passwd|pwd|secret|secret[-_ ]?access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|token|jwt|connection[-_ ]?string)|authorization|cookie|set[-_ ]?cookie)["']?\s*[:=]\s*)(?!["']?\[REDACTED\]["']?)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gim,
      "$1$2[REDACTED]",
    )
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@/\s]+@/gi,
      "$1[REDACTED]@",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]");
}

export interface AdvisorConversationMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export interface AdvisorToolInfo {
  name: string;
  description?: string;
}

/** Remove the unresolved advisor() call that invoked the consultation. */
export function stripInflightAdvisorCall(
  messages: readonly AdvisorConversationMessage[],
  toolCallId?: string,
): AdvisorConversationMessage[] {
  const completedCalls = new Set(messages
    .filter((message) => message.role === "toolResult" && typeof message.toolCallId === "string")
    .map((message) => message.toolCallId as string));
  const next: AdvisorConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      next.push(message);
      continue;
    }
    const filtered = message.content.filter((block) => {
      if (typeof block !== "object" || block === null) return true;
      const record = block as Record<string, unknown>;
      if (record.type !== "toolCall" || record.name !== "advisor") return true;
      if (toolCallId) return record.id !== toolCallId;
      return typeof record.id === "string" && completedCalls.has(record.id);
    });
    if (filtered.length > 0) next.push(filtered.length === message.content.length ? message : { ...message, content: filtered });
  }
  return next;
}

/** Provider-neutral reviewers receive an explicit user request at the tail. */
export function ensureAdvisorUserTail(
  messages: readonly AdvisorConversationMessage[],
): AdvisorConversationMessage[] {
  if (messages.length === 0 || messages.at(-1)?.role === "user") return [...messages];
  return [...messages, {
    role: "user",
    content: [{ type: "text", text: "Please advise on the executor's situation above." }],
    timestamp: Date.now(),
  }];
}

function stableJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function serializeConversationContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stableJson(content);
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return stableJson(block);
    const record = block as Record<string, unknown>;
    if (record.type === "image") return `[image${typeof record.mimeType === "string" ? ` ${record.mimeType}` : ""}]`;
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "thinking" && typeof record.thinking === "string") return `[thinking] ${record.thinking}`;
    if (record.type === "toolCall") return `[tool call] ${String(record.name ?? "tool")} ${stableJson(record.arguments ?? {})}`;
    return stableJson(record);
  }).filter(Boolean).join("\n");
}

function serializeAdvisorMessage(message: AdvisorConversationMessage): string {
  if (message.role === "bashExecution") {
    if (message.excludeFromContext === true) return "";
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return `BASH: ${command}${output ? `\n${output}` : ""}`.trim();
  }
  const label = message.role === "toolResult"
    ? `TOOL RESULT ${String(message.toolName ?? "tool")}`
    : message.role.toUpperCase();
  const content = message.content !== undefined
    ? serializeConversationContent(message.content)
    : typeof message.summary === "string"
      ? message.summary
      : "";
  return `${label}: ${content}`.trim();
}

/** Serialize the full resolved branch while preserving tool intent and redacting secrets. */
export function serializeAdvisorConversation(messages: readonly AdvisorConversationMessage[]): string {
  return redactAdvisorText(messages.map(serializeAdvisorMessage).filter(Boolean).join("\n\n"));
}

/** Stable compact inventory of the model-visible tools, without schema expansion. */
export function buildAdvisorToolInventory(tools: readonly AdvisorToolInfo[]): string {
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => `- ${tool.name}${tool.description?.trim() ? `: ${tool.description.trim()}` : ""}`)
    .join("\n");
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
    } else if (role === "tool" || role === "toolResult") {
      const name = record.name ?? record.toolName ?? "tool";
      line = `TOOL ${name}: ${text}`;
    } else if (record.customType) {
      line = `CUSTOM ${record.customType}: ${text}`;
    } else {
      line = `${role || "MESSAGE"}: ${text}`;
    }
    const normalized = redactAdvisorText(line.replace(/\s*\n+/g, "\n").trim());
    if (!normalized) continue;
    const truncated = truncate(normalized, budget);
    lines.push(truncated);
    // Reserve one char for the join separator so the serialized tail stays
    // within maxChars even after lines are joined with "\n".
    budget -= truncated.length + 1;
  }

  return lines.join("\n");
}

export interface AdvisorToolCheckpoint {
  toolName: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
}

function serializeCheckpointValue(value: unknown): string {
  if (typeof value === "string") return redactAdvisorText(value);
  const text = messageText({ content: value });
  if (text) return redactAdvisorText(text);
  try {
    return redactAdvisorText(JSON.stringify(value) ?? "");
  } catch {
    return redactAdvisorText(String(value ?? ""));
  }
}

/** Serialize a bounded mid-execution checkpoint for background impact review. */
export function serializeToolCheckpoint(
  checkpoint: AdvisorToolCheckpoint,
  maxChars = DEFAULT_ADVISOR_CONFIG.maxTailChars,
): string {
  const lines = [
    `TOOL CHECKPOINT ${checkpoint.toolName} (${checkpoint.isError ? "error" : "ok"})`,
    `INPUT: ${serializeCheckpointValue(checkpoint.input)}`,
    `RESULT: ${serializeCheckpointValue(checkpoint.content)}`,
  ];
  return truncate(lines.join("\n").trim(), maxChars);
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

export function buildManualAdvisorPrompt(
  config: AdvisorConfig,
  conversation: string,
  toolInventory: string,
): string {
  const guideBlock = config.guide.trim()
    ? `\nProject review priorities:\n<attention>\n${config.guide.trim()}\n</attention>`
    : "";
  return [
    "You are a second-opinion reviewer for a coding agent executing a task end to end.",
    "Return one concise response: a concrete plan, a correction, or a stop signal when the user must decide.",
    "Do not call tools. Ground every recommendation in the supplied conversation and available tool inventory.",
    "Name files, symbols, and exact verification steps when the context supports them. No preamble or meta-commentary.",
    guideBlock,
    "",
    "<available-tools>",
    toolInventory || "(none)",
    "</available-tools>",
    "",
    "<resolved-conversation>",
    conversation || "(no conversation available)",
    "</resolved-conversation>",
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
