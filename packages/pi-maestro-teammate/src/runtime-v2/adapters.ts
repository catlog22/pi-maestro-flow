import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeEventDraftV2,
} from "./contracts.ts";
import type { RemoteRunEvent } from "../remote/types.ts";

export interface RuntimeAdapterContextV2 {
  streamId: string;
  actor: ActorAddressV2;
  occurredAt?: number;
}

export type PiRuntimeSignalV2 =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end" | "tool_end"; toolCallId: string; toolName: string; isError?: boolean }
  | { type: "result_published"; publicationId: string; hasStructuredOutput?: boolean }
  | { type: "agent_settled"; outcome: "completed" | "failed" | "cancelled" | "lost"; error?: string }
  | { type: "process_reclaimed"; processId: string; exitCode: number | null; signal: string | null }
  | { type: "turn_end" | "close" };

export type AcpRuntimeSignalV2 =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError?: boolean }
  | { type: "result_published"; publicationId: string; hasStructuredOutput?: boolean }
  | { type: "run_settled"; outcome: "completed" | "failed" | "cancelled" | "lost"; error?: string }
  | { type: "process_reclaimed"; processId: string; exitCode: number | null; signal: string | null }
  | { type: "turn_end" | "close" };

function base(context: RuntimeAdapterContextV2) {
  return {
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    streamId: context.streamId,
    actor: context.actor,
    occurredAt: context.occurredAt ?? Date.now(),
  } as const;
}

export function adaptPiRuntimeSignalV2(
  signal: PiRuntimeSignalV2,
  context: RuntimeAdapterContextV2,
): RuntimeEventDraftV2[] {
  const event = base(context);
  switch (signal.type) {
    case "tool_execution_start":
      return [{ ...event, kind: "tool.started", toolCallId: signal.toolCallId, toolName: signal.toolName }];
    case "tool_execution_end":
    case "tool_end":
      return [{
        ...event,
        kind: "tool.finished",
        toolCallId: signal.toolCallId,
        toolName: signal.toolName,
        outcome: signal.isError ? "failed" : "succeeded",
      }];
    case "result_published":
      return [{ ...event, kind: "result.published", publicationId: signal.publicationId, hasStructuredOutput: signal.hasStructuredOutput === true }];
    case "agent_settled":
      return [{ ...event, kind: "run.settled", outcome: signal.outcome, ...(signal.error ? { error: signal.error } : {}) }];
    case "process_reclaimed":
      return [{ ...event, kind: "process.reclaimed", processId: signal.processId, exitCode: signal.exitCode, signal: signal.signal }];
    case "turn_end":
    case "close":
      return [];
  }
}

export function adaptAcpRuntimeSignalV2(
  signal: AcpRuntimeSignalV2,
  context: RuntimeAdapterContextV2,
): RuntimeEventDraftV2[] {
  const event = base(context);
  switch (signal.type) {
    case "tool_start":
      return [{ ...event, kind: "tool.started", toolCallId: signal.toolCallId, toolName: signal.toolName }];
    case "tool_end":
      return [{
        ...event,
        kind: "tool.finished",
        toolCallId: signal.toolCallId,
        toolName: signal.toolName,
        outcome: signal.isError ? "failed" : "succeeded",
      }];
    case "result_published":
      return [{ ...event, kind: "result.published", publicationId: signal.publicationId, hasStructuredOutput: signal.hasStructuredOutput === true }];
    case "run_settled":
      return [{ ...event, kind: "run.settled", outcome: signal.outcome, ...(signal.error ? { error: signal.error } : {}) }];
    case "process_reclaimed":
      return [{ ...event, kind: "process.reclaimed", processId: signal.processId, exitCode: signal.exitCode, signal: signal.signal }];
    case "turn_end":
    case "close":
      return [];
  }
}

/** Adapts only explicit durable remote events; transport close is never a success signal. */
export function adaptRemoteRunEventV2(
  event: RemoteRunEvent,
  protocol: "pi-rpc" | "acp",
  context: Omit<RuntimeAdapterContextV2, "occurredAt">,
): RuntimeEventDraftV2[] {
  const at = { ...context, occurredAt: event.updatedAt };
  if (event.type === "run/event" && event.event.type === "tool") {
    const tool = event.event.tool;
    return protocol === "pi-rpc"
      ? adaptPiRuntimeSignalV2({
          type: tool.phase === "start" ? "tool_execution_start" : "tool_execution_end",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          ...(tool.isError === undefined ? {} : { isError: tool.isError }),
        } as PiRuntimeSignalV2, at)
      : adaptAcpRuntimeSignalV2({
          type: tool.phase === "start" ? "tool_start" : "tool_end",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          ...(tool.isError === undefined ? {} : { isError: tool.isError }),
        }, at);
  }
  if (event.type !== "run/result") return [];
  const resultPublished = {
    type: "result_published" as const,
    publicationId: `${event.runId}:${event.generation}:${event.sequence}`,
    hasStructuredOutput: event.structuredOutput !== undefined,
  };
  const published = event.result !== undefined || event.structuredOutput !== undefined
    ? protocol === "pi-rpc"
      ? adaptPiRuntimeSignalV2(resultPublished, at)
      : adaptAcpRuntimeSignalV2(resultPublished, at)
    : [];
  const settled = protocol === "pi-rpc"
    ? adaptPiRuntimeSignalV2({ type: "agent_settled", outcome: event.status, ...(event.error ? { error: event.error } : {}) }, at)
    : adaptAcpRuntimeSignalV2({ type: "run_settled", outcome: event.status, ...(event.error ? { error: event.error } : {}) }, at);
  return [...published, ...settled];
}
