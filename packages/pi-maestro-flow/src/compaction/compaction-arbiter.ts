import type { CompactionThresholdReason } from "./compaction-threshold.ts";

export type CompactionRequestOwner = "mid-turn" | "plan-handoff" | "output-limit";
export type CompactionOwner = CompactionRequestOwner | "native";

/**
 * Durable, owner-typed trigger metadata for a hard compaction. Each owner
 * records only the facts it actually observed at the request site. Native
 * compaction carries no trigger: the extension did not initiate it, so it must
 * not fabricate one.
 */
export interface MidTurnCompactionTrigger {
  owner: "mid-turn";
  estimatedTokens: number;
  contextWindow: number;
  /** Effective trigger threshold: contextWindow - effectiveReserve. */
  effectiveThresholdTokens: number;
  /** Threshold implied by the configured reserve alone. */
  configuredThresholdTokens: number;
  effectiveReserveTokens: number;
  configuredReserveTokens: number;
  reason: CompactionThresholdReason;
}

export interface OutputLimitCompactionTrigger {
  owner: "output-limit";
  usageTokens: number | null;
  contextWindow: number;
  usagePercent: number | null;
  /** Context-usage ratio that gated the trigger. */
  gateRatio: number;
}

export interface PlanHandoffCompactionTrigger {
  owner: "plan-handoff";
  reason: string;
}

export type CompactionTrigger =
  | MidTurnCompactionTrigger
  | OutputLimitCompactionTrigger
  | PlanHandoffCompactionTrigger;

export type CompactionOutcome = "success" | "cancel" | "error" | "timeout";

export const COMPACTION_LEASE_TIMEOUT_MS = 5 * 60_000;

export interface CompactionLease {
  readonly owner: CompactionRequestOwner;
  readonly operationId: number;
  readonly trigger?: CompactionTrigger;
  tagInstructions(instructions: string): string;
  release(): void;
}

export interface CompactionRequest {
  owner: CompactionRequestOwner;
  id: number;
}

export interface ObservedCompaction {
  readonly operationId: number;
  readonly owner: CompactionOwner;
  readonly allowed: boolean;
  readonly trigger?: CompactionTrigger;
  finalize(outcome: CompactionOutcome): boolean;
  releaseIfNative(): void;
}

interface ActiveCompaction {
  id: number;
  owner: CompactionOwner;
  trigger?: CompactionTrigger;
  cleanup?: () => void;
}

/**
 * Session-local arbitration for extension-triggered compaction.
 *
 * Pi's native automatic and built-in manual compaction enter through
 * session_before_compact. They are observed, never replaced or cancelled.
 */
export class CompactionArbiter {
  private nextId = 0;
  private active?: ActiveCompaction;

  constructor(private readonly leaseTimeoutMs = COMPACTION_LEASE_TIMEOUT_MS) {}

  request(owner: CompactionRequestOwner, trigger?: CompactionTrigger): CompactionLease | undefined {
    if (this.active) return undefined;
    const id = ++this.nextId;
    this.active = { id, owner, trigger };
    return {
      owner,
      operationId: id,
      trigger,
      tagInstructions: (instructions) => tagCompactionInstructions({ owner, id }, instructions),
      release: () => this.finalize(id, "cancel"),
    };
  }

  observeStart(request?: CompactionRequest, signal?: AbortSignal): ObservedCompaction {
    // Pi-native compaction wins a race with an extension request. This preserves
    // both native automatic behavior and the built-in manual command semantics.
    if (!request && this.active && this.active.owner !== "native") {
      this.active.cleanup?.();
      this.active = undefined;
    }
    if (this.active) {
      const observed = this.active;
      const allowed = request !== undefined
        && observed.owner === request.owner
        && observed.id === request.id;
      // Extension-triggered compactions arrive without a cleanup/timeout.
      // Arm the same bounded deadline as native compactions only after the
      // matching request starts; a stale/mismatched observation must not
      // shorten the legitimate lease's lifetime.
      if (allowed && !observed.cleanup) {
        const release = () => this.finalize(observed.id, "timeout");
        const timeout = setTimeout(release, this.leaseTimeoutMs);
        timeout.unref?.();
        signal?.addEventListener("abort", release, { once: true });
        observed.cleanup = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", release);
        };
      }
      return {
        operationId: observed.id,
        owner: observed.owner,
        allowed,
        trigger: observed.trigger,
        finalize: (outcome) => this.finalize(observed.id, outcome),
        releaseIfNative: () => {
          if (observed.owner === "native") this.finalize(observed.id, "cancel");
        },
      };
    }
    if (request) {
      return {
        operationId: request.id,
        owner: request.owner,
        allowed: false,
        trigger: undefined,
        finalize: () => false,
        releaseIfNative() {},
      };
    }
    if (!this.active) {
      const id = ++this.nextId;
      const release = () => this.finalize(id, "timeout");
      this.active = {
        id,
        owner: "native",
      };
      const timeout = setTimeout(release, this.leaseTimeoutMs);
      timeout.unref?.();
      signal?.addEventListener("abort", release, { once: true });
      this.active.cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", release);
      };
    }
    const observed = this.active;
    return {
      operationId: observed.id,
      owner: observed.owner,
      allowed: true,
      trigger: observed.trigger,
      finalize: (outcome) => this.finalize(observed.id, outcome),
      releaseIfNative: () => {
        if (observed.owner === "native") this.finalize(observed.id, "cancel");
      },
    };
  }

  complete(outcome: CompactionOutcome = "success"): boolean {
    if (!this.active) return false;
    return this.finalize(this.active.id, outcome);
  }

  reset(): void {
    this.active?.cleanup?.();
    this.active = undefined;
    this.nextId++;
  }

  currentOwner(): CompactionOwner | undefined {
    return this.active?.owner;
  }

  currentOperationId(): number | undefined {
    return this.active?.id;
  }

  private finalize(id: number, _outcome: CompactionOutcome): boolean {
    if (this.active?.id !== id) return false;
    this.active.cleanup?.();
    this.active = undefined;
    return true;
  }
}

export async function runObservedCompaction<T>(
  observed: ObservedCompaction,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    observed.finalize("error");
    throw error;
  }
}

const OWNER_PREFIX = "[maestro-compaction-owner:";

function tagCompactionInstructions(request: CompactionRequest, instructions: string): string {
  return `${OWNER_PREFIX}${request.owner}:${request.id}]\n${instructions}`;
}

export function compactionRequestFromInstructions(
  instructions: string | undefined,
): CompactionRequest | undefined {
  const match = instructions?.match(/^\[maestro-compaction-owner:(mid-turn|plan-handoff|output-limit):(\d+)\]/);
  if (!match) return undefined;
  return {
    owner: match[1] as CompactionRequestOwner,
    id: Number(match[2]),
  };
}
