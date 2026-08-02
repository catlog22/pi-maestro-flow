/**
 * Shadow-write rollout controller for the durable mailbox.
 *
 * Modes:
 * - "disabled": v1 direct path only; no v2 admission or consumption.
 * - "shadow": v2 enqueue + validate but NEVER consume/inject. Files written for parity audit.
 * - "authoritative": (default) v2 is the delivery authority. Consumer dispatches from mailbox.
 *
 * Rollback: switch to "disabled" → new messages use v1 direct path; v2 files preserved for drain.
 * Disk error: surfaced as error, NEVER silent fallback to direct stdin.
 */

import { MailboxService } from "./service.ts";
import type { MailboxCapability } from "./service.ts";
import type { MailboxEnvelope, MailboxEnqueueResult } from "./types.ts";

// --- Rollout Mode ---

export type RolloutMode = "disabled" | "shadow" | "authoritative";

export interface RolloutConfig {
  /** Current rollout mode. */
  mode: RolloutMode;
  /** Whether to advertise v2 capability to peers. */
  advertiseV2: boolean;
}

const DEFAULT_CONFIG: RolloutConfig = {
  mode: "authoritative",
  advertiseV2: true,
};

// --- Rollout Controller ---

export interface MailboxRolloutOptions {
  service: MailboxService;
  config?: Partial<RolloutConfig>;
  /** Fallback delivery function for v1 direct path. */
  directDeliver: (envelope: {
    recipientCorrelationId: string;
    payload: string;
    mode: string;
  }) => Promise<void>;
  now?: () => number;
}

export class MailboxRollout {
  #config: RolloutConfig;
  readonly #service: MailboxService;
  readonly #directDeliver: MailboxRolloutOptions["directDeliver"];

  constructor(options: MailboxRolloutOptions) {
    this.#service = options.service;
    this.#directDeliver = options.directDeliver;
    const requested = { ...DEFAULT_CONFIG, ...options.config };
    // Advertise v2 iff the mode actually consumes/probes v2; never advertise for disabled.
    this.#config = {
      mode: requested.mode,
      advertiseV2: requested.mode === "shadow" || requested.mode === "authoritative",
    };
  }

  get mode(): RolloutMode {
    return this.#config.mode;
  }

  get config(): Readonly<RolloutConfig> {
    return this.#config;
  }

  /** Switch rollout mode. Preserves v2 files on downgrade. */
  setMode(mode: RolloutMode): void {
    const previous = this.#config.mode;
    this.#config.mode = mode;

    if (mode === "authoritative" && previous !== "authoritative") {
      // Start consuming
      this.#service.consumer.start();
    } else if (mode !== "authoritative" && previous === "authoritative") {
      // Stop consuming but preserve files for drain
      void this.#service.consumer.stop();
    }

    if (mode === "disabled") {
      this.#config.advertiseV2 = false;
    } else if (mode === "shadow" || mode === "authoritative") {
      this.#config.advertiseV2 = true;
    }
  }

  /** Get the capability to advertise to peers based on current mode. */
  advertisedCapability(): MailboxCapability {
    return this.#config.advertiseV2 ? "v2" : "v1";
  }

  /**
   * Route a message through the appropriate delivery path.
   *
   * - disabled: direct delivery only
   * - shadow: enqueue to v2 (validate) + direct delivery (actual)
   * - authoritative: enqueue to v2 only (consumer delivers)
   *
   * Disk errors are ALWAYS surfaced, never silently falling back.
   */
  async deliver(request: {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    kind: "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
    mode: "steer" | "follow_up" | "abort" | "notify";
    payload: string;
    requestId?: string;
    correlationId?: string;
  }): Promise<{ path: "v1" | "v2" | "shadow"; result: MailboxEnqueueResult | { ok: true; messageId: string; state: "ready" } }> {
    switch (this.#config.mode) {
      case "disabled": {
        // Pure v1 direct path
        await this.#directDeliver({
          recipientCorrelationId: request.recipientCorrelationId,
          payload: request.payload,
          mode: request.mode,
        });
        return {
          path: "v1",
          result: { ok: true, messageId: "direct-" + Date.now(), state: "ready" },
        };
      }

      case "shadow": {
        // Enqueue to v2 for validation/parity audit (may throw on disk error)
        const enqueueResult = await this.#service.enqueue(request);
        // Also deliver via direct path (shadow does NOT consume from v2)
        await this.#directDeliver({
          recipientCorrelationId: request.recipientCorrelationId,
          payload: request.payload,
          mode: request.mode,
        });
        return { path: "shadow", result: enqueueResult };
      }

      case "authoritative": {
        // v2 is the authority — enqueue only, consumer delivers
        const enqueueResult = await this.#service.enqueue(request);
        if (!enqueueResult.ok) {
          // Surface the error — do NOT fall back to direct
          return { path: "v2", result: enqueueResult };
        }
        return { path: "v2", result: enqueueResult };
      }
    }
  }

  /**
   * Check if v2 files exist (for drain verification before cleanup).
   */
  async hasV2Files(): Promise<boolean> {
    const live = await this.#service.store.countLive();
    const applied = await this.#service.store.count("applied");
    const dead = await this.#service.store.count("dead");
    return live > 0 || applied > 0 || dead > 0;
  }
}
