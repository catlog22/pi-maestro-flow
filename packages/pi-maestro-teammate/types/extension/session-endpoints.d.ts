import type { RemoteWindowMonitorListing } from "./remote-window-monitor.ts";
import type { TeammateState } from "../shared/types.ts";
import { type SessionDiscoveryProvider, type SessionEndpoint, type SessionEndpointCapability, type SessionRouteAuthority } from "../sessions/session-core.ts";
import { discoverWorkspacePeers, type WorkspaceOwnerSnapshot, type WorkspacePeerIdentity } from "../sessions/workspace-peer-core.ts";
/** Projects live root state and validated workspace-peer v1 snapshots into canonical endpoints. */
export declare function localRootSessionCapabilities(monitorAggregation?: boolean): readonly SessionEndpointCapability[];
export declare function projectTeammateSessionEndpoints(state: TeammateState, localIdentity: Pick<WorkspacePeerIdentity, "workspaceId" | "ownerId" | "ownerNonce">, remoteOwners: readonly WorkspaceOwnerSnapshot[], localSessionName?: string, monitorAggregation?: boolean, sshWindows?: readonly RemoteWindowMonitorListing[]): readonly SessionEndpoint[];
export interface LocalWorkspacePeerDiscoveryProviderOptions {
    state: TeammateState;
    identity: WorkspacePeerIdentity;
    localSessionName?: () => string | undefined;
    monitorAggregation?: () => boolean;
    cleanupStale?: boolean;
    /** @internal deterministic discovery hook for focused tests. */
    discover?: typeof discoverWorkspacePeers;
}
/** Local filesystem discovery provider backed by validated workspace-peer v1 snapshots. */
export declare class LocalWorkspacePeerDiscoveryProvider implements SessionDiscoveryProvider {
    #private;
    readonly authority: SessionRouteAuthority;
    constructor(options: LocalWorkspacePeerDiscoveryProviderOptions);
    refresh(signal?: AbortSignal): Promise<readonly SessionEndpoint[]>;
    close(): Promise<void>;
}
export declare function createLocalWorkspacePeerDiscoveryProvider(options: LocalWorkspacePeerDiscoveryProviderOptions): LocalWorkspacePeerDiscoveryProvider;
