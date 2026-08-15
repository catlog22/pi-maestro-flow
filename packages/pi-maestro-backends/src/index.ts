/**
 * Teammate execution backends.
 *
 * Every backend implements the same `pi-maestro-backend-core` contract. The Pi
 * subprocess is an ordinary member rather than a bypass, so the seam is
 * exercised by the default deployment instead of only by third parties.
 */

export { resolveBackendConfig } from "./config.ts";
export {
  adjudicateTask,
  requiredCapabilities,
  validateBackendCapabilities,
  type AdjudicatedTask,
} from "./capabilities.ts";
export { TeammateBackendRegistry, type BackendLoader } from "./registry.ts";
