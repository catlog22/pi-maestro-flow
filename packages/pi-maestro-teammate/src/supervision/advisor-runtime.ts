import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const ADVISOR_RUNTIME_REGISTRY = Symbol.for("pi-maestro.advisor-runtime.v1");

export interface AdvisorRuntimeCandidate {
  id: string;
  priority: number;
  handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
  onOwnershipChanged?(owned: boolean): void;
}

export interface AdvisorRuntimeLease {
  isOwner(): boolean;
  release(): void;
}

interface RegisteredAdvisorRuntime extends AdvisorRuntimeCandidate {
  generation: number;
  order: number;
}

interface AdvisorRuntimeRegistryState {
  candidates: Map<string, RegisteredAdvisorRuntime>;
  commandHosts: WeakSet<object>;
  nextGeneration: number;
  nextOrder: number;
}

function registryState(): AdvisorRuntimeRegistryState {
  const host = globalThis as Record<symbol, AdvisorRuntimeRegistryState | undefined>;
  let state = host[ADVISOR_RUNTIME_REGISTRY];
  if (!state) {
    state = {
      candidates: new Map(),
      commandHosts: new WeakSet(),
      nextGeneration: 1,
      nextOrder: 1,
    };
    host[ADVISOR_RUNTIME_REGISTRY] = state;
  }
  return state;
}

function currentOwner(state = registryState()): RegisteredAdvisorRuntime | undefined {
  let owner: RegisteredAdvisorRuntime | undefined;
  for (const candidate of state.candidates.values()) {
    if (!owner
      || candidate.priority > owner.priority
      || (candidate.priority === owner.priority && candidate.order < owner.order)) {
      owner = candidate;
    }
  }
  return owner;
}

function sameRegistration(
  left: RegisteredAdvisorRuntime | undefined,
  right: RegisteredAdvisorRuntime | undefined,
): boolean {
  return left?.id === right?.id && left?.generation === right?.generation;
}

function notifyOwnership(candidate: RegisteredAdvisorRuntime | undefined, owned: boolean): void {
  if (!candidate?.onOwnershipChanged) return;
  try {
    candidate.onOwnershipChanged(owned);
  } catch {
    // Ownership arbitration must remain available even when one runtime's
    // best-effort lifecycle cleanup fails.
  }
}

export function registerAdvisorRuntime(candidate: AdvisorRuntimeCandidate): AdvisorRuntimeLease {
  const id = candidate.id.trim();
  if (!id) throw new Error("Advisor runtime id must be non-empty");
  if (!Number.isFinite(candidate.priority)) throw new Error("Advisor runtime priority must be finite");

  const state = registryState();
  const previousOwner = currentOwner(state);
  const previousRegistration = state.candidates.get(id);
  const registration: RegisteredAdvisorRuntime = {
    ...candidate,
    id,
    generation: state.nextGeneration++,
    order: previousRegistration?.order ?? state.nextOrder++,
  };
  state.candidates.set(id, registration);
  const nextOwner = currentOwner(state);

  const notified = new Set<RegisteredAdvisorRuntime>();
  const notifyOnce = (target: RegisteredAdvisorRuntime | undefined, owned: boolean) => {
    if (!target || notified.has(target)) return;
    notified.add(target);
    notifyOwnership(target, owned);
  };

  if (previousRegistration && !sameRegistration(previousRegistration, previousOwner)) {
    notifyOnce(previousRegistration, false);
  }
  if (!sameRegistration(previousOwner, nextOwner)) {
    notifyOnce(previousOwner, false);
    notifyOnce(nextOwner, true);
  }
  if (!sameRegistration(registration, nextOwner)) {
    notifyOnce(registration, false);
  }

  let released = false;
  return {
    isOwner() {
      if (released) return false;
      const active = state.candidates.get(id);
      return active?.generation === registration.generation
        && sameRegistration(currentOwner(state), registration);
    },
    release() {
      if (released) return;
      released = true;
      const active = state.candidates.get(id);
      if (active?.generation !== registration.generation) return;
      const ownerBeforeRelease = currentOwner(state);
      state.candidates.delete(id);
      const ownerAfterRelease = currentOwner(state);
      notifyOwnership(registration, false);
      if (!sameRegistration(ownerBeforeRelease, ownerAfterRelease)
        && !sameRegistration(registration, ownerAfterRelease)) {
        notifyOwnership(ownerAfterRelease, true);
      }
    },
  };
}

export function getAdvisorRuntimeOwner(): string | undefined {
  return currentOwner()?.id;
}

export function ensureAdvisorCommandRegistered(pi: ExtensionAPI): void {
  const state = registryState();
  const host = pi as object;
  if (state.commandHosts.has(host)) return;
  state.commandHosts.add(host);
  pi.registerCommand("advisor", {
    description: "Configure or inspect the active Advisor runtime",
    async handler(args, ctx) {
      const owner = currentOwner();
      if (!owner) {
        ctx.ui.notify("Advisor runtime is unavailable.", "warning");
        return;
      }
      await owner.handleCommand(args, ctx);
    },
  });
}
