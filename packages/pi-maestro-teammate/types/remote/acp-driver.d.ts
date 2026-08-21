import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "./driver.ts";
import { type RemoteRunStartParams } from "./protocol.ts";
export declare const ACP_STDERR_LIMIT: number;
export declare const ACP_EVENT_TEXT_LIMIT: number;
export declare const ACP_RESULT_LIMIT: number;
export declare const ACP_CANCEL_GRACE_MS = 2000;
export declare const ACP_STARTUP_TIMEOUT_MS = 15000;
export declare const ACP_PENDING_INPUT_LIMIT = 64;
export declare const ACP_PENDING_INPUT_BYTES: number;
export declare const ACP_EVENT_QUEUE_BYTES: number;
type SpawnChild = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcessWithoutNullStreams;
export interface AcpDriverOptions {
    cancelGraceMs?: number;
    startupTimeoutMs?: number;
    eventQueueBytes?: number;
    spawnChild?: SpawnChild;
    /**
     * Values to set on the session the agent opens, keyed by ACP config id.
     *
     * One map rather than one option per axis: the client drives whatever the
     * agent advertises, and an axis it does not advertise is absent from the
     * agent rather than special in this client. An omitted key leaves that
     * selector on whatever the agent treats as current, which is the only
     * behaviour available from an agent that offers no such selector.
     *
     * A value the agent does not advertise fails the run rather than falling back
     * to the current one, so a stale registration cannot silently run something
     * other than what it names.
     */
    selections?: Readonly<Record<string, string>>;
}
/**
 * A run handle that also reports which model its session was put on.
 *
 * `RemoteRunHandle` stays model-free because model selection is an ACP session
 * concept and no other driver has one. The value is read after the run settles,
 * so it is declared here rather than pushed through the event stream: the
 * selection happens once, during the handshake, and never changes for the life
 * of the session.
 */
export interface AcpRunHandleView extends RemoteRunHandle {
    /**
     * The advertised values this session's selectors were set to, by config id.
     *
     * A key is present only once the agent accepted the value, so a reader may
     * treat every entry as what ran rather than what was asked for. The values
     * are the agent's own catalogue entries, not the requested strings: a request
     * naming a model by name resolves to the advertised value carrying it, so
     * this reports the variant that actually ran.
     *
     * An axis nobody asked for, and an axis the agent does not advertise, are
     * both simply absent — this map claims nothing about either.
     */
    readonly selected: Readonly<Record<string, string>>;
}
/** What a configuration probe needs in order to launch the agent it asks. */
export interface AcpProbeTarget {
    /** Executable and arguments, already resolved from the registration. */
    command: readonly string[];
    /** Working directory the session is opened against. */
    cwd: string;
    /** Environment variable names passed through to the child. */
    env: readonly string[];
}
/**
 * Read the configuration options an ACP agent advertises, without running a
 * task.
 *
 * Launches the agent, completes `initialize` and `session/new`, and returns
 * what that response advertised. No prompt is sent, so the probe costs a
 * process and a handshake rather than model usage. The child is always killed
 * before returning, including on failure.
 *
 * Failure throws rather than yielding an empty list: an agent that cannot be
 * launched, or that refuses without credentials, is a state the operator has to
 * act on, and an empty list would read as "this agent offers no choices".
 *
 * @param target - launch command, directory, and env passthrough.
 * @param options - startup bound, abort signal, and spawn injection for tests.
 * @returns the advertised configuration options, empty when the agent sends none.
 * @throws when the agent cannot be launched, times out, or rejects the handshake.
 */
export declare function probeAcpConfigOptions(target: AcpProbeTarget, options?: {
    startupTimeoutMs?: number;
    signal?: AbortSignal;
    spawnChild?: SpawnChild;
}): Promise<readonly SessionConfigOption[]>;
export declare class AcpDriver implements RemoteDriver {
    #private;
    readonly id: "acp";
    constructor(options?: AcpDriverOptions);
    start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<AcpRunHandleView>;
    close(): Promise<void>;
}
export {};
