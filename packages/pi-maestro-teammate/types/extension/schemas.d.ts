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
import { Type } from "typebox";
export declare const TaskSpec: Type.TObject<{
    prompt: Type.TString;
    agent: Type.TOptional<Type.TString>;
    taskType: Type.TOptional<Type.TUnsafe<unknown>>;
    name: Type.TOptional<Type.TString>;
    dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
    fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    maxNestingDepth: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateParams: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    taskType: Type.TOptional<Type.TUnsafe<unknown>>;
    reply_to: Type.TOptional<Type.TUnsafe<"main" | "caller">>;
    tasks: Type.TArray<Type.TObject<{
        prompt: Type.TString;
        agent: Type.TOptional<Type.TString>;
        taskType: Type.TOptional<Type.TUnsafe<unknown>>;
        name: Type.TOptional<Type.TString>;
        dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
        context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
        model: Type.TOptional<Type.TString>;
        fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
        thinking: Type.TOptional<Type.TUnsafe<unknown>>;
        cwd: Type.TOptional<Type.TString>;
        outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
        timeoutMs: Type.TOptional<Type.TInteger>;
        maxNestingDepth: Type.TOptional<Type.TInteger>;
    }>>;
    concurrency: Type.TOptional<Type.TInteger>;
    maxAgents: Type.TOptional<Type.TInteger>;
    maxNestingDepth: Type.TOptional<Type.TInteger>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    background: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
    fallbackModels: Type.TOptional<Type.TArray<Type.TString>>;
    thinking: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateSendParams: Type.TObject<{
    to: Type.TString;
    message: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TUnsafe<"steer" | "follow_up" | "abort">>;
}>;
export declare const TeammateListParams: Type.TObject<{
    view: Type.TOptional<Type.TUnsafe<"active" | "named" | "all" | "roles">>;
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
    action: Type.TUnsafe<"status" | "wait" | "watch">;
    targets: Type.TArray<Type.TObject<{
        kind: Type.TString;
        id: Type.TString;
    }>>;
    detail: Type.TOptional<Type.TUnsafe<"summary" | "tail" | "full">>;
    lines: Type.TOptional<Type.TInteger>;
    waitMode: Type.TOptional<Type.TUnsafe<"count" | "all" | "any">>;
    waitCount: Type.TOptional<Type.TInteger>;
    until: Type.TOptional<Type.TUnsafe<"completed" | "result-ready">>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateMonitorParams: Type.TObject<{
    action: Type.TUnsafe<"status" | "wait">;
    targets: Type.TArray<Type.TString>;
    waitMode: Type.TOptional<Type.TUnsafe<"count" | "all" | "any">>;
    waitCount: Type.TOptional<Type.TInteger>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    lines: Type.TOptional<Type.TInteger>;
    verbose: Type.TOptional<Type.TBoolean>;
}>;
