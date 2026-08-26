export declare const RUNTIME_BROKER_PRIVATE_DIRECTORY_MODE = 448;
export declare const RUNTIME_BROKER_PRIVATE_FILE_MODE = 384;
export declare const RUNTIME_BROKER_SOCKET_FILE = "broker.sock";
export declare const RUNTIME_BROKER_DATABASE_FILE = "broker.sqlite";
export declare const RUNTIME_BROKER_DAEMON_LOCK_FILE = "daemon.lock";
export interface RuntimeWorkspaceIdentity {
    canonicalPath: string;
    workspaceId: string;
    legacyWorkspaceIds: readonly string[];
}
export declare function canonicalizeRuntimeBrokerWorkspace(workspaceDirectory: string, platform?: NodeJS.Platform): string;
export declare function getRuntimeWorkspaceIdentity(workspaceDirectory: string, platform?: NodeJS.Platform): RuntimeWorkspaceIdentity;
export declare function getRuntimeBrokerStateDirectory(workspaceDirectory?: string, platform?: NodeJS.Platform): string;
export declare function getRuntimeBrokerEndpoint(stateDirectory?: string, platform?: NodeJS.Platform): string;
/** Stable authority scope used by the readiness handshake for a broker endpoint. */
export declare function getRuntimeBrokerEndpointWorkspaceId(endpoint: string, platform?: NodeJS.Platform): string;
export declare function getRuntimeBrokerDatabasePath(stateDirectory?: string): string;
export declare function ensurePrivateRuntimeBrokerDirectory(directoryPath: string): void;
export declare function assertSecureRuntimeBrokerFile(filePath: string, label: string): void;
export declare function secureRuntimeBrokerFile(filePath: string): void;
