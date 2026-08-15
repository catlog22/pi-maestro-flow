/**
 * Host-side backend registry construction.
 *
 * Decides whether a dispatch consults the registry at all, and supplies the
 * loader that resolves `pi-subprocess` to the in-process implementation instead
 * of importing it by module specifier.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BackendRegistryConfig,
  TeammateExecutionMode,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateBackend } from "pi-maestro-backend-core/v1/backend";
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
  default: PI_SUBPROCESS,
  backends: { [PI_SUBPROCESS]: { module: PI_SUBPROCESS } },
};

/**
 * Read the project's registration document.
 *
 * A missing file is the documented default, not a failure. Malformed JSON is a
 * failure: silently running the built-in registration would hide a document the
 * operator believes is in effect.
 *
 * @param workspaceRoot - directory holding `.pi/`.
 * @returns the registration document, or the built-in one when none exists.
 */
export async function readBackendRegistryConfig(
  workspaceRoot: string,
): Promise<BackendRegistryConfig> {
  const path = join(workspaceRoot, REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return BUILT_IN;
    throw new Error(`teammate backend registry at ${path} could not be read`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`teammate backend registry at ${path} is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`teammate backend registry at ${path} must contain a JSON object`);
  }

  const document = parsed as Partial<BackendRegistryConfig>;
  if (typeof document.default !== "string") {
    throw new Error(`teammate backend registry at ${path} must name a "default" backend`);
  }
  if (typeof document.backends !== "object" || document.backends === null) {
    throw new Error(`teammate backend registry at ${path} must map "backends" to registrations`);
  }
  // The built-in stays registered unless the document redefines it, so a
  // document that only adds a remote backend does not lose Pi.
  return {
    default: document.default,
    backends: { ...BUILT_IN.backends, ...document.backends },
  };
}

/**
 * Build the registry for one dispatch.
 *
 * @param mode - the configured execution mode.
 * @param workspaceRoot - directory holding `.pi/`.
 * @param extrasOf - per-run host wiring handed to the Pi backend.
 * @returns the registry, or undefined when the mode keeps the legacy path.
 */
export async function createTeammateBackendRegistry(
  mode: TeammateExecutionMode,
  workspaceRoot: string,
  extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras,
): Promise<TeammateBackendRegistry | undefined> {
  if (mode === "legacy") return undefined;
  const config = await readBackendRegistryConfig(workspaceRoot);
  const pi = createPiSubprocessBackend(extrasOf);
  return new TeammateBackendRegistry(config, async (module): Promise<TeammateBackend> => {
    // Pi is in this process already; importing it by specifier would load a
    // second copy with its own module state.
    if (module === PI_SUBPROCESS) return pi;
    return (await import(module)) as TeammateBackend;
  });
}
