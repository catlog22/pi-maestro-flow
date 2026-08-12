/**
 * Teammate Extension Entry Point
 *
 * Tools: teammate (dispatch), teammate-send (RPC message injection), teammate-list (status), observe
 * TUI: Alt+R mode-aware session list, widget above editor, Alt+B foreground→background detach
 * Mode: RPC subprocess — stdin open for steer/follow_up/abort
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type WorkspacePeerMessageKind, type WorkspacePeerWindowListing } from "./workspace-peers.ts";
import type { RunTeammateParams } from "../runs/execution.ts";
import type { TeammateState, ChildAgentCallSnapshot } from "../shared/types.ts";
import { type TeammateModelCapability } from "../models/model-catalog.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";
import type { TeammateRuntimeOptions } from "./index.ts";
import type { RelayedQuestion, RelayedQuestionOption, TeammateInteractionQueue } from "./teammate-helpers.ts";
/**
 * Builds the serial queue that relays child permission/question requests to the
 * human. Serialization is deliberate — `ctx.ui.select` owns the terminal, so two
 * concurrent prompts would fight over it — but every entry is bounded and
 * cancellable, because the failure it guards against is a nested one: a parent
 * agent waits on a child, that child waits on a prompt, and that prompt waits
 * behind an unattended prompt belonging to an unrelated agent. Answering on the
 * child's behalf after a timeout keeps that chain from becoming permanent.
 */
export declare function createTeammateInteractionQueue(pi: ExtensionAPI, state: TeammateState, timeoutMs?: number): TeammateInteractionQueue;
export declare function replyChildRequestFailure(event: Record<string, unknown>, reply: (msg: unknown) => void, error: unknown): void;
export declare function showRelayedPermission(ctx: ExtensionContext, agentLabel: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
export declare function showRelayedQuestions(ctx: ExtensionContext, agentLabel: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
export declare function selectOne(ctx: ExtensionContext, title: string, options: RelayedQuestionOption[], signal?: AbortSignal): Promise<string[] | undefined>;
export declare function selectMultiple(ctx: ExtensionContext, title: string, options: RelayedQuestionOption[], signal?: AbortSignal): Promise<string[] | undefined>;
export declare function normalizeRelayedQuestion(value: Record<string, unknown>): RelayedQuestion | undefined;
export declare function replyInteraction(reply: (msg: unknown) => void, requestId: string, result: Record<string, unknown>): void;
export declare function interactionDetail(value: unknown): string;
export declare function questionSummary(value: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function dispatchRegisteredChildTool(event: Record<string, unknown>, reply: (message: unknown) => void, state?: TeammateState, verifiedCorrelationId?: string): Promise<boolean>;
/**
 * Cancels the agent a proxy request created, once its requester gave up.
 *
 * The nested dispatch runs in this process while the child that asked for it
 * waits over IPC. If that wait ends first — its 30-minute ceiling, or the child
 * itself being aborted — nothing used to tell this side, and the agent kept
 * running with no consumer and nobody left to settle it. Returns the ids of the
 * agents torn down.
 */
export declare function cancelProxyDispatch(state: TeammateState, requestId: string, reason?: string): string[];
export declare function beginProxyObservation(state: TeammateState, requestId: string, parentSignal?: AbortSignal): {
    signal: AbortSignal;
    dispose(): void;
};
export declare function withProxyObservation<T>(state: TeammateState, requestId: string, parentSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
/** Records which agent a proxy request created, so a later give-up can find it. */
export declare function trackProxyDispatch(state: TeammateState, requestId: string, correlationId: string): void;
/** Parse untrusted child IPC parameters before they enter shared normalization. */
export declare function parseProxyTeammateParams(params: Record<string, unknown>): RunTeammateParams | undefined;
export declare function parseThinkingInput(value: unknown): TeammateThinkingInput | undefined;
export declare function parseOutputSchema(value: unknown): Record<string, unknown> | undefined;
export declare function handleProxyRequest(pi: ExtensionAPI, state: TeammateState, event: Record<string, unknown>, rawReply: (msg: unknown) => void, spawnedBy?: string, modelCapabilities?: readonly TeammateModelCapability[], onInteraction?: (event: Record<string, unknown>, reply: (message: unknown) => void, correlationId: string) => void, onChildStatus?: (child: ChildAgentCallSnapshot) => void, runtimeOptions?: TeammateRuntimeOptions, mailboxDeliver?: (request: {
    senderId: string;
    recipientId: string;
    recipientCorrelationId: string;
    kind: "lifecycle" | "result" | "steer" | "follow_up" | "task" | "control";
    mode: "steer" | "follow_up" | "abort" | "notify";
    payload: string;
}) => Promise<{
    path: string;
    result: {
        ok: boolean;
    };
}>, workspacePeerSend?: (target: string, message: string, mode: "steer" | "follow_up") => Promise<boolean>, workspacePeerList?: () => Promise<readonly WorkspacePeerWindowListing[]>, sessionSend?: (request: {
    selector: string;
    message: string;
    mode: "steer" | "follow_up" | "abort";
    messageKind?: WorkspacePeerMessageKind;
}) => Promise<{
    delivered: boolean;
    error?: string;
    receipt?: {
        mode?: string;
        wasSleeping?: boolean;
        terminatedCount?: number;
    };
}>, refreshModelCapabilities?: () => Promise<readonly TeammateModelCapability[]>): Promise<void>;
