/**
 * Host-side backend registry construction.
 *
 * Decides whether a dispatch consults the registry at all, and supplies the
 * loader that resolves `pi-subprocess` to the in-process implementation instead
 * of importing it by module specifier.
 */
import type { BackendRegistryConfig } from "pi-maestro-backend-core/v1/registry";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { TeammateBackendRegistry } from "pi-maestro-backends";
import type { RemoteWorkerManagerLike as RemoteManagerPort } from "pi-maestro-backends/remote";
import { type PiSubprocessRunExtras } from "./pi-subprocess.ts";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
/** Global registration document under Pi's configured agent directory. */
export declare function getGlobalBackendRegistryPath(): string;
/** Project registration document relative to the workspace root. */
export declare function getProjectBackendRegistryPath(workspaceRoot: string): string;
/** Name under which Pi registers itself; it holds no privilege beyond the name. */
export declare const PI_SUBPROCESS = "pi-subprocess";
/**
 * Module name a remote-target registration names.
 *
 * One registration per target, conventionally named `remote:<targetId>`, all
 * resolving to this one module: the target is a config field, not a module.
 */
export declare const REMOTE_WORKERS = "remote-workers";
/**
 * Read the effective registration document synchronously, reusing an earlier read.
 *
 * A project document is an explicit per-workspace decision and therefore wins
 * as a whole. When it is absent, the global document under Pi's agent directory
 * applies. Mixing their `mode` or `default` fields would create a registry that
 * appears in neither file, so this is precedence rather than field merging.
 *
 * Synchronous on purpose. Dispatch resolves the registry immediately before
 * spawning, and inserting an awaited read there delays the child by an I/O tick
 * — enough to break callers that address its stdin as soon as dispatch returns.
 *
 * @param workspaceRoot - directory holding the project's `.pi/`.
 * @param globalFilePath - global document path; injectable for isolated tests.
 * @returns the project document, global fallback, or built-in legacy config.
 */
export declare function backendRegistryConfigSync(workspaceRoot: string, globalFilePath?: string): BackendRegistryConfig;
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
export declare function dispatchRegistrySync(workspaceRoot: string, extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras, remoteManagerOf?: () => RemoteManagerPort, globalFilePath?: string): TeammateBackendRegistry | undefined;
/** Forget synchronously cached documents so an operator edit takes effect. */
export declare function forgetBackendRegistryConfigSync(workspaceRoot?: string): void;
