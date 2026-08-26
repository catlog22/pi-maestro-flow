export declare const RUNTIME_BROKER_MAX_LINE_BYTES: number;
export declare const RUNTIME_BROKER_MAX_REQUEST_ID_BYTES = 256;
export interface RuntimeBrokerServerOptions {
    stateDirectory?: string;
    databasePath?: string;
    maxLineBytes?: number;
    daemonToken?: string;
    daemonGeneration?: string;
    /** Production daemon fence; direct embedded servers may omit it. */
    assertDaemonAuthority?: () => boolean | void;
}
export declare class RuntimeBrokerServer {
    #private;
    readonly stateDirectory: string;
    readonly databasePath: string;
    readonly endpoint: string;
    readonly daemonToken: string;
    readonly daemonGeneration: string;
    readonly workspaceId: string;
    constructor(options?: RuntimeBrokerServerOptions);
    listen(): Promise<void>;
    close(): Promise<void>;
}
export declare function removeStaleUnixSocket(endpoint: string): Promise<void>;
export declare class BoundedJsonLineDecoder {
    #private;
    constructor(maxLineBytes: number, onLine: (line: string) => void);
    write(chunk: Buffer): void;
    end(): void;
}
