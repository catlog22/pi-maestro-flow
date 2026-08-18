/**
 * The ACP-CLI backend: run one external CLI that speaks the Agent Client
 * Protocol, over the same `TeammateBackend` contract every other backend uses.
 *
 * Generic by construction. Nothing here names a particular CLI: the executable,
 * its argv, its working directory, and its ssh connection are configuration
 * fields, so adding a CLI that speaks ACP is a registration in
 * `.pi/teammate-backends.json` plus an entry in `teammate-cli-tools.json`, with
 * no host source change. One registration serves one CLI, which is what lets two
 * of them declare different routes and different timeouts.
 *
 * It ships in this package because its implementation reuses this package's ACP
 * driver and CLI launch helpers, and it is registered by module specifier like
 * any third-party adapter — the host loader has no branch for it.
 *
 * Recovery facts travel on the returned outcome. The dispatch path this backend
 * replaces fed them through a `WeakMap` keyed on the result, with a hardcoded
 * zero completed-tool count: a CLI run that edited files and then failed was
 * reported as having touched nothing, so the host's replay fence cleared a
 * replay that would repeat those edits.
 */
import type { AttemptRecoveryFacts, TeammateBackend } from "pi-maestro-backend-core/v1";
import { type CliToolRunResult, type RunLocalCliToolParams } from "../cli-tools/local-acp.ts";
/**
 * Translate one settled CLI run into the facts the host's failover reads.
 *
 * Exported because this fold is the whole of D1a: every field is an observation
 * the run reported, and a count invented here would be indistinguishable to the
 * fence from one the CLI actually earned.
 *
 * @param run - the settled CLI run.
 * @returns the recovery facts, in contract shape.
 */
export declare function recoveryFactsOf(run: CliToolRunResult): AttemptRecoveryFacts;
/** The CLI launcher this backend drives; injected so tests need no subprocess. */
export type CliToolRunner = (params: RunLocalCliToolParams) => Promise<CliToolRunResult>;
/**
 * Create the ACP-CLI backend.
 *
 * @param run - launches one CLI run; the default drives a real subprocess.
 * @returns the backend, ready for registration.
 */
export declare function createAcpCliBackend(run?: CliToolRunner): TeammateBackend;
/**
 * The registered instance.
 *
 * The registry narrows a loaded module's `default` before its own members, so a
 * module reached through a real `import(module)` must export one — without it,
 * registration fails with "exports no backend" for a module that has one.
 */
declare const _default: TeammateBackend;
export default _default;
