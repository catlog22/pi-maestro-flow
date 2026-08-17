/**
 * A control channel for a backend that has no child stdin.
 *
 * The host addresses a running agent by writing JSON lines to a pipe captured
 * when a Pi child spawned. A backend that talks to its runtime some other way
 * publishes no pipe, so `teammate-send` reported "no restorable runtime" for a
 * runtime that was running and able to take the message.
 *
 * The mismatch is the channel's shape, not the capability: the line protocol
 * carries exactly the `(message, mode)` pair {@link BackendRun.send} accepts.
 * This translates one into the other, so the host keeps addressing agents the
 * single way it already does and backends keep implementing the one method the
 * contract declares.
 */
import { Writable } from "node:stream";
import type { BackendRun } from "pi-maestro-backend-core/v1/backend";
/**
 * Wrap a started run as the pipe the host knows how to address.
 *
 * @param run - the started run whose control channel this exposes.
 * @returns a stream accepting the host's control lines.
 */
export declare function createBackendControlStdin(run: BackendRun): Writable;
/**
 * Close a control channel so later sends are refused rather than swallowed.
 *
 * The host checks `writable` before writing, so ending the stream is what makes
 * a settled run stop accepting messages it can no longer deliver.
 *
 * @param stream - the channel returned by {@link createBackendControlStdin}.
 */
export declare function closeBackendControlStdin(stream: Writable): void;
