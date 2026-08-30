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
  spawn(request: MonitorWindowCreateRequest): Promise<{ ok: boolean; window?: Window; error?: string }>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns admission ordering, exact-owner revalidation, generation/root fencing,
 * and rollback. Cleanup is intentionally exact-window scoped and still runs
 * after authority loss so a partially launched process is not orphaned.
 */
export class MonitorWindowLifecycleService<Authority, Window, Owner, Handle, Delivery> {
  constructor(
    private readonly adapter: MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery>,
  ) {}

  async create(
    request: MonitorWindowCreateRequest,
    signal: AbortSignal,
  ): Promise<MonitorWindowCreateResult<Window, Owner, Handle>> {
    const authority = this.adapter.captureAuthority();
    if (!authority || !this.adapter.isAuthorityCurrent(authority)) {
      return { ok: false, error: "Active root Monitor authority is required." };
    }
    if (signal.aborted) return { ok: false, error: "Monitor window creation was aborted." };

    const handle = this.adapter.createHandle();
    const spawned = await this.adapter.spawn(request);
    if (!spawned.ok || !spawned.window) {
      return { ok: false, error: spawned.error ?? `Failed to create ${request.name}.` };
    }

    const window = spawned.window;
    let admittedOwner: Owner | undefined;
    let published = false;
    try {
      this.assertAuthority(authority, `window "${request.name}" launch`);
      this.assertCurrentWindow(window, request.name);

      admittedOwner = await this.adapter.waitForOwner(window, signal);
      this.assertAdmission(authority, window, admittedOwner, request.name, "workspace registration");

      await this.adapter.refreshOwners();
      this.assertAdmission(authority, window, admittedOwner, request.name, "admission refresh");

      this.adapter.bindHandle(window, handle);
      const delivery = await this.adapter.deliverObjective({
        request,
        window,
        owner: admittedOwner,
        handle,
        authority,
        signal,
        authorize: () => this.adapter.isAuthorityCurrent(authority),
      });
      const deliveryState = this.adapter.deliveryState(delivery);
      published = deliveryState.published;
      this.assertAdmission(authority, window, admittedOwner, request.name, "objective delivery");
      await this.adapter.refreshOwners();
      this.assertAdmission(authority, window, admittedOwner, request.name, "post-delivery refresh");

      if (published) this.adapter.commitPublished(window, handle);
      if (!deliveryState.accepted) {
        throw new Error(deliveryState.error ?? `Terminal result request for window "${request.name}" was not accepted.`);
      }
      return { ok: true, window, owner: admittedOwner, handle };
    } catch (error) {
      if (published) this.adapter.markCloseRequested(window, true);
      const cleanup = await this.adapter.stopExact(window);
      let completionPersisted = true;
      if (published && cleanup.ok) {
        completionPersisted = await this.adapter.finalizeCancelled(
          window,
          `Workspace window ${request.name} setup was rolled back before terminal work completed.`,
        );
      }
      const cleanupText = cleanup.ok
        ? `setup was rolled back (${cleanup.status ?? "stopped"})`
        : `ownership record retained: ${cleanup.error ?? "reclamation not proven"}`;
      const completionText = published && !completionPersisted
        ? " canonical cancelled completion could not be persisted"
        : "";
      return {
        ok: false,
        window,
        ...(admittedOwner === undefined ? {} : { owner: admittedOwner }),
        ...(published ? { handle } : {}),
        error: `${messageOf(error)}; ${cleanupText}.${completionText}`,
        cleanup,
        ...(published ? { completionPersisted } : {}),
      };
    }
  }

  async close(name: string): Promise<MonitorWindowCloseResult<Handle>> {
    const authority = this.adapter.captureAuthority();
    if (!authority || !this.adapter.isAuthorityCurrent(authority)) {
      return { ok: false, error: "Active root Monitor authority is required." };
    }
    const window = this.adapter.lookup(name);
    if (!window) return { ok: false, error: `No managed window "${name}".` };

    const handle = this.adapter.handleOf(window);
    const managed = this.adapter.isMonitorManaged(window);
    if (managed && handle) this.adapter.markCloseRequested(window, true);
    const stopped = await this.adapter.stopExact(window);
    if (!this.adapter.isAuthorityCurrent(authority)) {
      return {
        ok: false,
        error: `Root session or Monitor generation changed during window "${name}" close.`,
        ...(handle === undefined ? {} : { handle }),
        ...(stopped.status === undefined ? {} : { status: stopped.status }),
      };
    }
    if (!stopped.ok) {
      if (managed && handle) this.adapter.markCloseRequested(window, false);
      return { ...stopped, ...(handle === undefined ? {} : { handle }) };
    }
    if (!managed || !handle) return { ...stopped, ...(handle === undefined ? {} : { handle }) };

    const completionPersisted = await this.adapter.finalizeCancelled(
      window,
      `Workspace window ${name} was closed by its Monitor owner.`,
    );
    if (!this.adapter.isAuthorityCurrent(authority)) {
      return {
        ok: false,
        status: stopped.status,
        handle,
        completionPersisted,
        error: `Root session or Monitor generation changed while window "${name}" close completion was persisted.`,
      };
    }
    if (!completionPersisted) {
      return {
        ok: false,
        status: stopped.status,
        handle,
        completionPersisted,
        error: `Closed Monitor-owned window ${name} (${stopped.status ?? "stopped"}), but canonical cancelled completion could not be persisted.`,
      };
    }
    return { ...stopped, handle, completionPersisted };
  }

  private assertAuthority(authority: Authority, phase: string): void {
    if (!this.adapter.isAuthorityCurrent(authority)) {
      throw new Error(`Root session or Monitor generation changed during ${phase}.`);
    }
  }

  private assertCurrentWindow(window: Window, name: string): void {
    if (!this.adapter.isCurrentWindow(window)) {
      throw new Error(`managed window "${name}" was replaced`);
    }
  }

  private assertAdmission(
    authority: Authority,
    window: Window,
    admittedOwner: Owner,
    name: string,
    phase: string,
  ): void {
    this.assertAuthority(authority, phase);
    this.assertCurrentWindow(window, name);
    const current = this.adapter.exactOwner(window);
    if (!current || !this.adapter.sameOwner(current, admittedOwner)) {
      throw new Error(`window "${name}" changed its exact owner during ${phase}.`);
    }
  }
}
