import type { ActorAddressV2, RuntimeEventDraftV2, RuntimeEventV2 } from "../runtime-v2/contracts.ts";
import { type RuntimeV2JournalStream } from "../runtime-v2/journal.ts";
import { RuntimeBrokerClient, type RuntimeBrokerClientOptions } from "./client.ts";
import { type ActorLease, type RuntimeBrokerListStreamsRequest } from "./contracts.ts";
import { type RuntimeBrokerMode } from "./rollout.ts";
export declare const DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS = 20000;
export declare const DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS = 5000;
export interface RuntimeActorRegistration {
    /** Stable lease identity across actor generations. */
    leaseActorId: string;
    holderId: string;
    streamId: string;
    actor: ActorAddressV2;
    correlationId?: string;
    ttlMs?: number;
    heartbeatMs?: number;
}
export interface RuntimeActorLease {
    readonly mode: Exclude<RuntimeBrokerMode, "off">;
    readonly registration: RuntimeActorRegistration;
    readonly credential: Readonly<{
        epoch: number;
        nonce: string;
    }>;
    readonly revision: number;
    readonly active: boolean;
    heartbeat(): Promise<void>;
    replay(afterSequence?: number): Promise<readonly RuntimeEventV2[]>;
    append(events: readonly RuntimeEventDraftV2[]): Promise<readonly RuntimeEventV2[]>;
    release(): Promise<void>;
}
/** Driver-neutral client contract. Store and server authority stay private to the sidecar. */
export interface RuntimeActorHostClient {
    readonly mode: RuntimeBrokerMode;
    acquire(registration: RuntimeActorRegistration): Promise<RuntimeActorLease | undefined>;
    listStreams?(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]>;
    stop(): Promise<void>;
}
export interface RuntimeActorBrokerClient {
    acquireLease: RuntimeBrokerClient["acquireLease"];
    heartbeatLease: RuntimeBrokerClient["heartbeatLease"];
    commit: RuntimeBrokerClient["commit"];
    releaseLease: RuntimeBrokerClient["releaseLease"];
    getStreamRevision: RuntimeBrokerClient["getStreamRevision"];
    readEvents: RuntimeBrokerClient["readEvents"];
    listStreams?: RuntimeBrokerClient["listStreams"];
    close(): Promise<void>;
}
export interface RuntimeActorHostOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    mode?: RuntimeBrokerMode;
    stateDirectory?: string;
    clientOptions?: RuntimeBrokerClientOptions;
    sqliteClientFactory?: () => Promise<RuntimeActorBrokerClient>;
    fileJournalFactory?: (rootDirectory: string) => RuntimeV2JournalAppender;
}
export interface RuntimeV2JournalAppender {
    append(event: RuntimeEventDraftV2 & {
        producerEpoch: number;
    }): RuntimeEventV2;
    read?(streamId: string): RuntimeV2JournalStream | undefined;
    listStreams?(request: RuntimeBrokerListStreamsRequest): readonly string[];
}
interface DriverLeaseState {
    lease: ActorLease;
    revision: number;
}
interface ActorDriver {
    listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]>;
    acquire(registration: RuntimeActorRegistration): Promise<DriverLeaseState>;
    heartbeat(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<DriverLeaseState>;
    replay(registration: RuntimeActorRegistration, state: DriverLeaseState, afterSequence: number): Promise<readonly RuntimeEventV2[]>;
    append(registration: RuntimeActorRegistration, state: DriverLeaseState, events: readonly RuntimeEventDraftV2[]): Promise<{
        state: DriverLeaseState;
        events: readonly RuntimeEventV2[];
    }>;
    release(registration: RuntimeActorRegistration, state: DriverLeaseState): Promise<void>;
    stop(): Promise<void>;
}
export declare class RuntimeActorHost implements RuntimeActorHostClient {
    #private;
    readonly mode: RuntimeBrokerMode;
    constructor(mode: RuntimeBrokerMode, driver?: ActorDriver);
    acquire(registration: RuntimeActorRegistration): Promise<RuntimeActorLease | undefined>;
    listStreams(request: RuntimeBrokerListStreamsRequest): Promise<readonly string[]>;
    stop(): Promise<void>;
}
export declare function createRuntimeActorHost(options?: RuntimeActorHostOptions): RuntimeActorHostClient;
export {};
