import type { RuntimeTransport, RuntimeTransportFactory } from "./transport.ts";
export declare const RUNTIME_BROKER_ENV_VAR: "PI_RUNTIME_BROKER";
export type RuntimeBrokerMode = "off" | "file" | "sqlite";
/** Default off: the SQLite broker causes intermittent startup hangs (see debug-notes). Opt in explicitly via PI_RUNTIME_BROKER=sqlite|file. */
export declare function parseRuntimeBrokerMode(value: string | undefined): RuntimeBrokerMode;
export declare function runtimeBrokerModeFromEnv(env?: NodeJS.ProcessEnv): RuntimeBrokerMode;
export interface RuntimeTransportRolloutOptions {
    env?: NodeJS.ProcessEnv;
    mode?: RuntimeBrokerMode;
    fileFactory?: RuntimeTransportFactory;
    sqliteFactory?: RuntimeTransportFactory;
}
export type RuntimeTransportSelection = {
    mode: "off";
    transport: undefined;
} | {
    mode: "file" | "sqlite";
    transport: RuntimeTransport;
};
/** Selects and constructs a transport only; it does not install production authority. */
export declare function createRuntimeTransport(options?: RuntimeTransportRolloutOptions): RuntimeTransportSelection;
export declare const selectRuntimeTransport: typeof createRuntimeTransport;
