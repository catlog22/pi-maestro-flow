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
  structuredOutput?: unknown;
  attemptedModels?: string[];
}

export type AgentProgressStatus = "pending" | "running" | "completed" | "failed";

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
  durationMs: number;
  lastActivityAt: number;
  startedAt: number;
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
  lastMessage?: string;
}

export interface Details {
  mode: "single" | "parallel" | "chain" | "graph";
  results: SingleResult[];
  structuredOutput?: unknown;
  progress?: AgentProgressSnapshot[];
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

export type AgentStatus = "running" | "sleeping" | "completed";

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
  inbox: MessageEnvelope[];
  outputLog: string[];
  pendingResolve?: (result: SingleResult) => void;
  lastActivityAt: number;
  replyTo?: string;
  spawnedBy?: string;
  status: AgentStatus;
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
}

export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
