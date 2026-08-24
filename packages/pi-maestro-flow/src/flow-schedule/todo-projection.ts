import {
  registerWorkspaceProjectionProvider,
  type WorkspaceProjectionItem,
  type WorkspaceProjectionRegistration,
  type WorkspaceTodoSnapshot,
} from "pi-maestro-teammate/v1/workspace-projections";
import {
  getVisibleTasks,
  subscribeTodoStateChanges,
  type TodoTask,
} from "../tools/todo.ts";
import { isTerminalBindingState, type FlowScheduleTodoBinding } from "./types.ts";

export const FLOW_SCHEDULE_MAX_PROJECTED_TODOS = 32;

export interface FlowScheduleTodoProjectionStore {
  listBindings(): Promise<FlowScheduleTodoBinding[]>;
}

export interface FlowScheduleTodoProjectionOptions {
  store: FlowScheduleTodoProjectionStore;
  getTasks?: () => TodoTask[];
  subscribe?: (listener: () => void) => () => void;
  registerProvider?: typeof registerWorkspaceProjectionProvider;
  onError?: (error: unknown) => void;
}

export interface FlowScheduleTodoProjection {
  refresh(): Promise<void>;
  snapshot(): WorkspaceTodoSnapshot[];
  markDirty(): void;
  dispose(): void;
}

export function registerFlowScheduleTodoProjection(
  options: FlowScheduleTodoProjectionOptions,
): FlowScheduleTodoProjection {
  const getTasks = options.getTasks ?? getVisibleTasks;
  const subscribe = options.subscribe ?? subscribeTodoStateChanges;
  const registerProvider = options.registerProvider ?? registerWorkspaceProjectionProvider;
  let bindingByTodoId = new Map<string, FlowScheduleTodoBinding>();
  let bindingSignature = "";
  let refreshing: Promise<void> | undefined;
  let refreshQueued = false;
  let disposed = false;
  let registration: WorkspaceProjectionRegistration;

  const snapshot = (): WorkspaceTodoSnapshot[] => {
    void refresh();
    return getTasks()
      .map((task, index) => {
        const binding = bindingByTodoId.get(task.id);
        const data: WorkspaceTodoSnapshot = {
          id: task.id,
          subject: task.subject,
          status: task.status,
          assigneeLabel: task.assignee.label,
          ...(binding === undefined ? {} : {
            dispatchId: binding.dispatchId,
            scheduleId: binding.scheduleId,
            stepId: binding.stepId,
            bindingActive: !isTerminalBindingState(binding.state),
          }),
          updatedAt: task.updatedAt,
        };
        return {
          data,
          index,
          activeBinding: binding !== undefined && !isTerminalBindingState(binding.state),
        };
      })
      .sort((left, right) => Number(right.activeBinding) - Number(left.activeBinding) || left.index - right.index)
      .slice(0, FLOW_SCHEDULE_MAX_PROJECTED_TODOS)
      .map(({ data }) => data);
  };

  const refreshOnce = async (): Promise<void> => {
    try {
      const bindings = await options.store.listBindings();
      if (disposed) return;
      const signature = JSON.stringify(bindings);
      if (signature === bindingSignature) return;
      const next = new Map<string, FlowScheduleTodoBinding>();
      for (const binding of bindings) {
        if (!binding.todoId) continue;
        const current = next.get(binding.todoId);
        if (!current || binding.updatedAt >= current.updatedAt) next.set(binding.todoId, binding);
      }
      bindingByTodoId = next;
      bindingSignature = signature;
      registration.markDirty();
    } catch (error) {
      options.onError?.(error);
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshing) {
      refreshQueued = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshQueued = false;
        await refreshOnce();
      } while (refreshQueued && !disposed);
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  registration = registerProvider({
    kind: "todo",
    snapshot: (): WorkspaceProjectionItem[] => snapshot().map((data) => ({ kind: "todo", data })),
  });
  const unsubscribe = subscribe(() => {
    registration.markDirty();
    void refresh();
  });
  registration.markDirty();
  void refresh();

  return {
    refresh,
    snapshot,
    markDirty: () => registration.markDirty(),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      registration.dispose();
    },
  };
}
