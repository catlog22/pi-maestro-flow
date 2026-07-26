/**
 * Version 1 public agent discovery contract.
 *
 * No in-repo consumer today: `pi-maestro-flow`'s native Swarm runtime imported
 * `resolveAgent` / `resolveInternalAgent` / `listAgentSummaries` from here
 * (added in 24e066d8) until that runtime was deliberately removed in 581141b3,
 * when Swarm dispatch moved out of Flow entirely. The discovery API itself is
 * live and unchanged, so this is a published entry point without a current
 * caller rather than dead code — intentionally kept and *not* deprecated,
 * because there is no successor to redirect a consumer to.
 */
export * from "../../agents/agents.ts";
