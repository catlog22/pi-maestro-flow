import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
export declare function setPersistentUi(ui: ExtensionUIContext | undefined, resetOwners?: boolean): void;
/** Registers one foreground owner; unregister is idempotent on every race path. */
export declare function registerForegroundDetach(detach: () => void, ui?: ExtensionUIContext): () => void;
