/**
 * Shared Monitor-owned local window lifecycle orchestration.
 *
 * Process launch, workspace discovery, delivery, and completion persistence stay
 * in the root extension. This service owns the create/close ordering and fences
 * so model tools and slash-command compatibility entry points cannot drift.
 */
export interface MonitorWindowCreateRequest {
    name: string;
    objective: string;
    cwd: string;
    presentation: "interactive" | "headless";
    provider?: "native" | "herdr";
    herdrSession?: string;
}
export interface MonitorWindowStopResult {
    ok: boolean;
    /** True once process termination has been invoked, regardless of its outcome. */
    terminationStarted: boolean;
    status?: string;
    error?: string;
}
export interface MonitorWindowDeliveryState {
    published: boolean;
    accepted: boolean;
    error?: string;
}
export interface MonitorWindowCreateResult<Window, Owner, Handle> {
    ok: boolean;
    window?: Window;
    owner?: Owner;
    handle?: Handle;
    error?: string;
    cleanup?: MonitorWindowStopResult;
    completionPersisted?: boolean;
}
export interface MonitorWindowCloseResult<Handle> extends MonitorWindowStopResult {
    handle?: Handle;
    completionPersisted?: boolean;
}
export interface MonitorWindowStopAuthorization<Authority> {
    /** Exact-resource rollback is create-only; ordinary close remains Monitor-authority fenced. */
    scope: "exact-resource" | "monitor-authority";
    /** Captured root/Monitor generation retained for adapter-side diagnostics. */
    authority: Authority;
    /** Must be checked after every await and immediately before termination. */
    authorize(): boolean;
}
export interface MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery> {
    captureAuthority(): Authority | undefined;
    isAuthorityCurrent(authority: Authority): boolean;
    createHandle(): Handle;
    spawn(request: MonitorWindowCreateRequest, authority: Authority, signal: AbortSignal): Promise<{
        ok: boolean;
        window?: Window;
        error?: string;
    }>;
    isCurrentWindow(window: Window): boolean;
    waitForOwner(window: Window, signal: AbortSignal): Promise<Owner>;
    refreshOwners(): Promise<void>;
    exactOwner(window: Window): Owner | undefined;
    sameOwner(left: Owner, right: Owner): boolean;
    bindHandle(window: Window, handle: Handle): void;
    deliverObjective(input: {
        request: MonitorWindowCreateRequest;
        window: Window;
        owner: Owner;
        handle: Handle;
        authority: Authority;
        signal: AbortSignal;
        authorize: () => boolean;
    }): Promise<Delivery>;
    deliveryState(delivery: Delivery): MonitorWindowDeliveryState;
    commitPublished(window: Window, handle: Handle): void;
    lookup(name: string): Window | undefined;
    handleOf(window: Window): Handle | undefined;
    isMonitorManaged(window: Window): boolean;
    markCloseRequested(window: Window, requested: boolean): void;
    stopExact(window: Window, authorization: MonitorWindowStopAuthorization<Authority>): Promise<MonitorWindowStopResult>;
    finalizeCancelled(window: Window, message: string): Promise<boolean>;
}
/**
 * Owns admission ordering, exact-owner revalidation, generation/root fencing,
 * and rollback. Create rollback may reclaim only the exact spawned resource
 * after authority loss; ordinary close always remains root/Monitor fenced.
 */
export declare class MonitorWindowLifecycleService<Authority, Window, Owner, Handle, Delivery> {
    private readonly adapter;
    constructor(adapter: MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery>);
    create(request: MonitorWindowCreateRequest, signal: AbortSignal): Promise<MonitorWindowCreateResult<Window, Owner, Handle>>;
    close(name: string): Promise<MonitorWindowCloseResult<Handle>>;
    private stopAuthorization;
    private assertAuthority;
    private assertCurrentWindow;
    private assertAdmission;
}
