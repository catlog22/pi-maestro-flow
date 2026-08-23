/**
 * Generic tool-call trajectory — the structured, ordered timeline of every
 * tool invocation in the transcript tail, plus deterministic episode
 * classification.
 *
 * This module replaces the narrow `buildToolCallEvidence` (which only covered
 * `browser` / `computer_use`) with a general timeline that captures ALL tools
 * the assistant called, preserving call order, call ids, whitelisted input
 * parameters, structured results, and a generic outcome.
 *
 * Design (locked by the approved Plan):
 *
 * 1. **Ordered timeline first.** {@link collectToolCallTimeline} walks the
 *    transcript in order and emits one {@link TimelineEntry} per `tool_use`
 *    block — paired with its `tool_result` by id. Order is preserved so
 *    retry / recovery patterns are visible. Calls without a result are
 *    `incomplete`, never `ok`.
 *
 * 2. **Tool adapters are incremental.** Each adapter (`bash`, `edit`, `grep`,
 *    …) classifies a result into a {@link GenericOutcome} and extracts a
 *    stable operation key for episode grouping. Unknown tools fall back to
 *    the generic classifier; removing one adapter restores generic behavior.
 *
 * 3. **Deterministic episodes.** {@link buildTrajectoryEpisodes} groups the
 *    timeline into `failure_recovery` / `repeated_failure` /
 *    `empty_then_refined` / `permission_block` / `success` episodes using
 *    only the structured outcomes + operation keys. The LLM consumes these
 *    episodes; it never infers call pairings itself.
 *
 * 4. **SOP compatibility.** {@link projectSopToolCalls} projects the timeline
 *    back onto the legacy `ToolCallEvidence[]` shape (browser/computer_use
 *    only) so `signalEvidenceContent` and the SOP frontmatter hint keep
 *    working unchanged.
 *
 * This module is host-free and unit-testable. No LLM calls.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCallEvidence } from "./runtime.ts";
import { SOP_TOOL_NAMES } from "./runtime.ts";

/** Extract text from a message's content (string or array of {text} blocks). */
function messageText(message: { content?: unknown }): string {
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generic outcome bucket for any tool call. */
export type GenericOutcome =
  | "ok"
  | "error"
  | "empty"
  | "timeout"
  | "permission_denied"
  | "cancelled"
  | "incomplete"
  | "unknown";

/** One entry in the ordered tool-call timeline. */
export interface TimelineEntry {
  /** 0-based position in the transcript scan (stable within one collection). */
  index: number;
  /** The assistant tool_use block id (pi-ai `id` / Anthropic `id`). */
  callId: string;
  /** Pi tool name (`bash`, `edit`, `browser`, …). */
  tool: string;
  /** Whitelisted input parameters (action/topic/command/path/file/pattern/query/…). */
  input: Record<string, string>;
  /** Generic outcome of the paired result. */
  outcome: GenericOutcome;
  /** Short error/result excerpt when outcome is not ok (truncated). */
  excerpt?: string;
}

/** A grouped trajectory episode the LLM (and review) can reason about. */
export interface TrajectoryEpisode {
  kind:
    | "failure_recovery"
    | "repeated_failure"
    | "empty_then_refined"
    | "permission_block"
    | "success";
  /** Tool the episode centers on. */
  tool: string;
  /** Operation key the adapter extracted (groups retries of the same op). */
  operation: string;
  /** Timeline entries in this episode (indices into the timeline). */
  entryIndices: number[];
  /** Outcomes in order, for quick inspection. */
  outcomes: GenericOutcome[];
}

// ---------------------------------------------------------------------------
// Tool adapters
// ---------------------------------------------------------------------------

export interface ToolAdapter {
  /** Tool names this adapter handles (lowercase). */
  tools: readonly string[];
  /** Classify a tool_result text + isError flag into a generic outcome. */
  classify(isError: boolean, text: string): GenericOutcome;
  /** Extract a stable operation key from the call input (groups retries). */
  operation(input: Record<string, string>): string;
  /** Whitelisted input fields to preserve on the timeline entry. */
  inputFields: readonly string[];
}

/** Default whitelisted input fields shared across tools. */
const COMMON_INPUT_FIELDS = ["action", "topic", "command", "path", "file", "pattern", "query", "url"] as const;

function pickInput(raw: unknown, fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === "string" && value.length > 0) out[field] = value;
  }
  return out;
}

function firstNonEmpty(input: Record<string, string>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = input[field];
    if (value) return value;
  }
  return "_";
}

// --- bash adapter ---
const bashAdapter: ToolAdapter = {
  tools: ["bash", "bash_bg", "shell"],
  inputFields: ["command", "path"],
  classify(isError, text) {
    if (isError) {
      if (/command not found|not found/i.test(text)) return "error";
      if (/\btimeout\b|timed out/i.test(text)) return "timeout";
      if (/permission denied|EACCES|not permitted/i.test(text)) return "permission_denied";
      if (/cancelled|aborted|SIGINT/i.test(text)) return "cancelled";
      return "error";
    }
    return "ok";
  },
  operation(input) {
    // Group by the command's leading token (e.g. `grep`, `npm`, `git`).
    const cmd = input.command ?? "";
    const firstToken = cmd.trim().split(/\s+/)[0] ?? "";
    return firstToken || "_";
  },
};

// --- edit adapter ---
const editAdapter: ToolAdapter = {
  tools: ["edit", "write", "str_replace", "apply"],
  inputFields: ["path", "file"],
  classify(isError, text) {
    if (isError) {
      if (/not found|could not find|unique|occurrences/i.test(text)) return "error";
      if (/permission denied|EACCES/i.test(text)) return "permission_denied";
      return "error";
    }
    return "ok";
  },
  operation(input) {
    return input.path ?? input.file ?? "_";
  },
};

// --- grep/search adapter ---
const grepAdapter: ToolAdapter = {
  tools: ["grep", "ffgrep", "rg", "search", "fffind"],
  inputFields: ["pattern", "query", "path"],
  classify(isError, text) {
    // grep returns exit 1 on no matches, surfaced as isError by the host.
    if (/no match|no matches|no results|0 matches/i.test(text)) return "empty";
    if (isError) return "error";
    return "ok";
  },
  operation(input) {
    return input.pattern ?? input.query ?? "_";
  },
};

// --- lsp adapter ---
const lspAdapter: ToolAdapter = {
  tools: ["lsp"],
  inputFields: ["path", "file", "query"],
  classify(isError, text) {
    if (isError) return "error";
    if (/no definitions|no references|empty|no results|not found/i.test(text)) return "empty";
    return "ok";
  },
  operation(input) {
    return input.path ?? input.file ?? input.query ?? "_";
  },
};

// --- read/find adapter ---
const readAdapter: ToolAdapter = {
  tools: ["read", "find", "ls"],
  inputFields: ["path", "file", "pattern"],
  classify(isError, text) {
    if (isError) {
      if (/no such file|does not exist|ENOENT/i.test(text)) return "empty";
      if (/permission denied|EACCES/i.test(text)) return "permission_denied";
      return "error";
    }
    return "ok";
  },
  operation(input) {
    return input.path ?? input.file ?? input.pattern ?? "_";
  },
};

// --- delegate/teammate adapter ---
const delegateAdapter: ToolAdapter = {
  tools: ["delegate", "teammate", "maestro"],
  inputFields: [],
  classify(isError, text) {
    if (isError) {
      if (/timeout|timed out|deadline/i.test(text)) return "timeout";
      if (/cancelled|aborted/i.test(text)) return "cancelled";
      return "error";
    }
    return "ok";
  },
  operation() {
    return "_";
  },
};

// --- ask/ask-user adapter ---
const askAdapter: ToolAdapter = {
  tools: ["ask", "ask-user", "ask_user_question"],
  inputFields: [],
  classify(isError, text) {
    if (isError) {
      if (/cancel|dismiss|abort/i.test(text)) return "cancelled";
      return "error";
    }
    return "ok";
  },
  operation() {
    return "_";
  },
};

// --- browser/computer_use adapter (SOP tools — reuse runtime classifier) ---
const sopAdapter: ToolAdapter = {
  tools: [...SOP_TOOL_NAMES],
  inputFields: ["action", "topic"],
  classify(isError, text) {
    if (!isError) return "ok";
    if (/near[-_ ]?zero|NEAR_ZERO/i.test(text)) return "empty";
    if (/\btimeout\b|TIMEOUT|aborted|ABORTED/i.test(text)) return "timeout";
    if (/permission|denied|EACCES|FOREGROUND_NOT_VERIFIED|not permitted/i.test(text)) {
      return "permission_denied";
    }
    return "error";
  },
  operation(input) {
    const action = input.action ?? "_";
    const topic = input.topic;
    return topic ? `${action}:${topic}` : action;
  },
};

/** Registry of tool adapters, keyed by lowercase tool name. */
const ADAPTERS: ReadonlyMap<string, ToolAdapter> = (() => {
  const map = new Map<string, ToolAdapter>();
  for (const adapter of [
    bashAdapter,
    editAdapter,
    grepAdapter,
    lspAdapter,
    readAdapter,
    delegateAdapter,
    askAdapter,
    sopAdapter,
  ]) {
    for (const tool of adapter.tools) map.set(tool.toLowerCase(), adapter);
  }
  return map;
})();

/** Fallback adapter for tools not in the registry. */
const FALLBACK_ADAPTER: ToolAdapter = {
  tools: [],
  inputFields: COMMON_INPUT_FIELDS,
  classify(isError, text) {
    if (isError) {
      if (/\btimeout\b|timed out|deadline/i.test(text)) return "timeout";
      if (/permission denied|EACCES|not permitted/i.test(text)) return "permission_denied";
      if (/cancelled|aborted|SIGINT/i.test(text)) return "cancelled";
      if (/empty|no match|no results|nothing/i.test(text)) return "empty";
      return "error";
    }
    return "ok";
  },
  operation(input) {
    return firstNonEmpty(input, COMMON_INPUT_FIELDS);
  },
};

function adapterFor(tool: string): ToolAdapter {
  return ADAPTERS.get(tool.toLowerCase()) ?? FALLBACK_ADAPTER;
}

// ---------------------------------------------------------------------------
// Timeline collection
// ---------------------------------------------------------------------------

/**
 * Extract a result's `{ isError, text }` from a tool_result message.
 * Returns `undefined` when the message is not a tool result.
 */
function extractToolResult(message: unknown): { callId: string; isError: boolean; text: string } | undefined {
  const record = message as {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
  };
  if (record.role !== "tool" && record.role !== "toolResult") return undefined;
  const callId = record.toolCallId;
  if (typeof callId !== "string" || !callId) return undefined;
  return {
    callId,
    isError: record.isError === true,
    text: messageText(record),
  };
}

/** Extract tool_use blocks from an assistant message. */
function extractToolUseBlocks(message: unknown): Array<{
  tool: string;
  rawInput: unknown;
  callId: string;
}> {
  const record = message as { role?: string; content?: unknown };
  if (record.role !== "assistant") return [];
  const blocks = Array.isArray(record.content) ? record.content : [record.content];
  const out: Array<{ tool: string; rawInput: unknown; callId: string }> = [];
  for (const block of blocks) {
    const use = block as { type?: string; name?: string; input?: unknown; arguments?: unknown; id?: string; toolCallId?: string } | null;
    if (!use) continue;
    const isToolUse = use.type === "tool_use" || use.type === "toolCall";
    if (!isToolUse) continue;
    const tool = typeof use.name === "string" ? use.name : "";
    if (!tool) continue;
    const callId = typeof (use.id ?? use.toolCallId) === "string"
      ? ((use.id ?? use.toolCallId) as string)
      : "";
    out.push({ tool, rawInput: use.input ?? use.arguments ?? {}, callId });
  }
  return out;
}

/**
 * Collect the ordered tool-call timeline from the transcript tail.
 *
 * Walks the last `windowSize` messages in order: first indexes all tool
 * results by callId, then scans assistant messages for tool_use blocks and
 * emits one {@link TimelineEntry} per block, paired with its result. Calls
 * without a result are `incomplete`. Bounded by `max`.
 */
export function collectToolCallTimeline(
  messages: AgentMessage[],
  max = 12,
  windowSize = 64,
): TimelineEntry[] {
  const window = messages.slice(-windowSize);
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const message of window) {
    const result = extractToolResult(message);
    if (result) results.set(result.callId, { isError: result.isError, text: result.text });
  }
  const timeline: TimelineEntry[] = [];
  let index = 0;
  for (const message of window) {
    if (timeline.length >= max) break;
    const uses = extractToolUseBlocks(message);
    for (const use of uses) {
      if (timeline.length >= max) break;
      if (!use.callId) {
        // Without a callId we cannot pair the result; still record an
        // incomplete entry so the call is not lost.
        const adapter = adapterFor(use.tool);
        timeline.push({
          index: index++,
          callId: "",
          tool: use.tool,
          input: pickInput(use.rawInput, adapter.inputFields),
          outcome: "incomplete",
        });
        continue;
      }
      const result = results.get(use.callId);
      const adapter = adapterFor(use.tool);
      const isError = result?.isError === true;
      const text = result?.text ?? "";
      const outcome: GenericOutcome = result
        ? adapter.classify(isError, text)
        : "incomplete";
      timeline.push({
        index: index++,
        callId: use.callId,
        tool: use.tool,
        input: pickInput(use.rawInput, adapter.inputFields),
        outcome,
        ...(outcome !== "ok" && outcome !== "incomplete" && text
          ? { excerpt: text.slice(0, 160) }
          : {}),
      });
    }
  }
  return timeline;
}

// ---------------------------------------------------------------------------
// Episode construction
// ---------------------------------------------------------------------------

/**
 * Group a timeline into deterministic episodes.
 *
 * Episodes are keyed by `(tool, operation)` (the adapter's operation key).
 * Within a group, the sequence of outcomes determines the episode kind:
 *
 * - `failure_recovery`   — at least one non-ok outcome followed by an ok.
 * - `repeated_failure`   — all non-ok and never recovered.
 * - `empty_then_refined` — `empty` then a later ok with the same operation
 *                          (e.g. grep no-match → refined query → hit).
 * - `permission_block`   — any `permission_denied`.
 * - `success`            — all ok.
 *
 * Incomplete outcomes are treated as non-ok but do not, on their own,
 * constitute a failure.
 */
export function buildTrajectoryEpisodes(timeline: readonly TimelineEntry[]): TrajectoryEpisode[] {
  // Group by (tool, operation) preserving first-appearance order.
  const groups = new Map<string, TimelineEntry[]>();
  const order: string[] = [];
  for (const entry of timeline) {
    const adapter = adapterFor(entry.tool);
    const operation = adapter.operation(entry.input);
    const key = `${entry.tool}::${operation}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(entry);
  }
  const episodes: TrajectoryEpisode[] = [];
  for (const key of order) {
    const entries = groups.get(key)!;
    const outcomes = entries.map((e) => e.outcome);
    const hasPermission = outcomes.includes("permission_denied");
    const hasNonOk = outcomes.some((o) => o !== "ok" && o !== "incomplete");
    const hasOkAfterNonOk = (() => {
      let sawNonOk = false;
      for (const o of outcomes) {
        if (o !== "ok" && o !== "incomplete") sawNonOk = true;
        else if (sawNonOk && o === "ok") return true;
      }
      return false;
    })();
    const hasEmptyThenOk = (() => {
      let sawEmpty = false;
      for (const o of outcomes) {
        if (o === "empty") sawEmpty = true;
        else if (sawEmpty && o === "ok") return true;
      }
      return false;
    })();
    const allOk = outcomes.every((o) => o === "ok");
    const [tool, operation] = key.split("::");
    let kind: TrajectoryEpisode["kind"];
    if (hasPermission) kind = "permission_block";
    else if (hasEmptyThenOk) kind = "empty_then_refined";
    else if (hasOkAfterNonOk) kind = "failure_recovery";
    else if (hasNonOk) kind = "repeated_failure";
    else if (allOk) kind = "success";
    else kind = "success"; // incomplete-only group → treat as neutral success
    episodes.push({
      kind,
      tool,
      operation,
      entryIndices: entries.map((e) => e.index),
      outcomes,
    });
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// SOP compatibility projection
// ---------------------------------------------------------------------------

const SOP_OUTCOME_MAP: Readonly<Record<GenericOutcome, ToolCallEvidence["outcome"]>> = {
  ok: "ok",
  error: "error",
  empty: "near_zero",
  timeout: "timeout",
  permission_denied: "permission_denied",
  cancelled: "error",
  incomplete: "unknown",
  unknown: "unknown",
};

/**
 * Project the timeline onto the legacy `ToolCallEvidence[]` shape used by
 * `signalEvidenceContent` and the SOP frontmatter hint. Only browser /
 * computer_use entries are kept (the SOP tools). Deduplicates by
 * `tool:action:topic:outcome` to match the legacy behavior.
 */
export function projectSopToolCalls(timeline: readonly TimelineEntry[]): ToolCallEvidence[] {
  const out: ToolCallEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of timeline) {
    if (!SOP_TOOL_NAMES.has(entry.tool)) continue;
    const action = entry.input.action;
    const topic = entry.input.topic;
    const legacyOutcome = SOP_OUTCOME_MAP[entry.outcome];
    const key = `${entry.tool}:${action ?? ""}:${topic ?? ""}:${legacyOutcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool: entry.tool,
      ...(action ? { action } : {}),
      ...(topic ? { topic } : {}),
      outcome: legacyOutcome,
      ...(entry.excerpt ? { errorMessage: entry.excerpt } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public re-exports for consumers
// ---------------------------------------------------------------------------

export { adapterFor as getToolAdapter };
