/**
 * Version 1 public model-routing contract.
 *
 * No in-repo consumer today, for the same reason as `./agents.ts`:
 * `TEAMMATE_TASK_TYPES` / `TeammateTaskType` were imported by Flow's native
 * Swarm runtime (24e066d8) and went away with it (581141b3). Routing is still
 * how every dispatch picks a model, so the entry point stays published and is
 * not deprecated.
 */
export * from "../../models/model-routing.ts";
