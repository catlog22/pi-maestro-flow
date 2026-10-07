export declare function codexFastConfigPath(cwd: string): string;
export declare function loadCodexFast(cwd: string): boolean;
export type RequestModel = {
    provider: string;
    api: string;
    id: string;
};
export declare function applyCodexFast(payload: unknown, model: RequestModel | undefined, enabled: boolean): unknown;
/** A child override is authoritative, including false; otherwise use its project default. */
export declare function resolveChildCodexFast(cwd: string, override: string | undefined): boolean;
