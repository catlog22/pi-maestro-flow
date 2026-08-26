import type { MailboxFileStore, MailboxMutationAuthority } from "./file-store.ts";
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
  /** Mutation-authority preflight; false makes a sweep a no-op. */
  canMutate?: () => boolean | Promise<boolean>;
  /** Revalidated from inside every destructive store commit. */
  mutationAuthority?: MailboxMutationAuthority;
  /** Maximum records inspected/mutated by one sweep. */
  maxSweep?: number;
}

const DEFAULT_GC_MAX_SWEEP = 128;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MailboxGC {
  readonly #store: MailboxFileStore;
  readonly #now: () => number;
  readonly #canMutate: () => boolean | Promise<boolean>;
  readonly #mutationAuthority: MailboxMutationAuthority | undefined;
  readonly #maxSweep: number;

  constructor(options: MailboxGCOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#canMutate = options.canMutate ?? (() => true);
    this.#mutationAuthority = options.mutationAuthority;
    this.#maxSweep = Math.max(1, Math.min(options.maxSweep ?? DEFAULT_GC_MAX_SWEEP, DEFAULT_GC_MAX_SWEEP));
  }

  async collectEligible(): Promise<GCCandidate[]> {
    return (await this.#collectEligible()).candidates;
  }

  async run(): Promise<GCResult> {
    if (!await this.#canMutate()) return { removed: 0, errors: [] };
    const errors: string[] = [];
    const collected = await this.#collectEligible(errors, this.#maxSweep);
    const candidates = collected.candidates;
    let removed = 0;
    let inspected = collected.inspected;

    for (const candidate of candidates) {
      if (!await this.#canMutate()) break;
      try {
        if (candidate.state === "ready") {
          await this.#store.expire(candidate.messageId, this.#mutationAuthority);
          continue;
        }
        if (await this.#store.remove(candidate.state, candidate.messageId, this.#mutationAuthority)) removed += 1;
      } catch (error) {
        errors.push(`${candidate.state}/${candidate.messageId}: ${errorMessage(error)}`);
      }
    }

    const orphanStates: MailboxState[] = [
      "staging", "ready", "claimed", "accepted", "applied", "rejected", "expired", "dead",
    ];
    for (const state of orphanStates) {
      if (inspected >= this.#maxSweep || !await this.#canMutate()) break;
      try {
        const orphans = await this.#store.listOrphanStateRecords(state, this.#maxSweep - inspected);
        inspected += orphans.length;
        for (const messageId of orphans) {
          if (!await this.#canMutate()) break;
          try {
            if (await this.#store.removeStateRecordOnly(state, messageId, this.#mutationAuthority)) removed += 1;
          } catch (error) {
            errors.push(`${state}/${messageId}: ${errorMessage(error)}`);
          }
        }
      } catch (error) {
        errors.push(`${state}: ${errorMessage(error)}`);
      }
    }

    const nowSeen = this.#now();
    try {
      const seen = inspected >= this.#maxSweep ? [] : await this.#store.listSeen(this.#maxSweep - inspected);
      for (const record of seen) {
        if (!await this.#canMutate()) break;
        if (nowSeen - record.seenAt > TTL_RECEIPT_MS) {
          try {
            if (await this.#store.removeSeen(record.file, this.#mutationAuthority)) removed += 1;
          } catch (error) {
            errors.push(`seen/${record.file}: ${errorMessage(error)}`);
          }
        }
      }
    } catch (error) {
      errors.push(`seen: ${errorMessage(error)}`);
    }

    return { removed, errors };
  }

  async #collectEligible(
    errors?: string[],
    limit?: number,
  ): Promise<{ candidates: GCCandidate[]; inspected: number }> {
    const candidates: GCCandidate[] = [];
    const now = this.#now();
    let inspected = 0;
    const remaining = (): number | undefined => limit === undefined ? undefined : Math.max(0, limit - inspected);

    inspected += await this.#scanState("staging", errors, async (messageId) => {
      const envelope = await this.#store.readEnvelope("staging", messageId);
      if (envelope && now - envelope.createdAt > TTL_STAGING_MS) {
        candidates.push({ state: "staging", messageId, reason: "staging orphan exceeded retention" });
      }
    }, remaining());

    inspected += await this.#scanState("ready", errors, async (messageId) => {
      const envelope = await this.#store.readEnvelope("ready", messageId);
      if (envelope && now > envelope.expiresAt) {
        candidates.push({ state: "ready", messageId, reason: "message expired" });
      }
    }, remaining());

    inspected += await this.#scanTerminalState(
      "applied", TTL_RECEIPT_MS, "applied receipt exceeded retention", now, candidates, errors, remaining(),
    );
    inspected += await this.#scanTerminalState(
      "expired", TTL_DEAD_MS, "expired message exceeded retention", now, candidates, errors, remaining(),
    );
    inspected += await this.#scanTerminalState(
      "dead", TTL_DEAD_MS, "dead message exceeded retention", now, candidates, errors, remaining(),
    );

    return { candidates, inspected };
  }

  async #scanTerminalState(
    state: "applied" | "expired" | "dead",
    retentionMs: number,
    reason: string,
    now: number,
    candidates: GCCandidate[],
    errors?: string[],
    limit?: number,
  ): Promise<number> {
    return this.#scanState(state, errors, async (messageId) => {
      const record = await this.#store.readStateRecord(state, messageId);
      if (record && now - record.transitionedAt > retentionMs) candidates.push({ state, messageId, reason });
    }, limit);
  }

  async #scanState(
    state: MailboxState,
    errors: string[] | undefined,
    inspect: (messageId: string) => Promise<void>,
    limit?: number,
  ): Promise<number> {
    if (limit !== undefined && limit <= 0) return 0;
    try {
      const messageIds = await this.#store.listMessages(state, limit);
      for (const messageId of messageIds) {
        try {
          await inspect(messageId);
        } catch (error) {
          if (!errors) throw error;
          errors.push(`${state}/${messageId}: ${errorMessage(error)}`);
        }
      }
      return messageIds.length;
    } catch (error) {
      if (!errors) throw error;
      errors.push(`${state}: ${errorMessage(error)}`);
      return 0;
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
