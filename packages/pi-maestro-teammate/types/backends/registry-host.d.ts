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
export declare function backendRegistryConfigSync(workspaceRoot: string): BackendRegistryConfig;
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
export declare function dispatchRegistrySync(workspaceRoot: string, extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras, remoteManagerOf?: () => RemoteManagerPort): TeammateBackendRegistry | undefined;
/** Forget synchronously cached documents so an operator edit takes effect. */
export declare function forgetBackendRegistryConfigSync(workspaceRoot?: string): void;
