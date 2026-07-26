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
/** Locked UCL surface for the teammate package. */
export declare function isGuiTeammateToolAllowed(name: string, owner: string): boolean;
export declare function registerGuiTool(def: ToolDefinition, owner: string): void;
