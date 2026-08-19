/**
 * The ACP-CLI backend: run one external CLI that speaks the Agent Client
 * Protocol, over the same `TeammateBackend` contract every other backend uses.
 *
 * Generic by construction. Nothing here names a particular CLI: the executable,
 * its argv, its working directory, and its ssh connection are configuration
 * fields, so adding a CLI that speaks ACP needs no host source change. One
 * registration serves one CLI, which is what lets two of them declare different
 * routes and different timeouts.
 *
 * Two documents, each sufficient for one thing and neither for both. A
 * registration in `.pi/teammate-backends.json` is necessary and sufficient to
 * *run* `cli/<tool>`: the launch takes its configuration from the registration
 * and reads no file. An entry in `teammate-cli-tools.json` is necessary and
 * sufficient for `cli/<tool>` to *appear* in the model catalog, which is all the
 * host still derives from that file. So a registered tool missing from the tools
 * file runs when a task names it and is never offered, and a tool present only
 * in the tools file is offered and then refused by name — including one the
 * tools file marks `enabled: false`, because the registration is the enablement
 * decision.
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
import { probeAcpConfigOptions } from "../remote/acp-driver.ts";
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
/** Reads the configuration options an agent advertises, without running a task. */
export type AcpConfigOptionProbe = typeof probeAcpConfigOptions;
/**
 * Create the ACP-CLI backend.
 *
 * @param run - launches one CLI run; the default drives a real subprocess.
 * @param probe - reads an agent's advertised options; the default launches it.
 * @returns the backend, ready for registration.
 */
export declare function createAcpCliBackend(run?: CliToolRunner, probe?: AcpConfigOptionProbe): TeammateBackend;
/**
 * The registered instance.
 *
 * `asBackend` takes a loaded module's `.default` when it has one and narrows the
 * module namespace itself otherwise, so a default export is not required of
 * every adapter — it is required of this one. The named exports here are a
 * factory and a fold, neither of which is `name`, `capabilities`, or `start`, so
 * a namespace without the default carries no backend to find.
 */
declare const _default: TeammateBackend;
export default _default;
