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
  /** Recovery requests are fail-closed and must never enter Pi native summarization. */
  recovery?: "provider-pressure";
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

export function isProviderPressureCompactionTrigger(
  trigger: CompactionTrigger | undefined,
): trigger is MidTurnCompactionTrigger & { recovery: "provider-pressure" } {
  return trigger?.owner === "mid-turn" && trigger.recovery === "provider-pressure";
}

export type CompactionOutcome = "success" | "cancel" | "error" | "timeout";

export const COMPACTION_LEASE_TIMEOUT_MS = 5 * 60_000;
/**
 * Marks an unowned fallback request so completed-turn threshold preservation
 * cannot cancel the only recovery path for an already aborted user request.
 * It deliberately does not use the owner-tag grammar: the arbiter still
 * observes it as a native request.
 */
export const NATIVE_FALLBACK_COMPACTION_MARKER = "[maestro-native-fallback]";

/** True only when the fallback marker is the leading instruction token. */
export function isNativeFallbackCompactionInstructions(
  customInstructions: string | undefined,
): boolean {
  return customInstructions?.trimStart().startsWith(NATIVE_FALLBACK_COMPACTION_MARKER) === true;
}

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
 * session_before_compact and participate in the same arbitration. The extension
 * may replace their summary through its session_before_compact handler, while
 * the completed-turn threshold policy may cancel a native threshold request to
 * preserve an active transcript. Native starts still win an in-flight race with
 * an extension request.
 */
export class CompactionArbiter {
  private nextId = 0;
  private active?: ActiveCompaction;
  /**
   * Set when a lease expires by wall-clock timeout. Unlike an abort, a timeout
   * gives no proof the in-flight compaction died — there is no API to abort it
   * — so extension submissions are held until a session_compact proves a
   * settlement or a second lease period elapses. Native requests always
   * proceed: Pi serializes its own compactions, and overflow recovery must
   * never be blocked.
   */
  private timedOutAt?: number;

  constructor(private readonly leaseTimeoutMs = COMPACTION_LEASE_TIMEOUT_MS) {}

  /** Live tombstone info for diagnostics, or undefined when none is active. */
  timeoutTombstone(): { sinceMs: number; remainingMs: number } | undefined {
    if (this.timedOutAt === undefined) return undefined;
    const remainingMs = this.leaseTimeoutMs - (Date.now() - this.timedOutAt);
    if (remainingMs <= 0) {
      // A second full lease period elapsed; whatever was hung either settled
      // or died with its provider request. Stop holding submissions.
      this.timedOutAt = undefined;
      return undefined;
    }
    return { sinceMs: this.timedOutAt, remainingMs };
  }

  request(owner: CompactionRequestOwner, trigger?: CompactionTrigger): CompactionLease | undefined {
    if (this.active) return undefined;
    if (this.timeoutTombstone()) return undefined;
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
    if (request && this.timeoutTombstone()) {
      // A timed-out compaction may still be alive; hold extension submissions
      // until a settlement is observed or the tombstone expires.
      return {
        operationId: request.id,
        owner: request.owner,
        allowed: false,
        trigger: undefined,
        finalize: () => false,
        releaseIfNative() {},
      };
    }
    if (this.active) {
      const observed = this.active;
      const allowed = request !== undefined
        && observed.owner === request.owner
        && observed.id === request.id;
      // Extension-triggered compactions arrive without a cleanup/timeout.
      // Arm the same bounded deadline as native compactions only after the
      // matching request starts; a stale/mismatched observation must not
      // shorten the legitimate lease's lifetime. Abort means the host proved
      // the compaction dead (cancel, no tombstone); a wall-clock expiry does
      // not (timeout, tombstone).
      if (allowed && !observed.cleanup) {
        const expire = () => this.finalize(observed.id, "timeout");
        const onAbort = () => this.finalize(observed.id, "cancel");
        const timeout = setTimeout(expire, this.leaseTimeoutMs);
        timeout.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        observed.cleanup = () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
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
      const expire = () => this.finalize(id, "timeout");
      const onAbort = () => this.finalize(id, "cancel");
      this.active = {
        id,
        owner: "native",
      };
      const timeout = setTimeout(expire, this.leaseTimeoutMs);
      timeout.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.active.cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
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
    // A completed compaction proves the in-flight work settled; any timeout
    // tombstone is obsolete regardless of whether a lease is still active.
    this.timedOutAt = undefined;
    if (!this.active) return false;
    return this.finalize(this.active.id, outcome);
  }

  reset(): void {
    this.active?.cleanup?.();
    this.active = undefined;
    this.timedOutAt = undefined;
    this.nextId++;
  }

  currentOwner(): CompactionOwner | undefined {
    return this.active?.owner;
  }

  currentOperationId(): number | undefined {
    return this.active?.id;
  }

  private finalize(id: number, outcome: CompactionOutcome): boolean {
    if (this.active?.id !== id) return false;
    this.active.cleanup?.();
    this.active = undefined;
    if (outcome === "timeout") this.timedOutAt = Date.now();
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
