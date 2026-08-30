/**
 * Compatibility facade for the workspace-peer v1 protocol.
 *
 * New transport and discovery providers should import the TUI-free core from
 * sessions/workspace-peer-core.ts. Existing extension imports remain stable.
 */
export * from "../sessions/workspace-peer-core.ts";
