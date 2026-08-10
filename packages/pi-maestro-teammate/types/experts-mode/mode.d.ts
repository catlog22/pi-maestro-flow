import type { ExpertsMode } from "./types.ts";
export declare function resolveStatePath(cwd?: string, explicitPath?: string): string;
export declare function getMode(cwd?: string, statePath?: string): ExpertsMode;
export declare function setMode(mode: ExpertsMode, cwd?: string, statePath?: string): Record<string, unknown>;
export declare function readState(cwd?: string, statePath?: string): {
    mode: ExpertsMode;
    path: string;
    updatedAt?: string | null;
    lastDispatch?: unknown;
};
