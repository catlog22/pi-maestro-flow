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

export interface AgentProgress {
  agent: string;
  status: "running" | "completed" | "failed";
  recentTools: Array<{ name: string; status: string }>;
  toolCount: number;
  tokens: number;
  durationMs: number;
  lastActivityAt: number;
  startedAt: number;
  lastMessage?: string;
}

export interface Details {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
  structuredOutput?: unknown;
  progress?: Array<{
    agent: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt?: string;
    recentTools?: Array<{ name: string; status: string }>;
    toolCount?: number;
    tokens?: number;
  }>;
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

export interface ActiveAgent {
  agent: string;
  name?: string;
  correlationId: string;
  startedAt: number;
  abortController: AbortController;
  stdin?: import("node:stream").Writable;
  inbox: MessageEnvelope[];
  pendingResolve?: (result: SingleResult) => void;
  lastActivityAt: number;
  replyTo?: string;
}

export interface TeammateState {
  baseCwd: string;
  currentSessionId: string | null;
  activeRuns: Map<string, ActiveAgent>;
  namedAgents: Map<string, string>;
}

export const TEAMMATE_COMPLETE_EVENT = "teammate:complete";
export const TEAMMATE_STARTED_EVENT = "teammate:started";
export const TEAMMATE_MESSAGE_EVENT = "teammate:message";
