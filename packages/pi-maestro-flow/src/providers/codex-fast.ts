import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { applyCodexFast, codexFastConfigPath, loadCodexFast, type RequestModel } from "pi-maestro-teammate/v1/codex-fast";
export { applyCodexFast, codexFastConfigPath, loadCodexFast } from "pi-maestro-teammate/v1/codex-fast";

export function saveCodexFast(cwd: string, enabled: boolean): void {
  const path = codexFastConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export default function registerCodexFast(pi: ExtensionAPI): void {
  let enabled = false;
  let loadedCwd: string | undefined;

  pi.registerFlag("fast", { description: "Request Codex priority service tier (may consume more quota)", type: "boolean", default: false });

  function updateStatus(ctx: ExtensionContext, model: RequestModel | undefined = ctx.model): void {
    const active = enabled && model?.provider === "openai-codex" && model.api === "openai-codex-responses";
    ctx.ui.setStatus("codex-fast", active ? "Codex Fast: on" : undefined);
  }

  function load(ctx: ExtensionContext): void {
    if (loadedCwd === ctx.cwd) return;
    loadedCwd = ctx.cwd;
    enabled = false;
    try {
      enabled = loadCodexFast(ctx.cwd);
    } catch (error) {
      ctx.ui.notify(`Codex Fast disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    // If this standalone extension is explicitly inherited too, honor the same
    // child override as Teammate's hook; false must beat project/CLI defaults.
    const childOverride = process.env.PI_TEAMMATE_CHILD === "1" ? process.env.PI_TEAMMATE_CODEX_FAST : undefined;
    if (childOverride === "true" || childOverride === "false") enabled = childOverride === "true";
    else if (pi.getFlag("fast") === true) enabled = true;
    updateStatus(ctx);
  }

  const command = {
    description: "Codex Fast priority tier: /fast [on|off|status] (may consume more quota)",
    async handler(args: string, ctx: ExtensionContext): Promise<void> {
      load(ctx);
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(`Codex Fast: ${enabled ? "on" : "off"}. Only openai-codex requests are affected. Config: ${codexFastConfigPath(ctx.cwd)}`, "info");
        return;
      }
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      const next = action === "on" ? true : action === "off" ? false : !enabled;
      try {
        saveCodexFast(ctx.cwd, next);
      } catch (error) {
        ctx.ui.notify(`Codex Fast unchanged; config save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      enabled = next;
      updateStatus(ctx);
      ctx.ui.notify(`Codex Fast ${enabled ? "enabled (priority tier may consume more quota)" : "disabled"}; saved to .pi/codex-fast.json.`, "info");
    },
  };
  pi.registerCommand("fast", command);
  pi.on("session_start", (_event, ctx) => {
    loadedCwd = undefined;
    load(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    load(ctx);
    updateStatus(ctx, event.model);
  });
  pi.on("before_provider_request", (event, ctx) => {
    load(ctx);
    return applyCodexFast(event.payload, ctx.model, enabled);
  });
}
