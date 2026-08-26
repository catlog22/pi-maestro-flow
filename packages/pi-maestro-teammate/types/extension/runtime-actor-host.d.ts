import { type RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
export interface WindowSupervisorRuntimeActorOptions {
    cwd: string;
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    generation: number;
    host?: RuntimeActorHostClient;
    onError?: (error: unknown) => void;
}
/** Advisory Runtime Broker binding for the v1 workspace-peer window owner. */
export declare class WindowSupervisorRuntimeActor {
    #private;
    constructor(options: WindowSupervisorRuntimeActorOptions);
    get active(): boolean;
    start(): Promise<boolean>;
    stop(): Promise<void>;
}
export declare function createWindowSupervisorRuntimeActor(options: WindowSupervisorRuntimeActorOptions): WindowSupervisorRuntimeActor;
