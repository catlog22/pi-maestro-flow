/**
 * TypeBox schemas for teammate tool parameters.
 *
 * Unified TaskSpec model:
 *   - Single agent: { agent, task }
 *   - Multi-task: { tasks: TaskSpec[] } with {name} variable references defining execution order
 *   - Top-level fields serve as defaults, per-task overrides win
 *
 * P0 three-axis decoupling:
 *   - name: addressability + variable referencing
 *   - reply_to: result routing (caller | main)
 */
import { Type } from "typebox";
export declare const TaskSpec: Type.TObject<{
    agent: Type.TString;
    task: Type.TOptional<Type.TString>;
    prompt: Type.TOptional<Type.TString>;
    promptArgs: Type.TOptional<Type.TArray<Type.TString>>;
    taskType: Type.TOptional<Type.TUnsafe<unknown>>;
    name: Type.TOptional<Type.TString>;
    dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
    thinking: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const TeammateParams: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    task: Type.TOptional<Type.TString>;
    prompt: Type.TOptional<Type.TString>;
    promptArgs: Type.TOptional<Type.TArray<Type.TString>>;
    taskType: Type.TOptional<Type.TUnsafe<unknown>>;
    name: Type.TOptional<Type.TString>;
    reply_to: Type.TOptional<Type.TUnsafe<"main" | "caller">>;
    tasks: Type.TOptional<Type.TArray<Type.TObject<{
        agent: Type.TString;
        task: Type.TOptional<Type.TString>;
        prompt: Type.TOptional<Type.TString>;
        promptArgs: Type.TOptional<Type.TArray<Type.TString>>;
        taskType: Type.TOptional<Type.TUnsafe<unknown>>;
        name: Type.TOptional<Type.TString>;
        dependsOn: Type.TOptional<Type.TArray<Type.TString>>;
        context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
        model: Type.TOptional<Type.TString>;
        thinking: Type.TOptional<Type.TUnsafe<unknown>>;
        cwd: Type.TOptional<Type.TString>;
        outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
        timeoutMs: Type.TOptional<Type.TInteger>;
    }>>>;
    chain: Type.TOptional<Type.TArray<Type.TObject<{
        agent: Type.TString;
        task: Type.TOptional<Type.TString>;
        model: Type.TOptional<Type.TString>;
        thinking: Type.TOptional<Type.TUnsafe<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">>;
        taskType: Type.TOptional<Type.TUnsafe<"explore" | "analysis" | "debug" | "planning" | "development" | "review" | "testing">>;
        prompt: Type.TOptional<Type.TString>;
        promptArgs: Type.TOptional<Type.TArray<Type.TString>>;
    }>>>;
    concurrency: Type.TOptional<Type.TInteger>;
    maxAgents: Type.TOptional<Type.TInteger>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    background: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TUnsafe<"fresh" | "fork">>;
    model: Type.TOptional<Type.TString>;
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
