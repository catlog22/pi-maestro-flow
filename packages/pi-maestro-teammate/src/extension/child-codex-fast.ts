import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCodexFast, resolveChildCodexFast } from "../shared/codex-fast.ts";

/** Explicitly installed by the child extension, including --no-extensions launches. */
export function registerChildCodexFast(pi: ExtensionAPI): void {
  let loadedCwd: string | undefined;
  let loadedOverride: string | undefined;
  let enabled = false;

  function load(ctx: ExtensionContext): void {
    const override = process.env.PI_TEAMMATE_CODEX_FAST;
    if (loadedCwd === ctx.cwd && loadedOverride === override) return;
    loadedCwd = ctx.cwd;
    loadedOverride = override;
    enabled = false;
    try {
      enabled = resolveChildCodexFast(ctx.cwd, override);
    } catch (error) {
      ctx.ui.notify(`Codex Fast disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    loadedCwd = undefined;
    load(ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    load(ctx);
    return applyCodexFast(event.payload, ctx.model, enabled);
  });
}
