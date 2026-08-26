import { RUNTIME_BROKER_PROTOCOL, RUNTIME_BROKER_PROTOCOL_VERSION } from "./contracts.ts";
export interface RuntimeBrokerCapability {
    ok: boolean;
    protocol: typeof RUNTIME_BROKER_PROTOCOL;
    version: typeof RUNTIME_BROKER_PROTOCOL_VERSION;
    nodeVersion: string;
    sqlite: boolean;
    transport: "named-pipe" | "unix-socket";
    stateDirectory: string;
    endpoint: string;
    reason?: string;
}
export declare function probeRuntimeBrokerCapability(stateDirectory?: string): RuntimeBrokerCapability;
