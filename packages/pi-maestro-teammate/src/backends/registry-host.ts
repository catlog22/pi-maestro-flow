/**
 * Host-side backend registry construction.
 *
 * Decides whether a dispatch consults the registry at all, and supplies the
 * loader that resolves `pi-subprocess` to the in-process implementation instead
 * of importing it by module specifier.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BackendRegistryConfig,
  TeammateExecutionMode,
} from "pi-maestro-backend-core/v1/registry";

import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { TeammateBackendRegistry } from "pi-maestro-backends";
import { createRemoteBackend } from "pi-maestro-backends/remote";
import type { RemoteWorkerManagerLike as RemoteManagerPort } from "pi-maestro-backends/remote";
import { loadCliToolsConfigProjection, type CliToolsConfig } from "../cli-tools/cli-tools-config.ts";
import type { AvailableModelEntry } from "../models/model-catalog.ts";
import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
  type CompiledModelRegistryPair,
  type ProjectionIdentity,
} from "../models/model-registry.ts";
import { createPiSubprocessBackend, type PiSubprocessRunExtras } from "./pi-subprocess.ts";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";

/** Registration document read from the project, relative to the workspace root. */
const REGISTRY_FILE = join(".pi", "teammate-backends.json");

/** Name under which Pi registers itself; it holds no privilege beyond the name. */
export const PI_SUBPROCESS = "pi-subprocess";

/**
 * Module name a remote-target registration names.
 *
 * One registration per target, conventionally named `remote:<targetId>`, all
 * resolving to this one module: the target is a config field, not a module.
 */
export const REMOTE_WORKERS = "remote-workers";

/**
 * The registration used when the project ships no document.
 *
 * Pi alone, under its ordinary name. A deployment that opts into the registry
 * without configuring anything therefore gets the same execution it had before,
 * routed through the interface rather than around it.
 */
const BUILT_IN: BackendRegistryConfig = {
  mode: "legacy",
  default: PI_SUBPROCESS,
  backends: { [PI_SUBPROCESS]: { module: PI_SUBPROCESS } },
};

/** The modes a document may name; anything else is a load-time error. */
const MODES: readonly TeammateExecutionMode[] = ["legacy", "backend-registry", "model-registry"];

/**
 * Validate one registration document.
 *
 * Shared by the async and synchronous readers so a rule can never hold on one
 * path and not the other.
 *
 * @param raw - the document text.
 * @param path - the document path, for diagnostics that must name it.
 * @returns the validated document with the built-in registration merged in.
 */
function parseBackendRegistryDocument(raw: string, path: string): BackendRegistryConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`teammate backend registry at ${path} is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`teammate backend registry at ${path} must contain a JSON object`);
  }

  const rawDocument = parsed as Record<string, unknown>;
  if (rawDocument.mode === "model-registry") {
    const manifest = parseModelRegistryManifest(raw, path);
    return {
      mode: manifest.mode,
      default: manifest.default,
      backends: manifest.backends,
    };
  }

  const document = parsed as Partial<BackendRegistryConfig>;
  if (document.mode !== undefined && !MODES.includes(document.mode)) {
    throw new Error(
      `teammate backend registry at ${path} names mode "${String(document.mode)}"; `
      + `expected one of ${MODES.join(" | ")}`,
    );
  }
  if (typeof document.default !== "string") {
    throw new Error(`teammate backend registry at ${path} must name a "default" backend`);
  }
  if (typeof document.backends !== "object" || document.backends === null || Array.isArray(document.backends)) {
    throw new Error(`teammate backend registry at ${path} must map "backends" to registrations`);
  }
  // Each entry must name a loadable module; an entry without one reaches the
  // loader as import(undefined) and fails with a message about "undefined"
  // rather than about the entry the operator wrote.
  for (const [name, registration] of Object.entries(document.backends)) {
    if (typeof registration !== "object" || registration === null || Array.isArray(registration)) {
      throw new Error(`teammate backend registry at ${path}: registration "${name}" must be an object`);
    }
    if (typeof (registration as { module?: unknown }).module !== "string") {
      throw new Error(`teammate backend registry at ${path}: registration "${name}" must name a "module"`);
    }
  }
  // The built-in stays registered unless the document redefines it, so a
  // document that only adds a remote backend does not lose Pi.
  return {
    mode: document.mode ?? "legacy",
    default: document.default,
    backends: { ...BUILT_IN.backends, ...document.backends },
  };
}

/** Synchronously resolved legacy/backend documents, keyed by workspace root. */
const syncDocuments = new Map<string, BackendRegistryConfig>();

/** Atomically published v2 projection pairs, keyed by workspace root. */
const modelRegistryPairs = new Map<string, CompiledModelRegistryPair>();
/** Last successfully published identity survives invalidation to keep revisions monotonic. */
const modelRegistryGenerations = new Map<string, ProjectionIdentity>();

function modeGenerationHash(mode: string): string {
  return createHash("sha256").update(`<mode:${mode}>`, "utf8").digest("hex");
}

export interface ModelRegistryProjectionInputs {
  /** Authenticated models currently visible to the host Pi registry. */
  hostModels?: readonly AvailableModelEntry[];
  /** Effective CLI overlay; null explicitly means no overlay. */
  cliToolsConfig?: CliToolsConfig | null;
  /** Test/embedding override for the global CLI overlay path. */
  cliToolsGlobalFilePath?: string;
}

/**
 * Read the registration document synchronously, reusing an earlier read.
 *
 * Synchronous on purpose. Dispatch resolves the registry immediately before
 * spawning, and inserting an awaited read there delays the child by an I/O tick
 * — enough to break callers that address the child's stdin as soon as dispatch
 * returns. The file is small deployment configuration read once per root, in a
 * path that already performs synchronous file work.
 *
 * @param workspaceRoot - directory holding `.pi/`.
 * @returns the registration document.
 */
export function backendRegistryConfigSync(workspaceRoot: string): BackendRegistryConfig {
  const hit = syncDocuments.get(workspaceRoot);
  if (hit !== undefined) return hit;
  const path = join(workspaceRoot, REGISTRY_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      syncDocuments.set(workspaceRoot, BUILT_IN);
      return BUILT_IN;
    }
    throw new Error(`teammate backend registry at ${path} could not be read`, { cause });
  }
  const config = parseBackendRegistryDocument(raw, path);
  syncDocuments.set(workspaceRoot, config);
  return config;
}

/**
 * Read and atomically publish an opted-in model-registry projection pair.
 *
 * Unlike the frozen 2.0 backend reader, this path fingerprints its semantic
 * inputs on every call. A hand edit therefore takes effect before the next
 * prompt or dispatch without changing legacy cache behavior. Compilation is
 * completed into a local pair first; only then is the workspace publication
 * swapped. Any changed invalid input removes the publication, so callers can
 * never fall back to a prior valid discovery or dispatch projection.
 */
export function modelRegistryPairSync(
  workspaceRoot: string,
  inputs: ModelRegistryProjectionInputs = {},
): CompiledModelRegistryPair | undefined {
  // The 2.0 reader is deliberately read-once per workspace. A catalog refresh
  // must not bypass that boundary and activate an edit from legacy or
  // backend-registry into model-registry. Explicit invalidation removes this
  // cached authority; once model-registry is authoritative, the reads below
  // remain revision-aware until they observe a rollback to an older mode.
  const cachedConfig = syncDocuments.get(workspaceRoot);
  if (cachedConfig !== undefined && cachedConfig.mode !== "model-registry") {
    return undefined;
  }
  if (cachedConfig === undefined
    && backendRegistryConfigSync(workspaceRoot).mode !== "model-registry") {
    return undefined;
  }

  const path = join(workspaceRoot, REGISTRY_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (cause) {
    modelRegistryPairs.delete(workspaceRoot);
    syncDocuments.delete(workspaceRoot);
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      const previous = modelRegistryGenerations.get(workspaceRoot);
      if (previous !== undefined) {
        modelRegistryGenerations.set(workspaceRoot, {
          revision: previous.revision,
          hash: modeGenerationHash("missing"),
        });
      }
      return undefined;
    }
    throw new Error(`teammate backend registry at ${path} could not be read`, { cause });
  }

  try {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // Use the shared parser for the canonical path-bearing diagnostic.
      parseBackendRegistryDocument(raw, path);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      parseBackendRegistryDocument(raw, path);
    }
    if ((envelope as { mode?: unknown }).mode !== "model-registry") {
      // Preserve the exact legacy/backend-registry parser and validation path.
      const legacyConfig = parseBackendRegistryDocument(raw, path);
      modelRegistryPairs.delete(workspaceRoot);
      syncDocuments.set(workspaceRoot, legacyConfig);
      const previous = modelRegistryGenerations.get(workspaceRoot);
      const modeHash = modeGenerationHash(legacyConfig.mode ?? "legacy");
      if (previous !== undefined && previous.hash !== modeHash) {
        modelRegistryGenerations.set(workspaceRoot, {
          revision: previous.revision,
          hash: modeHash,
        });
      }
      return undefined;
    }

    const manifest = parseModelRegistryManifest(raw, path);
    let cliToolsConfig: CliToolsConfig | null = null;
    const projectionDiagnostics: string[] = [];
    if (Object.hasOwn(inputs, "cliToolsConfig")) {
      cliToolsConfig = inputs.cliToolsConfig ?? null;
    } else if (manifest.compatibility?.teammateCliToolsProjection?.enabled === true) {
      try {
        cliToolsConfig = loadCliToolsConfigProjection(workspaceRoot, inputs.cliToolsGlobalFilePath);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        projectionDiagnostics.push(`CLI compatibility projection is unavailable: ${message}`);
      }
    }
    const compiled = compileModelRegistryManifest(manifest, {
      hostModels: inputs.hostModels ?? [],
      cliToolsConfig,
      diagnostics: projectionDiagnostics,
      previousIdentity: modelRegistryGenerations.get(workspaceRoot),
    });
    const published = modelRegistryPairs.get(workspaceRoot);
    const backendConfig: BackendRegistryConfig = {
      mode: manifest.mode,
      default: manifest.default,
      backends: manifest.backends,
    };
    if (published?.dispatch.hash === compiled.dispatch.hash) {
      syncDocuments.set(workspaceRoot, backendConfig);
      return published;
    }

    // These synchronous assignments form one publication boundary: no caller
    // can observe the pair between them, and both are ready before this returns.
    syncDocuments.set(workspaceRoot, backendConfig);
    modelRegistryPairs.set(workspaceRoot, compiled);
    modelRegistryGenerations.set(workspaceRoot, {
      revision: compiled.dispatch.revision,
      hash: compiled.dispatch.hash,
    });
    return compiled;
  } catch (cause) {
    modelRegistryPairs.delete(workspaceRoot);
    syncDocuments.delete(workspaceRoot);
    throw cause;
  }
}

/** Return the currently published pair without reading or compiling sources. */
export function publishedModelRegistryPairSync(workspaceRoot: string): CompiledModelRegistryPair | undefined {
  return modelRegistryPairs.get(workspaceRoot);
}

/**
 * Build a backend registry from one already-captured dispatch authority.
 * Callers use this for the whole dispatch so a registry edit cannot split a
 * candidate sweep across two model/deployment projections.
 */
export function dispatchRegistryForProjectionSync(
  projection: CompiledModelRegistryPair["dispatch"],
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
  remoteManagerOf?: () => RemoteManagerPort,
): TeammateBackendRegistry {
  const backends = Object.create(null) as BackendRegistryConfig["backends"];
  for (const [deploymentId, deployment] of projection.deploymentsById) {
    backends[deploymentId] = deployment.registration;
  }
  return new TeammateBackendRegistry({
    mode: "model-registry",
    default: projection.defaultDeployment,
    backends,
  }, backendLoader(extrasOf, remoteManagerOf));
}

/**
 * Resolve the registry a dispatch should use, without an awaited read.
 *
 * @param workspaceRoot - directory holding `.pi/`.
 * @param extrasOf - per-run host wiring handed to the Pi backend.
 * @param remoteManagerOf - the host's remote Monitor wiring; omitted by a
 * dispatch that has none, which makes a remote registration unloadable rather
 * than silently local.
 * @returns the registry, or undefined when the document keeps the legacy path.
 */
export function dispatchRegistrySync(
  workspaceRoot: string,
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
  remoteManagerOf?: () => RemoteManagerPort,
): TeammateBackendRegistry | undefined {
  let config = backendRegistryConfigSync(workspaceRoot);
  if (config.mode === "model-registry") {
    const pair = modelRegistryPairSync(workspaceRoot);
    if (pair === undefined) {
      // The revision-aware read may have observed a rollback to a 2.0 mode.
      config = backendRegistryConfigSync(workspaceRoot);
    } else {
      return dispatchRegistryForProjectionSync(pair.dispatch, extrasOf, remoteManagerOf);
    }
  }
  if ((config.mode ?? "legacy") === "legacy") return undefined;
  return new TeammateBackendRegistry(config, backendLoader(extrasOf, remoteManagerOf));
}

/**
 * Resolve a registration's module to something the registry can narrow.
 *
 * The return type is `unknown` rather than `TeammateBackend`: a module
 * namespace is not a backend, and asserting that it is defeats the registry's
 * own check — which is exactly how a backend with no default export came to be
 * unregisterable while the loader compiled cleanly.
 *
 * @param extrasOf - per-run host wiring handed to the Pi backend.
 * @param remoteManagerOf - the host's remote Monitor wiring, when it has any.
 * @returns the loader.
 */
function backendLoader(
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
  remoteManagerOf?: () => RemoteManagerPort,
): (module: string) => Promise<unknown> {
  // Pi is in this process already; importing it by specifier would load a
  // second copy with its own module state.
  const pi = createPiSubprocessBackend(extrasOf);
  return async (module) => {
    if (module === PI_SUBPROCESS) return pi;
    if (module === REMOTE_WORKERS) {
      // Same reason Pi resolves in-process, one step stronger: a second
      // `RemoteWorkerManager` would open a second SSH connection under a second
      // ownership nonce, and every run dispatched through it would be invisible
      // to `observe kind=remote` and `teammate-list view=remote`. A dispatch
      // without the wiring is refused by name rather than served by a stand-in.
      if (remoteManagerOf === undefined) {
        throw new Error(
          `teammate backend module "${REMOTE_WORKERS}" needs the host's remote Monitor wiring, `
          + "but this dispatch supplied no remote Monitor wiring; "
          + "remote locations are dispatchable only from a root session running Monitor mode",
        );
      }
      return createRemoteBackend(remoteManagerOf);
    }
    return await import(module);
  };
}

/** Forget cached documents and published pairs so an operator edit takes effect. */
export function forgetBackendRegistryConfigSync(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    syncDocuments.clear();
    modelRegistryPairs.clear();
  } else {
    syncDocuments.delete(workspaceRoot);
    modelRegistryPairs.delete(workspaceRoot);
  }
}
