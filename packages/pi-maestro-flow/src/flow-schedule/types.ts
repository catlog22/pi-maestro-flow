export const FLOW_SCHEDULE_VERSION = 1 as const;
export const FLOW_SCHEDULE_STORE_TYPE = "flow-schedule-store" as const;
export const FLOW_SCHEDULE_DISPATCH_TYPE = "flow-schedule-dispatch" as const;
export const FLOW_SCHEDULE_RESULT_TYPE = "flow-schedule-result" as const;

export const FLOW_SCHEDULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FLOW_SCHEDULE_TARGET_PATTERN = /^owner:[a-f0-9]{32}$/;
export const FLOW_SCHEDULE_DISPATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const FLOW_SCHEDULE_LIMITS = {
  maxNonterminalSchedules: 32,
  maxStepsPerSchedule: 64,
  maxAttemptsPerStep: 10,
  maxPromptBytes: 48 * 1024,
  maxSummaryBytes: 8 * 1024,
  maxResources: 16,
  maxResourceBytes: 2 * 1024,
  maxScheduleRecordBytes: 4 * 1024 * 1024,
  maxDispatchRecordBytes: 128 * 1024,
  terminalRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxGcSchedulesPerRun: 32,
} as const;

export const FLOW_SCHEDULE_STATES = [
  "draft",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type FlowScheduleState = typeof FLOW_SCHEDULE_STATES[number];

export const FLOW_SCHEDULE_STEP_STATES = [
  "pending",
  "dispatching",
  "awaiting-result",
  "completed",
  "failed",
  "ambiguous",
  "cancelled",
] as const;

export type FlowScheduleStepState = typeof FLOW_SCHEDULE_STEP_STATES[number];

export const FLOW_SCHEDULE_DISPATCH_STATES = [
  "prepared",
  "published",
  "accepted",
  "completed",
  "failed",
  "ambiguous",
  "retired",
] as const;

export type FlowScheduleDispatchState = typeof FLOW_SCHEDULE_DISPATCH_STATES[number];

export const FLOW_SCHEDULE_RESULT_OUTCOMES = ["completed", "failed"] as const;
export type FlowScheduleResultOutcome = typeof FLOW_SCHEDULE_RESULT_OUTCOMES[number];

export interface ExactWindowIdentity {
  workspaceId: string;
  endpointId: string;
  ownerId: string;
  ownerNonce: string;
  sessionId?: string;
}

export interface FlowScheduleResult {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: typeof FLOW_SCHEDULE_RESULT_TYPE;
  scheduleId: string;
  stepId: string;
  dispatchId: string;
  outcome: FlowScheduleResultOutcome;
  summary: string;
  resources: string[];
}

export interface FlowScheduleStep {
  stepId: string;
  prompt: string;
  state: FlowScheduleStepState;
  attempts: string[];
  currentDispatchId?: string;
  result?: FlowScheduleResult;
}

export interface FlowScheduleRecord {
  version: typeof FLOW_SCHEDULE_VERSION;
  scheduleId: string;
  targetSelector: string;
  targetIdentity?: ExactWindowIdentity;
  state: FlowScheduleState;
  stepIds: string[];
  steps: Record<string, FlowScheduleStep>;
  activeStepId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlowScheduleDispatch {
  version: typeof FLOW_SCHEDULE_VERSION;
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  targetIdentity: ExactWindowIdentity;
  state: FlowScheduleDispatchState;
  createdAt: number;
  publishedAt?: number;
  acceptedAt?: number;
  settledAt?: number;
}

export interface FlowScheduleDispatchEnvelope {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: typeof FLOW_SCHEDULE_DISPATCH_TYPE;
  scheduleId: string;
  stepId: string;
  dispatchId: string;
  instruction: string;
  report: {
    tool: "flow-schedule";
    action: "report";
  };
}

export interface FlowScheduleOwnerMarker {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: typeof FLOW_SCHEDULE_STORE_TYPE;
  storeId: string;
  projectRoot: string;
  storageRoot: string;
  createdAt: number;
}

export interface FlowScheduleLockOwner {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: "flow-schedule-lock";
  token: string;
  pid: number;
  processIdentity?: string;
  createdAt: number;
  heartbeatAt: number;
}

export interface FlowSchedulePublishedRecord {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: "flow-schedule-published";
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  messageId: string;
  traceId: string;
  publishedAt: number;
}

export interface FlowScheduleAcceptedRecord {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: "flow-schedule-accepted";
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  messageId: string;
  acceptedAt: number;
  deliveryState: "accepted" | "injected" | "replayed";
}

export const FLOW_SCHEDULE_COMPLETION_STATES = [
  "completed",
  "failed",
  "ambiguous",
  "retired",
  "ignored",
] as const;

export type FlowScheduleCompletionState = typeof FLOW_SCHEDULE_COMPLETION_STATES[number];

export interface FlowScheduleCompletionRecord {
  version: typeof FLOW_SCHEDULE_VERSION;
  type: "flow-schedule-completion";
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  targetIdentity: ExactWindowIdentity;
  state: FlowScheduleCompletionState;
  result?: FlowScheduleResult;
  reason?: string;
  completedAt: number;
}

export interface FlowScheduleCreateStepInput {
  stepId: string;
  prompt: string;
}

export interface FlowScheduleCreateInput {
  scheduleId: string;
  target: string;
  steps: FlowScheduleCreateStepInput[];
}

export interface FlowScheduleDispatchIntentInput {
  dispatchId: string;
  scheduleId: string;
  stepId: string;
  targetIdentity: ExactWindowIdentity;
}

export type FlowScheduleAction =
  | { action: "create"; scheduleId: string; target: string; steps: FlowScheduleCreateStepInput[] }
  | { action: "start"; scheduleId: string }
  | { action: "list" }
  | { action: "status"; scheduleId: string }
  | { action: "append"; scheduleId: string; afterStepId: string; steps: FlowScheduleCreateStepInput[] }
  | { action: "pause"; scheduleId: string }
  | { action: "resume"; scheduleId: string; target?: string }
  | { action: "retry"; scheduleId: string; stepId: string; reason: string }
  | { action: "cancel"; scheduleId: string; reason: string }
  | { action: "report"; dispatchId: string; outcome: FlowScheduleResultOutcome; summary: string; resources?: string[] };

export interface FlowScheduleLegacyStatus {
  present: boolean;
  path: string;
  kind?: "directory" | "file" | "symlink" | "other";
}

export function isTerminalScheduleState(state: FlowScheduleState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function isTerminalDispatchState(state: FlowScheduleDispatchState): boolean {
  return state === "completed" || state === "failed" || state === "ambiguous" || state === "retired";
}
