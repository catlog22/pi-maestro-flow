import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  autoCompactionIdleStatus,
  COMPACTION_MODE_STATUS_KEY,
  COMPACTION_STATUS_KEY,
} from "./maestro-compaction.ts";
import { loadPiCompactionInternals, type PiCompactionInternals } from "./pi-internals.ts";

const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const AUTO_PRUNE_RATIO = 0.8;
const NUDGE_RATIO = 0.7;
const AUTO_PRUNE_TARGET_RATIO = NUDGE_RATIO;
const MIN_PRUNABLE_TOOL_RESULT_CHARS = 4_000;
const REPLAYABLE_TOOL_NAMES = new Set(["read", "grep", "glob", "search", "find"]);
const CONTINUE_PROMPT = "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.";
const PRUNE_STATE_ENTRY_TYPE = "maestro-auto-prune-state";
const PRUNE_STATE_VERSION = 1;

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

interface AppliedPrunes {
  messages: AgentMessage[];
  prunedToolResults: number;
  savedTokens: number;
  pendingSavedTokens: number;
}

export interface PruneManifestEntry {
  replacement: AgentMessage;
  savedTokens: number;
  introducedAtUsageEpoch?: string;
}

/** Set is retained for callers that used the original exported policy signature. */
export type PruneManifest = Set<string> | Map<string, PruneManifestEntry>;

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
  generation: number;
  nextOwner: number;
  activeOwner?: number;
  lastTriggerKey?: string;
  internalsWarningShown: boolean;
  lastNoCompactableKey?: string;
  pruneManifest: Map<string, PruneManifestEntry>;
  restoredPruneIds: Set<string>;
  sessionId?: string;
  persistedPruneKey?: string;
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
  onSessionStart(ctx: ExtensionContext): void;
  evaluate(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[] | undefined>;
  onAgentEnd(ctx: ExtensionContext): void;
  onCompact(): void;
  reset(ctx?: ExtensionContext): void;
} {
  const state: AutoCompactionState = {
    running: false,
    generation: 0,
    nextOwner: 0,
    internalsWarningShown: false,
    pruneManifest: new Map(),
    restoredPruneIds: new Set(),
  };
  const loadInternals = dependencies.loadInternals ?? loadPiCompactionInternals;
  const readSettings = dependencies.readSettings ?? readEffectiveCompactionSettings;
  return {
    onSessionStart(ctx) {
      state.pruneManifest.clear();
      state.sessionId = sessionIdOf(ctx);
      state.restoredPruneIds = loadPersistedPruneIds(ctx, state.sessionId);
      state.persistedPruneKey = pruneKey(state.restoredPruneIds);
      publishIdleStatus(ctx, readSettings(ctx.cwd).enabled);
    },
    async evaluate(messages, ctx) {
      const generation = state.generation;
      if (state.running) return undefined;
      const settings = readSettings(ctx.cwd);
      publishIdleStatus(ctx, settings.enabled);
      if (!ctx.model) {
        clearPressureStatus(ctx);
        return undefined;
      }
      if (!settings.enabled || ctx.model.contextWindow <= settings.reserveTokens) {
        state.pruneManifest.clear();
        state.restoredPruneIds.clear();
        persistPruneManifest(pi, state);
        clearPressureStatus(ctx);
        return undefined;
      }
      hydrateRestoredPrunes(state, messages);
      retainVisiblePrunes(state.pruneManifest, messages);
      if (!endsWithCompleteToolResultBatch(messages)) {
        clearPressureStatus(ctx);
        const stable = applyRecordedPrunes(messages, state.pruneManifest);
        persistPruneManifest(pi, state);
        return stable.prunedToolResults > 0 ? stable.messages : undefined;
      }
      const pressure = applyContextPressurePolicy(
        messages,
        ctx.model.contextWindow,
        settings,
        state.pruneManifest,
      );
      updatePressureStatus(ctx, pressure);
      persistPruneManifest(pi, state);
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
        if (state.generation !== generation) return undefined;
        clearPressureStatus(ctx);
        if (!state.internalsWarningShown) {
          state.internalsWarningShown = true;
          ctx.ui.notify(`Mid-turn compaction disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return pressure.messages;
      }
      if (state.generation !== generation || state.running) return undefined;
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
        ctx.ui.setStatus(COMPACTION_STATUS_KEY, `CTX CRITICAL ${pressure.estimatedTokens}/${thresholdTokens}`);
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
      const owner = ++state.nextOwner;
      state.activeOwner = owner;
      ctx.abort();
      ctx.ui.setStatus(COMPACTION_STATUS_KEY, `COMPACT ${estimate.tokens}/${thresholdTokens}`);
      const failCompaction = (error: unknown) => {
        if (state.generation !== generation || state.activeOwner !== owner) return;
        state.running = false;
        state.activeOwner = undefined;
        state.lastTriggerKey = undefined;
        clearPressureStatus(ctx);
        ctx.ui.notify(`Mid-turn compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      };
      try {
        ctx.compact({
          customInstructions: buildMidTurnInstructions(estimate, ctx.model.contextWindow, settings.reserveTokens),
          onComplete: () => {
            if (state.generation !== generation || state.activeOwner !== owner) return;
            state.running = false;
            state.activeOwner = undefined;
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
      if (!state.running) {
        publishIdleStatus(ctx, readSettings(ctx.cwd).enabled);
        clearPressureStatus(ctx);
      }
    },
    onCompact() {
      state.pruneManifest.clear();
      state.restoredPruneIds.clear();
      state.persistedPruneKey = undefined;
      state.lastTriggerKey = undefined;
      state.lastNoCompactableKey = undefined;
    },
    reset(ctx) {
      state.generation += 1;
      state.running = false;
      state.activeOwner = undefined;
      state.lastTriggerKey = undefined;
      state.internalsWarningShown = false;
      state.lastNoCompactableKey = undefined;
      state.pruneManifest.clear();
      state.restoredPruneIds.clear();
      state.persistedPruneKey = undefined;
      persistPruneManifest(pi, state);
      if (ctx) {
        clearPressureStatus(ctx);
        ctx.ui.setStatus(COMPACTION_MODE_STATUS_KEY, undefined);
      }
    },
  };
}

export function applyContextPressurePolicy(
  messages: AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings,
  pruneManifest: PruneManifest = new Map(),
): ContextPressureResult {
  const thresholdTokens = contextWindow - settings.reserveTokens;
  const applied = applyRecordedPrunes(messages, pruneManifest);
  const transformed = applied.messages;
  let savedTokens = applied.savedTokens;
  let prunedToolResults = applied.prunedToolResults;

  // A prune introduced after the latest successful provider usage is still
  // pending acknowledgement. Its saved tokens must remain deducted until a
  // later provider response establishes a new usage epoch.
  const initial = Math.max(0, estimateContextTokens(transformed).tokens - applied.pendingSavedTokens);
  const criticalRatio = thresholdTokens / contextWindow;
  const initialRatio = initial / contextWindow;
  const initiallyCritical = initial > thresholdTokens;
  if (!settings.enabled || (!initiallyCritical && initialRatio < NUDGE_RATIO)) {
    return pressureResult(transformed, "normal", initial, thresholdTokens, prunedToolResults, savedTokens);
  }
  if (!initiallyCritical && initialRatio < AUTO_PRUNE_RATIO) {
    return pressureResult(transformed, "nudge", initial, thresholdTokens, prunedToolResults, savedTokens);
  }

  const frontierStart = protectedFrontierStart(transformed, settings.keepRecentTokens);
  let newlySavedTokens = 0;
  const pruneTarget = Math.min(thresholdTokens, Math.floor(contextWindow * AUTO_PRUNE_TARGET_RATIO));
  const usageEpoch = latestProviderUsageEpoch(messages);
  for (let index = frontierStart - 1; index >= 0 && initial - newlySavedTokens > pruneTarget; index--) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId || hasRecordedPrune(pruneManifest, callId)) continue;
    const replacement = replaceableToolResult(transformed[index]);
    if (!replacement) continue;
    const before = estimateMessageTokens(transformed[index]);
    const after = estimateMessageTokens(replacement);
    if (after >= before) continue;
    transformed[index] = replacement;
    const saved = before - after;
    recordPrune(pruneManifest, callId, {
      replacement,
      savedTokens: saved,
      introducedAtUsageEpoch: usageEpoch,
    });
    newlySavedTokens += saved;
    savedTokens += saved;
    prunedToolResults++;
  }
  const estimatedTokens = Math.max(0, initial - newlySavedTokens);
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

function applyRecordedPrunes(messages: AgentMessage[], pruneManifest: PruneManifest): AppliedPrunes {
  const transformed = [...messages];
  let savedTokens = 0;
  let prunedToolResults = 0;
  let pendingSavedTokens = 0;
  const usageEpoch = latestProviderUsageEpoch(messages);
  for (let index = 0; index < transformed.length; index++) {
    const callId = toolResultCallId(transformed[index]);
    if (!callId) continue;
    const recorded = getRecordedPrune(pruneManifest, callId);
    if (!recorded && !hasRecordedPrune(pruneManifest, callId)) continue;
    const replacement = recorded?.replacement ?? replaceableToolResult(transformed[index]);
    if (!replacement) continue;
    const saved = recorded?.savedTokens ?? estimateMessageTokens(transformed[index]) - estimateMessageTokens(replacement);
    if (saved <= 0) continue;
    transformed[index] = replacement;
    savedTokens += saved;
    prunedToolResults++;
    if (recorded?.introducedAtUsageEpoch === usageEpoch) pendingSavedTokens += saved;
  }
  return { messages: transformed, prunedToolResults, savedTokens, pendingSavedTokens };
}

function retainVisiblePrunes(pruneManifest: PruneManifest, messages: AgentMessage[]): void {
  if (pruneManifest.size === 0) return;
  const visible = new Set(messages.map(toolResultCallId).filter((id): id is string => Boolean(id)));
  for (const callId of pruneManifest.keys()) {
    if (!visible.has(callId)) pruneManifest.delete(callId);
  }
}

function hasRecordedPrune(manifest: PruneManifest, callId: string): boolean {
  return manifest.has(callId);
}

function getRecordedPrune(manifest: PruneManifest, callId: string): PruneManifestEntry | undefined {
  return manifest instanceof Map ? manifest.get(callId) : undefined;
}

function recordPrune(manifest: PruneManifest, callId: string, entry: PruneManifestEntry): void {
  if (manifest instanceof Map) manifest.set(callId, entry);
  else manifest.add(callId);
}

function hydrateRestoredPrunes(state: AutoCompactionState, messages: AgentMessage[]): void {
  if (state.restoredPruneIds.size === 0) return;
  const usageEpoch = latestProviderUsageEpoch(messages);
  const visibleIds = new Set<string>();
  for (const message of messages) {
    const callId = toolResultCallId(message);
    if (!callId || !state.restoredPruneIds.has(callId)) continue;
    visibleIds.add(callId);
    const replacement = replaceableToolResult(message);
    if (!replacement) continue;
    const savedTokens = estimateMessageTokens(message) - estimateMessageTokens(replacement);
    if (savedTokens <= 0) continue;
    state.pruneManifest.set(callId, { replacement, savedTokens, introducedAtUsageEpoch: usageEpoch });
  }
  state.restoredPruneIds = new Set([...state.restoredPruneIds].filter((id) => !visibleIds.has(id)));
}

function persistPruneManifest(pi: ExtensionAPI, state: AutoCompactionState): void {
  const toolCallIds = [...state.pruneManifest.keys()].sort();
  const nextKey = pruneKey(toolCallIds);
  if (nextKey === state.persistedPruneKey) return;
  state.persistedPruneKey = nextKey;
  pi.appendEntry?.(PRUNE_STATE_ENTRY_TYPE, {
    version: PRUNE_STATE_VERSION,
    sessionId: state.sessionId,
    toolCallIds,
  });
}

function loadPersistedPruneIds(ctx: ExtensionContext, sessionId: string | undefined): Set<string> {
  const manager = ctx.sessionManager as {
    getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  } | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const entry = entries.filter((candidate) => candidate.type === "custom" && candidate.customType === PRUNE_STATE_ENTRY_TYPE).pop();
  const data = entry?.data as { version?: unknown; sessionId?: unknown; toolCallIds?: unknown } | undefined;
  if (data?.version !== PRUNE_STATE_VERSION || (sessionId && data.sessionId !== sessionId) || !Array.isArray(data?.toolCallIds)) {
    return new Set();
  }
  return new Set(data.toolCallIds.filter((value): value is string => typeof value === "string"));
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
  return manager?.getSessionId?.();
}

function pruneKey(toolCallIds: Iterable<string>): string {
  return [...toolCallIds].sort().join("\u0000");
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

function latestProviderUsageEpoch(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    const record = messages[index] as MessageRecord & { timestamp?: unknown };
    return `${index}:${String(record.timestamp ?? "")}:${JSON.stringify(usage)}`;
  }
  return undefined;
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
    clearPressureStatus(ctx);
    return;
  }
  const pruned = pressure.prunedToolResults > 0 ? ` -${pressure.prunedToolResults}` : "";
  ctx.ui.setStatus(
    COMPACTION_STATUS_KEY,
    `CTX ${pressure.band.toUpperCase()} ${pressure.estimatedTokens}/${pressure.thresholdTokens}${pruned}`,
  );
}

function publishIdleStatus(ctx: ExtensionContext, enabled: boolean): void {
  ctx.ui.setStatus(COMPACTION_MODE_STATUS_KEY, autoCompactionIdleStatus(enabled));
}

function clearPressureStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(COMPACTION_STATUS_KEY, undefined);
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
