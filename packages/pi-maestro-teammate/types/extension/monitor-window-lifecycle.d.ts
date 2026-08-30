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
}
export interface MonitorWindowStopResult {
    ok: boolean;
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
export interface MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery> {
    captureAuthority(): Authority | undefined;
    isAuthorityCurrent(authority: Authority): boolean;
    createHandle(): Handle;
    spawn(request: MonitorWindowCreateRequest): Promise<{
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
    stopExact(window: Window): Promise<MonitorWindowStopResult>;
    finalizeCancelled(window: Window, message: string): Promise<boolean>;
}
/**
 * Owns admission ordering, exact-owner revalidation, generation/root fencing,
 * and rollback. Cleanup is intentionally exact-window scoped and still runs
 * after authority loss so a partially launched process is not orphaned.
 */
export declare class MonitorWindowLifecycleService<Authority, Window, Owner, Handle, Delivery> {
    private readonly adapter;
    constructor(adapter: MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery>);
    create(request: MonitorWindowCreateRequest, signal: AbortSignal): Promise<MonitorWindowCreateResult<Window, Owner, Handle>>;
    close(name: string): Promise<MonitorWindowCloseResult<Handle>>;
    private assertAuthority;
    private assertCurrentWindow;
    private assertAdmission;
}
