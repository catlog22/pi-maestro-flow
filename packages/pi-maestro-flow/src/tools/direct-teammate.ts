import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTeammateDirectChildRequestHandler } from "pi-maestro-teammate/v1/extension";
import { createModelCatalogSnapshot } from "pi-maestro-teammate/v1/model-routing";
import type { RunTeammateOptions } from "pi-maestro-teammate/v1/execution";

export type DirectTeammateRunOverrides = Omit<RunTeammateOptions, "onChildRequest">;

/**
 * Build the parent-authoritative options required by direct runTeammate/runGraph callers.
 * Keeping this in one factory prevents a direct runtime from silently dropping child requests.
 */
export function createDirectTeammateRunOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  overrides: DirectTeammateRunOverrides = { baseCwd: ctx.cwd },
): RunTeammateOptions {
  return {
    ...overrides,
    baseCwd: overrides.baseCwd || ctx.cwd,
    modelCapabilities: overrides.modelCapabilities
      ?? createModelCatalogSnapshot(ctx.modelRegistry.getAvailable()).models,
    onChildRequest: createTeammateDirectChildRequestHandler(pi, ctx),
  };
}
