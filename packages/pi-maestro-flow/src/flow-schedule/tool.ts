import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  getSessionHostRegistry,
  type SessionEndpoint,
  type SessionHostRegistry,
  type SessionMessageResult,
} from "pi-maestro-teammate/v1/sessions";
import type { FlowToolResult } from "../tools/tool-result.ts";
import { resultSummary, toolCallLine, toolResultLine } from "../quiet-render.ts";
import {
  FlowScheduleCreateStepInputSchema,
  FlowScheduleDispatchIdSchema,
  FlowScheduleIdSchema,
  FlowScheduleReportActionSchema,
  FlowScheduleTargetSelectorSchema,
  parseFlowScheduleAction,
} from "./schemas.ts";
import type { FlowScheduleActorStatus } from "./actor.ts";
import type { FlowScheduleBrokerRuntime } from "./broker-runtime.ts";
import { flowScheduleDispatchMessageId, flowScheduleResultTransportMessageId } from "./protocol.ts";
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
  brokerRuntime?: FlowScheduleBrokerRuntime;
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
  completionResource?: string;
  delivery?: SessionMessageResult;
  actor?: {
    schedule?: FlowScheduleActorStatus;
    dispatch?: FlowScheduleActorStatus;
  };
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

const STEP_STATE_LABELS: Record<FlowScheduleRecord["steps"][string]["state"], string> = {
  pending: "wait",
  dispatching: "send",
  "awaiting-result": "run",
  completed: "done",
  failed: "fail",
  ambiguous: "check",
  cancelled: "stop",
};

function compactFlowText(value: string, maxLength = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function todoBindingDetail(binding: FlowScheduleRecord["steps"][string]["todoBinding"]): string {
  if (!binding) return "";
  const gates = [
    ...(binding.requireCompleted ? ["require-completed"] : []),
    ...(binding.conflictCheck ? ["conflict-check"] : []),
  ];
  const label = binding.label ? ` ${compactFlowText(binding.label, 72)}` : "";
  return `todo:${label}${gates.length > 0 ? ` [${gates.join("+")}]` : ""}`;
}

function stepDetailLines(
  step: FlowScheduleRecord["steps"][string],
  index: number,
): string[] {
  const edge = index === 0 ? "  " : "  -> ";
  const lines = [`${edge}[${STEP_STATE_LABELS[step.state]}] ${step.stepId}`];
  const prompt = compactFlowText(step.prompt);
  if (prompt) lines.push(`      ${prompt}`);
  const todo = todoBindingDetail(step.todoBinding);
  if (todo) lines.push(`      ${todo}`);
  if (step.currentDispatchId) lines.push(`      dispatch: ${step.currentDispatchId}`);
  if (step.result) {
    const todoOutcome = step.result.todoOutcome
      ? ` todo=${step.result.todoOutcome.todoId}/${step.result.todoOutcome.todoStatus}`
      : "";
    lines.push(`      result: ${step.result.outcome} ${compactFlowText(step.result.summary, 96)}${todoOutcome}`);
  }
  return lines;
}

function stepRelationship(schedule: FlowScheduleRecord): string {
  return schedule.stepIds
    .map((stepId) => `[${STEP_STATE_LABELS[schedule.steps[stepId].state]}] ${stepId}`)
    .join(" -> ");
}

function scheduleRelationshipSummary(schedule: FlowScheduleRecord): string {
  const completed = schedule.stepIds.filter((stepId) => schedule.steps[stepId].state === "completed").length;
  const relationship = stepRelationship(schedule);
  return `${schedule.scheduleId} ${schedule.state} ${completed}/${schedule.stepIds.length}${relationship ? ` · ${relationship}` : ""}`;
}

function scheduleRelationshipDetail(schedules: readonly FlowScheduleRecord[], text: string): string {
  const relationships = schedules.flatMap((schedule) => [
    scheduleLine(schedule),
    ...schedule.stepIds.flatMap((stepId, index) => stepDetailLines(schedule.steps[stepId], index)),
  ]);
  return [...relationships, ...(text.trim() ? [text] : [])].join("\n");
}

function flowScheduleCallArg(args: Record<string, unknown>, expanded = false): string {
  const action = typeof args.action === "string" ? args.action : "?";
  const scheduleId = typeof args.scheduleId === "string" ? args.scheduleId : "";
  if (action === "report") {
    const outcome = typeof args.outcome === "string" ? args.outcome : "";
    const dispatchId = typeof args.dispatchId === "string" ? args.dispatchId.slice(0, 8) : "";
    return [action, outcome, dispatchId].filter(Boolean).join(" ");
  }
  const steps = Array.isArray(args.steps)
    ? args.steps
      .map((step) => step && typeof step === "object" ? {
        stepId: "stepId" in step ? String(step.stepId) : "",
        prompt: "prompt" in step && typeof step.prompt === "string" ? step.prompt : "",
      } : undefined)
      .filter((step): step is { stepId: string; prompt: string } => Boolean(step?.stepId))
    : [];
  const relationship = steps.map((step) => step.stepId).join(" -> ");
  if (expanded && steps.length > 0) {
    const target = typeof args.target === "string" ? args.target : "";
    return [
      [action, scheduleId].filter(Boolean).join(" "),
      target ? `  target: ${target}` : "",
      ...steps.flatMap((step, index) => [
        `${index === 0 ? "  " : "  -> "}${step.stepId}`,
        ...(compactFlowText(step.prompt) ? [`      ${compactFlowText(step.prompt)}`] : []),
      ]),
    ].filter(Boolean).join("\n");
  }
  return [action, scheduleId, relationship].filter(Boolean).join(" ");
}

function flowScheduleResultSummary(
  details: FlowScheduleToolDetails | undefined,
  result: { content: Array<{ type: string; text?: string }> },
): string {
  const schedules = details?.schedules ?? [];
  if (schedules.length === 1) return scheduleRelationshipSummary(schedules[0]);
  if (schedules.length > 1) return `${schedules.length} schedules`;
  if (details?.resultMessageId) return `published ${details.resultMessageId.slice(0, 12)}`;
  return resultSummary(result);
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
): Promise<{
  schedule: FlowScheduleRecord;
  dispatch?: FlowScheduleDispatchBundle;
  actor?: { schedule?: FlowScheduleActorStatus; dispatch?: FlowScheduleActorStatus };
}> {
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
  const actor = controller.brokerRuntime?.enabled ? {
    schedule: await controller.brokerRuntime.actorStatus("schedule", schedule.scheduleId),
    ...(latestDispatchId ? {
      dispatch: await controller.brokerRuntime.actorStatus("dispatch", latestDispatchId).then(async (status) => {
        const outbox = await controller.brokerRuntime!.outbox!.read(flowScheduleResultTransportMessageId(latestDispatchId));
        return status ? {
          ...status,
          ...(outbox ? { outboxState: outbox.state, outboxMessageId: outbox.messageId } : {}),
        } : status;
      }),
    } : {}),
  } : undefined;
  return { schedule, ...(dispatch ? { dispatch } : {}), ...(actor ? { actor } : {}) };
}

function statusText(
  schedule: FlowScheduleRecord,
  dispatch?: FlowScheduleDispatchBundle,
  actor?: { schedule?: FlowScheduleActorStatus; dispatch?: FlowScheduleActorStatus },
): string {
  const admitLine = schedule.lastAdmitReason
    ? [`Admit: deferred attempts=${schedule.admitAttempts ?? 0} at=${schedule.lastAdmitAt ?? "-"}`, `  ${compactFlowText(schedule.lastAdmitReason, 96)}`]
    : [];
  if (!dispatch) {
    const actorLine = actor?.schedule
      ? `\nActor: scheduleRevision=${actor.schedule.revision} brokerRevision=${actor.schedule.brokerRevision} lease=${actor.schedule.leaseEpoch ?? "-"}/${actor.schedule.leaseNonce ?? "-"}\nProjection: migration=${actor.schedule.migration ?? "none"} repair=${actor.schedule.projectionState ?? "none"}`
      : "";
    return [scheduleLine(schedule), ...admitLine].join("\n") + actorLine;
  }
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
  const transportTimes = [
    `preparedAt=${dispatch.intent.createdAt}`,
    `publishedAt=${dispatch.published?.publishedAt ?? "-"}`,
    `acceptedAt=${dispatch.accepted?.acceptedAt ?? "-"}`,
  ].join(" ");
  const resultLine = [
    `state=${dispatch.completion?.state ?? "none"}`,
    `at=${dispatch.completion?.completedAt ?? "-"}`,
    `outcome=${result?.outcome ?? "none"}`,
    `todoOutcome=${todoOutcome}`,
  ].join(" ");
  const actorLines = actor ? [
    `Actor: scheduleRevision=${actor.schedule?.revision ?? "-"} brokerRevision=${actor.schedule?.brokerRevision ?? "-"} lease=${actor.schedule?.leaseEpoch ?? "-"}/${actor.schedule?.leaseNonce ?? "-"}`,
    `DispatchActor: revision=${actor.dispatch?.revision ?? "-"} brokerRevision=${actor.dispatch?.brokerRevision ?? "-"} lease=${actor.dispatch?.leaseEpoch ?? "-"}/${actor.dispatch?.leaseNonce ?? "-"}`,
    `Evidence: exactAt=${actor.dispatch?.exactReportedAt ?? "-"} genericAt=${actor.dispatch?.genericTerminalAt ?? "-"} graceDeadline=${actor.dispatch?.genericGraceDeadline ?? "-"}`,
    `Outbox: state=${actor.dispatch?.outboxState ?? "none"} messageId=${actor.dispatch?.outboxMessageId ?? "-"}`,
    `Projection: migration=${actor.schedule?.migration ?? "none"} repair=${actor.schedule?.projectionState ?? "none"}`,
  ] : [];
  return [
    scheduleLine(schedule),
    ...actorLines,
    `Dispatch: id=${dispatch.intent.dispatchId} state=${dispatchState}`,
    `Transport: ${transportTimes}`,
    bindingLine,
    `Result: ${resultLine}`,
    ...(dispatch.completion?.reason ? [`Diagnostic: ${compactFlowText(dispatch.completion.reason, 160)}`] : []),
    `Canonical: ${result?.completionCorrelation?.resource ?? dispatch.intent.completionCorrelation?.resource ?? "none"}`,
    ...admitLine,
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
      "Monitor-only control surface for durably executing stable ordered steps in an already-managed workspace window. The Monitor creates and controls schedules; observe remains the lifecycle surface, teammate-send remains ad hoc messaging, workspace-window remains process ownership, and loop remains recurring work. A step advances only from an exact correlated worker report; Todo evidence is additional only for a negotiated Todo gate.",
    promptSnippet: "Create and control durable ordered work for an existing managed workspace window.",
    promptGuidelines: [
      "Use create then start; create never sends work.",
      "Use append with afterStepId. Cursor and wall-clock completion attribution are not supported.",
      "Queued or accepted delivery is not step completion. Use status to inspect transport, binding, and exact result evidence separately.",
      "todoBinding.requireCompleted and conflictCheck are opt-in per step and require the worker's flow-schedule-todo-binding capability. A capability mismatch intentionally degrades the dispatch: no Todo instruction or binding is created, and those gates are not enforced; status reports gate=none (not negotiated).",
      "A Todo gate waits up to 30 seconds by default; missing or mismatched Todo evidence, target replacement, or terminal-without-report settles the dispatch as ambiguous. Inspect status before retrying; retry can duplicate work and is only safe when that risk is accepted.",
      "Use observe view=todos for cross-process Todo visibility only; Todo projection alone is not completion authority.",
      "Use retry only after failed or ambiguous attempts; retry is the only action that creates a new dispatch attempt.",
      "Cancel stops scheduling but does not close or reclaim the target window.",
      "If the target workspace worker is unreachable (window exited, peer discovery stale, or Monitor observation authority lost), admission defers: no dispatch is created and status reports an `Admit: deferred` line with the reason and attempt count. After several consecutive deferrals the schedule transitions to failed automatically; use status to diagnose, then resume with a live target.",
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
            const schedule = await awaitMonitor(controller.runtime.createSchedule(action));
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
            return success(statusText(current.schedule, current.dispatch, current.actor), {
              schedules: [current.schedule],
              ...(current.dispatch ? { dispatch: current.dispatch } : {}),
              ...(current.actor ? { actor: current.actor } : {}),
              lifecycle: lifecycleFor(getRegistry(), current.schedule),
            });
          }
          case "append": {
            const before = await awaitMonitor(controller.store.readSchedule(action.scheduleId));
            if (!before) throw new Error(`Unknown Flow schedule: ${action.scheduleId}`);
            if (isTerminalScheduleState(before.state)) throw new Error(`Flow schedule ${action.scheduleId} is ${before.state}.`);
            const schedule = await awaitMonitor(controller.runtime.appendSchedule(action.scheduleId, action.afterStepId, action.steps));
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
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const input = args as Record<string, unknown>;
      const expanded = ctx?.expanded === true;
      return toolCallLine(theme, "flow-schedule", flowScheduleCallArg(input, expanded));
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as FlowScheduleToolDetails | undefined;
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      return toolResultLine(theme, {
        name: "flow-schedule",
        ok: (result as { isError?: boolean }).isError !== true,
        arg: flowScheduleCallArg(ctx.args as Record<string, unknown>),
        summary: flowScheduleResultSummary(details, result),
        expanded: opts.expanded,
        detail: scheduleRelationshipDetail(details?.schedules ?? [], message),
      });
    },
  };
}

export interface WorkerFlowScheduleToolOptions {
  getRegistry?: () => SessionHostRegistry | undefined;
  getBrokerRuntime?: () => FlowScheduleBrokerRuntime | undefined;
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
      "Finish the instruction as one attempt, then always call report with outcome=completed or outcome=failed; do not omit a failure report, because a missing exact report becomes ambiguous.",
      "Do not invent or alter dispatchId and do not supply a reply target.",
      "When the dispatch carries todoBinding, create one Todo for the work and include its exact todoId and todoStatus in report.todoOutcome.",
      "For requireCompleted, report completed only with todoStatus=completed; conflictCheck treats explicit non-completed Todo evidence on a completed result as ambiguous. If the work fails, report outcome=failed rather than omitting the result.",
      "Reporting links the business result to the managed window's canonical agent:// terminal resource when the dispatch provides one; it does not terminate or reclaim this window.",
    ],
    parameters: FlowScheduleReportActionSchema,
    async execute(_id, raw, signal): Promise<FlowToolResult<FlowScheduleToolDetails>> {
      try {
        signal?.throwIfAborted();
        const action = parseFlowScheduleAction(raw);
        if (action.action !== "report") throw new Error("Managed worker Flow schedule exposes report only.");
        const registry = getRegistry();
        if (!registry) throw new Error("Session host registry is unavailable.");
        const inbound = registry.thread.get(flowScheduleDispatchMessageId(action.dispatchId), "incoming");
        if (!inbound) throw new Error(`Trusted Flow schedule dispatch not found: ${action.dispatchId}`);
        const published = await publishFlowScheduleReport({
          registry,
          inbound,
          outcome: action.outcome,
          summary: action.summary,
          resources: action.resources,
          todoOutcome: action.todoOutcome,
          brokerRuntime: options.getBrokerRuntime?.(),
        });
        signal?.throwIfAborted();
        return success(`Published Flow schedule result ${published.resultMessageId}.`, {
          schedules: [],
          resultMessageId: published.resultMessageId,
          ...(published.completionCorrelation
            ? { completionResource: published.completionCorrelation.resource }
            : {}),
          delivery: published.delivery,
        });
      } catch (error) {
        return failure(error);
      }
    },
    renderShell: "self",
    renderCall(args, theme, ctx) {
      if (ctx?.isPartial === false) return new Text("", 0, 0);
      const input = args as Record<string, unknown>;
      const expanded = ctx?.expanded === true;
      return toolCallLine(theme, "flow-schedule", flowScheduleCallArg(input, expanded));
    },
    renderResult(result, opts, theme, ctx) {
      if (opts.isPartial) return new Text("", 0, 0);
      const details = result.details as FlowScheduleToolDetails | undefined;
      const text = result.content.find((item) => item.type === "text");
      const message = text && "text" in text ? text.text : "";
      return toolResultLine(theme, {
        name: "flow-schedule",
        ok: (result as { isError?: boolean }).isError !== true,
        arg: flowScheduleCallArg(ctx.args as Record<string, unknown>),
        summary: flowScheduleResultSummary(details, result),
        expanded: opts.expanded,
        detail: scheduleRelationshipDetail(details?.schedules ?? [], message),
      });
    },
  };
}
