import type { GuiServerHandle } from "./types.ts";
import { cloneSerializable } from "./gui-state.ts";

/**
 * SSE event forwarding for the UCL.
 *
 * The forwarder is created once per extension surface and bound to whichever GUI
 * server is active for the current session. Subsystem change-points in the
 * extension call `emit`/`emitDeduped`; payloads are JSON-cloned before push so
 * events are serializable and carry no live references.
 */
export const GUI_EVENTS = {
  stateChanged: "state.changed",
  todoUpdated: "todo.updated",
  goalChanged: "goal.changed",
  runTransition: "run.transition",
  teammateStarted: "teammate.started",
  teammateProgress: "teammate.progress",
  teammateComplete: "teammate.complete",
  planMode: "plan.mode",
  toolInvoked: "tool.invoked",
  toolProgress: "tool.progress",
  permissionRequest: "permission.request",
} as const;

export interface GuiEventForwarder {
  /** Bind the active GUI server (null detaches; events become no-ops). */
  bind(server: GuiServerHandle | null): void;
  /** Push a named event (no dedup, no state.changed). */
  emit(name: string, payload?: unknown): void;
  /**
   * Push a subsystem event only when `key` differs from the last emission for
   * that name; also pushes a generic `state.changed`. Used for change-points that
   * may fire on renders/refreshes (todo, goal, plan mode).
   */
  emitDeduped(name: string, key: string, payload?: unknown): void;
  isActive(): boolean;
}

export function createGuiEventForwarder(): GuiEventForwarder {
  let server: GuiServerHandle | null = null;
  const lastKeys = new Map<string, string>();

  const emit = (name: string, payload?: unknown): void => {
    if (!server) return;
    server.pushEvent(name, cloneSerializable(payload));
  };

  return {
    bind(next) {
      server = next;
      lastKeys.clear();
    },
    emit,
    emitDeduped(name, key, payload) {
      if (!server) return;
      if (lastKeys.get(name) === key) return;
      lastKeys.set(name, key);
      emit(name, payload);
      emit(GUI_EVENTS.stateChanged, { subsystem: name, at: Date.now() });
    },
    isActive() {
      return server !== null;
    },
  };
}
