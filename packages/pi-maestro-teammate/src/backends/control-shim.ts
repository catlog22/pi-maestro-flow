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
import type { ControlMode } from "pi-maestro-backend-core/v1/spec";
import { unwrapLeasedMessage } from "../runs/session-handoff.ts";

/** Line types the host writes, mapped to the modes the contract declares. */
const MODES: Readonly<Record<string, ControlMode>> = {
  prompt: "prompt",
  follow_up: "follow_up",
  steer: "steer",
};

/**
 * A refusal reported to the caller of `write`.
 *
 * The host's writer wraps `stdin.write(...)` in try/catch and otherwise returns
 * true, so throwing synchronously is the only way a refusal travels back
 * through the pipe-shaped call. Reporting it through the stream's `_write`
 * callback would surface asynchronously as an `error` event, long after the
 * host had already told the model its message was delivered.
 */
class ControlRefused extends Error {}

/**
 * The pipe the host knows how to address, backed by a run's control channel.
 *
 * `write` is overridden rather than `_write` because the host reads delivery
 * success from whether the call threw, not from a stream callback.
 */
class BackendControlStdin extends Writable {
  constructor(private readonly run: BackendRun) {
    super();
    // Delivery failures travel by throwing; this listener exists only so a
    // stream error can never crash the host.
    this.on("error", () => {});
  }

  /**
   * Translate one or more control lines and deliver them.
   *
   * @param chunk - the host's control line, or several.
   * @returns true; a refusal throws instead.
   */
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    for (const line of String(chunk).split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new ControlRefused("backend control channel received a non-JSON line");
      }
      const { type, message } = parsed as { type?: unknown; message?: unknown };
      if (type === "abort") {
        this.run.abort();
        continue;
      }
      const mode = typeof type === "string" ? MODES[type] : undefined;
      if (mode === undefined) {
        // Lease updates and other Pi-child control messages have no meaning for
        // a backend addressed through this contract; dropping them is correct,
        // and refusing them would fail an unrelated send.
        continue;
      }
      if (typeof message !== "string") {
        throw new ControlRefused(`backend control line "${type}" carried no message`);
      }
      // The lease envelope is the Pi child's protocol, not the contract's.
      if (!this.run.send(unwrapLeasedMessage(message).message, mode)) {
        throw new ControlRefused(`backend refused a "${mode}" message`);
      }
    }
    // Nothing is buffered, so there is never backpressure to report.
    const callback = rest.find((argument) => typeof argument === "function");
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }

  /** No buffering happens, so the stream never needs to drain. */
  override _write(_chunk: unknown, _encoding: unknown, done: (error?: Error) => void): void {
    done();
  }
}

/**
 * Wrap a started run as the pipe the host knows how to address.
 *
 * @param run - the started run whose control channel this exposes.
 * @returns a stream accepting the host's control lines.
 */
export function createBackendControlStdin(run: BackendRun): Writable {
  return new BackendControlStdin(run);
}

/**
 * Close a control channel so later sends are refused rather than swallowed.
 *
 * The host checks `writable` before writing, so ending the stream is what makes
 * a settled run stop accepting messages it can no longer deliver.
 *
 * @param stream - the channel returned by {@link createBackendControlStdin}.
 */
export function closeBackendControlStdin(stream: Writable): void {
  if (!stream.writableEnded) stream.end();
}
