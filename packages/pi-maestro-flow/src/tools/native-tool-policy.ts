import { matchesGlob } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getPiHostMode } from "pi-maestro-settings-core/v1";

const DEFERRED_TOOLS = new Set([
  "browser", "computer_use", "conflict", "loop", "lsp", "model-availability",
  "smart_search", "source_check", "teammate-session-routing",
]);
const CONTROL_TOOLS = new Set([
  "maestro", "goal", "todo", "run-control", "ask-user-question", "new_context",
  "board", "device", "workspace", "endpoint", "route",
]);

export interface NativeDiscoverySelection {
  defaultTools?: readonly string[];
  extensions?: readonly string[];
  cli?: {
    tools?: readonly string[];
    excludeTools?: readonly string[];
    extensions?: readonly string[];
    noExtensions?: boolean;
    noTools?: boolean;
  };
}

function extensionSelection(entries: readonly string[] | undefined): boolean | undefined {
  let selected: boolean | undefined;
  for (const entry of entries ?? []) {
    const prefix = /^[!+-]/.test(entry) ? entry[0] : "";
    const pattern = prefix ? entry.slice(1) : entry;
    if (!pattern || !matchesGlob("builtin:tool-search", pattern)) continue;
    selected = prefix !== "!" && prefix !== "-";
  }
  return selected;
}

/** Default discovery never overrides an explicit tool list or a disabled builtin. */
export function isNativeDiscoverySelected(selection: NativeDiscoverySelection): boolean {
  const cli = selection.cli;
  const cliBuiltin = extensionSelection(cli?.extensions);
  if (cliBuiltin !== true && cli?.noExtensions) return false;
  if (cliBuiltin === false) return false;
  if (cliBuiltin !== true && extensionSelection(selection.extensions) === false) return false;
  if (cli?.noTools || cli?.excludeTools?.some((pattern) => matchesGlob("tool_search", pattern))) return false;
  if (cli?.tools) return cli.tools.some((pattern) => matchesGlob("tool_search", pattern));
  const defaults = selection.defaultTools;
  let selected = defaults === undefined || defaults.includes("tool_search")
    || (defaults.length > 0 && defaults.every((entry) => /^[+-]/.test(entry)));
  for (const entry of defaults ?? []) {
    if (entry === "+tool_search") selected = true;
    if (entry === "-tool_search") selected = false;
  }
  return selected;
}

export function applyNativeToolPolicy<T extends ToolDefinition>(
  tool: T,
  discoveryEnabled: boolean,
): T {
  const control = CONTROL_TOOLS.has(tool.name) || tool.name.startsWith("plan-");
  return {
    ...tool,
    namespace: tool.namespace ?? { name: "maestro", description: "Maestro workflow and developer tools" },
    exposure: tool.exposure ?? (control ? "model-only" : discoveryEnabled && DEFERRED_TOOLS.has(tool.name) ? "deferred" : "direct"),
  };
}

/** Decorate only this extension's registrations and reuse the host's discovery tool. */
export function withNativeToolPolicy(
  pi: ExtensionAPI,
  hostVersion: unknown,
  discoveryEnabled: boolean,
): ExtensionAPI {
  if (getPiHostMode(hostVersion) !== "native") return pi;
  const originalRegister = pi.registerTool.bind(pi);
  const deferredDefinitions = new Map<string, ToolDefinition>();
  let enabled = discoveryEnabled;
  let registerTool = (tool: ToolDefinition): void => {
    const decorated = applyNativeToolPolicy(tool, enabled);
    if (enabled && tool.exposure === undefined && decorated.exposure === "deferred") {
      deferredDefinitions.set(tool.name, tool);
    } else {
      deferredDefinitions.delete(tool.name);
    }
    originalRegister(decorated);
  };
  if (discoveryEnabled) {
    pi.on("session_start", (_event, ctx) => {
      if (!enabled) return;
      const search = pi.getAllTools().find((tool) => tool.name === "tool_search");
      if (search && search.exposure !== "hidden") {
        const active = pi.getActiveTools();
        if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
        if (pi.getActiveTools().includes("tool_search")) return;
      }
      enabled = false;
      for (const tool of deferredDefinitions.values()) originalRegister(applyNativeToolPolicy(tool, false));
      deferredDefinitions.clear();
      ctx.ui.notify("Native tool_search is unavailable; Maestro low-frequency tools remain directly available.", "warning");
    });
  }
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return registerTool;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === "registerTool") {
        registerTool = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
}
