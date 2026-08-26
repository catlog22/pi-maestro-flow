import type { AgentProgress, AgentTerminalStatus, SingleResult } from "../shared/types.ts";
import type { ChildReclamationOutcome, RunTeammateOptions } from "./execution-infra.ts";
export declare class AgentRunRuntimeActor {
    #private;
    private constructor();
    static start(correlationId: string, params: {
        cwd?: string;
    }, options: RunTeammateOptions): Promise<AgentRunRuntimeActor>;
    wrap(options: RunTeammateOptions): RunTeammateOptions;
    progressAfterV1(progress: AgentProgress): void;
    resultPublishedAfterV1(result: SingleResult): Promise<void>;
    settledAfterV1(result: SingleResult, status?: AgentTerminalStatus, afterPersist?: () => void): void;
    reclaimedAfterV1(outcome: ChildReclamationOutcome, afterPersist?: () => void): void;
    finish(): Promise<void>;
    abort(): Promise<void>;
}
