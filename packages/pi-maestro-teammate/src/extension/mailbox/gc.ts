import type { MailboxFileStore } from "./file-store.ts";
import {
  type MailboxPriority,
  type MailboxState,
  QUOTA_HARD_TOTAL,
  QUOTA_NORMAL_MAX,
  TTL_DEAD_MS,
  TTL_RECEIPT_MS,
  TTL_STAGING_MS,
} from "./types.ts";

export interface GCResult {
  removed: number;
  errors: string[];
}

export interface GCCandidate {
  state: MailboxState;
  messageId: string;
  reason: string;
}

export interface MailboxGCOptions {
  store: MailboxFileStore;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MailboxGC {
  readonly #store: MailboxFileStore;
  readonly #now: () => number;

  constructor(options: MailboxGCOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  async collectEligible(): Promise<GCCandidate[]> {
    return this.#collectEligible();
  }

  async run(): Promise<GCResult> {
    const errors: string[] = [];
    const candidates = await this.#collectEligible(errors);
    let removed = 0;

    for (const candidate of candidates) {
      try {
        if (candidate.state === "ready") {
          await this.#store.expire(candidate.messageId);
          continue;
        }

        await this.#store.remove(candidate.state, candidate.messageId);
        removed += 1;
      } catch (error) {
        errors.push(
          `${candidate.state}/${candidate.messageId}: ${errorMessage(error)}`,
        );
      }
    }

    return { removed, errors };
  }

  async #collectEligible(errors?: string[]): Promise<GCCandidate[]> {
    const candidates: GCCandidate[] = [];
    const now = this.#now();

    await this.#scanState("staging", errors, async (messageId) => {
      const envelope = await this.#store.readEnvelope("staging", messageId);
      if (envelope && now - envelope.createdAt > TTL_STAGING_MS) {
        candidates.push({
          state: "staging",
          messageId,
          reason: "staging orphan exceeded retention",
        });
      }
    });

    await this.#scanState("ready", errors, async (messageId) => {
      const envelope = await this.#store.readEnvelope("ready", messageId);
      if (envelope && now > envelope.expiresAt) {
        candidates.push({
          state: "ready",
          messageId,
          reason: "message expired",
        });
      }
    });

    await this.#scanTerminalState(
      "applied",
      TTL_RECEIPT_MS,
      "applied receipt exceeded retention",
      now,
      candidates,
      errors,
    );
    await this.#scanTerminalState(
      "expired",
      TTL_DEAD_MS,
      "expired message exceeded retention",
      now,
      candidates,
      errors,
    );
    await this.#scanTerminalState(
      "dead",
      TTL_DEAD_MS,
      "dead message exceeded retention",
      now,
      candidates,
      errors,
    );

    return candidates;
  }

  async #scanTerminalState(
    state: "applied" | "expired" | "dead",
    retentionMs: number,
    reason: string,
    now: number,
    candidates: GCCandidate[],
    errors?: string[],
  ): Promise<void> {
    await this.#scanState(state, errors, async (messageId) => {
      const record = await this.#store.readStateRecord(state, messageId);
      if (record && now - record.transitionedAt > retentionMs) {
        candidates.push({ state, messageId, reason });
      }
    });
  }

  async #scanState(
    state: MailboxState,
    errors: string[] | undefined,
    inspect: (messageId: string) => Promise<void>,
  ): Promise<void> {
    try {
      const messageIds = await this.#store.listMessages(state);
      for (const messageId of messageIds) {
        try {
          await inspect(messageId);
        } catch (error) {
          if (!errors) throw error;
          errors.push(`${state}/${messageId}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      if (!errors) throw error;
      errors.push(`${state}: ${errorMessage(error)}`);
    }
  }
}

export interface QuotaAdmissionOptions {
  store: MailboxFileStore;
  /** Override hard total for testing (default: QUOTA_HARD_TOTAL). */
  hardTotal?: number;
  /** Override normal max for testing (default: QUOTA_NORMAL_MAX). */
  normalMax?: number;
}

export interface QuotaAdmissionResult {
  allowed: boolean;
  code?: "quota_exceeded";
  live: number;
}

export class QuotaAdmission {
  readonly #store: MailboxFileStore;
  readonly #hardTotal: number;
  readonly #normalMax: number;

  constructor(options: QuotaAdmissionOptions) {
    this.#store = options.store;
    this.#hardTotal = options.hardTotal ?? QUOTA_HARD_TOTAL;
    this.#normalMax = options.normalMax ?? QUOTA_NORMAL_MAX;
  }

  async check(priority: MailboxPriority): Promise<QuotaAdmissionResult> {
    const live = await this.#store.countLive();
    if (live >= this.#hardTotal) {
      return { allowed: false, code: "quota_exceeded", live };
    }

    if (priority !== "critical") {
      const nonCritical = await this.#countNonCritical();
      if (nonCritical >= this.#normalMax) {
        return { allowed: false, code: "quota_exceeded", live };
      }
    }

    return { allowed: true, live };
  }

  async #countNonCritical(): Promise<number> {
    const states = ["ready", "claimed", "accepted"] as const;
    let count = 0;

    for (const state of states) {
      const messageIds = await this.#store.listMessages(state);
      for (const messageId of messageIds) {
        const envelope = await this.#store.readEnvelope(state, messageId);
        if (envelope?.priority !== "critical") count += 1;
      }
    }

    return count;
  }
}
