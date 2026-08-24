/**
 * TypeBox schemas for teammate tool parameters.
 *
 * Unified TaskSpec model:
 *   - Every public dispatch uses a non-empty tasks array
 *   - prompt is the task text; agent may inherit from the top level
 *   - Top-level fields serve as defaults, per-task overrides win
 *
 * P0 three-axis decoupling:
 *   - name: addressability + variable referencing
 *   - reply_to: result routing (caller | main)
 */
import { Type, type Static } from "typebox";
export declare const TaskSpec: Type.TObject<{
    prompt: Type.TString;
    description: Type.TOptional<Type.TString>;
    agent: Type.TOptional<Type.TString>;
    taskType: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
    fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TUnsafe<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">>;
    cwd: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    background: Type.TOptional<Type.TBoolean>;
    todo: Type.TOptional<Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>>;
    briefing: Type.TOptional<Type.TArray<Type.TString>>;
    maxNestingDepth: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateParams: Type.TObject<{
    mode: Type.TOptional<Type.TUnsafe<"default" | "expert">>;
    agent: Type.TOptional<Type.TString>;
    taskType: Type.TOptional<Type.TString>;
    reply_to: Type.TOptional<Type.TUnsafe<"caller" | "main">>;
    tasks: Type.TArray<Type.TObject<{
        prompt: Type.TString;
        description: Type.TOptional<Type.TString>;
        agent: Type.TOptional<Type.TString>;
        taskType: Type.TOptional<Type.TString>;
        name: Type.TOptional<Type.TString>;
        dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
        context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
        model: Type.TOptional<Type.TString>;
        fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
        thinking: Type.TOptional<Type.TUnsafe<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">>;
        cwd: Type.TOptional<Type.TString>;
        outputSchema: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
        timeoutMs: Type.TOptional<Type.TInteger>;
        background: Type.TOptional<Type.TBoolean>;
        todo: Type.TOptional<Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>>;
        briefing: Type.TOptional<Type.TArray<Type.TString>>;
        maxNestingDepth: Type.TOptional<Type.TInteger>;
    }>>;
    concurrency: Type.TOptional<Type.TInteger>;
    concurrencyWaitMs: Type.TOptional<Type.TInteger>;
    maxAgents: Type.TOptional<Type.TInteger>;
    maxNestingDepth: Type.TOptional<Type.TInteger>;
    outputSchema: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
    background: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
    fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TUnsafe<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">>;
    cwd: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const LocalTeammateListParams: Type.TObject<{
    view: Type.TOptional<Type.TUnsafe<"active" | "named" | "all" | "roles">>;
}>;
export declare const TeammateSendParams: Type.TObject<{
    to: Type.TString;
    message: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TUnsafe<"follow_up" | "steer" | "abort">>;
    kind: Type.TOptional<Type.TUnsafe<"coordination" | "request" | "supervision">>;
}>;
export declare const TeammateListParams: Type.TObject<{
    view: Type.TOptional<Type.TUnsafe<"active" | "windows" | "named" | "all" | "roles" | "inbox">>;
    session: Type.TOptional<Type.TString>;
    peer: Type.TOptional<Type.TString>;
    direction: Type.TOptional<Type.TUnsafe<"outgoing" | "incoming">>;
    status: Type.TOptional<Type.TUnsafe<"queued" | "accepted" | "injected" | "pending" | "rejected" | "timeout">>;
    since: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateWatchParams: Type.TObject<{
    name: Type.TString;
    lines: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateWaitParams: Type.TObject<{
    name: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    waitMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ObserveParams: Type.TObject<{
    action: Type.TUnsafe<"status" | "diagnose" | "wait" | "watch">;
    targets: Type.TArray<Type.TObject<{
        kind: Type.TString;
        id: Type.TString;
        cursor: Type.TOptional<Type.TString>;
    }>>;
    detail: Type.TOptional<Type.TUnsafe<"summary" | "tail" | "full">>;
    lines: Type.TOptional<Type.TInteger>;
    waitMode: Type.TOptional<Type.TUnsafe<"count" | "all" | "any">>;
    waitCount: Type.TOptional<Type.TInteger>;
    until: Type.TOptional<Type.TUnsafe<"completed" | "result-ready">>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    view: Type.TOptional<Type.TUnsafe<"turns" | "todos" | "session" | "live">>;
    turn: Type.TOptional<Type.TInteger>;
}>;
type LocalObserveParamsInput = Omit<Static<typeof ObserveParams>, "targets" | "view"> & {
    targets: Array<{
        kind: "teammate" | "bash_bg";
        id: string;
    }>;
    view?: "live" | "turns";
};
export declare const LocalObserveParams: Type.TUnsafe<LocalObserveParamsInput>;
export declare const TeammateMonitorParams: Type.TObject<{
    action: Type.TUnsafe<"status" | "wait">;
    targets: Type.TArray<Type.TString>;
    waitMode: Type.TOptional<Type.TUnsafe<"count" | "all" | "any">>;
    waitCount: Type.TOptional<Type.TInteger>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    lines: Type.TOptional<Type.TInteger>;
    verbose: Type.TOptional<Type.TBoolean>;
}>;
export declare const WorkspaceWindowParams: Type.TObject<{
    action: Type.TUnsafe<"close" | "create" | "list">;
    name: Type.TOptional<Type.TString>;
    objective: Type.TOptional<Type.TString>;
    presentation: Type.TOptional<Type.TUnsafe<"headless" | "interactive">>;
}>;
export declare const RemoteWorkerParams: Type.TObject<{
    action: Type.TUnsafe<"close" | "targets" | "create" | "list">;
    targetId: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    objective: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
}>;
export {};
