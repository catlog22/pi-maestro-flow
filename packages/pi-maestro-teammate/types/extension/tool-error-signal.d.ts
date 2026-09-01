import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Mark legacy teammate-send delivery failures as failed Pi tool results. */
export declare function teammateSendErrorOverride(toolName: string, details: unknown): {
    isError: true;
} | undefined;
/** Bridge returned `isError` flags into pi's canonical tool-result error state. */
export declare function installReturnedToolErrorBridge(pi: ExtensionAPI): void;
