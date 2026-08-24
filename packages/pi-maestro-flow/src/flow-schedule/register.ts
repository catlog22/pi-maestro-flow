import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isManagedWorkerWindow, isMonitorSession } from "pi-maestro-teammate/v1/child-extensions";
import { getSessionHostRegistry, type SessionHostRegistry } from "pi-maestro-teammate/v1/sessions";
import { FlowScheduleRuntime, type FlowScheduleRuntimeOptions } from "./runtime.ts";
import { FlowScheduleStore } from "./store.ts";
import {
  createCoordinatorFlowScheduleTool,
  createWorkerFlowScheduleTool,
  type FlowScheduleController,
} from "./tool.ts";

export interface RegisterFlowScheduleOptions {
  managedWorker?: boolean;
  monitor?: boolean;
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
  const monitor = !managedWorker && (options.monitor ?? isMonitorSession());
  const getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
  let binding: ControllerBinding | undefined;
  let disposed = false;

  const reportError = (error: unknown): void => {
    if (options.onError) options.onError(error);
    else console.warn(`[pi-maestro-flow] Flow schedule runtime: ${error instanceof Error ? error.message : String(error)}`);
  };

  const disposeBinding = (): void => {
    binding?.runtime.dispose();
    binding = undefined;
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

  if (managedWorker) {
    pi.registerTool(createWorkerFlowScheduleTool({ getRegistry }));
  } else if (monitor) {
    pi.registerTool(createCoordinatorFlowScheduleTool({ resolve: ensureBinding, getRegistry }));
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      const current = ensureBinding(ctx.cwd);
      await current.runtime.start().catch(reportError);
    });
    pi.on("session_shutdown", () => {
      disposeBinding();
    });
  }

  return {
    managedWorker,
    monitor,
    current: () => binding,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeBinding();
    },
  };
}
