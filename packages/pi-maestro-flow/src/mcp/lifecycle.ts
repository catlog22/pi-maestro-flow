import type { ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";

export type ReconnectCallback = (serverName: string) => void;

export interface ReconnectFailureEvent {
  serverName: string;
  attempt: number;
  nextRetryAt: number;
  error: Error;
}

export type ReconnectFailureCallback = (event: ReconnectFailureEvent) => void;

export interface McpLifecycleOptions {
  now?: () => number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectFailureNotifyThreshold?: number;
}

interface ReconnectFailureState {
  attempt: number;
  nextRetryAt: number;
  notified: boolean;
}

export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  private healthCheckInterval?: NodeJS.Timeout;
  private healthCheckInFlight = false;
  private healthCheckPromise?: Promise<void>;
  private lifecycleGeneration = 0;
  private reconnectFailures = new Map<string, ReconnectFailureState>();
  private onReconnect?: ReconnectCallback;
  private onReconnectFailure?: ReconnectFailureCallback;
  private onIdleShutdown?: (serverName: string) => void;
  private readonly now: () => number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectFailureNotifyThreshold: number;

  constructor(manager: McpServerManager, options: McpLifecycleOptions = {}) {
    this.manager = manager;
    this.now = options.now ?? Date.now;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 30_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5 * 60_000;
    this.reconnectFailureNotifyThreshold = options.reconnectFailureNotifyThreshold ?? 3;
  }

  /**
   * Set callback to be invoked after a successful auto-reconnect.
   * Use this to update tool metadata when a server reconnects.
   */
  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  setReconnectFailureCallback(callback: ReconnectFailureCallback): void {
    this.onReconnectFailure = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  startHealthChecks(intervalMs = 30000): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = setInterval(() => {
      void this.runHealthCheck();
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  async runHealthCheck(): Promise<void> {
    if (this.healthCheckInFlight) return this.healthCheckPromise;
    this.healthCheckInFlight = true;
    const generation = this.lifecycleGeneration;
    const pending = this.checkConnections(generation);
    this.healthCheckPromise = pending;
    try {
      await pending;
    } finally {
      if (this.healthCheckPromise === pending) {
        this.healthCheckInFlight = false;
        this.healthCheckPromise = undefined;
      }
    }
  }

  private async checkConnections(generation: number): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      if (generation !== this.lifecycleGeneration) return;
      const connection = this.manager.getConnection(name);

      if (!connection || connection.status !== "connected") {
        const previousFailure = this.reconnectFailures.get(name);
        if (previousFailure && previousFailure.nextRetryAt > this.now()) continue;
        try {
          const reconnected = await this.manager.connect(name, definition);
          if (generation !== this.lifecycleGeneration) {
            await this.manager.close(name);
            return;
          }
          if (reconnected.status !== "connected") {
            throw new Error(`server reported ${reconnected.status}`);
          }
          this.reconnectFailures.delete(name);
          logger.debug(`Reconnected to ${name}`);
          // Notify extension to update metadata
          this.onReconnect?.(name);
        } catch (error) {
          if (generation !== this.lifecycleGeneration) return;
          const failure = this.recordReconnectFailure(name);
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            `MCP reconnect failed for ${name}; attempt ${failure.attempt}, `
            + `next retry in ${Math.max(0, failure.nextRetryAt - this.now())}ms`,
            { server: name, error: normalizedError.message },
          );
          if (!failure.notified && failure.attempt >= this.reconnectFailureNotifyThreshold) {
            failure.notified = true;
            this.onReconnectFailure?.({
              serverName: name,
              attempt: failure.attempt,
              nextRetryAt: failure.nextRetryAt,
              error: normalizedError,
            });
          }
        }
      }
    }

    for (const [name] of this.allServers) {
      if (generation !== this.lifecycleGeneration) return;
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        if (generation !== this.lifecycleGeneration) return;
        this.onIdleShutdown?.(name);
      }
    }
  }

  private recordReconnectFailure(name: string): ReconnectFailureState {
    const previous = this.reconnectFailures.get(name);
    const attempt = (previous?.attempt ?? 0) + 1;
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * 2 ** Math.max(0, attempt - 1),
      this.reconnectMaxDelayMs,
    );
    const failure: ReconnectFailureState = {
      attempt,
      nextRetryAt: this.now() + delayMs,
      notified: previous?.notified ?? false,
    };
    this.reconnectFailures.set(name, failure);
    return failure;
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    this.lifecycleGeneration += 1;
    const pendingHealthCheck = this.healthCheckPromise;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    this.reconnectFailures.clear();
    await this.manager.closeAll();
    if (pendingHealthCheck) await Promise.allSettled([pendingHealthCheck]);
  }
}
