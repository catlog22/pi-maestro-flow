import { type RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
import type { SessionEndpointCapability } from "../sessions/session-core.ts";
export interface WindowSupervisorRuntimeActorOptions {
    cwd: string;
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
    generation: number;
    capabilities?: readonly SessionEndpointCapability[];
    host?: RuntimeActorHostClient;
    onError?: (error: unknown) => void;
}
/** Advisory Runtime Broker binding for the v1 workspace-peer window owner. */
export declare class WindowSupervisorRuntimeActor {
    #private;
    constructor(options: WindowSupervisorRuntimeActorOptions);
    get active(): boolean;
    start(): Promise<boolean>;
    publishMessage(stage: "accepted" | "injected" | "replied", messageId: string, direction: "incoming" | "outgoing", mode: "steer" | "follow_up", inReplyTo?: string): Promise<void>;
    stop(): Promise<void>;
}
export declare function createWindowSupervisorRuntimeActor(options: WindowSupervisorRuntimeActorOptions): WindowSupervisorRuntimeActor;
