import { createHash } from "node:crypto";
import type { WorkspaceCompletionCorrelation } from "pi-maestro-teammate/v1/workspace-completion";
import {
  parseFlowScheduleDispatchEnvelope,
  parseFlowScheduleResult,
  FlowScheduleValidationError,
} from "./schemas.ts";
import {
  FLOW_SCHEDULE_DISPATCH_ID_PATTERN,
  FLOW_SCHEDULE_DISPATCH_TYPE,
  FLOW_SCHEDULE_RESULT_TYPE,
  FLOW_SCHEDULE_VERSION,
  type FlowScheduleDispatchEnvelope,
  type FlowScheduleResult,
  type FlowScheduleResultOutcome,
  type FlowScheduleTodoBindingSpec,
  type FlowScheduleTodoOutcome,
} from "./types.ts";

export const FLOW_SCHEDULE_RESULT_MESSAGE_PREFIX = "flow-schedule-result/v1:" as const;

/** Workspace-peer v1 transport identity for a Flow dispatch UUID. */
export function flowScheduleDispatchMessageId(dispatchId: string): string {
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(dispatchId)) {
    throw new FlowScheduleValidationError("Flow schedule dispatch message ID", "", "dispatchId must be a UUID v4");
  }
  return dispatchId.replaceAll("-", "");
}

/** Workspace-peer v1 transport identity for the queued report reminder. */
export function flowScheduleReportReminderMessageId(dispatchId: string): string {
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(dispatchId)) {
    throw new FlowScheduleValidationError("Flow schedule report reminder transport ID", "", "dispatchId must be a UUID v4");
  }
  return createHash("sha256").update(`flow-schedule-report-reminder\0${dispatchId}`).digest("hex").slice(0, 32);
}

/** Workspace-peer v1 transport identity for a Flow result. */
export function flowScheduleResultTransportMessageId(dispatchId: string): string {
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(dispatchId)) {
    throw new FlowScheduleValidationError("Flow schedule result transport ID", "", "dispatchId must be a UUID v4");
  }
  return createHash("sha256").update(`flow-schedule-result-transport\0${dispatchId}`).digest("hex").slice(0, 32);
}

export function flowScheduleResultMessageId(dispatchId: string): string {
  if (!FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(dispatchId)) {
    throw new FlowScheduleValidationError("Flow schedule result message ID", "", "dispatchId must be a UUID v4");
  }
  const digest = createHash("sha256").update(`flow-schedule-result\0${dispatchId}`).digest("hex").slice(0, 16);
  return `${FLOW_SCHEDULE_RESULT_MESSAGE_PREFIX}${dispatchId}:${digest}`;
}

export function createFlowScheduleDispatchEnvelope(input: {
  scheduleId: string;
  stepId: string;
  dispatchId: string;
  instruction: string;
  todoBinding?: FlowScheduleTodoBindingSpec;
}): FlowScheduleDispatchEnvelope {
  return parseFlowScheduleDispatchEnvelope({
    version: FLOW_SCHEDULE_VERSION,
    type: FLOW_SCHEDULE_DISPATCH_TYPE,
    ...input,
    report: { tool: "flow-schedule", action: "report" },
  });
}

export function createFlowScheduleResult(input: {
  scheduleId: string;
  stepId: string;
  dispatchId: string;
  outcome: FlowScheduleResultOutcome;
  summary: string;
  resources?: string[];
  completionCorrelation?: WorkspaceCompletionCorrelation;
  todoOutcome?: FlowScheduleTodoOutcome;
}): FlowScheduleResult {
  const resources = [...new Set([
    ...(input.resources ?? []),
    ...(input.completionCorrelation ? [input.completionCorrelation.resource] : []),
  ])];
  return parseFlowScheduleResult({
    version: FLOW_SCHEDULE_VERSION,
    type: FLOW_SCHEDULE_RESULT_TYPE,
    ...input,
    resources,
  });
}

function decodeJson(text: string, context: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FlowScheduleValidationError(context, "", error instanceof Error ? error.message : String(error));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FlowScheduleValidationError(context, "", "must be a JSON object");
  }
  return value;
}

export function encodeFlowScheduleDispatch(envelope: FlowScheduleDispatchEnvelope): string {
  return JSON.stringify(parseFlowScheduleDispatchEnvelope(envelope));
}

export function decodeFlowScheduleDispatch(text: string): FlowScheduleDispatchEnvelope {
  return parseFlowScheduleDispatchEnvelope(decodeJson(text, "Flow schedule dispatch JSON"));
}

export function encodeFlowScheduleResult(result: FlowScheduleResult): string {
  return JSON.stringify(parseFlowScheduleResult(result));
}

export function decodeFlowScheduleResult(text: string): FlowScheduleResult {
  return parseFlowScheduleResult(decodeJson(text, "Flow schedule result JSON"));
}
