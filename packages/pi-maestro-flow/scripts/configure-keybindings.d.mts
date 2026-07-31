export const THINKING_CYCLE_KEY: "ctrl+shift+e";
export const THINKING_CYCLE_ACTION: "app.thinking.cycle";

export type KeybindingUpdateResult =
  | { status: "updated" | "unchanged"; configPath: string }
  | { status: "skipped"; configPath: string; message: string };

export function ensureMaestroKeybindings(configPath?: string): KeybindingUpdateResult;
export function restorePiKeybindings(configPath?: string): KeybindingUpdateResult;
