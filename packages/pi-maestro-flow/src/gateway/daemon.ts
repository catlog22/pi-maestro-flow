/** Lifecycle owner for the one packaged Gateway daemon. */
import type { GatewayConfig } from "./config.ts";
import { loadGatewayConfig } from "./config.ts";
import type { GatewayOwnerRecord } from "./contracts.ts";
import type { GatewayHttpServerHandle } from "./http-server.ts";
import { isLoopbackHost } from "./auth.ts";
import { gatewayIpcAddress, startGatewayIpcServer, type GatewayIpcServerHandle } from "./ipc.ts";
import { GatewayOwnerStore } from "./owner-store.ts";
import { gatewayLegacyPidPaths } from "./state-paths.ts";
import { GatewayRuntime, type GatewayRuntimeOptions } from "./runtime.ts";

export interface GatewayDaemonOptions extends Omit<GatewayRuntimeOptions, "config"> {
  config?: GatewayConfig;
  ownerStore?: GatewayOwnerStore;
  ipcAddress?: string;
  http?: boolean;
  httpHost?: string;
  httpPort?: number;
  httpPath?: string;
  commandIdentity?: string;
  /** Override legacy raw PID evidence paths; primarily useful for migration tests. */
  legacyPidPaths?: string[];
}

export class GatewayDaemon {
  readonly options: GatewayDaemonOptions;
  config?: GatewayConfig;
  runtime?: GatewayRuntime;
  owner?: GatewayOwnerRecord;
  ipc?: GatewayIpcServerHandle;
  http?: GatewayHttpServerHandle;
  private ownerStore?: GatewayOwnerStore;
  private stopping?: Promise<void>;
  private stopped: Promise<void> = Promise.resolve();
  private resolveStopped?: () => void;

  constructor(options: GatewayDaemonOptions = {}) {
    this.options = options;
  }

  async start(): Promise<this> {
    if (this.owner) return this;
    this.stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });
    const config = this.options.config ?? await loadGatewayConfig(this.options.configPath);
    this.config = config;
    const store = this.options.ownerStore ?? new GatewayOwnerStore({
      ownerPath: config.state.ownerPath,
      commandIdentity: this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath),
    });
    this.ownerStore = store;
    const address = this.options.ipcAddress ?? gatewayIpcAddress(undefined, store.ownerPath);
    const commandIdentity = this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath);
    if ((await store.read()) === undefined) {
      const legacyPidPaths = this.options.legacyPidPaths
        ?? (store.legacyPidPath ? [store.legacyPidPath] : gatewayLegacyPidPaths());
      for (const pidPath of legacyPidPaths) {
        const adopted = await store.tryAdoptLegacyPid({
          pidPath,
          expectedCommandIdentity: commandIdentity,
          socket: address,
        });
        if (adopted) break;
      }
    }
    // If migration adopted a live legacy process, claim observes the new
    // versioned owner and fails active instead of starting a duplicate daemon.
    const owner = await store.claim({ socket: address, commandIdentity });
    this.owner = owner;
    try {
      const runtime = await GatewayRuntime.create({ ...this.options, config });
      this.runtime = runtime;
      this.ipc = await startGatewayIpcServer(runtime, {
        ownerToken: owner.ownerToken,
        address,
        onControl: async (action, data) => {
          if (action === "status") {
            const host = runtime.host.test();
            const httpEnabled = this.options.http ?? config.transport.http.enabled;
            const httpReady = !httpEnabled || Boolean(this.http?.server.listening && runtime.isReady);
            return { ...host, readiness: { ipc: true, http: httpReady, ready: httpReady } };
          }
          if (action === "stop") { void this.stop(); return; }
          if (action === "workspace-list" || action === "workspace-register" || action === "workspace-renew" || action === "workspace-remove") {
            return runtime.workspace.control(action, data);
          }
          if (action === "pair" || action === "pair-bootstrap") {
            const http = config.transport.http;
            const effectiveHost = this.options.httpHost ?? http.host;
            const reverseProxyHttps = isLoopbackHost(effectiveHost) && config.server.trustProxyHeaders && config.auth.oauth?.serverUrl?.startsWith("https://");
            if (config.auth.mode === "open") throw new Error("Pairing requires authenticated Gateway HTTP");
            if (!http.tls?.enabled && !reverseProxyHttps && !isLoopbackHost(effectiveHost)) throw new Error("Pairing is refused for non-loopback plaintext HTTP");
            const ttlMs = data?.ttlMs;
            const label = data?.label;
            if (action === "pair-bootstrap" && (!this.http?.secure || !this.http.server.listening || !runtime.isReady)) throw new Error("Secure Gateway HTTPS is not ready for pairing");
            const issued = await runtime.pairingStore.issue({
              ...(ttlMs === undefined ? {} : { ttlMs: Number(ttlMs) }),
              ...(label === undefined ? {} : { label: String(label) }),
            });
            return action === "pair-bootstrap"
              ? { ...issued, endpoint: this.http!.url, serverName: "pi-maestro-gateway", protocolVersion: 1 }
              : issued;
          }
          if (action === "pair-list") return runtime.pairingStore.list();
          if (action === "pair-revoke") {
            if (typeof data?.id !== "string" || !data.id) throw new Error("pair-revoke requires an id");
            return { revoked: await runtime.pairingStore.revoke(data.id) };
          }
        },
      });
      const enableHttp = this.options.http ?? config.transport.http.enabled;
      if (enableHttp) {
        const { startGatewayHttpServer } = await import("./http-server.ts");
        this.http = await startGatewayHttpServer(runtime, {
          host: this.options.httpHost,
          port: this.options.httpPort,
          path: this.options.httpPath,
        });
      }
      return this;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const ownerToken = this.owner?.ownerToken;
      this.http?.setReady(false);
      await this.http?.close().catch(() => undefined);
      this.http = undefined;
      await this.ipc?.close().catch(() => undefined);
      this.ipc = undefined;
      await this.runtime?.close().catch(() => undefined);
      this.runtime = undefined;
      if (ownerToken) await this.ownerStore?.release(ownerToken).catch(() => undefined);
      this.owner = undefined;
    })();
    try { await this.stopping; }
    finally {
      this.stopping = undefined;
      this.resolveStopped?.();
      this.resolveStopped = undefined;
    }
  }

  waitUntilStopped(): Promise<void> { return this.stopped; }

  async close(): Promise<void> { await this.stop(); }
}

export async function startGatewayDaemon(options: GatewayDaemonOptions = {}): Promise<GatewayDaemon> {
  return new GatewayDaemon(options).start();
}
