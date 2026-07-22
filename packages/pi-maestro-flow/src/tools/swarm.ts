import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadLatestTeamSwarmProjection, type TeamSwarmProjection } from "../swarm/projection.ts";
import { SwarmOverlay } from "../tui/swarm-overlay.ts";

export const SWARM_STATUS_KEY = "maestro-swarm";
let latestProjection: TeamSwarmProjection | undefined;
let activeOverlay: SwarmOverlay | undefined;

export function registerSwarmDisplay(pi: ExtensionAPI): void {
  const refresh = (ctx: ExtensionContext) => refreshSwarmDisplay(ctx);
  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_start", (_event, ctx) => refresh(ctx));
  pi.on("tool_execution_end", (_event, ctx) => refresh(ctx));
  pi.on("input", async (event, ctx) => {
    const match = /^\/swarm(?:\s+(.*))?$/is.exec(event.text.trim());
    if (!match) return;
    const action = (match[1] ?? "status").trim().toLowerCase();
    const snapshot = refresh(ctx);
    if (!snapshot) {
      ctx.ui.notify("No team-swarm JSON state found. Start with /skill:team-swarm <objective>.", "info");
      return { action: "handled" } as const;
    }
    if (action === "inspect") await openSwarmOverlay(ctx, snapshot);
    else if (!action || action === "status") ctx.ui.notify(formatSwarmMonitorStatus(snapshot), "info");
    else ctx.ui.notify("Native /swarm controller was removed. Use /skill:team-swarm; only hidden /swarm status|inspect remain read-only.", "warning");
    return { action: "handled" } as const;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    latestProjection = undefined;
    activeOverlay?.dispose();
    activeOverlay = undefined;
    ctx.ui.setStatus(SWARM_STATUS_KEY, undefined);
  });
}

export function refreshSwarmDisplay(ctx: ExtensionContext): TeamSwarmProjection | undefined {
  const snapshot = loadLatestTeamSwarmProjection(ctx.cwd);
  latestProjection = snapshot;
  if (snapshot) {
    ctx.ui.setStatus(SWARM_STATUS_KEY, formatSwarmMonitorStatus(snapshot));
    activeOverlay?.update(snapshot);
  } else ctx.ui.setStatus(SWARM_STATUS_KEY, undefined);
  return snapshot;
}

export function formatSwarmMonitorStatus(snapshot: TeamSwarmProjection): string {
  const metric = snapshot.metrics[snapshot.metrics.length - 1];
  return [
    `TEAM SWARM ${snapshot.iteration}/${snapshot.maxIterations || "?"}`,
    metric?.bestScore === undefined ? undefined : `BEST ${Math.round(metric.bestScore * 100)}%`,
    snapshot.status.toUpperCase(),
  ].filter(Boolean).join(" · ");
}

export function resetSwarmDisplayStateForTest(): void {
  latestProjection = undefined;
  activeOverlay?.dispose();
  activeOverlay = undefined;
}

async function openSwarmOverlay(ctx: ExtensionContext, snapshot: TeamSwarmProjection): Promise<void> {
  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    const disableMouse = enableMouseTracking(tui);
    const overlay = new SwarmOverlay({
      snapshot,
      requestRender: () => tui.requestRender(),
      close: () => { if (activeOverlay === overlay) activeOverlay = undefined; done(undefined); },
      onDispose: disableMouse,
    });
    activeOverlay = overlay;
    return overlay;
  }, { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" } });
}

function enableMouseTracking(tui: { terminal: { write(data: string): void } }): () => void {
  let enabled = true;
  tui.terminal.write("\x1b[?1000h\x1b[?1006h");
  return () => { if (enabled) { enabled = false; tui.terminal.write("\x1b[?1006l\x1b[?1000l"); } };
}
