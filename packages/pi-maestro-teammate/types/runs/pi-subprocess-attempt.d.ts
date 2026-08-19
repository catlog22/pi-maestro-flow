/**
 * The Pi subprocess attempt: everything needed to run one teammate turn in a
 * child Pi runtime, from spawn through settlement and child-process reclamation.
 *
 * Split out of `execution.ts` so orchestration and backend implementation stop
 * sharing a file. `execution.ts` keeps the model-candidate sweep, circuit
 * breaker, replay fence, and completion publication — decisions about *which*
 * model runs. This module owns what one specific runtime does with an
 * already-chosen model.
 *
 * The recovery WeakMaps are written here and read only by this package's Pi
 * backend adapter, which turns them into the contract's `AttemptOutcome`. They
 * are deliberately absent from the package's public surface: outside this pair
 * of modules, recovery facts travel as a value on the outcome rather than as a
 * side channel a caller can forget to consult.
 */
import { type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { type AgentConfig } from "../agents/agents.ts";
import { type ReplyTarget } from "../shared/routing.ts";
import type { SingleResult } from "../shared/types.ts";
import { type LeaseToken } from "./session-handoff.ts";
import type { RunSingleTeammateParams, RunTeammateOptions } from "./execution-infra.ts";
export declare const attemptReclamations: WeakMap<SingleResult, Promise<unknown>>;
export type AttemptSettlementCapability = "agent_settled" | "legacy" | "unknown";
interface AttemptRecoveryFacts {
    settlementCapability: AttemptSettlementCapability;
    completedToolCount: number;
    inFlightToolCount: number;
    /** A non-zero close before any child event, stderr, or possible side effect. */
    preActivityInfrastructureExit: boolean;
    /** IPC or non-protocol output that may represent untracked external work. */
    externalReplayRisk: boolean;
    /** Non-JSON stdout was attributed as assistant content (protocol violation). Optional: not all settlement paths populate it. */
    stdoutProtocolViolation?: boolean;
}
export declare const attemptRecoveryFacts: WeakMap<SingleResult, AttemptRecoveryFacts>;
/**
 * While a tool is in flight (e.g. a long bash script), the pi child emits no
 * further events until the tool completes. Without a heartbeat the parent's
 * 30s stall clock (`TEAMMATE_STALL_TIMEOUT_MS`) would mark a busy agent as
 * stalled. This interval refreshes progress activity until the tool ends; it
 * stays well under the stall threshold so dropped ticks cannot false-flag.
 */
export declare const TOOL_EXECUTION_HEARTBEAT_MS = 10000;
/**
 * Cache tier for agent subprocesses.
 *
 * Agents stay on the short tier (5m on Anthropic, implicit 30m on OpenAI) even
 * when the main process runs with PI_CACHE_RETENTION=long, so a long-lived main
 * session does not leak its expensive 1h/24h cache tier into short-lived agents.
 * PI_TEAMMATE_CACHE_RETENTION overrides the pin (valid values: short | long | none).
 */
export declare function resolveAgentCacheRetention(env?: NodeJS.ProcessEnv): string;
export declare function runSingleAttempt(params: RunSingleTeammateParams, agentConfig: AgentConfig, cwd: string, correlationId: string, replyTo: ReplyTarget, startTime: number, modelOverride: string | undefined, options: RunTeammateOptions): Promise<SingleResult>;
export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";
export declare function sendRpcMessage(stdin: Writable, message: string, mode?: RpcMessageMode, token?: LeaseToken): boolean;
export declare function sendChildIpcMessage(child: ChildProcess, message: Record<string, unknown>): boolean;
export declare function dispatchChildIpcMessage(message: Record<string, unknown>, onRequest: RunTeammateOptions["onChildRequest"], onEvent: RunTeammateOptions["onChildEvent"], reply: (message: unknown) => void): "request" | "event";
export {};
