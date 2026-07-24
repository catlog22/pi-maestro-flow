import { startGuiServer } from "./gui-server.ts";
import { registerToolRoutes } from "./tool-routes.ts";
import { registerStateRoutes, type GuiStateProviders } from "./gui-state.ts";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { GuiPermissionGateway, GuiServerHandle } from "./types.ts";

/**
 * Unified Communication Layer (UCL) subsystem entry.
 *
 * The sidecar is opt-in via `PI_GUI=1` so existing sessions see zero behavior
 * change (no listener, no discovery file). GUI developers enable it to get tool
 * discovery/invocation, aggregated state, and change events over loopback HTTP+SSE.
 * Conversation/message/model control stays on `pi --mode rpc`.
 */
export function guiEnabled(): boolean {
  const flag = process.env.PI_GUI;
  return flag === "1" || flag === "true";
}

function resolvePort(): number {
  const raw = process.env.PI_GUI_PORT;
  if (!raw) return 0;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

export interface GuiSubsystemOptions {
  sessionId: string;
  cwd: string;
  getHealth?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Host-level tool catalog; when provided, GET /tools is registered. */
  listAllTools?: () => ToolInfo[];
  /** Permission gateway + live ctx; when provided, POST /tools/:name is registered. */
  gateway?: GuiPermissionGateway;
  getCtx?: () => ExtensionContext | undefined;
  /** State providers; when provided, GET /state and /state/:sub are registered. */
  stateProviders?: GuiStateProviders;
}

/**
 * Start the UCL sidecar when enabled. Returns null when `PI_GUI` is off.
 * Later phases extend this to register tool/state/event routes on the handle.
 */
export async function startGuiSubsystem(options: GuiSubsystemOptions): Promise<GuiServerHandle | null> {
  if (!guiEnabled()) return null;
  const server = await startGuiServer({
    sessionId: options.sessionId,
    cwd: options.cwd,
    port: resolvePort(),
    getHealth: options.getHealth,
  });
  if (options.listAllTools) {
    registerToolRoutes(server, {
      listAllTools: options.listAllTools,
      gateway: options.gateway,
      getCtx: options.getCtx,
    });
  }
  if (options.stateProviders) {
    registerStateRoutes(server, options.stateProviders);
  }
  return server;
}

export type { GuiServerHandle };
export { startGuiServer } from "./gui-server.ts";
export { registerGuiTool, getGuiTool, listGuiTools, clearGuiTools, isGuiToolAllowed, type GuiToolEntry } from "./gui-registry.ts";
export { registerToolRoutes, type GuiToolView } from "./tool-routes.ts";
export { registerStateRoutes, cloneSerializable, GUI_STATE_SUBSYSTEMS, type GuiStateProviders, type GuiStateProvider, type GuiStateSubsystem } from "./gui-state.ts";
export { createGuiEventForwarder, GUI_EVENTS, type GuiEventForwarder } from "./gui-events.ts";
export { GuiClient, GuiClientError, type GuiClientOptions, type GuiInvokeOptions, type GuiEventHandler } from "./client.ts";
export * from "./types.ts";
