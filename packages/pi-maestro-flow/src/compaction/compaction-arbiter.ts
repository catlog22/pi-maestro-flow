export type CompactionRequestOwner = "mid-turn" | "plan-handoff";
export type CompactionOwner = CompactionRequestOwner | "native";

export interface CompactionLease {
  readonly owner: CompactionRequestOwner;
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
  releaseIfNative(): void;
}

interface ActiveCompaction {
  id: number;
  owner: CompactionOwner;
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

  request(owner: CompactionRequestOwner): CompactionLease | undefined {
    if (this.active) return undefined;
    const id = ++this.nextId;
    this.active = { id, owner };
    return {
      owner,
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
        releaseIfNative: () => {
          if (observed.owner === "native") this.release(observed.id);
        },
      };
    }
    if (request) {
      return {
        owner: request.owner,
        allowed: false,
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

const OWNER_PREFIX = "[maestro-compaction-owner:";

function tagCompactionInstructions(request: CompactionRequest, instructions: string): string {
  return `${OWNER_PREFIX}${request.owner}:${request.id}]\n${instructions}`;
}

export function compactionRequestFromInstructions(
  instructions: string | undefined,
): CompactionRequest | undefined {
  const match = instructions?.match(/^\[maestro-compaction-owner:(mid-turn|plan-handoff):(\d+)\]/);
  if (!match) return undefined;
  return {
    owner: match[1] as CompactionRequestOwner,
    id: Number(match[2]),
  };
}
