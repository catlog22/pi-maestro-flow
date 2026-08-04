/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R composer panel, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export * from "./teammate-core.ts";
import type { TeammateRuntimeOptions } from "./teammate-core.ts";
/** Shared-process bridge key: the root host publishes the live v1 mailbox registry here. */
export declare const MAILBOX_REGISTRY_KEY: unique symbol;
export default function registerTeammateExtension(pi: ExtensionAPI, runtimeOptions?: TeammateRuntimeOptions): void;
export * from "./teammate-helpers.ts";
