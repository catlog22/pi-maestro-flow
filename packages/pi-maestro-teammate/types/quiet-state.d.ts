export type QuietSymbolMode = "check" | "dot";
export type QuietStatus = "running" | "success" | "failure";
export declare function setQuietMode(value: boolean, symbols?: unknown): void;
export declare function isQuietMode(): boolean;
export declare function getQuietSymbols(): QuietSymbolMode;
export declare function quietStatusMark(status: QuietStatus): string;
