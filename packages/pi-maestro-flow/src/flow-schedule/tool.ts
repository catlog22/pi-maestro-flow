import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  getSessionHostRegistry,
  type SessionEndpoint,
  type SessionHostRegistry,
  type SessionMessageResult,
} from "pi-maestro-teammate/v1/sessions";
import type { FlowToolResult } from "../tools/tool-result.ts";
import {
  FlowScheduleCreateStepInputSchema,
  FlowScheduleDispatchIdSchema,
  FlowScheduleIdSchema,
  FlowScheduleReportActionSchema,
  FlowScheduleTargetSelectorSchema,
  parseFlowScheduleAction,
} from "./schemas.ts";
import { publishFlowScheduleReport, type FlowScheduleRuntime } from "./runtime.ts";
import type { FlowScheduleDispatchBundle, FlowScheduleStore } from "./store.ts";
import {
  FLOW_SCHEDULE_LIMITS,
  isTerminalScheduleState,
  type FlowScheduleLegacyStatus,
  type FlowScheduleRecord,
} from "./types.ts";

const COORDINATOR_ACTIONS = [
  "create",
  "start",
  "list",
  "status",
  "append",
  "pause",
  "resume",
  "retry",
  "cancel",
] as const;

const ACTION_FIELDS = [
  "scheduleId",
  "target",
  "steps",
  "afterStepId",
  "stepId",
  "reason",
] as const;

function actionBranch(
  action: typeof COORDINATOR_ACTIONS[number],
  required: readonly string[],
  allowed: readonly string[],
): Record<string, unknown> {
  const forbidden = ACTION_FIELDS.filter((field) => !allowed.includes(field));
  return {
    if: { properties: { action: { const: action } }, required: ["action"] },
    then: {
      ...(required.length ? { required: [...required] } : {}),
      ...(forbidden.length
        ? { not: { anyOf: forbidden.map((field) => ({ required: [field] })) } }
        : {}),
    },
  };
}

export const FlowScheduleCoordinatorParams = Type.Object({
  action: Type.Unsafe<typeof COORDINATOR_ACTIONS[number]>({
    type: "string",
    enum: [...COORDINATOR_ACTIONS],
  }),
  scheduleId: Type.Optional(FlowScheduleIdSchema),
  target: Type.Optional(FlowScheduleTargetSelectorSchema),
  steps: Type.Optional(Type.Array(FlowScheduleCreateStepInputSchema, {
    minItems: 1,
    maxItems: FLOW_SCHEDULE_LIMITS.maxStepsPerSchedule,
  })),
  afterStepId: Type.Optional(FlowScheduleIdSchema),
  stepId: Type.Optional(FlowScheduleIdSchema),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: FLOW_SCHEDULE_LIMITS.maxSummaryBytes })),
}, {
  additionalProperties: false,
  allOf: [
    actionBranch("create", ["scheduleId", "target", "steps"], ["scheduleId", "target", "steps"]),
    actionBranch("start", ["scheduleId"], ["scheduleId"]),
    actionBranch("list", [], []),
    actionBranch("status", ["scheduleId"], ["scheduleId"]),
    actionBranch("append", ["scheduleId", "afterStepId", "steps"], ["scheduleId", "afterStepId", "steps"]),
    actionBranch("pause", ["scheduleId"], ["scheduleId"]),
    actionBranch("resume", ["scheduleId"], ["scheduleId", "target"]),
    actionBranch("retry", ["scheduleId", "stepId", "reason"], ["scheduleId", "stepId", "reason"]),
    actionBranch("cancel", ["scheduleId", "reason"], ["scheduleId", "reason"]),
  ],
});

export type FlowScheduleCoordinatorParamsInput = Static<typeof FlowScheduleCoordinatorParams>;
export type FlowScheduleWorkerParamsInput = Static<typeof FlowScheduleReportActionSchema>;

export interface FlowScheduleController {
  store: FlowScheduleStore;
  runtime: FlowScheduleRuntime;
}

export interface FlowScheduleLifecycleStatus {
  found: boolean;
  endpointId?: string;
  ownerId?: string;
  ownerNonce?: string;
  sessionId?: string;
  status?: string;
  exact: boolean;
}

export interface FlowScheduleToolDetails {
  schedules: FlowScheduleRecord[];
  dispatch?: FlowScheduleDispatchBundle;
  legacy?: FlowScheduleLegacyStatus;
  lifecycle?: FlowScheduleLifecycleStatus;
  resultMessageId?: string;
  delivery?: SessionMessageResult;
}

export interface CoordinatorFlowScheduleToolOptions {
  resolve(cwd: string): FlowScheduleController;
  getRegistry?: () => SessionHostRegistry | undefined;
  isMonitorActive?: () => boolean;
  captureMonitor?: () => { generation: number } | undefined;
}

function scheduleLine(schedule: FlowScheduleRecord): string {
  const completed = schedule.stepIds.filter((stepId) => schedule.steps[stepId].state === "completed").length;
  const active = schedule.activeStepId ? ` active=${schedule.activeStepId}` : "";
  return `${schedule.scheduleId} ${schedule.state} steps=${completed}/${schedule.stepIds.length}${active} target=${schedule.targetSelector}`;
}

function lifecycleFor(
  registry: SessionHostRegistry | undefined,
  schedule: FlowScheduleRecord,
): FlowScheduleLifecycleStatus {
  const resolution = registry?.resolve(schedule.targetSelector, { includeSettled: true, localFirst: false });
  const endpoint = resolution?.code === "resolved" ? resolution.endpoint : undefined;
  const identity = schedule.targetIdentity;
  return {
    found: endpoint !== undefined,
    ...(endpoint ? endpointDetails(endpoint) : {}),
    exact: endpoint !== undefined && identity !== undefined
      && endpoint.id === identity.endpointId
      && endpoint.workspaceId === identity.workspaceId
      && endpoint.ownerId === identity.ownerId
      && endpoint.ownerNonce === identity.ownerNonce
      && endpoint.sessionId === identity.sessionId,
  };
}

function endpointDetails(endpoint: SessionEndpoint): Omit<FlowScheduleLifecycleStatus, "found" | "exact"> {
  return {
    endpointId: endpoint.id,
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    ...(endpoint.sessionId === undefined ? {} : { sessionId: endpoint.sessionId }),
    status: endpoint.status,
  };
}

function success(
  text: string,
  details: FlowScheduleToolDetails,
): FlowToolResult<FlowScheduleToolDetails> {
  return { content: [{ type: "text", text }], details };
}

function failure(error: unknown): FlowToolResult<FlowScheduleToolDetails> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { schedules: [] },
  };
}

async function scheduleAndDispatch(
  controller: FlowScheduleController,
  scheduleId: string,
): Promise<{ schedule: FlowScheduleRecord; dispatch?: FlowScheduleDispatchBundle }> {
  const schedule = await controller.store.readSchedule(scheduleId);
  if (!schedule) throw new Error(`Unknown Flow schedule: ${scheduleId}`);
  const activeStep = schedule.activeStepId ? schedule.steps[schedule.activeStepId] : undefined;
  const latestDispatchId = activeStep?.currentDispatchId ?? schedule.stepIds.reduce<string | undefined>(
    (latest, stepId) => schedule.steps[stepId]?.attempts.at(-1) ?? latest,
    undefined,
  );
  const dispatch = latestDispatchId
    ? await controller.store.readDispatch(latestDispatchId)
    : undefined;
  return { schedule, ...(dispatch ? { dispatch } : {}) };
}

function statusText(
  schedule: FlowScheduleRecord,
  dispatch?: FlowScheduleDispatchBundle,
): string {
  if (!dispatch) return scheduleLine(schedule);
  const dispatchState = dispatch.completion?.state
    ?? (dispatch.accepted ? "accepted" : dispatch.published ? "published" : "prepared");
  const step = schedule.steps[dispatch.intent.stepId];
  const gate = step?.todoBinding
    ? [
      ...(step.todoBinding.requireCompleted ? ["require-completed"] : []),
      ...(step.todoBinding.conflictCheck ? ["conflict-check"] : []),
    ].join("+") || "none"
    : "none";
  const binding = dispatch.binding;
  const bindingLine = binding
    ? `Binding: state=${binding.state} gate=${gate} todoId=${binding.todoId ?? "-"} todoStatus=${binding.todoStatus ?? "-"}`
    : `Binding: none gate=${step?.todoBinding ? "none (not negotiated)" : "none"}`;
  const result = dispatch.completion?.result;
  const todoOutcome = result?.todoOutcome
    ? `${result.todoOutcome.todoId}/${result.todoOutcome.todoStatus}`
    : "none";
  return [
    scheduleLine(schedule),
    `Dispatch: id=${dispatch.intent.dispatchId} state=${dispatchState}`,
    bindingLine,
    `Result: outcome=${result?.outcome ?? "none"} todoOutcome=${todoOutcome}`,
  ].join("\n");
}

export function createCoordinatorFlowScheduleTool(
  options: CoordinatorFlowScheduleToolOptions,
): ToolDefinition<typeof FlowScheduleCoordinatorParams, FlowScheduleToolDetails> {
  const getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
  return {
    name: "flow-schedule",
    label: "Flow Schedule",
    description:
      "Monitor-only control surface for durably executing stable ordered steps in an already-managed workspace window. The Monitor creates and controls schedules; observe remains the lifecycle surface, teammate-send remains ad hoc messaging, workspace-window remains process ownership, and loop remains recurring work. A step advances only from an exact correlated worker report.",
    promptSnippet: "Create and control durable ordered work for an existing managed workspace window.",
    promptGuidelines: [
      "Use create then start; create never sends work.",
      "Use append with afterStepId. Cursor and wall-clock completion attribution are not supported.",
      "Queued or accepted delivery is not step completion. Use status to inspect transport, binding, and exact result evidence separately.",
      "todoBinding.requireCompleted and conflictCheck are opt-in per step; workers without the flow-schedule-todo-binding capability silently run that dispatch as gate=none.",
      "Use observe view=todos for cross-process Todo visibility only; Todo projection alone is not completion authority.",
      "Use retry only after failed or ambiguous attempts; retry is the only action that creates a new dispatch attempt.",
      "Cancel stops scheduling but does not close or reclaim the target window.",
    ],
    parameters: FlowScheduleCoordinatorParams,
    async execute(_id, raw, signal, _onUpdate, ctx): Promise<FlowToolResult<FlowScheduleToolDetails>> {
      try {
        signal?.throwIfAborted();
        const monitorCapture = options.captureMonitor?.();
        const assertMonitorCurrent = (): void => {
          if (options.isMonitorActive && !options.isMonitorActive()) {
            throw new Error("Flow schedule requires active Monitor mode.");
          }
          if (options.captureMonitor) {
            const current = options.captureMonitor();
            if (!monitorCapture || !current || current.generation !== monitorCapture.generation) {
              throw new Error("Monitor mode changed during the Flow schedule action.");
            }
          }
        };
        const awaitMonitor = async <T>(operation: Promise<T>): Promise<T> => {
          const result = await operation;
          assertMonitorCurrent();
          return result;
        };
        assertMonitorCurrent();
        const action = parseFlowScheduleAction(raw);
        if (action.action === "report") throw new Error("Coordinator Flow schedule does not expose report.");
        const controller = options.resolve(ctx.cwd);
        switch (action.action) {
          case "create": {
            const schedule = await awaitMonitor(controller.store.createSchedule(action));
            return success(`Created ${scheduleLine(schedule)}.`, { schedules: [schedule] });
          }
          case "start": {
            const schedule = await awaitMonitor(controller.runtime.startSchedule(action.scheduleId));
            const current = await awaitMonitor(scheduleAndDispatch(controller, schedule.scheduleId));
            return success(`Started ${scheduleLine(current.schedule)}.`, {
              schedules: [current.schedule],
              ...(current.dispatch ? { dispatch: current.dispatch } : {}),
              lifecycle: lifecycleFor(getRegistry(), current.schedule),
            });
          }
          case "list": {
            const schedules = (await awaitMonitor(controller.store.listSchedules())).slice(0, 100);
            const legacy = await awaitMonitor(controller.store.detectLegacyFlowTrack());
            const text = schedules.length ? schedules.map(scheduleLine).join("\n") : "No Flow schedules.";
            return success(`${text}${legacy.present ? `\nLegacy flow-track data detected at ${legacy.path}; it is read-only.` : ""}`, {
              schedules,
              legacy,
            });
          }
          case "status": {
            const current = await awaitMonitor(scheduleAndDispatch(controller, action.scheduleId));
            return success(statusText(current.schedule, current.dispatch), {
              schedules: [current.schedule],
              ...(current.dispatch ? { dispatch: current.dispatch } : {}),
              lifecycle: lifecycleFor(getRegistry(), current.schedule),
            });
          }
          case "append": {
            const before = await awaitMonitor(controller.store.readSchedule(action.scheduleId));
            if (!before) throw new Error(`Unknown Flow schedule: ${action.scheduleId}`);
            if (isTerminalScheduleState(before.state)) throw new Error(`Flow schedule ${action.scheduleId} is ${before.state}.`);
            const schedule = await awaitMonitor(controller.store.appendSteps(action.scheduleId, action.afterStepId, action.steps));
            await awaitMonitor(controller.runtime.reconcileReady());
            return success(`Updated ${scheduleLine(schedule)}.`, { schedules: [schedule] });
          }
          case "pause": {
            const schedule = await awaitMonitor(controller.runtime.pauseSchedule(action.scheduleId));
            return success(`Paused ${scheduleLine(schedule)}.`, { schedules: [schedule] });
          }
          case "resume": {
            const schedule = await awaitMonitor(controller.runtime.resumeSchedule(action.scheduleId, action.target));
            return success(`Resumed ${scheduleLine(schedule)}.`, { schedules: [schedule] });
          }
          case "retry": {
            const schedule = await awaitMonitor(controller.runtime.retrySchedule(action.scheduleId, action.stepId, action.reason));
            return success(`Retry admitted for ${action.scheduleId}/${action.stepId}.`, { schedules: [schedule] });
          }
          case "cancel": {
            const schedule = await awaitMonitor(controller.runtime.cancelSchedule(action.scheduleId, action.reason));
            return success(`Cancelled ${scheduleLine(schedule)}. Target lifecycle was not changed.`, { schedules: [schedule] });
          }
        }
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export interface WorkerFlowScheduleToolOptions {
  getRegistry?: () => SessionHostRegistry | undefined;
}

export function createWorkerFlowScheduleTool(
  options: WorkerFlowScheduleToolOptions = {},
): ToolDefinition<typeof FlowScheduleReportActionSchema, FlowScheduleToolDetails> {
  const getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
  return {
    name: "flow-schedule",
    label: "Flow Schedule Report",
    description:
      "Report the result of the current durable Flow schedule dispatch. This managed-worker surface cannot create, start, modify, retry, cancel, or reclaim schedules/windows. The host verifies the exact inbound dispatch and derives the reply target from trusted session metadata.",
    promptSnippet: "Report completion or failure for a received Flow schedule dispatch.",
    promptGuidelines: [
      "Call report only after completing the instruction associated with dispatchId.",
      "Do not invent or alter dispatchId and do not supply a reply target.",
      "When the dispatch carries todoBinding, create one Todo for the work and include its exact todoId and todoStatus in report.todoOutcome.",
      "For requireCompleted, report completed only with todoStatus=completed; conflictCheck treats explicit non-completed Todo evidence on a completed result as ambiguous.",
      "Reporting publishes a business result; it does not terminate or reclaim this window.",
    ],
    parameters: FlowScheduleReportActionSchema,
    async execute(_id, raw, signal): Promise<FlowToolResult<FlowScheduleToolDetails>> {
      try {
        signal?.throwIfAborted();
        const action = parseFlowScheduleAction(raw);
        if (action.action !== "report") throw new Error("Managed worker Flow schedule exposes report only.");
        const registry = getRegistry();
        if (!registry) throw new Error("Session host registry is unavailable.");
        const inbound = registry.thread.get(action.dispatchId, "incoming");
        if (!inbound) throw new Error(`Trusted Flow schedule dispatch not found: ${action.dispatchId}`);
        const published = await publishFlowScheduleReport({
          registry,
          inbound,
          outcome: action.outcome,
          summary: action.summary,
          resources: action.resources,
          todoOutcome: action.todoOutcome,
        });
        signal?.throwIfAborted();
        return success(`Published Flow schedule result ${published.resultMessageId}.`, {
          schedules: [],
          resultMessageId: published.resultMessageId,
          delivery: published.delivery,
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
