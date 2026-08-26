import { logDiagnosticError } from "../shared/diagnostic-log.ts";
import {
  createRuntimeActorHost,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
} from "../runtime-broker/actor-host.ts";
import { RUNTIME_V2_REVISION, RUNTIME_V2_VERSION } from "../runtime-v2/contracts.ts";

export interface WindowSupervisorRuntimeActorOptions {
  cwd: string;
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  generation: number;
  host?: RuntimeActorHostClient;
  onError?: (error: unknown) => void;
}

/** Advisory Runtime Broker binding for the v1 workspace-peer window owner. */
export class WindowSupervisorRuntimeActor {
  readonly #ownsHost: boolean;
  readonly #options: WindowSupervisorRuntimeActorOptions;
  #host: RuntimeActorHostClient | undefined;
  #lease: RuntimeActorLease | undefined;
  #stopped = false;

  constructor(options: WindowSupervisorRuntimeActorOptions) {
    this.#options = options;
    this.#host = options.host;
    this.#ownsHost = options.host === undefined;
  }

  get active(): boolean {
    return this.#lease?.active === true;
  }

  async start(): Promise<boolean> {
    if (this.#stopped) return false;
    try {
      const host = this.#host ??= createRuntimeActorHost({ cwd: this.#options.cwd });
      const actor = {
        version: RUNTIME_V2_VERSION,
        revision: RUNTIME_V2_REVISION,
        workspaceId: this.#options.workspaceId,
        actorKind: "root" as const,
        actorId: this.#options.ownerId,
        generation: this.#options.generation,
      };
      const lease = await host.acquire({
        leaseActorId: `window-supervisor:${this.#options.workspaceId}:${this.#options.ownerId}`,
        holderId: `${this.#options.ownerId}:${this.#options.ownerNonce}`,
        streamId: `window-supervisor:${this.#options.workspaceId}:${this.#options.generation}`,
        actor,
      });
      if (this.#stopped) {
        await lease?.release().catch(() => undefined);
        return false;
      }
      this.#lease = lease;
      return host.mode === "off" || lease?.active === true;
    } catch (error) {
      this.#report(error);
      if (this.#ownsHost) {
        await this.#host?.stop().catch((stopError) => this.#report(stopError));
        this.#host = undefined;
      }
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const lease = this.#lease;
    this.#lease = undefined;
    try {
      await lease?.release();
    } catch (error) {
      this.#report(error);
    } finally {
      if (this.#ownsHost) await this.#host?.stop().catch((error) => this.#report(error));
    }
  }

  #report(error: unknown): void {
    try {
      this.#options.onError?.(error);
    } catch {}
    if (!this.#options.onError) {
      logDiagnosticError("[pi-maestro-teammate] WindowSupervisor runtime actor mutation failed:", error);
    }
  }
}

export function createWindowSupervisorRuntimeActor(
  options: WindowSupervisorRuntimeActorOptions,
): WindowSupervisorRuntimeActor {
  return new WindowSupervisorRuntimeActor(options);
}
