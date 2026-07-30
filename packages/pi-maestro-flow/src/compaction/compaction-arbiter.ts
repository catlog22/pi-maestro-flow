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

export interface CompactionLease {
  readonly owner: CompactionRequestOwner;
  readonly trigger?: CompactionTrigger;
  tagInstructions(instructions: string): string;
  release(): void;
}

export interface CompactionRequest {
  owner: CompactionRequestOwner;
  id: number;
}

export interface ObservedCompaction {
  readonly owner: CompactionOwner;
  readonly allowed: boolean;
  readonly trigger?: CompactionTrigger;
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

  request(owner: CompactionRequestOwner, trigger?: CompactionTrigger): CompactionLease | undefined {
    if (this.active) return undefined;
    const id = ++this.nextId;
    this.active = { id, owner, trigger };
    return {
      owner,
      trigger,
      tagInstructions: (instructions) => tagCompactionInstructions({ owner, id }, instructions),
      release: () => this.release(id),
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
      return {
        owner: observed.owner,
        allowed: request !== undefined
          && observed.owner === request.owner
          && observed.id === request.id,
        trigger: observed.trigger,
        releaseIfNative: () => {
          if (observed.owner === "native") this.release(observed.id);
        },
      };
    }
    if (request) {
      return {
        owner: request.owner,
        allowed: false,
        trigger: undefined,
        releaseIfNative() {},
      };
    }
    if (!this.active) {
      const id = ++this.nextId;
      const release = () => this.release(id);
      this.active = {
        id,
        owner: "native",
      };
      const timeout = setTimeout(release, 5 * 60_000);
      timeout.unref?.();
      signal?.addEventListener("abort", release, { once: true });
      this.active.cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", release);
      };
    }
    const observed = this.active;
    return {
      owner: observed.owner,
      allowed: true,
      trigger: observed.trigger,
      releaseIfNative: () => {
        if (observed.owner === "native") this.release(observed.id);
      },
    };
  }

  complete(): void {
    this.active?.cleanup?.();
    this.active = undefined;
  }

  reset(): void {
    this.active?.cleanup?.();
    this.active = undefined;
    this.nextId++;
  }

  currentOwner(): CompactionOwner | undefined {
    return this.active?.owner;
  }

  private release(id: number): void {
    if (this.active?.id !== id) return;
    this.active.cleanup?.();
    this.active = undefined;
  }
}

export async function runObservedCompaction<T>(
  observed: ObservedCompaction,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    observed.releaseIfNative();
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
