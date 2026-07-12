import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiCompactionInternals, type PiCompactionInternals } from "./pi-internals.ts";

const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const AUTO_PRUNE_RATIO = 0.8;
const NUDGE_RATIO = 0.7;
const MIN_PRUNABLE_TOOL_RESULT_CHARS = 4_000;
const REPLAYABLE_TOOL_NAMES = new Set(["read", "grep", "glob", "search", "find"]);
const CONTINUE_PROMPT = "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

interface ContextEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
}

export type ContextPressureBand = "normal" | "nudge" | "auto-prune" | "critical";

export interface ContextPressureResult {
  messages: AgentMessage[];
  band: ContextPressureBand;
  estimatedTokens: number;
  thresholdTokens: number;
  prunedToolResults: number;
  savedTokens: number;
}

interface AutoCompactionState {
  running: boolean;
  lastTriggerKey?: string;
  internalsWarningShown: boolean;
  lastNoCompactableKey?: string;
}

interface AutoCompactionDependencies {
  loadInternals?: () => Promise<PiCompactionInternals>;
  readSettings?: (projectRoot: string) => CompactionSettings;
}

interface MessageRecord {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  usage?: unknown;
  stopReason?: unknown;
}

export function createMidTurnAutoCompaction(pi: ExtensionAPI, dependencies: AutoCompactionDependencies = {}): {
  evaluate(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[] | undefined>;
  onAgentEnd(ctx: ExtensionContext): void;
  reset(ctx?: ExtensionContext): void;
} {
  const state: AutoCompactionState = { running: false, internalsWarningShown: false };
  const loadInternals = dependencies.loadInternals ?? loadPiCompactionInternals;
  const readSettings = dependencies.readSettings ?? readEffectiveCompactionSettings;
  return {
    async evaluate(messages, ctx) {
      if (state.running) return undefined;
      if (!ctx.model || !endsWithCompleteToolResultBatch(messages)) {
        clearPressureStatus(ctx);
        return undefined;
      }
      const settings = readSettings(ctx.cwd);
      if (!settings.enabled || ctx.model.contextWindow <= settings.reserveTokens) return undefined;
      const pressure = applyContextPressurePolicy(messages, ctx.model.contextWindow, settings);
      updatePressureStatus(ctx, pressure);
      if (pressure.band !== "critical") {
        state.lastNoCompactableKey = undefined;
        return pressure.prunedToolResults > 0 ? pressure.messages : undefined;
      }
      const estimate = estimateContextTokens(pressure.messages);
      const thresholdTokens = pressure.thresholdTokens;

      const triggerKey = `${estimate.tokens}:${thresholdTokens}:${messages.length}`;
      if (state.lastTriggerKey === triggerKey) return pressure.messages;
      let internals: PiCompactionInternals;
      try {
        internals = await loadInternals();
      } catch (error) {
        clearPressureStatus(ctx);
        if (!state.internalsWarningShown) {
          state.internalsWarningShown = true;
          ctx.ui.notify(`Mid-turn compaction disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return pressure.messages;
      }
      const branch = ctx.sessionManager.getBranch();
      let preparation: unknown;
      try {
        preparation = internals.prepareCompaction(branch, settings);
      } catch (error) {
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction preparation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return pressure.messages;
      }
      if (!preparation) {
        ctx.ui.setStatus("maestro-auto-compact", `CTX CRITICAL ${pressure.estimatedTokens}/${thresholdTokens}`);
        const noCompactableKey = `${thresholdTokens}:${settings.keepRecentTokens}:${branch.length}`;
        if (state.lastNoCompactableKey !== noCompactableKey) {
          state.lastNoCompactableKey = noCompactableKey;
          ctx.ui.notify(
            "Mid-turn compaction skipped: Pi has no compactable history; context pressure is inside the recent keep window or static prompt overhead.",
            "warning",
          );
        }
        return pressure.messages;
      }
      state.lastNoCompactableKey = undefined;
      state.lastTriggerKey = triggerKey;
      state.running = true;
      ctx.abort();
      ctx.ui.setStatus("maestro-auto-compact", `COMPACT ${estimate.tokens}/${thresholdTokens}`);
      const failCompaction = (error: unknown) => {
        state.running = false;
        state.lastTriggerKey = undefined;
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      };
      try {
        ctx.compact({
          customInstructions: buildMidTurnInstructions(estimate, ctx.model.contextWindow, settings.reserveTokens),
          onComplete: () => {
            state.running = false;
            state.lastTriggerKey = undefined;
            clearPressureStatus(ctx);
            try {
              pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
            } catch (error) {
              ctx.ui.notify(`Mid-turn continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          },
          onError: failCompaction,
        });
      } catch (error) {
        failCompaction(error);
      }
      return pressure.messages;
    },
    onAgentEnd(ctx) {
      if (!state.running) clearPressureStatus(ctx);
    },
    reset(ctx) {
      state.running = false;
      state.lastTriggerKey = undefined;
      state.internalsWarningShown = false;
      state.lastNoCompactableKey = undefined;
      if (ctx) clearPressureStatus(ctx);
    },
  };
}

export function applyContextPressurePolicy(
  messages: AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings,
): ContextPressureResult {
  const thresholdTokens = contextWindow - settings.reserveTokens;
  const initial = estimateContextTokens(messages).tokens;
  const criticalRatio = thresholdTokens / contextWindow;
  const initialRatio = initial / contextWindow;
  const initiallyCritical = initial > thresholdTokens;
  if (!settings.enabled || (!initiallyCritical && initialRatio < NUDGE_RATIO)) {
    return pressureResult(messages, "normal", initial, thresholdTokens, 0, 0);
  }
  if (!initiallyCritical && initialRatio < AUTO_PRUNE_RATIO) {
    return pressureResult(messages, "nudge", initial, thresholdTokens, 0, 0);
  }

  const frontierStart = protectedFrontierStart(messages, settings.keepRecentTokens);
  const transformed = [...messages];
  let savedTokens = 0;
  let prunedToolResults = 0;
  const pruneTarget = Math.min(thresholdTokens, Math.floor(contextWindow * AUTO_PRUNE_RATIO));
  for (let index = 0; index < frontierStart && initial - savedTokens > pruneTarget; index++) {
    const replacement = replaceableToolResult(transformed[index]);
    if (!replacement) continue;
    const before = estimateMessageTokens(transformed[index]);
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    transformed[index] = replacement;
    savedTokens += before - after;
    prunedToolResults++;
  }
  const estimatedTokens = Math.max(0, initial - savedTokens);
  const ratio = estimatedTokens / contextWindow;
  const band: ContextPressureBand = ratio > criticalRatio
    ? "critical"
    : prunedToolResults > 0
      ? "auto-prune"
    : ratio >= AUTO_PRUNE_RATIO
      ? "auto-prune"
      : ratio >= NUDGE_RATIO
        ? "nudge"
        : "normal";
  return pressureResult(transformed, band, estimatedTokens, thresholdTokens, prunedToolResults, savedTokens);
}

export function shouldCompactMidTurn(input: {
  messages: AgentMessage[];
  contextWindow: number;
  settings: CompactionSettings;
}): boolean {
  if (!input.settings.enabled || input.contextWindow <= input.settings.reserveTokens) return false;
  if (!endsWithCompleteToolResultBatch(input.messages)) return false;
  return applyContextPressurePolicy(input.messages, input.contextWindow, input.settings).band === "critical";
}

export function estimateContextTokens(messages: AgentMessage[]): ContextEstimate {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    lastUsageIndex = index;
    usageTokens = usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    break;
  }
  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index++) {
    trailingTokens += estimateMessageTokens(messages[index]);
  }
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens };
}

export function endsWithCompleteToolResultBatch(messages: AgentMessage[]): boolean {
  let endIndex = messages.length - 1;
  while (endIndex >= 0 && roleOf(messages[endIndex]) === "custom") endIndex--;
  if (roleOf(messages[endIndex]) !== "toolResult") return false;
  let assistantIndex = endIndex;
  while (assistantIndex >= 0 && roleOf(messages[assistantIndex]) === "toolResult") assistantIndex--;
  if (roleOf(messages[assistantIndex]) !== "assistant") return false;
  const callIds = assistantToolCallIds(messages[assistantIndex]);
  const resultIds = messages.slice(assistantIndex + 1, endIndex + 1).map(toolResultCallId);
  if (!callIds || callIds.length === 0 || resultIds.some((id) => !id)) return false;
  return callIds.length === resultIds.length
    && new Set(callIds).size === callIds.length
    && callIds.every((id) => resultIds.includes(id));
}

function readEffectiveCompactionSettings(projectRoot: string): CompactionSettings {
  let settings: CompactionSettings = {
    enabled: true,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
  };
  for (const path of [join(resolveAgentDir(), "settings.json"), join(projectRoot, ".pi", "settings.json")]) {
    if (!existsSync(path)) continue;
    try {
      const payload = JSON.parse(readFileSync(path, "utf8")) as { compaction?: Partial<CompactionSettings> };
      if (!payload.compaction || typeof payload.compaction !== "object") continue;
      settings = {
        enabled: typeof payload.compaction.enabled === "boolean" ? payload.compaction.enabled : settings.enabled,
        reserveTokens: positiveNumber(payload.compaction.reserveTokens) ?? settings.reserveTokens,
        keepRecentTokens: positiveNumber(payload.compaction.keepRecentTokens) ?? settings.keepRecentTokens,
      };
    } catch {
      // Pi owns settings validation. A malformed optional override must not break provider requests.
    }
  }
  return settings;
}

function resolveAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function assistantUsage(message: AgentMessage): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number } | undefined {
  const record = message as MessageRecord;
  if (record.role !== "assistant" || record.stopReason === "aborted" || record.stopReason === "error") return undefined;
  if (!record.usage || typeof record.usage !== "object") return undefined;
  const usage = record.usage as Record<string, unknown>;
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  if ([input, output, cacheRead, cacheWrite].some((value) => value === undefined)) return undefined;
  return {
    input: input!,
    output: output!,
    cacheRead: cacheRead!,
    cacheWrite: cacheWrite!,
    ...(finiteNumber(usage.totalTokens) !== undefined ? { totalTokens: finiteNumber(usage.totalTokens) } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function estimateMessageTokens(message: AgentMessage): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function protectedFrontierStart(messages: AgentMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  let start = messages.length;
  while (start > 0 && tokens < keepRecentTokens) {
    start--;
    tokens += estimateMessageTokens(messages[start]);
  }
  while (start > 0 && roleOf(messages[start]) === "toolResult") start--;
  return start;
}

function replaceableToolResult(message: AgentMessage): AgentMessage | undefined {
  const record = message as MessageRecord;
  if (record.role !== "toolResult" || record.isError === true) return undefined;
  if (typeof record.toolName !== "string" || !REPLAYABLE_TOOL_NAMES.has(record.toolName.toLowerCase())) return undefined;
  const serialized = JSON.stringify(record.content);
  if (serialized.length < MIN_PRUNABLE_TOOL_RESULT_CHARS) return undefined;
  const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Maestro context pressure: stale large output from ${toolName} was pruned. Re-run the tool if the full payload is needed.]`,
    }],
  } as AgentMessage;
}

function pressureResult(
  messages: AgentMessage[],
  band: ContextPressureBand,
  estimatedTokens: number,
  thresholdTokens: number,
  prunedToolResults: number,
  savedTokens: number,
): ContextPressureResult {
  return { messages, band, estimatedTokens, thresholdTokens, prunedToolResults, savedTokens };
}

function updatePressureStatus(ctx: ExtensionContext, pressure: ContextPressureResult): void {
  if (pressure.band === "normal") {
    ctx.ui.setStatus("maestro-auto-compact", undefined);
    return;
  }
  const pruned = pressure.prunedToolResults > 0 ? ` -${pressure.prunedToolResults}` : "";
  ctx.ui.setStatus(
    "maestro-auto-compact",
    `CTX ${pressure.band.toUpperCase()} ${pressure.estimatedTokens}/${pressure.thresholdTokens}${pruned}`,
  );
}

function clearPressureStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("maestro-auto-compact", undefined);
}

function roleOf(message: AgentMessage | undefined): string | undefined {
  return (message as MessageRecord | undefined)?.role as string | undefined;
}

function assistantToolCallIds(message: AgentMessage): string[] | undefined {
  const content = (message as MessageRecord).content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") continue;
    const id = (block as { id?: unknown }).id;
    if (typeof id !== "string") return undefined;
    ids.push(id);
  }
  return ids;
}

function toolResultCallId(message: AgentMessage): string | undefined {
  const record = message as MessageRecord;
  return record.role === "toolResult" && typeof record.toolCallId === "string" ? record.toolCallId : undefined;
}

function buildMidTurnInstructions(estimate: ContextEstimate, contextWindow: number, reserveTokens: number): string {
  return [
    "This compaction was triggered at a completed tool-result checkpoint inside an active agent turn.",
    "Preserve the exact current objective, completed tool results, pending tool work, modified files, and the next action so execution can resume immediately.",
    `Estimated context: ${estimate.tokens}/${contextWindow} tokens; reserve: ${reserveTokens}; trailing since last usage: ${estimate.trailingTokens}.`,
  ].join("\n");
}
