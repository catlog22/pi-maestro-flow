import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isManagedWorkerWindow } from "pi-maestro-teammate/v1/child-extensions";
import { getSessionHostRegistry, type SessionHostRegistry } from "pi-maestro-teammate/v1/sessions";
import { MONITOR_TOOL_EXPOSURE_EVENT, type MonitorToolExposureEventV1 } from "pi-maestro-teammate/v1/events";
import { FlowScheduleRuntime, type FlowScheduleRuntimeOptions } from "./runtime.ts";
import { FlowScheduleStore } from "./store.ts";
import {
  registerFlowScheduleTodoProjection,
  type FlowScheduleTodoProjection,
} from "./todo-projection.ts";
import {
  createCoordinatorFlowScheduleTool,
  createWorkerFlowScheduleTool,
  type FlowScheduleController,
} from "./tool.ts";

export interface RegisterFlowScheduleOptions {
  managedWorker?: boolean;
  getRegistry?: () => SessionHostRegistry | undefined;
  createStore?: (cwd: string) => FlowScheduleStore;
  createRuntime?: (store: FlowScheduleStore, cwd: string) => FlowScheduleRuntime;
  runtimeOptions?: Omit<FlowScheduleRuntimeOptions, "store" | "getRegistry">;
  onError?: (error: unknown) => void;
}

export interface FlowScheduleRegistration {
  readonly managedWorker: boolean;
  readonly monitor: boolean;
  current(): FlowScheduleController | undefined;
  dispose(): void;
}

interface ControllerBinding extends FlowScheduleController {
  cwd: string;
}

export function registerFlowSchedule(
  pi: ExtensionAPI,
  options: RegisterFlowScheduleOptions = {},
): FlowScheduleRegistration {
  const managedWorker = options.managedWorker ?? isManagedWorkerWindow();
  const getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
  let monitorActive = false;
  let monitorGeneration = 0;
  let coordinatorToolRegistered = false;
  let monitorExposureDisposer: (() => void) | undefined;
  let binding: ControllerBinding | undefined;
  let todoProjection: FlowScheduleTodoProjection | undefined;
  let disposed = false;

  const reportError = (error: unknown): void => {
    if (options.onError) options.onError(error);
    else console.warn(`[pi-maestro-flow] Flow schedule runtime: ${error instanceof Error ? error.message : String(error)}`);
  };

  const disposeBinding = (): void => {
    binding?.runtime.dispose();
    binding = undefined;
  };

  const disposeTodoProjection = (): void => {
    todoProjection?.dispose();
    todoProjection = undefined;
  };

  const startTodoProjection = async (cwd: string): Promise<void> => {
    disposeTodoProjection();
    const root = resolvePath(cwd);
    const store = options.createStore?.(root) ?? new FlowScheduleStore(root);
    todoProjection = registerFlowScheduleTodoProjection({ store, onError: reportError });
    await todoProjection.refresh();
    todoProjection.markDirty();
  };

  const ensureBinding = (cwd: string): ControllerBinding => {
    if (disposed) throw new Error("Flow schedule registration is disposed.");
    const root = resolvePath(cwd);
    if (binding?.cwd === root) return binding;
    disposeBinding();
    const store = options.createStore?.(root) ?? new FlowScheduleStore(root);
    const runtime = options.createRuntime?.(store, root) ?? new FlowScheduleRuntime({
      ...options.runtimeOptions,
      store,
      getRegistry,
    });
    binding = { cwd: root, store, runtime };
    void runtime.start().catch(reportError);
    return binding;
  };

  const setCoordinatorActive = (active: boolean): void => {
    if (!coordinatorToolRegistered) return;
    const current = pi.getActiveTools();
    const next = active
      ? current.includes("flow-schedule") ? current : [...current, "flow-schedule"]
      : current.filter((name) => name !== "flow-schedule");
    if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
      pi.setActiveTools(next);
    }
  };

  const exposeCoordinator = (active: boolean): void => {
    monitorActive = active;
    if (active && !coordinatorToolRegistered) {
      pi.registerTool(createCoordinatorFlowScheduleTool({
        resolve: ensureBinding,
        getRegistry,
        isMonitorActive: () => monitorActive,
        captureMonitor: () => monitorActive ? { generation: monitorGeneration } : undefined,
      }));
      coordinatorToolRegistered = true;
    }
    setCoordinatorActive(active);
  };

  if (managedWorker) {
    pi.registerTool(createWorkerFlowScheduleTool({ getRegistry }));
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      await startTodoProjection(ctx.cwd).catch(reportError);
    });
    pi.on("session_shutdown", () => {
      disposeTodoProjection();
    });
  } else {
    const events = (pi as ExtensionAPI & {
      events?: { on?: (channel: string, handler: (data: unknown) => void) => () => void };
    }).events;
    monitorExposureDisposer = events?.on?.(MONITOR_TOOL_EXPOSURE_EVENT, (payload) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as Partial<MonitorToolExposureEventV1>;
      const generation = event.generation;
      if (typeof event.active !== "boolean"
        || typeof generation !== "number"
        || !Number.isInteger(generation)
        || generation <= monitorGeneration) return;
      monitorGeneration = generation;
      exposeCoordinator(event.active);
    });
    exposeCoordinator(getRegistry()?.viewMode === "windows");
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      if (!monitorActive) return;
      const current = ensureBinding(ctx.cwd);
      await current.runtime.start().catch(reportError);
    });
    pi.on("session_shutdown", () => {
      disposeBinding();
    });
  }

  return {
    managedWorker,
    get monitor() { return monitorActive; },
    current: () => binding,
    dispose() {
      if (disposed) return;
      if (!managedWorker) {
        monitorExposureDisposer?.();
        monitorExposureDisposer = undefined;
        exposeCoordinator(false);
      }
      disposed = true;
      disposeTodoProjection();
      disposeBinding();
    },
  };
}
