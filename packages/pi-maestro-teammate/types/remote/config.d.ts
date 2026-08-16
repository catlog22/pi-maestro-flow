import { REMOTE_CONFIG_VERSION, type RemoteHostConfig, type RemoteTargetConfig, type ResolvedRemoteTarget } from "./types.ts";
export interface GlobalRemoteConfigStore {
    version: typeof REMOTE_CONFIG_VERSION;
    hosts: Record<string, RemoteHostConfig>;
    targets: Record<string, RemoteTargetConfig>;
}
export interface ProjectRemoteConfigStore {
    version: typeof REMOTE_CONFIG_VERSION;
    /** Project values override globals; null explicitly hides a global entry. */
    hosts: Record<string, RemoteHostConfig | null>;
    /** Project values override globals; null explicitly hides a global entry. */
    targets: Record<string, RemoteTargetConfig | null>;
}
export interface RemoteConfig {
    version: typeof REMOTE_CONFIG_VERSION;
    hosts: Record<string, RemoteHostConfig>;
    targets: Record<string, RemoteTargetConfig>;
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
export declare function loadGlobalRemoteConfig(globalFilePath?: string): GlobalRemoteConfigStore;
export declare function loadProjectRemoteConfig(cwd: string, globalFilePath?: string): ProjectRemoteConfigStore;
export declare function loadRemoteConfigState(cwd: string, globalFilePath?: string): RemoteConfigState;
export declare function loadRemoteConfig(cwd: string, globalFilePath?: string): RemoteConfig;
export declare function resolveRemoteTarget(config: RemoteConfig, targetId: string): ResolvedRemoteTarget;
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
