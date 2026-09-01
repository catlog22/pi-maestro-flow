import { REMOTE_CONFIG_VERSION, type RemoteHostEntry, type RemoteTargetConfig, type RemoteWorkspaceConfig, type ResolvedRemoteTarget, type ResolvedRemoteWorkspace } from "./types.ts";
export interface GlobalRemoteConfigStore {
    version: typeof REMOTE_CONFIG_VERSION;
    hosts: Record<string, RemoteHostEntry>;
    targets: Record<string, RemoteTargetConfig>;
    workspaces: Record<string, RemoteWorkspaceConfig>;
}
export interface ProjectRemoteConfigStore {
    version: typeof REMOTE_CONFIG_VERSION;
    /** Project values override globals; null explicitly hides a global entry. */
    hosts: Record<string, RemoteHostEntry | null>;
    /** Project values override globals; null explicitly hides a global entry. */
    targets: Record<string, RemoteTargetConfig | null>;
    /** Project values override globals; null explicitly hides a global entry. */
    workspaces: Record<string, RemoteWorkspaceConfig | null>;
}
export interface RemoteConfig {
    version: typeof REMOTE_CONFIG_VERSION;
    hosts: Record<string, RemoteHostEntry>;
    targets: Record<string, RemoteTargetConfig>;
    workspaces: Record<string, RemoteWorkspaceConfig>;
}
export interface RemoteConfigState {
    global: GlobalRemoteConfigStore;
    project: ProjectRemoteConfigStore;
    config: RemoteConfig;
}
export interface RemoteConfigStorePair {
    global: GlobalRemoteConfigStore;
    project: ProjectRemoteConfigStore;
}
export declare function getGlobalRemoteConfigPath(): string;
export declare function getProjectRemoteConfigPath(cwd: string): string;
export declare function validateHostId(id: string): void;
export declare function validateTargetId(id: string): void;
export declare function validateWorkspaceRef(workspaceRef: string): void;
export declare function loadGlobalRemoteConfig(globalFilePath?: string): GlobalRemoteConfigStore;
export declare function loadProjectRemoteConfig(cwd: string, globalFilePath?: string): ProjectRemoteConfigStore;
export declare function loadRemoteConfigState(cwd: string, globalFilePath?: string): RemoteConfigState;
export declare function loadRemoteConfig(cwd: string, globalFilePath?: string): RemoteConfig;
export declare function resolveRemoteTarget(config: RemoteConfig, targetId: string): ResolvedRemoteTarget;
export declare function resolveRemoteWorkspace(config: RemoteConfig, workspaceRef: string): ResolvedRemoteWorkspace;
export declare function saveGlobalRemoteConfig(store: GlobalRemoteConfigStore, globalFilePath?: string): GlobalRemoteConfigStore;
export declare function saveProjectRemoteConfig(cwd: string, store: ProjectRemoteConfigStore, globalFilePath?: string): ProjectRemoteConfigStore;
export declare function replaceRemoteConfigStores(cwd: string, expected: RemoteConfigStorePair, next: RemoteConfigStorePair, globalFilePath?: string): RemoteConfigStorePair;
export type RemoteDraftValidation = {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** Validate a host draft (id + config) with the same rules as stored config. */
export declare function validateRemoteHostDraft(id: string, value: unknown): RemoteDraftValidation;
/** Validate a target draft (id + config) with the same rules as stored config. */
export declare function validateRemoteTargetDraft(id: string, value: unknown): RemoteDraftValidation;
/** Validate a workspace draft with the same trusted-cwd rules as stored config. */
export declare function validateRemoteWorkspaceDraft(workspaceRef: string, value: unknown): RemoteDraftValidation;
