import type { RuntimeEventDraftV2, RuntimeEventV2 } from "./contracts.ts";
import { type RuntimeV2RolloutMode } from "./rollout.ts";
export interface RuntimeV2JournalAppender {
    append(event: RuntimeEventDraftV2): RuntimeEventV2;
}
export interface RuntimeV2ShadowSinkOptions {
    mode?: RuntimeV2RolloutMode;
    journal?: RuntimeV2JournalAppender;
    onError?: (error: unknown) => void;
}
export declare class RuntimeV2ShadowSink {
    #private;
    readonly mode: RuntimeV2RolloutMode;
    constructor(options?: RuntimeV2ShadowSinkOptions);
    /**
     * The authoritative append runs first and its error is never intercepted.
     * Adapter and shadow-journal failures are advisory after that boundary.
     */
    appendAfterV1<Result>(appendV1: () => Result, adapt: () => readonly RuntimeEventDraftV2[]): Result;
}
export declare function createRuntimeV2ShadowSink(options: {
    stateDirectory: string;
    env?: NodeJS.ProcessEnv;
    onError?: (error: unknown) => void;
}): RuntimeV2ShadowSink;
