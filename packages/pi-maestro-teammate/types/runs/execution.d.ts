/**
 * Core teammate execution engine.
 *
 * Spawns a pi subprocess for agent execution, parses JSON lines from
 * stdout, tracks usage and progress, handles abort signals, and returns
 * a SingleResult.
 *
 * Supports single, parallel (tasks[]), and chain (chain[]) execution modes.
 */
import type { SingleResult, AgentProgress, TeammateExecutionProvenance } from "../shared/types.ts";
export * from "./execution-infra.ts";
import type { NormalizedTask, RunSingleTeammateParams, RunTeammateOptions, RunTeammateParams } from "./execution-infra.ts";
export { TOOL_EXECUTION_HEARTBEAT_MS, resolveAgentCacheRetention, sendRpcMessage, sendChildIpcMessage, dispatchChildIpcMessage, } from "./pi-subprocess-attempt.ts";
export type { RpcMessageMode } from "./pi-subprocess-attempt.ts";
export declare function hostRegistryResultProvenance(result: SingleResult): TeammateExecutionProvenance | undefined;
/**
 * Convert a backend's progress payload into the host's progress record.
 *
 * A backend reports whatever its runtime knows, so this is a real conversion
 * rather than a cast: the host supplies the identity and timing it owns, the
 * payload supplies what the runtime observed, and anything the backend cannot
 * report falls back to a value that reads as "not observed" instead of as a
 * measurement. Validation belongs here because the payload crosses a module
 * boundary untyped.
 *
 * @param data - the backend's payload.
 * @param agent - the agent this attempt runs, known to the host.
 * @param startedAt - attempt start, known to the host.
 * @returns the host-shaped progress record.
 *
 * @internal Exported for backend-seam regression tests.
 */
export declare function projectBackendProgress(data: Record<string, unknown>, agent: string, startedAt: number): AgentProgress;
export declare function runSingleTeammate(params: RunSingleTeammateParams, options: RunTeammateOptions): Promise<SingleResult>;
export declare function normalizeGraphConcurrency(concurrency: number, taskCount: number): number;
export declare function runGraph(tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions): Promise<SingleResult[]>;
/** Programmatic tasks-only entry point matching the public teammate schema. */
export declare function runTeammate(params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]>;
