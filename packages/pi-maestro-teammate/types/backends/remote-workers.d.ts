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
import type { RemoteWorkerManagerLike as RemoteManagerPort } from "pi-maestro-backends/remote";
import type { RemoteWorkerManager } from "../remote/worker-manager.ts";
import type { RemoteRunCapture, RemoteRunEvent } from "../remote/types.ts";
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
export declare function createRemoteManagerPort(manager: RemoteWorkerManager): RemoteManagerPortBinding;
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
export declare function remoteMonitorEventSink(publish: (capture: RemoteRunCapture, event: RemoteRunEvent) => void, record: (capture: RemoteRunCapture, event: RemoteRunEvent) => void): (capture: RemoteRunCapture, event: RemoteRunEvent) => void;
