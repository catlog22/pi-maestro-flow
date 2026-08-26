import { parseFlowScheduleAction, parseFlowScheduleRecord } from "./schemas.ts";
import { FlowScheduleConflictError } from "./store.ts";
import type { FlowScheduleRecord } from "./types.ts";

function conflict(schedule: FlowScheduleRecord, action: string): never {
  throw new FlowScheduleConflictError(`Flow schedule ${schedule.scheduleId} cannot ${action} from ${schedule.state}`);
}

export function startFlowSchedule(schedule: FlowScheduleRecord): FlowScheduleRecord {
  if (schedule.state !== "draft") conflict(schedule, "start");
  return parseFlowScheduleRecord({ ...schedule, state: "active" });
}

export function pauseFlowSchedule(schedule: FlowScheduleRecord): FlowScheduleRecord {
  if (schedule.state !== "active") conflict(schedule, "pause");
  return parseFlowScheduleRecord({ ...schedule, state: "paused" });
}

export function resumeFlowSchedule(schedule: FlowScheduleRecord, target?: string): FlowScheduleRecord {
  const action = parseFlowScheduleAction({
    action: "resume",
    scheduleId: schedule.scheduleId,
    ...(target === undefined ? {} : { target }),
  });
  if (action.action !== "resume") throw new Error("Flow schedule resume normalization failed");
  if (schedule.state !== "paused") conflict(schedule, "resume");
  if (action.target !== undefined && schedule.activeStepId !== undefined) {
    throw new FlowScheduleConflictError("Flow schedule retarget requires no active dispatch");
  }
  if (action.target === undefined || action.target === schedule.targetSelector) {
    return parseFlowScheduleRecord({ ...schedule, state: "active" });
  }
  const next = { ...schedule, state: "active" as const, targetSelector: action.target };
  delete next.targetIdentity;
  return parseFlowScheduleRecord(next);
}

export function failFlowSchedule(schedule: FlowScheduleRecord, reason: string): FlowScheduleRecord {
  if (schedule.state === "completed" || schedule.state === "failed" || schedule.state === "cancelled") {
    conflict(schedule, "fail");
  }
  if (schedule.state !== "active") conflict(schedule, "fail");
  if (schedule.activeStepId !== undefined) {
    throw new FlowScheduleConflictError("Flow schedule fail requires no active dispatch");
  }
  return parseFlowScheduleRecord({ ...schedule, state: "failed", reason });
}

export function cancelFlowSchedule(schedule: FlowScheduleRecord, reason: string): FlowScheduleRecord {
  const action = parseFlowScheduleAction({ action: "cancel", scheduleId: schedule.scheduleId, reason });
  if (action.action !== "cancel") throw new Error("Flow schedule cancel normalization failed");
  if (schedule.state === "completed" || schedule.state === "failed" || schedule.state === "cancelled") {
    conflict(schedule, "cancel");
  }
  const steps = { ...schedule.steps };
  for (const stepId of schedule.stepIds) {
    const step = steps[stepId];
    if (step.state === "pending" || step.state === "failed" || step.state === "ambiguous") {
      steps[stepId] = { ...step, state: "cancelled" };
    }
  }
  return parseFlowScheduleRecord({ ...schedule, state: "cancelled", reason: action.reason, steps });
}

export function selectNextFlowScheduleStep(schedule: FlowScheduleRecord): string | undefined {
  if (schedule.state !== "active" || schedule.activeStepId !== undefined) return undefined;
  const next = schedule.stepIds.find((stepId) => schedule.steps[stepId].state !== "completed");
  return next !== undefined && schedule.steps[next].state === "pending" ? next : undefined;
}
