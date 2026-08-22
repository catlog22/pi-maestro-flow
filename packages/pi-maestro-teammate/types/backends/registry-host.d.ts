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
import { type CliToolsConfig } from "../cli-tools/cli-tools-config.ts";
import type { AvailableModelEntry } from "../models/model-catalog.ts";
import { type CompiledModelRegistryPair } from "../models/model-registry.ts";
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
export declare function backendRegistryConfigSync(workspaceRoot: string): BackendRegistryConfig;
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
export declare function modelRegistryPairSync(workspaceRoot: string, inputs?: ModelRegistryProjectionInputs): CompiledModelRegistryPair | undefined;
/** Return the currently published pair without reading or compiling sources. */
export declare function publishedModelRegistryPairSync(workspaceRoot: string): CompiledModelRegistryPair | undefined;
/**
 * Build a backend registry from one already-captured dispatch authority.
 * Callers use this for the whole dispatch so a registry edit cannot split a
 * candidate sweep across two model/deployment projections.
 */
export declare function dispatchRegistryForProjectionSync(projection: CompiledModelRegistryPair["dispatch"], extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras, remoteManagerOf?: () => RemoteManagerPort): TeammateBackendRegistry;
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
/** Forget cached documents and published pairs so an operator edit takes effect. */
export declare function forgetBackendRegistryConfigSync(workspaceRoot?: string): void;
