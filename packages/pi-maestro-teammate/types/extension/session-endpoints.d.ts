import type { TeammateState } from "../shared/types.ts";
import { type SessionEndpoint } from "../sessions/session-core.ts";
import type { WorkspaceOwnerSnapshot, WorkspacePeerIdentity } from "./workspace-peers.ts";
/** Projects live root state and validated workspace-peer v1 snapshots into canonical endpoints. */
export declare function projectTeammateSessionEndpoints(state: TeammateState, localIdentity: Pick<WorkspacePeerIdentity, "workspaceId" | "ownerId" | "ownerNonce">, remoteOwners: readonly WorkspaceOwnerSnapshot[], localSessionName?: string): readonly SessionEndpoint[];
