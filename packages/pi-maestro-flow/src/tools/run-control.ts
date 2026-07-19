import { Type } from "typebox";
import type { WorkflowCoordinator } from "../session/coordinator.ts";

/** Read-only across both the native run-control tool and Maestro CLI aliases. */
export const RUN_CONTROL_READ_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "brief",
  "prepare",
  "recall",
  "skill",
  "mutations",
  "list",
  "show",
]);
export const RUN_CONTROL_WRITE_ACTIONS = new Set(["advance", "complete", "retry", "cancel"] as const);
export type RunControlAction = "status" | "brief" | "prepare" | "advance" | "complete" | "retry" | "cancel";

export function isRunControlReadAction(action: string): boolean {
  return RUN_CONTROL_READ_ACTIONS.has(action);
}

export const RunControlParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("brief"),
    Type.Literal("prepare"),
    Type.Literal("advance"),
    Type.Literal("complete"),
    Type.Literal("retry"),
    Type.Literal("cancel"),
  ]),
  runId: Type.Optional(Type.String()),
  step: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
});

export interface RunControlInput {
  action: RunControlAction;
  runId?: string;
  step?: string;
  command?: string;
  args?: string[];
}

export interface RunControlResult {
  ok: boolean;
  action: RunControlAction;
  message: string;
  details?: unknown;
}

export async function executeRunControl(
  input: RunControlInput,
  coordinator: WorkflowCoordinator,
): Promise<RunControlResult> {
  try {
    switch (input.action) {
      case "status": {
        const snapshot = coordinator.status();
        return snapshot
          ? success(input.action, `${snapshot.source} snapshot ${snapshot.revision.fingerprint.slice(0, 12)}`, snapshot)
          : failure(input.action, "Coordinator is not attached; attach during session_start first");
      }
      case "brief": {
        const result = await coordinator.brief(input.runId);
        return success(input.action, result.stdout, result);
      }
      case "prepare": {
        const result = await coordinator.prepare(required(input.step, "step"));
        return success(input.action, result.stdout, result);
      }
      case "advance": {
        const result = await coordinator.advance(required(input.command, "command"), input.args ?? []);
        return success(input.action, result.command.stdout, result);
      }
      case "complete": {
        const result = await coordinator.complete(required(input.runId, "runId"));
        return success(input.action, result.command.stdout, result);
      }
      case "retry": {
        const result = await coordinator.retry(required(input.runId, "runId"));
        return success(input.action, result.command.stdout, result);
      }
      case "cancel": {
        const result = await coordinator.cancel(required(input.runId, "runId"));
        return success(input.action, result.command.stdout, result);
      }
    }
  } catch (error) {
    return failure(input.action, error instanceof Error ? error.message : String(error));
  }
}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this action`);
  return normalized;
}

function success(action: RunControlAction, message: string, details?: unknown): RunControlResult {
  return { ok: true, action, message, ...(details === undefined ? {} : { details }) };
}

function failure(action: RunControlAction, message: string): RunControlResult {
  return { ok: false, action, message };
}
