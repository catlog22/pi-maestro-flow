/**
 * Core types for the teammate tool.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  usage: Usage;
  model: string;
  correlationId: string;
  durationMs: number;
  /** Whether the child process remains available for teammate-send after this turn. */
  wakeable?: boolean;
  /**
   * The final assistant result is available, but the child has not yet emitted
   * its authoritative lifecycle confirmation (`agent_end`, close, or error).
   */
  lifecyclePending?: boolean;
  structuredOutput?: unknown;
  attemptedModels?: string[];
}

export type AgentProgressStatus = "pending" | "running" | "retrying" | "completed" | "failed";

export interface AgentProgress {
  agent: string;
  name?: string;
  correlationId?: string;
  taskIndex?: number;
  dependencies?: number[];
  status: AgentProgressStatus;
  recentTools: Array<{ name: string; status: string }>;
  toolCount: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  lastActivityAt: number;
  startedAt: number;
  /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
  resultReadyAt?: number;
  lastMessage?: string;
}

export interface AgentProgressSnapshot {
  agent: string;
  name?: string;
  correlationId: string;
  taskIndex: number;
  dependencies: number[];
  status: AgentProgressStatus;
  startedAt?: string;
  completedAt?: string;
  recentTools?: Array<{ name: string; status: string }>;
  toolCount?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  lastActivityAt?: number;
  /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
  resultReadyAt?: number;
  lastMessage?: string;
  error?: string;
}

export interface ChildAgentCallSnapshot {
  agent: string;
  name?: string;
  correlationId: string;
  parentCorrelationId?: string;
  parentName?: string;
  status: "running" | "retrying" | "completed" | "failed";
  startedAt?: number;
  durationMs?: number;
  lastActivityAt?: number;
  /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
  resultReadyAt?: number;
  recentTools?: Array<{ name: string; status: string }>;
  lastMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Details {
  mode: "single" | "parallel" | "chain" | "graph";
  results: SingleResult[];
  structuredOutput?: unknown;
  progress?: AgentProgressSnapshot[];
  childCalls?: ChildAgentCallSnapshot[];
}

export type MessageKind = "task" | "notification" | "result";

export interface MessageEnvelope {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  correlation_id?: string;
  payload: string;
  timestamp: number;
}

export type AgentStatus = "pending" | "running" | "retrying" | "sleeping" | "completed" | "failed";

export interface AgentRetryState {
  attempt: number;
  maxRetries: number;
  nextRetryAt: number;
  lastError: string;
}

export interface TeammateInteractionRecord {
  requestId: string;
  interaction: "permission" | "question";
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface ActiveAgent {
  agent: string;
  name?: string;
  correlationId: string;
  startedAt: number;
  abortController: AbortController;
  stdin?: import("node:stream").Writable;
  sendControl?: (message: Record<string, unknown>) => boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionDir?: string;
  promptSeq?: number;
  lastParkNonce?: string;
  lease?: import("../runs/session-handoff.ts").SessionLease;
  pendingHandoff?: {
    nonce: string;
    resolve: (ready: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  pendingHandback?: {
    nonce: string;
    epoch: number;
    sessionId?: string;
    sessionFile?: string;
  };
  pendingCancel?: { nonce: string; fencedEpoch: number };
  pendingInteractions?: Map<string, TeammateInteractionRecord>;
  inbox: MessageEnvelope[];
  outputLog: string[];
  pendingResolve?: (result: SingleResult) => void;
  lastActivityAt: number;
  /**
   * When this agent failed. Set alongside `status: "failed"`, mirroring
   * `sleptAt` for retired agents, and read by the retention sweep that
   * eventually removes the tombstone.
   */
  failedAt?: number;
  replyTo?: string;
  spawnedBy?: string;
  /**
   * Nesting depth of this agent within the dispatch tree. Root-tool dispatches
   * are 0; every proxied dispatch is its spawner's depth plus one. This is the
   * authoritative depth: nested dispatches execute inside the root process, so
   * a process-scoped environment variable cannot carry it.
   */
  depth: number;
  status: AgentStatus;
  retry?: AgentRetryState;
  /** Pi emitted a final no-tool assistant turn; agent_end has not necessarily arrived yet. */
  resultReadyAt?: number;
  lastResult?: string;
  sleptAt?: number;
  sleepMs: number;
  progress?: AgentProgressSnapshot[];
}

export interface TeammateState {
  baseCwd: string;
  currentSessionId: string | null;
  mainSessionFile?: string;
  handoffSwitching?: boolean;
  activeRuns: Map<string, ActiveAgent>;
  namedAgents: Map<string, string>;
  /**
   * Settles relayed permission/question requests belonging to an agent that is
   * going away, so a killed agent's queued prompt never keeps the shared
   * interaction queue — and every agent behind it — waiting. Installed by the
   * root extension; absent in states that never relay interactions.
   */
  cancelInteractions?: (correlationId: string, reason: string) => void;
  /**
   * Bounded, insertion-ordered record of agents that have left `activeRuns`.
   * A settled agent is removed outright, so without this a lookup afterwards
   * cannot tell "this agent failed" from "there is no such agent" — and the
   * caller retries a name that will never come back. Oldest entries are
   * dropped once the cap is reached.
   */
  recentlySettled?: Map<string, SettledAgentRecord>;
  /**
   * Agents whose `result-ready` edge has already been reported to a waiter.
   * The flag itself stays set until the lifecycle settles, so without this a
   * caller waiting again for the true terminal state would be handed
   * `result-ready` back immediately, every time.
   */
  resultReadyNotified?: Set<string>;
}

export interface SettledAgentRecord {
  correlationId: string;
  agent: string;
  name?: string;
  status: "completed" | "failed" | "terminated";
  settledAt: number;
  lastResult?: string;
}

export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
