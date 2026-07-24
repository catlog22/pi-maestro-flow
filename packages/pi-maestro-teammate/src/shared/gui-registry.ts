import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Teammate-side mirror of the cross-extension GUI tool registry.
 *
 * CONTRACT: this must stay structurally identical to
 * `pi-maestro-flow/src/gui/gui-registry.ts`. Both packages read/write the same
 * `globalThis[Symbol.for("pi-maestro.gui-tool-registry")]` map; pi-maestro-flow
 * cannot import this package's registry directly without inverting the dependency,
 * so the global symbol + entry shape is the shared contract (same pattern as
 * `child-extensions.ts`).
 */
export interface GuiToolEntry {
  name: string;
  execute: ToolDefinition["execute"];
  executionMode?: "sequential" | "parallel";
  mutating: boolean;
  owner: string;
  description?: string;
}

interface GuiToolRegistry {
  tools: Map<string, GuiToolEntry>;
}

const registryKey = Symbol.for("pi-maestro.gui-tool-registry");

/** Locked UCL surface for the teammate package. */
export function isGuiTeammateToolAllowed(name: string, owner: string): boolean {
  return owner === "pi-maestro-teammate" && (name === "teammate" || name.startsWith("teammate-"));
}

function getRegistry(): GuiToolRegistry {
  const host = globalThis as Record<symbol, GuiToolRegistry | undefined>;
  let registry = host[registryKey];
  if (!registry) {
    registry = { tools: new Map() };
    host[registryKey] = registry;
  }
  return registry;
}

const READ_ONLY_TOOLS = new Set(["teammate-list", "teammate-watch", "teammate-wait"]);

export function registerGuiTool(def: ToolDefinition, owner: string): void {
  if (!isGuiTeammateToolAllowed(def.name, owner)) return;
  getRegistry().tools.set(def.name, {
    name: def.name,
    execute: def.execute,
    executionMode: def.executionMode,
    mutating: !READ_ONLY_TOOLS.has(def.name),
    owner,
    description: def.description,
  });
}
