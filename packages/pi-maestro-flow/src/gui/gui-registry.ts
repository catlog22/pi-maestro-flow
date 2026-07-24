import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Cross-extension shared registry of GUI-invocable tools.
 *
 * `pi.getAllTools()` exposes every tool's schema but NOT its `execute` function,
 * so the UCL keeps its own registry keyed by a global symbol. Each extension
 * package (pi-maestro-flow, pi-maestro-teammate) registers its tools here; the
 * UCL server reads the registry lazily at request time. The pattern mirrors
 * `pi-maestro-teammate/src/runs/child-extensions.ts` (globalThis symbol singleton).
 */
export interface GuiToolEntry {
  name: string;
  execute: ToolDefinition["execute"];
  executionMode?: "sequential" | "parallel";
  /** Advisory hint for the GUI; the permission gateway gates invocation regardless. */
  mutating: boolean;
  /** Owning package/surface, e.g. "pi-maestro-flow", "pi-maestro-teammate", "mcp". */
  owner: string;
  description?: string;
}

interface GuiToolRegistry {
  tools: Map<string, GuiToolEntry>;
}

const registryKey = Symbol.for("pi-maestro.gui-tool-registry");
const GUI_FLOW_TOOL_NAMES = new Set([
  "maestro",
  "goal",
  "todo",
  "run-control",
  "ask-user-question",
]);

/** Locked UCL surface: Flow tools, Plan tools, and dynamically registered MCP tools. */
export function isGuiToolAllowed(name: string, owner: string): boolean {
  if (owner === "mcp") return true;
  return owner === "pi-maestro-flow" && (GUI_FLOW_TOOL_NAMES.has(name) || name.startsWith("plan-"));
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

/** Tools that never mutate project state (advisory only). */
const READ_ONLY_TOOLS = new Set([
  "teammate-list",
  "teammate-watch",
  "teammate-wait",
  "ask-user-question",
  "search_tool_bm25",
]);

export function registerGuiTool(def: ToolDefinition, owner: string): void {
  if (!isGuiToolAllowed(def.name, owner)) return;
  getRegistry().tools.set(def.name, {
    name: def.name,
    execute: def.execute,
    executionMode: def.executionMode,
    mutating: !READ_ONLY_TOOLS.has(def.name),
    owner,
    description: def.description,
  });
}

export function getGuiTool(name: string): GuiToolEntry | undefined {
  return getRegistry().tools.get(name);
}

export function listGuiTools(): GuiToolEntry[] {
  return Array.from(getRegistry().tools.values());
}

/** Test helper: drop all registered tools. */
export function clearGuiTools(): void {
  getRegistry().tools.clear();
}
