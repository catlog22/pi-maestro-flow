export interface DecodedInputToken {
    kind: "input" | "paste";
    text: string;
}
export declare function sanitizeSingleLineInput(value: string): string;
export declare function removeLastGrapheme(value: string): string;
export declare function previousGraphemeBoundary(value: string, index: number): number;
export declare function nextGraphemeBoundary(value: string, index: number): number;
export declare class BracketedPasteDecoder {
    private pasting;
    private buffer;
    private pending;
    feed(data: string): DecodedInputToken[];
    hasPending(): boolean;
    flushPending(): DecodedInputToken[];
    private appendPaste;
}
