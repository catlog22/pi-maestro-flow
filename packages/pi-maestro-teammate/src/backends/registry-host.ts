/**
 * Host-side backend registry construction.
 *
 * Decides whether a dispatch consults the registry at all, and supplies the
 * loader that resolves `pi-subprocess` to the in-process implementation instead
 * of importing it by module specifier.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BackendRegistryConfig,
  TeammateExecutionMode,
} from "pi-maestro-backend-core/v1/registry";

import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { TeammateBackendRegistry } from "pi-maestro-backends";
import { createPiSubprocessBackend, type PiSubprocessRunExtras } from "./pi-subprocess.ts";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";

/** Registration document read from the project, relative to the workspace root. */
const REGISTRY_FILE = join(".pi", "teammate-backends.json");

/** Name under which Pi registers itself; it holds no privilege beyond the name. */
export const PI_SUBPROCESS = "pi-subprocess";

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
const MODES: readonly TeammateExecutionMode[] = ["legacy", "backend-registry"];

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

/** Synchronously resolved documents, keyed by workspace root. */
const syncDocuments = new Map<string, BackendRegistryConfig>();

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
 * Resolve the registry a dispatch should use, without an awaited read.
 *
 * @param workspaceRoot - directory holding `.pi/`.
 * @param extrasOf - per-run host wiring handed to the Pi backend.
 * @returns the registry, or undefined when the document keeps the legacy path.
 */
export function dispatchRegistrySync(
  workspaceRoot: string,
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
): TeammateBackendRegistry | undefined {
  const config = backendRegistryConfigSync(workspaceRoot);
  if ((config.mode ?? "legacy") === "legacy") return undefined;
  return new TeammateBackendRegistry(config, backendLoader(extrasOf));
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
 * @returns the loader.
 */
function backendLoader(
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
): (module: string) => Promise<unknown> {
  // Pi is in this process already; importing it by specifier would load a
  // second copy with its own module state.
  const pi = createPiSubprocessBackend(extrasOf);
  return async (module) => (module === PI_SUBPROCESS ? pi : await import(module));
}

/** Forget synchronously cached documents so an operator edit takes effect. */
export function forgetBackendRegistryConfigSync(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) syncDocuments.clear();
  else syncDocuments.delete(workspaceRoot);
}
