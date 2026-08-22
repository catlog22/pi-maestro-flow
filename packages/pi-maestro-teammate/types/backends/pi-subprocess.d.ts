/**
 * The Pi subprocess backend.
 *
 * Pi reaches the orchestrator through the same `TeammateBackend` contract every
 * other backend uses. It ships in this package because its implementation needs
 * this package's agent resolution, model routing, and child-extension wiring —
 * not because it is exempt. Living beside the orchestrator is not a bypass;
 * skipping the interface would be, and there is no path that does.
 */
import type { AttemptOutcome, BackendConfigField, BackendRunOptions, TeammateBackend } from "pi-maestro-backend-core/v1";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { ReplyTarget } from "../shared/routing.ts";
import type { RunTeammateOptions } from "../runs/execution-infra.ts";
/**
 * Pi's own configuration fields.
 *
 * Exported so a settings shell renders the same list the backend validates
 * against. A host that restated them would drift the moment a tunable is added.
 */
export declare const PI_SUBPROCESS_CONFIG_FIELDS: readonly BackendConfigField[];
/**
 * Display text for the `piSubprocess.*` keys this backend's `configFields` carry.
 *
 * The settings shell renders from labels, not keys: a field declared without an
 * entry here reaches an operator as `piSubprocess.resultReadyGraceMs` rather
 * than as a human label. Each tunable is a Pi-internal timing knob, so the
 * wording says what it bounds, not how it is spelled.
 */
export declare const PI_SUBPROCESS_SETTINGS_CATALOGS: {
    readonly en: {
        readonly "piSubprocess.firstActivityTimeoutMs": "First-activity timeout (ms)";
        readonly "piSubprocess.firstActivityTimeoutMs.description": "Milliseconds the subprocess has to report its first activity after launch before it is considered hung.";
        readonly "piSubprocess.resultReadyGraceMs": "Result-ready grace (ms)";
        readonly "piSubprocess.resultReadyGraceMs.description": "Grace period after a run settles before its result is considered final, so a late completion can still be captured.";
        readonly "piSubprocess.outputLimitRecoveryTimeoutMs": "Output-limit recovery timeout (ms)";
        readonly "piSubprocess.outputLimitRecoveryTimeoutMs.description": "Time allowed to recover a result whose output exceeded the size limit.";
        readonly "piSubprocess.structuredOutputRecoveryTimeoutMs": "Structured-output recovery timeout (ms)";
        readonly "piSubprocess.structuredOutputRecoveryTimeoutMs.description": "Time allowed to recover a structured-output result that exceeded the size limit.";
        readonly "piSubprocess.toolExecutionHeartbeatMs": "Tool-execution heartbeat (ms)";
        readonly "piSubprocess.toolExecutionHeartbeatMs.description": "Interval at which an active tool execution reports a heartbeat, used to detect stuck tools.";
        readonly "piSubprocess.interruptingSteerTimeoutMs": "Interrupting-steer timeout (ms)";
        readonly "piSubprocess.interruptingSteerTimeoutMs.description": "Time an interrupting steer waits for the run to acknowledge before degrading to a queued follow-up.";
        readonly "piSubprocess.foregroundMaxRunMs": "Foreground max run (ms)";
        readonly "piSubprocess.foregroundMaxRunMs.description": "Upper bound on a foreground run before it auto-detaches to background.";
    };
    readonly "zh-CN": {
        readonly "piSubprocess.firstActivityTimeoutMs": "首次活动超时（毫秒）";
        readonly "piSubprocess.firstActivityTimeoutMs.description": "子进程启动后报告首次活动的毫秒上限，超过即视为挂起。";
        readonly "piSubprocess.resultReadyGraceMs": "结果就绪宽限（毫秒）";
        readonly "piSubprocess.resultReadyGraceMs.description": "运行结束后、结果被判定为最终之前的宽限期，以便补发迟到的完成。";
        readonly "piSubprocess.outputLimitRecoveryTimeoutMs": "输出超限恢复超时（毫秒）";
        readonly "piSubprocess.outputLimitRecoveryTimeoutMs.description": "为输出超过大小限制的结果恢复所允许的时间。";
        readonly "piSubprocess.structuredOutputRecoveryTimeoutMs": "结构化输出恢复超时（毫秒）";
        readonly "piSubprocess.structuredOutputRecoveryTimeoutMs.description": "为超过大小限制的结构化输出结果恢复所允许的时间。";
        readonly "piSubprocess.toolExecutionHeartbeatMs": "工具执行心跳（毫秒）";
        readonly "piSubprocess.toolExecutionHeartbeatMs.description": "活动中的工具执行报告心跳的间隔，用于检测卡住的工具。";
        readonly "piSubprocess.interruptingSteerTimeoutMs": "中断式 steer 超时（毫秒）";
        readonly "piSubprocess.interruptingSteerTimeoutMs.description": "中断式 steer 等待运行确认的时间，超时后降级为排队 follow-up。";
        readonly "piSubprocess.foregroundMaxRunMs": "前台最长运行（毫秒）";
        readonly "piSubprocess.foregroundMaxRunMs.description": "前台运行自动转为后台之前的运行时长上限。";
    };
};
/**
 * Read the facts an attempt recorded about itself.
 *
 * Exported so the legacy dispatch path yields the same shape as the backend
 * path: with both producing an outcome, the orchestrator reads recovery facts
 * from a value instead of from a side channel it can forget to consult.
 *
 * @param result - the settled result the attempt keyed its facts on.
 * @returns the settled attempt, in contract shape.
 */
export declare function outcomeOf(result: SingleResult): AttemptOutcome;
/** Per-run wiring the host supplies but the contract keeps out of the spec. */
export interface PiSubprocessRunExtras {
    /** Host-owned run options that are not orchestrator-visible requests. */
    hostOptions: RunTeammateOptions;
    /** Resolved task cwd; already absolute. */
    cwd: string;
    /**
     * Where this run's completion is delivered.
     *
     * Supplied by the host because it owns the routing decision and holds the
     * `reply_to` the spec does not carry. Recomputing it here from the spec would
     * see only `name`, so a task addressed to `main` would silently reply to its
     * caller on this path and to `main` on the legacy one.
     */
    replyTo: ReplyTarget;
}
/**
 * Create the Pi subprocess backend.
 *
 * @param extrasOf - supplies the per-run host wiring the contract does not carry.
 * @returns the backend, ready for registration.
 */
export declare function createPiSubprocessBackend(extrasOf: (spec: TeammateRunSpec, options: BackendRunOptions) => PiSubprocessRunExtras): TeammateBackend;
