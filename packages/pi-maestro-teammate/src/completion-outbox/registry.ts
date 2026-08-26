import {

  COMPLETION_DURABILITY_REGISTRY_KEY,
  type CompletionDurabilityProvider,
  type CompletionDurabilityRegistry,
  type CompletionDurabilityRegistryListener,
  type CompletionDurabilityRegistrySnapshot,
} from "../public/v1/completion-durability.ts";
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";

interface RegistryHost {
  [key: symbol]: unknown;
}

export class CompletionDurabilityRegistryImpl implements CompletionDurabilityRegistry {
  #provider: CompletionDurabilityProvider | undefined;
  #generation = 0;
  readonly #listeners = new Set<CompletionDurabilityRegistryListener>();
  readonly #dispatchPins = new Map<string, {
    provider: CompletionDurabilityProvider;
    owners: Set<symbol>;
  }>();

  current(): CompletionDurabilityProvider | undefined {
    return this.#provider;
  }

  snapshot(): CompletionDurabilityRegistrySnapshot {
    return Object.freeze({
      generation: this.#generation,
      ...(this.#provider ? { provider: this.#provider } : {}),
    });
  }

  providerForDispatch(dispatchId: string): CompletionDurabilityProvider | undefined {
    return this.#dispatchPins.get(dispatchId)?.provider;
  }

  pinDispatch(dispatchId: string, provider: CompletionDurabilityProvider): () => void {
    if (!dispatchId) throw new TypeError("Completion dispatchId must be non-empty.");
    const owner = Symbol(dispatchId);
    const current = this.#dispatchPins.get(dispatchId);
    if (current && current.provider !== provider) {
      throw new Error(`Completion dispatch ${dispatchId} is already pinned to another provider generation.`);
    }
    const pin = current ?? { provider, owners: new Set<symbol>() };
    pin.owners.add(owner);
    this.#dispatchPins.set(dispatchId, pin);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.#dispatchPins.get(dispatchId);
      if (!active || active.provider !== provider || !active.owners.delete(owner)) return;
      if (active.owners.size === 0) this.#dispatchPins.delete(dispatchId);
    };
  }

  register(provider: CompletionDurabilityProvider): () => void {
    if (!provider || typeof provider !== "object") {
      throw new TypeError("Completion durability provider must be an object.");
    }
    this.#provider = provider;
    this.#generation += 1;
    this.#notify();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#provider !== provider) return;
      this.#provider = undefined;
      this.#generation += 1;
      this.#notify();
    };
  }

  subscribe(listener: CompletionDurabilityRegistryListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        logDiagnosticError("[pi-maestro-teammate] completion durability registry listener failed:", error);
      }
    }
  }
}

export function getCompletionDurabilityRegistry(
  root: object = globalThis,
): CompletionDurabilityRegistry {
  const host = root as RegistryHost;
  const existing = host[COMPLETION_DURABILITY_REGISTRY_KEY];
  if (existing && typeof existing === "object"
    && "current" in existing
    && "providerForDispatch" in existing
    && "pinDispatch" in existing
    && "register" in existing
    && "subscribe" in existing) {
    return existing as CompletionDurabilityRegistry;
  }
  const registry = new CompletionDurabilityRegistryImpl();
  host[COMPLETION_DURABILITY_REGISTRY_KEY] = registry;
  return registry;
}
