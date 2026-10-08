export interface TeammateHostBoundary {
    correlationId: string;
    incarnation: string;
    sequence: number;
    parentSessionFile?: string;
    runtimeGeneration: number;
    event: Readonly<Record<string, unknown>>;
    steer(message: string): boolean;
}
type Observer = (boundary: TeammateHostBoundary) => void;
export declare function registerTeammateHostObserver(owner: string, observer: Observer): () => void;
export declare function nextTeammateHostSequence(): number;
export declare function publishTeammateHostBoundary(boundary: TeammateHostBoundary): void;
export {};
