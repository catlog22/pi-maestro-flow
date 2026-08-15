/**
 * The backend registry: load registered backends, validate their configuration
 * once, and resolve a backend per task.
 *
 * Registration is explicit configuration, never discovery by package-name
 * convention. A referenced backend that cannot be loaded is a hard failure, so
 * a deployment never silently runs on the default after a typo.
 */

import type {
  BackendCapabilities,
  ConfigValue,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type {
  BackendRegistryConfig,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { resolveBackendConfig } from "./config.ts";

/** Protocol version this registry speaks; a backend declaring another is rejected. */
const PROTOCOL_VERSION = 1;

/** Loads a module specifier into a backend instance. */
export type BackendLoader = (module: string) => Promise<unknown>;

/** A backend that passed loading, protocol, and configuration checks. */
interface RegisteredBackend {
  backend: TeammateBackend;
  config: Record<string, ConfigValue>;
}

/**
 * Narrow a loaded module to a backend.
 *
 * The module boundary is untyped, so the checks here are real validation rather
 * than redundant defence: a module may export anything, including a default
 * export that is not a backend at all.
 *
 * @param loaded - whatever the loader returned.
 * @returns the backend, or undefined when the module exports none.
 */
function asBackend(loaded: unknown): TeammateBackend | undefined {
  const candidate = (loaded as { default?: unknown })?.default ?? loaded;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const shape = candidate as Partial<TeammateBackend>;
  if (typeof shape.name !== "string") return undefined;
  if (typeof shape.start !== "function") return undefined;
  if (typeof shape.capabilities !== "object" || shape.capabilities === null) return undefined;
  return candidate as TeammateBackend;
}

/**
 * Registry over one registration document.
 *
 * Loading is lazy per backend but memoized: a backend named by several tasks is
 * imported and configuration-checked once.
 */
export class TeammateBackendRegistry {
  private readonly loaded = new Map<string, Promise<RegisteredBackend>>();

  /**
   * @param config - the registration document.
   * @param load - module loader; injected so tests and bundlers can supply their own.
   */
  constructor(
    private readonly config: BackendRegistryConfig,
    private readonly load: BackendLoader = (module) => import(module),
  ) {
    if (config.backends[config.default] === undefined) {
      const known = Object.keys(config.backends).join(", ");
      throw new Error(
        `teammate backend registry names "${config.default}" as its default, `
        + `but no such backend is registered (registered: ${known || "none"})`,
      );
    }
  }

  /** @returns every registered backend name. */
  listBackendNames(): string[] {
    return Object.keys(this.config.backends);
  }

  /** @returns the backend used by a task that names none. */
  defaultBackendName(): string {
    return this.config.default;
  }

  /**
   * Load and configure one backend.
   *
   * @param name - registered backend name.
   * @returns the backend with its resolved configuration.
   */
  private async registered(name: string): Promise<RegisteredBackend> {
    const memoized = this.loaded.get(name);
    if (memoized !== undefined) return memoized;

    const registration = this.config.backends[name];
    const task = (async (): Promise<RegisteredBackend> => {
      if (registration === undefined) {
        const known = this.listBackendNames().join(", ");
        throw new Error(`teammate backend "${name}" is not registered (registered: ${known || "none"})`);
      }

      let loaded: unknown;
      try {
        loaded = await this.load(registration.module);
      } catch (cause) {
        throw new Error(
          `teammate backend "${name}" could not be loaded from "${registration.module}"`,
          { cause },
        );
      }

      const backend = asBackend(loaded);
      if (backend === undefined) {
        throw new Error(
          `teammate backend "${name}" loaded from "${registration.module}" but exports no backend `
          + "(expected an object with name, capabilities, and start)",
        );
      }
      if (backend.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `teammate backend "${name}" implements protocol version ${String(backend.protocolVersion)}, `
          + `but this host speaks version ${PROTOCOL_VERSION}`,
        );
      }

      const resolved = resolveBackendConfig(backend, registration.config);
      if (resolved.errors.length > 0) {
        throw new Error(
          `teammate backend "${name}" is misconfigured:\n  - ${resolved.errors.join("\n  - ")}`,
        );
      }
      return { backend, config: resolved.values };
    })();

    this.loaded.set(name, task);
    return task;
  }

  /**
   * Resolve the backend serving one task.
   *
   * @param _spec - the run spec; reserved for routing rules that read it.
   * @param requestedBackend - an explicitly requested backend name.
   * @returns the backend plus its resolved configuration.
   */
  async resolve(_spec: TeammateRunSpec, requestedBackend?: string): Promise<ResolvedBackend> {
    const { backend, config } = await this.registered(requestedBackend ?? this.config.default);
    return { backend, config };
  }

  /**
   * @param backendName - registered backend name.
   * @returns that backend's declared capability table.
   */
  async capabilitiesOf(backendName: string): Promise<BackendCapabilities> {
    return (await this.registered(backendName)).backend.capabilities;
  }
}
