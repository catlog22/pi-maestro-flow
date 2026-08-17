/**
 * Host-side adapter between the real `RemoteWorkerManager` and the structural
 * port the remote backend consumes.
 *
 * The backend lives in `pi-maestro-backends`, which does not depend on this
 * package, so it declares a port and the host supplies an implementation. The
 * adapter exists for the two members the manager has no method for: the manager
 * publishes events only through its constructor's `onEvent` callback, so
 * per-capture routing is built here, and target resolution lives in this
 * package's remote configuration.
 */

import type {
  RemoteWorkerManagerLike as RemoteManagerPort,
  RemoteDriverId,
  RemoteStartedRun,
  RemoteWorkerStartRequest as RemoteStartRequestPort,
} from "pi-maestro-backends/remote";
import type { RemoteWorkerManager } from "../remote/worker-manager.ts";
import type { RemoteRunCapture, RemoteRunEvent } from "../remote/types.ts";
import { captureMatches } from "../remote/protocol.ts";

/**
 * One subscriber and the capture it is fenced to.
 *
 * `capture` is undefined for exactly as long as the `start` that created the
 * subscription is in flight: the run has no identity yet, so nothing can be
 * matched against it and every event published meanwhile goes to `buffered`
 * instead. That window is the whole reason this type is mutable — the manager
 * replays a worker's orphaned notifications while admitting the run, inside
 * that same call, and a subscription created afterwards would never see them.
 */
interface Subscription {
  capture: RemoteRunCapture | undefined;
  readonly listener: (event: RemoteRunEvent) => void;
  /** Events published before the capture was known, each with the capture it was published under. */
  readonly buffered: Array<{ capture: RemoteRunCapture; event: RemoteRunEvent }>;
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
  /**
   * Hand one event to one subscriber, containing whatever it throws.
   *
   * @param subscription - the subscriber.
   * @param event - the event to deliver.
   */
  const deliver = (subscription: Subscription, event: RemoteRunEvent): void => {
    try {
      subscription.listener(event);
    } catch {
      // One observer's fault must not stop the pump for the others, and the
      // manager has no channel to report it on.
    }
  };
  return {
    publish(capture, event) {
      for (const subscription of subscriptions) {
        // Still nameless: its run's identity has not come back yet, so the
        // event is held rather than matched. Held with its own capture, since
        // the buffer sees every run's events and only the started run's belong
        // to this subscriber.
        if (subscription.capture === undefined) {
          subscription.buffered.push({ capture, event });
          continue;
        }
        // The whole six-field capture, not just the run id: a superseded
        // Monitor term reuses run ids, and a subscriber that accepted an event
        // from the previous term would fold a stale run's tool counts into this
        // one's outcome.
        if (!captureMatches(subscription.capture, capture)) continue;
        deliver(subscription, event);
      }
    },
    port: {
      get monitorOwnerNonce() {
        return manager.monitorOwnerNonce;
      },
      resolveTargetDriver(targetId: string): RemoteDriverId {
        return manager.resolveTarget(targetId).driver;
      },
      async start(request, onEvent): Promise<RemoteStartedRun> {
        // Registered before the request goes out, so there is no instant at
        // which this run's events have nowhere to go.
        const subscription: Subscription = { capture: undefined, listener: onEvent, buffered: [] };
        subscriptions.add(subscription);
        const unsubscribe = (): void => {
          subscriptions.delete(subscription);
        };
        let capture: RemoteRunCapture;
        try {
          capture = await manager.start(request);
        } catch (cause) {
          unsubscribe();
          throw cause;
        }
        // Naming the subscription and draining its buffer is one synchronous
        // step, so no event can arrive between the two and be dropped or
        // delivered out of order.
        subscription.capture = capture;
        for (const held of subscription.buffered.splice(0)) {
          if (captureMatches(capture, held.capture)) deliver(subscription, held.event);
        }
        return { capture, unsubscribe };
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
// already points at `pi-maestro-backends` and no cycle forms. `start` and
// `resolveTargetDriver` are the adapter's own work and have no method to
// compare against; the start *request* still crosses verbatim, so it keeps its
// own assertion rather than losing the drift check along with the method.
type _ManagerConformance = RemoteWorkerManager extends Pick<
  RemoteManagerPort, "monitorOwnerNonce" | "send" | "cancel" | "wait" | "snapshot"
> ? true : never;
const _managerConformance: _ManagerConformance = true;
void _managerConformance;

type _StartRequestConformance =
  RemoteStartRequestPort extends Parameters<RemoteWorkerManager["start"]>[0] ? true : never;
const _startRequestConformance: _StartRequestConformance = true;
void _startRequestConformance;

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
