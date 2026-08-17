/**
 * Host-side adapter between the real `RemoteWorkerManager` and the structural
 * port the remote backend consumes.
 *
 * The backend lives in `pi-maestro-backends`, which does not depend on this
 * package, so it declares a port and the host supplies an implementation. The
 * adapter exists for the two members the manager has no method for: the manager
 * publishes events only through its constructor's `onEvent` callback, so
 * per-capture subscription is built here, and target resolution lives in this
 * package's remote configuration.
 */

import type {
  RemoteWorkerManagerLike as RemoteManagerPort,
  RemoteDriverId,
} from "pi-maestro-backends/remote";
import type { RemoteWorkerManager } from "../remote/worker-manager.ts";
import type { RemoteRunCapture, RemoteRunEvent } from "../remote/types.ts";
import { captureMatches } from "../remote/protocol.ts";

/** One subscriber, kept with the capture it fenced itself to. */
interface Subscription {
  readonly capture: RemoteRunCapture;
  readonly listener: (event: RemoteRunEvent) => void;
}

/** The port plus the sink the host's `onEvent` must feed. */
export interface RemoteManagerPortBinding {
  readonly port: RemoteManagerPort;
  /**
   * Deliver one manager event to whichever backend subscribed to that capture.
   *
   * The host's `RemoteWorkerManager.onEvent` callback must call this for every
   * event; nothing else reaches a backend's fold.
   *
   * @param capture - the run the event belongs to.
   * @param event - the event, as the manager published it.
   */
  publish(capture: RemoteRunCapture, event: RemoteRunEvent): void;
}

/**
 * Adapt one manager to the backend's port.
 *
 * @param manager - the host's manager, already constructed.
 * @returns the port and the event sink that feeds its subscribers.
 */
export function createRemoteManagerPort(manager: RemoteWorkerManager): RemoteManagerPortBinding {
  const subscriptions = new Set<Subscription>();
  return {
    publish(capture, event) {
      for (const subscription of subscriptions) {
        // The whole six-field capture, not just the run id: a superseded
        // Monitor term reuses run ids, and a subscriber that accepted an event
        // from the previous term would fold a stale run's tool counts into this
        // one's outcome.
        if (!captureMatches(subscription.capture, capture)) continue;
        try {
          subscription.listener(event);
        } catch {
          // One observer's fault must not stop the pump for the others, and the
          // manager has no channel to report it on.
        }
      }
    },
    port: {
      get monitorOwnerNonce() {
        return manager.monitorOwnerNonce;
      },
      resolveTargetDriver(targetId: string): RemoteDriverId {
        return manager.resolveTarget(targetId).driver;
      },
      start: (request) => manager.start(request),
      subscribe(capture, listener) {
        const subscription: Subscription = { capture, listener };
        subscriptions.add(subscription);
        return () => {
          subscriptions.delete(subscription);
        };
      },
      send: (capture, mode, message, commandId) => manager.send(capture, mode, message, commandId),
      cancel: (capture, reason, commandId) => manager.cancel(capture, reason, commandId),
      wait: (capture, options) => manager.wait(capture, options),
      snapshot: (capture) => manager.snapshot(capture),
    },
  };
}

// The two structural copies must not drift: the port is declared in a package
// that cannot import this one, so the check lives here, where the dependency
// already points at `pi-maestro-backends` and no cycle forms. `subscribe` and
// `resolveTargetDriver` are the adapter's own work and have no counterpart to
// compare.
type _ManagerConformance = RemoteWorkerManager extends Pick<
  RemoteManagerPort, "monitorOwnerNonce" | "start" | "send" | "cancel" | "wait" | "snapshot"
> ? true : never;
const _managerConformance: _ManagerConformance = true;
void _managerConformance;

/**
 * Compose the host's two event consumers into the manager's single `onEvent`.
 *
 * Both legs must receive every event: the Monitor's session recorder is what
 * `observe kind=remote` and `teammate-list view=remote` read, and the backend's
 * subscriber pump is the only path by which a dispatched run's tool counts,
 * text, and terminal result reach its fold. Dropping either leg produces no
 * compile error and no failing assertion, so the composition is a named
 * function that a test can call directly.
 *
 * Two callbacks rather than the binding itself: the port only exists after the
 * manager is constructed, while `onEvent` is one of the manager's constructor
 * arguments, so naming the binding there would evaluate a still-uninitialised
 * reference.
 *
 * @param publish - delivers to the backend's subscribers.
 * @param record - delivers to the Monitor session recorder.
 * @returns the manager's `onEvent` callback.
 */
export function remoteMonitorEventSink(
  publish: (capture: RemoteRunCapture, event: RemoteRunEvent) => void,
  record: (capture: RemoteRunCapture, event: RemoteRunEvent) => void,
): (capture: RemoteRunCapture, event: RemoteRunEvent) => void {
  return (capture, event) => {
    record(capture, event);
    publish(capture, event);
  };
}
