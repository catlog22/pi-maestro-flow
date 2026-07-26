/**
 * Cross-package registry for teammate child extensions and the authorities
 * (permission broker, child tool brokers, IPC proxy caller) that the parent
 * session contributes to child processes.
 *
 * Ownership model — read before adding an authority: the `owner` on
 * {@link RegisterTeammateAuthorityOptions} is a *collaboration convention*, not
 * a security boundary. It is a self-declared string that the registry cannot
 * authenticate: any module sharing this globalThis registry may claim any owner
 * key. Its purpose is to let one package replace its own prior generation on
 * reload while making an unrelated package's collision a loud error instead of
 * a silent takeover. Do not treat a matching owner as proof of identity; the
 * real trust boundary is which modules get loaded into the process at all.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface TeammateChildExtensionRegistration {
    path: string;
    tools: readonly string[];
}
export interface RegisterTeammateChildExtensionOptions {
    tools?: readonly string[];
}
export interface RegisterTeammateAuthorityOptions {
    /** Stable package/session authority key. Re-registering the same key replaces its prior generation. */
    owner?: string;
}
/** Why an authority lookup produced (or failed to produce) a broker. */
export type TeammateAuthorityStatus = "resolved" | "unregistered" | "conflict";
/**
 * Diagnostic result of an authority lookup. `broker` is populated only for
 * `status: "resolved"`; `unregistered` and `conflict` both leave it undefined
 * but stay distinguishable so callers can log why they fell back.
 */
export interface TeammateAuthorityResolution<TBroker> {
    status: TeammateAuthorityStatus;
    broker?: TBroker;
    /** Human-readable explanation, present whenever `broker` is undefined. */
    reason?: string;
    /** Owner labels of every registration considered, in registration order. */
    owners?: string[];
}
export interface TeammatePermissionBrokerRequest {
    toolName: string;
    input: Record<string, unknown>;
}
export interface TeammatePermissionBrokerResult {
    action: "allow_once" | "deny";
    reason?: string;
    updatedInput?: Record<string, unknown>;
}
export type TeammatePermissionBroker = (request: TeammatePermissionBrokerRequest, ctx: ExtensionContext) => Promise<TeammatePermissionBrokerResult>;
export interface TeammateChildToolActor {
    correlationId: string;
    name?: string;
    agent?: string;
}
export interface TeammateChildToolBrokerRequest {
    toolName: string;
    input: Record<string, unknown>;
    actor: TeammateChildToolActor;
}
export interface TeammateChildToolResult {
    content: AgentToolResult<unknown>["content"];
    details?: unknown;
    isError?: boolean;
}
export type TeammateChildToolBroker = (request: TeammateChildToolBrokerRequest) => Promise<TeammateChildToolResult>;
export type TeammateChildProxyCaller = <T = unknown>(toolName: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<T>>;
/**
 * Registers an extension that must also be loaded by every teammate child.
 *
 * The registry lives on globalThis so independently loaded package modules can
 * contribute child extensions without making pi-maestro-teammate depend on
 * those packages.
 */
export declare function registerTeammateChildExtension(extensionPath: string, options?: RegisterTeammateChildExtensionOptions): () => void;
export declare function getTeammateChildExtensions(): TeammateChildExtensionRegistration[];
/** Registers the live parent-session authority used to decide child tool calls. */
export declare function registerTeammatePermissionBroker(broker: TeammatePermissionBroker, options?: RegisterTeammateAuthorityOptions): () => void;
export declare function getTeammatePermissionBroker(): TeammatePermissionBroker | undefined;
/**
 * Diagnostic form of {@link getTeammatePermissionBroker}: separates "nobody
 * registered" from "two generations are registered", which the plain getter
 * collapses into the same silent `undefined`.
 */
export declare function resolveTeammatePermissionBroker(): TeammateAuthorityResolution<TeammatePermissionBroker>;
/** Registers a root-session handler for a tool exposed by an inherited child extension. */
export declare function registerTeammateChildToolBroker(toolName: string, broker: TeammateChildToolBroker, options?: RegisterTeammateAuthorityOptions): () => void;
export declare function getTeammateChildToolBroker(toolName: string): TeammateChildToolBroker | undefined;
/**
 * Diagnostic form of {@link getTeammateChildToolBroker}: an unhandled tool and
 * a contested tool are different failures and must be reportable as such.
 */
export declare function resolveTeammateChildToolBroker(toolName: string): TeammateAuthorityResolution<TeammateChildToolBroker>;
/**
 * Installs the child-process IPC caller owned by the teammate extension.
 *
 * Shares the owner semantics of the broker registries: a foreign owner cannot
 * silently take over the channel (which would expose every proxied tool call),
 * and a stale disposer can no longer clear a newer generation. Callers that
 * pass no owner share the default teammate slot, preserving the historical
 * last-registration-wins behaviour for the package's own reload path.
 */
export declare function registerTeammateChildProxyCaller(caller: TeammateChildProxyCaller, options?: RegisterTeammateAuthorityOptions): () => void;
export declare function proxyTeammateChildTool<T = unknown>(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<T>>;
