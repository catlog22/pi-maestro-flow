/**
 * Core teammate execution engine.
 *
 * Spawns a pi subprocess for agent execution, parses JSON lines from
 * stdout, tracks usage and progress, handles abort signals, and returns
 * a SingleResult.
 *
 * Supports single, parallel (tasks[]), and chain (chain[]) execution modes.
 */
import { type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { SingleResult } from "../shared/types.ts";
import { type LeaseToken } from "./session-handoff.ts";
export * from "./execution-infra.ts";
import type { NormalizedTask, RunSingleTeammateParams, RunTeammateOptions, RunTeammateParams } from "./execution-infra.ts";
export declare function runSingleTeammate(params: RunSingleTeammateParams, options: RunTeammateOptions): Promise<SingleResult>;
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
export declare function normalizeGraphConcurrency(concurrency: number, taskCount: number): number;
export declare function runGraph(tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions): Promise<SingleResult[]>;
/** Programmatic tasks-only entry point matching the public teammate schema. */
export declare function runTeammate(params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]>;
export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort";
export declare function sendRpcMessage(stdin: Writable, message: string, mode?: RpcMessageMode, token?: LeaseToken): boolean;
export declare function sendChildIpcMessage(child: ChildProcess, message: Record<string, unknown>): boolean;
export declare function dispatchChildIpcMessage(message: Record<string, unknown>, onRequest: RunTeammateOptions["onChildRequest"], onEvent: RunTeammateOptions["onChildEvent"], reply: (message: unknown) => void): "request" | "event";
