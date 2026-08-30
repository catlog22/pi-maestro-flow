import { createHash } from "node:crypto";
import {
  MONITOR_WINDOW_STATE_VERSION,
  registerMonitorWindowFacetProvider,
  type MonitorWindowFacetAttentionV1,
  type MonitorWindowFacetProvider,
  type MonitorWindowFacetReadRequestV1,
  type MonitorWindowFacetTargetV1,
  type MonitorWindowFacetV1,
  type MonitorWindowIdentityV1,
  type MonitorWindowJsonValueV1,
} from "pi-maestro-teammate/v1/monitor-window-state";
import type { FlowScheduleDispatchBundle } from "./store.ts";
import type {
  ExactWindowIdentity,
  FlowScheduleRecord,
  FlowScheduleStep,
  FlowScheduleTodoBindingSpec,
} from "./types.ts";

export const FLOW_SCHEDULE_MONITOR_FACET_KIND = "flow-schedule";
export const FLOW_SCHEDULE_MONITOR_FACET_SOURCE = "pi-maestro-flow/flow-schedule";
export const FLOW_SCHEDULE_MONITOR_FACET_VERSION = 1 as const;
export const FLOW_SCHEDULE_MAX_MONITOR_TARGETS = 256;

export interface FlowScheduleMonitorFacetStore {
  listSchedules(): Promise<FlowScheduleRecord[]>;
  readDispatch(dispatchId: string): Promise<FlowScheduleDispatchBundle | undefined>;
}

export interface FlowScheduleMonitorFacetOptions {
  getStore(): FlowScheduleMonitorFacetStore | undefined;
  registerProvider?: typeof registerMonitorWindowFacetProvider;
}

/** Register the root-side, read-only Flow contribution to MonitorWindowStateV1. */
export function registerFlowScheduleMonitorFacet(options: FlowScheduleMonitorFacetOptions): () => void {
  const registerProvider = options.registerProvider ?? registerMonitorWindowFacetProvider;
  return registerProvider(createFlowScheduleMonitorFacetProvider(options.getStore));
}

/**
 * Build a bounded provider whose output is fenced to the exact identity captured
 * by Monitor. The provider never resolves owner selectors and never treats Todo
 * state as completion authority.
 */
export function createFlowScheduleMonitorFacetProvider(
  getStore: () => FlowScheduleMonitorFacetStore | undefined,
): MonitorWindowFacetProvider {
  return {
    kind: FLOW_SCHEDULE_MONITOR_FACET_KIND,
    async read(request: MonitorWindowFacetReadRequestV1): Promise<MonitorWindowFacetV1[]> {
      if (request.version !== MONITOR_WINDOW_STATE_VERSION) {
        throw new Error(`Unsupported Monitor window state version: ${String(request.version)}`);
      }
      const store = getStore();
      if (!store) return [];
      const schedules = await store.listSchedules();
      const targets = uniqueTargets(request.targets).slice(0, FLOW_SCHEDULE_MAX_MONITOR_TARGETS);
      const facets: MonitorWindowFacetV1[] = [];

      for (const target of targets) {
        const matching = schedules
          .filter((schedule) => schedule.targetIdentity !== undefined
            && sameIdentity(schedule.targetIdentity, target.identity))
          .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
        if (matching.length === 0) continue;

        const attention: MonitorWindowFacetAttentionV1[] = [];
        const projected = [];
        for (const schedule of matching) {
          projected.push(await projectSchedule(store, schedule, target.identity, attention));
        }
        const semanticData = {
          source: FLOW_SCHEDULE_MONITOR_FACET_SOURCE,
          version: FLOW_SCHEDULE_MONITOR_FACET_VERSION,
          schedules: projected,
        } satisfies MonitorWindowJsonValueV1;
        const revision = contentRevision({ data: semanticData, attention });
        facets.push({
          kind: FLOW_SCHEDULE_MONITOR_FACET_KIND,
          target: copyTarget(target),
          revision,
          data: { ...semanticData, revision },
          ...(attention.length === 0 ? {} : { attention }),
        });
      }
      return facets;
    },
  };
}

async function projectSchedule(
  store: FlowScheduleMonitorFacetStore,
  schedule: FlowScheduleRecord,
  identity: MonitorWindowIdentityV1,
  attention: MonitorWindowFacetAttentionV1[],
): Promise<MonitorWindowJsonValueV1> {
  const activeStep = schedule.activeStepId === undefined ? undefined : schedule.steps[schedule.activeStepId];
  const dispatchId = latestDispatchId(schedule);
  let bundle: FlowScheduleDispatchBundle | undefined;
  if (dispatchId) {
    try {
      const candidate = await store.readDispatch(dispatchId);
      if (candidate && dispatchMatches(candidate, schedule, identity, dispatchId)) {
        bundle = candidate;
      } else if (candidate) {
        attention.push({
          code: "flow-schedule-dispatch-identity-mismatch",
          severity: "warning",
          message: `Flow dispatch ${dispatchId} did not match the captured window identity and was omitted.`,
          dedupeKey: `flow-schedule:${schedule.scheduleId}:${dispatchId}:identity-mismatch`,
        });
      }
    } catch (error) {
      attention.push({
        code: "flow-schedule-dispatch-read-failed",
        severity: "warning",
        message: `Flow dispatch ${dispatchId} could not be read: ${errorMessage(error)}`,
        dedupeKey: `flow-schedule:${schedule.scheduleId}:${dispatchId}:read-failed`,
      });
    }
  }

  const completion = bundle?.completion
    && sameIdentity(bundle.completion.targetIdentity, identity)
    && bundle.completion.dispatchId === bundle.intent.dispatchId
    && bundle.completion.scheduleId === bundle.intent.scheduleId
    && bundle.completion.stepId === bundle.intent.stepId
    ? bundle.completion
    : undefined;
  if (bundle?.completion && !completion) {
    attention.push({
      code: "flow-schedule-completion-identity-mismatch",
      severity: "warning",
      message: `Flow completion ${bundle.completion.dispatchId} did not match the captured window identity and was omitted.`,
      dedupeKey: `flow-schedule:${schedule.scheduleId}:${bundle.completion.dispatchId}:completion-identity-mismatch`,
    });
  }

  const ambiguous = completion?.state === "ambiguous"
    || activeStep?.state === "ambiguous"
    || schedule.stepIds.some((stepId) => schedule.steps[stepId]?.state === "ambiguous");
  if (ambiguous) {
    attention.push({
      code: "flow-schedule-ambiguous",
      severity: "warning",
      message: completion?.reason ?? `Flow schedule ${schedule.scheduleId} contains ambiguous work.`,
      dedupeKey: `flow-schedule:${schedule.scheduleId}:${bundle?.intent.dispatchId ?? "none"}:ambiguous`,
    });
  }

  return {
    scheduleId: schedule.scheduleId,
    state: schedule.state,
    updatedAt: schedule.updatedAt,
    progress: {
      completed: schedule.stepIds.filter((stepId) => schedule.steps[stepId]?.state === "completed").length,
      total: schedule.stepIds.length,
    },
    ...(activeStep === undefined ? {} : { activeStep: projectStep(activeStep) }),
    ...(bundle === undefined ? {} : {
      dispatch: projectDispatch(bundle, completion, schedule.steps[bundle.intent.stepId]),
    }),
    ambiguity: {
      ambiguous,
      ...(completion?.reason === undefined ? {} : { reason: completion.reason }),
      ...(completion?.state !== "ambiguous" ? {} : { completedAt: completion.completedAt }),
    },
  } satisfies MonitorWindowJsonValueV1;
}

function projectStep(step: FlowScheduleStep): MonitorWindowJsonValueV1 {
  return {
    stepId: step.stepId,
    state: step.state,
    attempts: step.attempts.length,
    ...(step.currentDispatchId === undefined ? {} : { dispatchId: step.currentDispatchId }),
  };
}

function projectDispatch(
  bundle: FlowScheduleDispatchBundle,
  completion: FlowScheduleDispatchBundle["completion"],
  dispatchStep: FlowScheduleStep | undefined,
): MonitorWindowJsonValueV1 {
  const stepBinding = dispatchStep?.todoBinding;
  const negotiated = bundle.binding !== undefined && stepBinding !== undefined;
  const exact = completion?.result === undefined
    ? undefined
    : { result: completion.result, completedAt: completion.completedAt };
  return {
    dispatchId: bundle.intent.dispatchId,
    stepId: bundle.intent.stepId,
    state: completion?.state ?? (bundle.accepted ? "accepted" : bundle.published ? "published" : "prepared"),
    transport: {
      preparedAt: bundle.intent.createdAt,
      ...(bundle.published === undefined ? {} : { publishedAt: bundle.published.publishedAt }),
      ...(bundle.accepted === undefined ? {} : { acceptedAt: bundle.accepted.acceptedAt }),
    },
    todoGate: projectTodoGate(stepBinding, negotiated, bundle),
    ...(exact === undefined ? {} : {
      exactResult: {
        source: "exact-report",
        authority: "business-completion",
        outcome: exact.result.outcome,
        summary: exact.result.summary,
        resources: [...exact.result.resources],
        completedAt: exact.completedAt,
        ...(exact.result.completionCorrelation === undefined ? {} : {
          canonicalCompletion: {
            source: "canonical-completion",
            authority: "business-completion",
            resource: exact.result.completionCorrelation.resource,
          },
        }),
      },
    }),
  };
}

function projectTodoGate(
  requested: FlowScheduleTodoBindingSpec | undefined,
  negotiated: boolean,
  bundle: FlowScheduleDispatchBundle,
): MonitorWindowJsonValueV1 {
  const outcome = negotiated ? bundle.completion?.result?.todoOutcome : undefined;
  return {
    requested: requested !== undefined,
    negotiated,
    requireCompleted: negotiated && requested?.requireCompleted === true,
    conflictCheck: negotiated && requested?.conflictCheck === true,
    authority: "additional-evidence-only",
    ...(bundle.binding === undefined ? {} : {
      binding: {
        state: bundle.binding.state,
        ...(bundle.binding.todoId === undefined ? {} : { todoId: bundle.binding.todoId }),
        ...(bundle.binding.todoStatus === undefined ? {} : { todoStatus: bundle.binding.todoStatus }),
        updatedAt: bundle.binding.updatedAt,
      },
    }),
    ...(outcome === undefined ? {} : {
      reportedOutcome: { todoId: outcome.todoId, todoStatus: outcome.todoStatus },
    }),
  };
}

function latestDispatchId(schedule: FlowScheduleRecord): string | undefined {
  if (schedule.activeStepId !== undefined) {
    const current = schedule.steps[schedule.activeStepId]?.currentDispatchId;
    if (current !== undefined) return current;
  }
  let latest: string | undefined;
  for (const stepId of schedule.stepIds) latest = schedule.steps[stepId]?.attempts.at(-1) ?? latest;
  return latest;
}

function dispatchMatches(
  bundle: FlowScheduleDispatchBundle,
  schedule: FlowScheduleRecord,
  identity: MonitorWindowIdentityV1,
  dispatchId: string,
): boolean {
  return bundle.intent.dispatchId === dispatchId
    && bundle.intent.scheduleId === schedule.scheduleId
    && schedule.steps[bundle.intent.stepId] !== undefined
    && sameIdentity(bundle.intent.targetIdentity, identity);
}

function sameIdentity(left: ExactWindowIdentity, right: MonitorWindowIdentityV1): boolean {
  return left.workspaceId === right.workspaceId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.endpointId === right.endpointId;
}

function uniqueTargets(targets: readonly MonitorWindowFacetTargetV1[]): MonitorWindowFacetTargetV1[] {
  const seen = new Set<string>();
  const unique: MonitorWindowFacetTargetV1[] = [];
  for (const target of targets) {
    const key = [
      target.identity.workspaceId,
      target.identity.ownerId,
      target.identity.ownerNonce,
      target.identity.endpointId,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ identity: { ...target.identity } });
  }
  return unique;
}

function copyTarget(target: MonitorWindowFacetTargetV1): MonitorWindowFacetTargetV1 {
  return {
    identity: { ...target.identity },
    ...(target.workRef === undefined ? {} : { workRef: { ...target.workRef } }),
  };
}

function contentRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
