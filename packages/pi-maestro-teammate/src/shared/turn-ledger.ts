import {
  AGENT_TURN_VERSION,
  normalizeMessageProvenanceV1,
  type AgentRunPhase,
  type AgentTerminalStatus,
  type AgentToolActivityState,
  type AgentTurnEvent,
  type AgentTurnMessageMetadataV1,
  type AgentTurnSnapshot,
  type MessageProvenanceV1,
} from "./types.ts";

export const AGENT_TURN_LEDGER_VERSION = 1 as const;
export const AGENT_TURN_EVENT_CUSTOM_TYPE = "teammate-turn-event";

export interface AgentTurnLedgerAgentState {
  correlationId: string;
  current: AgentTurnSnapshot;
  last?: AgentTurnSnapshot;
}

export interface AgentTurnLedgerOwner {
  correlationId: string;
  runtimeGeneration: number;
  promptSeq: number;
}

/**
 * Immutable reducer state. The ownership and fingerprint maps are retained so
 * incremental live updates and a cold fold make the same decisions.
 */
export interface AgentTurnLedger {
  version: typeof AGENT_TURN_LEDGER_VERSION;
  agents: ReadonlyMap<string, AgentTurnLedgerAgentState>;
  turnOwners: ReadonlyMap<string, AgentTurnLedgerOwner>;
  eventFingerprints: ReadonlyMap<string, string>;
}

export type AgentTurnLedgerDiagnosticCode =
  | "malformed-event"
  | "unsupported-version"
  | "duplicate-event"
  | "conflicting-duplicate"
  | "turn-ownership"
  | "trigger-ownership"
  | "stale-generation"
  | "stale-sequence"
  | "stale-timestamp"
  | "stale-lifecycle"
  | "terminal-absorbed";

export interface AgentTurnLedgerDiagnostic {
  code: AgentTurnLedgerDiagnosticCode;
  message: string;
  correlationId?: string;
  turnId?: string;
  eventIndex?: number;
}

export type AgentTurnEventValidation =
  | { valid: true; event: AgentTurnEvent }
  | { valid: false; diagnostic: AgentTurnLedgerDiagnostic };

export type AgentTurnLedgerApplyResult =
  | {
      status: "applied";
      ledger: AgentTurnLedger;
      agent: AgentTurnLedgerAgentState;
    }
  | {
      status: "duplicate";
      ledger: AgentTurnLedger;
      diagnostic: AgentTurnLedgerDiagnostic;
      agent?: AgentTurnLedgerAgentState;
    }
  | {
      status: "ignored";
      ledger: AgentTurnLedger;
      diagnostic: AgentTurnLedgerDiagnostic;
      agent?: AgentTurnLedgerAgentState;
    }
  | {
      status: "rejected";
      ledger: AgentTurnLedger;
      diagnostic: AgentTurnLedgerDiagnostic;
    };

export interface AgentTurnLedgerFoldResult {
  ledger: AgentTurnLedger;
  diagnostics: readonly AgentTurnLedgerDiagnostic[];
  applied: number;
  duplicates: number;
  ignored: number;
  rejected: number;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  has(key: K): boolean { return this.#values.has(key); }
  get(key: K): V | undefined { return this.#values.get(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
}

const RUN_PHASES: ReadonlySet<AgentRunPhase> = new Set([
  "waiting-dependency",
  "waiting-capacity",
  "starting",
  "restoring",
  "prompting",
  "tool-execution",
  "result-ready",
  "retrying",
  "compacting",
  "continuing",
  "settling",
]);

const TOOL_ACTIVITY_STATES: ReadonlySet<AgentToolActivityState> = new Set([
  "idle",
  "active",
  "unknown",
]);

const TURN_MESSAGE_ROLES = new Set(["user", "assistant", "tool", "system", "custom"]);
const EVENT_TYPES = new Set([
  "trigger-enqueued",
  "trigger-accepted",
  "turn-started",
  "progress",
  "result-ready",
  "turn-ended",
  "agent-ended",
  "turn-settled",
  "failed",
  "terminated",
]);

type SnapshotBase = Pick<
  AgentTurnSnapshot,
  | "version"
  | "turnId"
  | "correlationId"
  | "runtimeGeneration"
  | "promptSeq"
  | "loopSeq"
  | "trigger"
  | "startedAt"
  | "lastActivityAt"
  | "phase"
  | "toolActivity"
  | "lastMessage"
>;

export function createAgentTurnLedger(): AgentTurnLedger {
  return freezeLedger(new Map(), new Map(), new Map());
}

export function agentTurnLedgerAgent(
  ledger: AgentTurnLedger,
  correlationId: string,
): AgentTurnLedgerAgentState | undefined {
  return ledger.agents.get(correlationId);
}

/** Validate and canonicalize persisted or live event input without throwing. */
export function validateAgentTurnEvent(value: unknown): AgentTurnEventValidation {
  if (!plainObject(value)) return invalidEvent("malformed-event", "Turn event must be an object.");
  if (value.version !== AGENT_TURN_VERSION) {
    return invalidEvent("unsupported-version", `Unsupported turn event version: ${String(value.version)}`);
  }
  if (!EVENT_TYPES.has(String(value.type))) {
    return invalidEvent("malformed-event", `Unknown turn event type: ${String(value.type)}`);
  }
  if (!validIdentifier(value.turnId) || !validIdentifier(value.correlationId)) {
    return invalidEvent(
      "malformed-event",
      "Turn event requires bounded turnId and correlationId identifiers.",
      value,
    );
  }
  if (!nonNegativeSafeInteger(value.runtimeGeneration)
    || !nonNegativeSafeInteger(value.promptSeq)
    || !nonNegativeSafeInteger(value.loopSeq)
    || !nonNegativeSafeInteger(value.timestamp)) {
    return invalidEvent(
      "malformed-event",
      "Turn generation, prompt, loop, and timestamp values must be non-negative safe integers.",
      value,
    );
  }
  const trigger = canonicalProvenance(value.trigger);
  if (!trigger) {
    return invalidEvent("malformed-event", "Turn event trigger provenance is malformed.", value);
  }

  const base = {
    version: AGENT_TURN_VERSION,
    turnId: value.turnId,
    correlationId: value.correlationId,
    runtimeGeneration: value.runtimeGeneration,
    promptSeq: value.promptSeq,
    loopSeq: value.loopSeq,
    trigger,
    timestamp: value.timestamp,
  } as const;
  const phase = optionalRunPhase(value.phase);
  if (phase === false) return invalidEvent("malformed-event", "Turn event phase is invalid.", value);
  const lastMessage = optionalLastMessage(value.lastMessage, value.timestamp);
  if (lastMessage === false) {
    return invalidEvent("malformed-event", "Turn event lastMessage metadata is malformed.", value);
  }

  let event: AgentTurnEvent;
  switch (value.type) {
    case "trigger-enqueued":
    case "trigger-accepted":
      event = { ...base, type: value.type };
      break;
    case "turn-started":
      event = { ...base, type: value.type, ...(phase === undefined ? {} : { phase }) };
      break;
    case "progress": {
      const toolActivity = optionalToolActivity(value.toolActivity);
      if (toolActivity === false) {
        return invalidEvent("malformed-event", "Turn progress toolActivity is invalid.", value);
      }
      event = {
        ...base,
        type: value.type,
        ...(phase === undefined ? {} : { phase }),
        ...(toolActivity === undefined ? {} : { toolActivity }),
        ...(lastMessage === undefined ? {} : { lastMessage }),
      };
      break;
    }
    case "result-ready":
    case "turn-ended":
      if (!lastMessage) {
        return invalidEvent("malformed-event", `${value.type} requires lastMessage metadata.`, value);
      }
      event = { ...base, type: value.type, lastMessage };
      break;
    case "agent-ended":
      event = { ...base, type: value.type, ...(lastMessage === undefined ? {} : { lastMessage }) };
      break;
    case "turn-settled":
      if (value.outcome !== "completed") {
        return invalidEvent("malformed-event", "turn-settled requires outcome completed.", value);
      }
      event = {
        ...base,
        type: value.type,
        outcome: "completed",
        ...(lastMessage === undefined ? {} : { lastMessage }),
      };
      break;
    case "failed":
      if (value.outcome !== "failed" || !nonEmptyText(value.error)) {
        return invalidEvent("malformed-event", "failed requires outcome failed and a non-empty error.", value);
      }
      event = {
        ...base,
        type: value.type,
        outcome: "failed",
        error: value.error,
        ...(lastMessage === undefined ? {} : { lastMessage }),
      };
      break;
    case "terminated":
      if (value.outcome !== "terminated" || !nonEmptyText(value.reason)) {
        return invalidEvent(
          "malformed-event",
          "terminated requires outcome terminated and a non-empty reason.",
          value,
        );
      }
      event = {
        ...base,
        type: value.type,
        outcome: "terminated",
        reason: value.reason,
        ...(lastMessage === undefined ? {} : { lastMessage }),
      };
      break;
    default:
      return invalidEvent("malformed-event", `Unknown turn event type: ${String(value.type)}`, value);
  }
  return Object.freeze({ valid: true, event: deepFreeze(event) });
}

/**
 * Apply one event. Rejections, stale events, terminal absorption, and exact
 * duplicates retain the identical ledger reference.
 */
export function applyAgentTurnEvent(
  ledger: AgentTurnLedger,
  value: unknown,
): AgentTurnLedgerApplyResult {
  const validation = validateAgentTurnEvent(value);
  if (!validation.valid) {
    return Object.freeze({ status: "rejected", ledger, diagnostic: validation.diagnostic });
  }
  const event = validation.event;
  const eventSlot = turnEventSlot(event);
  const fingerprint = canonicalJson(event);
  const priorFingerprint = ledger.eventFingerprints.get(eventSlot);
  const existingAgent = ledger.agents.get(event.correlationId);
  if (priorFingerprint !== undefined) {
    if (priorFingerprint === fingerprint) {
      return Object.freeze({
        status: "duplicate",
        ledger,
        diagnostic: diagnostic("duplicate-event", "Identical turn event was already applied.", event),
        ...(existingAgent === undefined ? {} : { agent: existingAgent }),
      });
    }
    return Object.freeze({
      status: "rejected",
      ledger,
      diagnostic: diagnostic(
        "conflicting-duplicate",
        "Turn event reuses an occupied lifecycle slot with different data.",
        event,
      ),
    });
  }

  const turnOwner = ledger.turnOwners.get(event.turnId);
  if (turnOwner && !sameTurnOwner(turnOwner, event)) {
    return rejected(
      ledger,
      diagnostic("turn-ownership", `Turn ${event.turnId} is already owned by another agent or sequence.`, event),
    );
  }

  if (!existingAgent) return applyNewTurn(ledger, event, fingerprint);
  const current = existingAgent.current;
  if (event.runtimeGeneration < current.runtimeGeneration) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-generation", "Older runtime generation cannot update the current turn.", event),
    );
  }
  if (event.runtimeGeneration > current.runtimeGeneration) {
    if (event.timestamp < (current.lastActivityAt ?? 0)) {
      return ignored(
        ledger,
        existingAgent,
        diagnostic("stale-timestamp", "Regressive timestamp cannot replace the current runtime generation.", event),
      );
    }
    return applyNewTurn(ledger, event, fingerprint, existingAgent);
  }

  if (event.promptSeq < current.promptSeq) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-sequence", "Regressive prompt sequence cannot update the current turn.", event),
    );
  }
  if (event.promptSeq > current.promptSeq) {
    if (event.timestamp < (current.lastActivityAt ?? 0)) {
      return ignored(
        ledger,
        existingAgent,
        diagnostic("stale-timestamp", "Regressive timestamp cannot replace the current prompt sequence.", event),
      );
    }
    return applyNewTurn(ledger, event, fingerprint, existingAgent);
  }

  if (event.turnId !== current.turnId) {
    return rejected(
      ledger,
      diagnostic("turn-ownership", "One runtime generation and prompt sequence cannot own two turn IDs.", event),
    );
  }
  if (!sameProvenance(current.trigger, event.trigger)) {
    return rejected(
      ledger,
      diagnostic("trigger-ownership", "A logical turn cannot change its trigger provenance.", event),
    );
  }
  if (terminalSnapshot(current)) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("terminal-absorbed", "Terminal turn state absorbs later events from the same turn.", event),
    );
  }
  if (event.loopSeq < current.loopSeq) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-sequence", "Regressive loop sequence cannot update the current turn.", event),
    );
  }
  if (event.timestamp < (current.lastActivityAt ?? 0)) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-timestamp", "Regressive event timestamp cannot update the current turn.", event),
    );
  }
  const lastMessage = eventLastMessage(event);
  if (lastMessage && current.lastMessage && lastMessage.timestamp < current.lastMessage.timestamp) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-timestamp", "Regressive message timestamp cannot update the current turn.", event),
    );
  }
  if (event.type === "turn-started"
    && event.loopSeq === current.loopSeq
    && (current.state === "result-ready" || current.state === "settling")) {
    return ignored(
      ledger,
      existingAgent,
      diagnostic("stale-lifecycle", "A same-loop turn start cannot resurrect a later lifecycle state.", event),
    );
  }

  const nextSnapshot = reduceSnapshot(current, event);
  const nextAgent = Object.freeze({ ...existingAgent, current: nextSnapshot });
  return applied(ledger, nextAgent, event, fingerprint);
}

export const reduceAgentTurnLedger = applyAgentTurnEvent;

/** Build the one terminal event owned by the final orchestration outcome. */
export function createAgentTurnTerminalEvent(
  turn: AgentTurnSnapshot,
  status: AgentTerminalStatus,
  message?: string,
  timestamp = Date.now(),
): AgentTurnEvent {
  const settledAt = Math.max(timestamp, turn.lastActivityAt ?? 0);
  const base = {
    version: AGENT_TURN_VERSION,
    turnId: turn.turnId,
    correlationId: turn.correlationId,
    runtimeGeneration: turn.runtimeGeneration,
    promptSeq: turn.promptSeq,
    loopSeq: turn.loopSeq,
    trigger: turn.trigger,
    timestamp: settledAt,
  } as const;
  if (status === "completed") return { ...base, type: "turn-settled", outcome: "completed" };
  if (status === "terminated") {
    return {
      ...base,
      type: "terminated",
      outcome: "terminated",
      reason: message?.trim() || "Teammate turn terminated.",
    };
  }
  return {
    ...base,
    type: "failed",
    outcome: "failed",
    error: message?.trim() || "Teammate turn failed.",
  };
}

/** Fold canonical event values, retaining every diagnostic with its source index. */
export function foldAgentTurnEvents(
  values: readonly unknown[],
  initialLedger: AgentTurnLedger = createAgentTurnLedger(),
): AgentTurnLedgerFoldResult {
  return foldValues(values, initialLedger, (value) => ({ matched: true, data: value }));
}

/**
 * Rebuild from Pi parent-session entries. Unrelated custom entries are ignored;
 * malformed entries for this module are rejected diagnostically.
 */
export function rebuildAgentTurnLedger(
  entries: readonly unknown[],
  initialLedger: AgentTurnLedger = createAgentTurnLedger(),
): AgentTurnLedgerFoldResult {
  return foldValues(entries, initialLedger, (value) => {
    if (!plainObject(value)
      || value.type !== "custom"
      || value.customType !== AGENT_TURN_EVENT_CUSTOM_TYPE) return { matched: false };
    return { matched: true, data: value.data };
  });
}

function foldValues(
  values: readonly unknown[],
  initialLedger: AgentTurnLedger,
  select: (value: unknown) => { matched: false } | { matched: true; data: unknown },
): AgentTurnLedgerFoldResult {
  let ledger: AgentTurnLedger = createTransientLedger(initialLedger);
  let appliedCount = 0;
  let duplicateCount = 0;
  let ignoredCount = 0;
  let rejectedCount = 0;
  const diagnostics: AgentTurnLedgerDiagnostic[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const selected = select(values[index]);
    if (!selected.matched) continue;
    const result = applyAgentTurnEvent(ledger, selected.data);
    ledger = result.ledger;
    if (result.status === "applied") appliedCount += 1;
    else {
      diagnostics.push(Object.freeze({ ...result.diagnostic, eventIndex: index }));
      if (result.status === "duplicate") duplicateCount += 1;
      if (result.status === "ignored") ignoredCount += 1;
      if (result.status === "rejected") rejectedCount += 1;
    }
  }
  const foldedLedger = appliedCount === 0
    ? initialLedger
    : freezeLedger(ledger.agents, ledger.turnOwners, ledger.eventFingerprints);
  transientLedgers.delete(ledger as object);
  return Object.freeze({
    ledger: foldedLedger,
    diagnostics: Object.freeze(diagnostics),
    applied: appliedCount,
    duplicates: duplicateCount,
    ignored: ignoredCount,
    rejected: rejectedCount,
  });
}

function applyNewTurn(
  ledger: AgentTurnLedger,
  event: AgentTurnEvent,
  fingerprint: string,
  existingAgent?: AgentTurnLedgerAgentState,
): AgentTurnLedgerApplyResult {
  const nextAgent = Object.freeze({
    correlationId: event.correlationId,
    current: reduceSnapshot(undefined, event),
    ...(existingAgent === undefined ? {} : { last: existingAgent.current }),
  });
  return applied(ledger, nextAgent, event, fingerprint);
}

function applied(
  ledger: AgentTurnLedger,
  agent: AgentTurnLedgerAgentState,
  event: AgentTurnEvent,
  fingerprint: string,
): AgentTurnLedgerApplyResult {
  const transient = transientLedgers.has(ledger as object);
  const agents = transient
    ? ledger.agents as Map<string, AgentTurnLedgerAgentState>
    : new Map(ledger.agents);
  agents.set(agent.correlationId, agent);
  const turnOwners = transient
    ? ledger.turnOwners as Map<string, AgentTurnLedgerOwner>
    : new Map(ledger.turnOwners);
  if (!turnOwners.has(event.turnId)) {
    turnOwners.set(event.turnId, Object.freeze({
      correlationId: event.correlationId,
      runtimeGeneration: event.runtimeGeneration,
      promptSeq: event.promptSeq,
    }));
  }
  const eventFingerprints = transient
    ? ledger.eventFingerprints as Map<string, string>
    : new Map(ledger.eventFingerprints);
  eventFingerprints.set(turnEventSlot(event), fingerprint);
  return Object.freeze({
    status: "applied",
    ledger: transient ? ledger : freezeLedger(agents, turnOwners, eventFingerprints),
    agent,
  });
}

function ignored(
  ledger: AgentTurnLedger,
  agent: AgentTurnLedgerAgentState,
  value: AgentTurnLedgerDiagnostic,
): AgentTurnLedgerApplyResult {
  return Object.freeze({ status: "ignored", ledger, diagnostic: value, agent });
}

function rejected(
  ledger: AgentTurnLedger,
  value: AgentTurnLedgerDiagnostic,
): AgentTurnLedgerApplyResult {
  return Object.freeze({ status: "rejected", ledger, diagnostic: value });
}

function reduceSnapshot(
  current: AgentTurnSnapshot | undefined,
  event: AgentTurnEvent,
): AgentTurnSnapshot {
  const base = snapshotBase(current, event);
  const resultReadyAt = current?.resultReadyAt;
  switch (event.type) {
    case "trigger-enqueued":
    case "trigger-accepted":
    case "progress":
      return current ? withSnapshotState(base, current) : deepFreeze({ ...base, state: "active" });
    case "turn-started":
      return deepFreeze({ ...base, state: "active" });
    case "result-ready":
      if (current?.state === "settling") {
        return deepFreeze({ ...base, state: "settling", resultReadyAt: resultReadyAt ?? event.timestamp });
      }
      return deepFreeze({ ...base, state: "result-ready", resultReadyAt: resultReadyAt ?? event.timestamp });
    case "turn-ended":
    case "agent-ended":
      return deepFreeze({
        ...base,
        state: "settling",
        ...(resultReadyAt === undefined ? {} : { resultReadyAt }),
      });
    case "turn-settled":
      return deepFreeze({
        ...base,
        state: "settled",
        ...(resultReadyAt === undefined ? {} : { resultReadyAt }),
        settledAt: event.timestamp,
        outcome: "completed",
      });
    case "failed":
      return deepFreeze({
        ...base,
        state: "failed",
        ...(resultReadyAt === undefined ? {} : { resultReadyAt }),
        settledAt: event.timestamp,
        outcome: "failed",
        error: event.error,
      });
    case "terminated":
      return deepFreeze({
        ...base,
        state: "terminated",
        ...(resultReadyAt === undefined ? {} : { resultReadyAt }),
        settledAt: event.timestamp,
        outcome: "terminated",
        reason: event.reason,
      });
  }
}

function snapshotBase(current: AgentTurnSnapshot | undefined, event: AgentTurnEvent): SnapshotBase {
  const retryLoopStarted = event.type === "turn-started"
    && current !== undefined
    && event.loopSeq > current.loopSeq;
  const phase = event.type === "turn-started"
    ? event.phase
    : event.type === "progress"
      ? event.phase ?? current?.phase
      : event.type === "result-ready"
        ? "result-ready"
        : event.type === "turn-ended" || event.type === "agent-ended"
          || event.type === "turn-settled" || event.type === "failed" || event.type === "terminated"
          ? "settling"
          : current?.phase;
  const toolActivity = retryLoopStarted
    ? undefined
    : event.type === "progress"
      ? event.toolActivity ?? current?.toolActivity
      : current?.toolActivity;
  const lastMessage = eventLastMessage(event) ?? current?.lastMessage;
  const startedAt = event.type === "turn-started"
    ? current?.startedAt ?? event.timestamp
    : current?.startedAt;
  return {
    version: AGENT_TURN_VERSION,
    turnId: event.turnId,
    correlationId: event.correlationId,
    runtimeGeneration: event.runtimeGeneration,
    promptSeq: event.promptSeq,
    loopSeq: event.loopSeq,
    trigger: current?.trigger ?? event.trigger,
    ...(startedAt === undefined ? {} : { startedAt }),
    lastActivityAt: event.timestamp,
    ...(phase === undefined ? {} : { phase }),
    ...(toolActivity === undefined ? {} : { toolActivity }),
    ...(lastMessage === undefined ? {} : { lastMessage }),
  };
}

function withSnapshotState(base: SnapshotBase, current: AgentTurnSnapshot): AgentTurnSnapshot {
  switch (current.state) {
    case "active": return deepFreeze({ ...base, state: "active" });
    case "result-ready": return deepFreeze({ ...base, state: "result-ready", resultReadyAt: current.resultReadyAt });
    case "settling": return deepFreeze({
      ...base,
      state: "settling",
      ...(current.resultReadyAt === undefined ? {} : { resultReadyAt: current.resultReadyAt }),
    });
    case "settled": return deepFreeze({
      ...base,
      state: "settled",
      ...(current.resultReadyAt === undefined ? {} : { resultReadyAt: current.resultReadyAt }),
      settledAt: current.settledAt,
      outcome: "completed",
    });
    case "failed": return deepFreeze({
      ...base,
      state: "failed",
      ...(current.resultReadyAt === undefined ? {} : { resultReadyAt: current.resultReadyAt }),
      settledAt: current.settledAt,
      outcome: "failed",
      error: current.error,
    });
    case "terminated": return deepFreeze({
      ...base,
      state: "terminated",
      ...(current.resultReadyAt === undefined ? {} : { resultReadyAt: current.resultReadyAt }),
      settledAt: current.settledAt,
      outcome: "terminated",
      reason: current.reason,
    });
  }
}

const transientLedgers = new WeakSet<object>();

function createTransientLedger(ledger: AgentTurnLedger): AgentTurnLedger {
  const transient: AgentTurnLedger = {
    version: AGENT_TURN_LEDGER_VERSION,
    agents: new Map(ledger.agents),
    turnOwners: new Map(ledger.turnOwners),
    eventFingerprints: new Map(ledger.eventFingerprints),
  };
  transientLedgers.add(transient);
  return transient;
}

function freezeLedger(
  agents: ReadonlyMap<string, AgentTurnLedgerAgentState>,
  turnOwners: ReadonlyMap<string, AgentTurnLedgerOwner>,
  eventFingerprints: ReadonlyMap<string, string>,
): AgentTurnLedger {
  return Object.freeze({
    version: AGENT_TURN_LEDGER_VERSION,
    agents: immutableSortedMap(agents),
    turnOwners: immutableSortedMap(turnOwners),
    eventFingerprints: immutableSortedMap(eventFingerprints),
  });
}

function immutableSortedMap<V>(entries: Iterable<readonly [string, V]>): ReadonlyMap<string, V> {
  return new ImmutableMap([...entries].sort(([left], [right]) => left.localeCompare(right, "en")));
}

function terminalSnapshot(snapshot: AgentTurnSnapshot): boolean {
  return snapshot.state === "settled" || snapshot.state === "failed" || snapshot.state === "terminated";
}

function sameTurnOwner(owner: AgentTurnLedgerOwner, event: AgentTurnEvent): boolean {
  return owner.correlationId === event.correlationId
    && owner.runtimeGeneration === event.runtimeGeneration
    && owner.promptSeq === event.promptSeq;
}

function sameProvenance(left: MessageProvenanceV1, right: MessageProvenanceV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function turnEventSlot(event: AgentTurnEvent): string {
  const base = [
    event.correlationId,
    String(event.runtimeGeneration),
    String(event.promptSeq),
    String(event.loopSeq),
    event.type,
  ].join("\u0000");
  return event.type === "progress" ? `${base}\u0000${event.timestamp}` : base;
}

function eventLastMessage(event: AgentTurnEvent): AgentTurnMessageMetadataV1 | undefined {
  return "lastMessage" in event ? event.lastMessage : undefined;
}

function optionalLastMessage(
  value: unknown,
  eventTimestamp: number,
): AgentTurnMessageMetadataV1 | undefined | false {
  if (value === undefined) return undefined;
  if (!plainObject(value)
    || !TURN_MESSAGE_ROLES.has(String(value.role))
    || !nonNegativeSafeInteger(value.timestamp)
    || value.timestamp > eventTimestamp) return false;
  const provenance = canonicalProvenance(value.provenance);
  if (!provenance) return false;
  return deepFreeze({
    role: value.role as AgentTurnMessageMetadataV1["role"],
    timestamp: value.timestamp,
    provenance,
  });
}

function canonicalProvenance(value: unknown): MessageProvenanceV1 | undefined {
  if (!plainObject(value)) return undefined;
  const normalized = normalizeMessageProvenanceV1(value);
  return canonicalJson(value) === canonicalJson(normalized) ? deepFreeze(normalized) : undefined;
}

function optionalRunPhase(value: unknown): AgentRunPhase | undefined | false {
  if (value === undefined) return undefined;
  return RUN_PHASES.has(value as AgentRunPhase) ? value as AgentRunPhase : false;
}

function optionalToolActivity(value: unknown): AgentToolActivityState | undefined | false {
  if (value === undefined) return undefined;
  return TOOL_ACTIVITY_STATES.has(value as AgentToolActivityState) ? value as AgentToolActivityState : false;
}

function invalidEvent(
  code: "malformed-event" | "unsupported-version",
  message: string,
  value?: Record<string, unknown>,
): AgentTurnEventValidation {
  const correlationId = value && validIdentifier(value.correlationId) ? value.correlationId : undefined;
  const turnId = value && validIdentifier(value.turnId) ? value.turnId : undefined;
  return Object.freeze({
    valid: false,
    diagnostic: Object.freeze({
      code,
      message,
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(turnId === undefined ? {} : { turnId }),
    }),
  });
}

function diagnostic(
  code: AgentTurnLedgerDiagnosticCode,
  message: string,
  event: AgentTurnEvent,
): AgentTurnLedgerDiagnostic {
  return Object.freeze({ code, message, correlationId: event.correlationId, turnId: event.turnId });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/\s|[\u0000-\u001f\u007f]/.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}
