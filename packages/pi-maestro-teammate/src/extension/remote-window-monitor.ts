import { randomUUID } from "node:crypto";
import type { RemoteConnection, RemoteConnectionFactory } from "../remote/driver.ts";
import {
  negotiateRemoteWindowBridge,
  normalizeRemoteWindowNotification,
  normalizeRemoteWindowObserveResult,
  normalizeRemoteWindowReceiptResult,
  normalizeRemoteWindowListResult,
  normalizeRemoteWindowReceipt,
  type RemoteWindowBridgeDiagnosticCode,
  type RemoteWindowCapture,
  type RemoteWindowListing,
  type RemoteWindowMessageNotification,
  type RemoteWindowNotification,
  type RemoteWindowObserveResult,
  type RemoteWindowReceipt,
} from "../remote/protocol.ts";
import type { RemoteConfig } from "../remote/config.ts";
import { resolveRemoteWorkspace } from "../remote/config.ts";
import type { RemoteWorkerIdentity, ResolvedRemoteWorkspace } from "../remote/types.ts";
import { remoteWindowCaptureMatches } from "../remote/window-protocol.ts";
import type { SessionMessageKind, SessionMessageMode, SessionMessageSource } from "../sessions/session-core.ts";

export interface RemoteWindowMonitorListing extends RemoteWindowListing {
  target: string;
  workspaceRef: string;
  authorityId: string;
}

export interface RemoteWindowMonitorDiagnostic {
  workspaceRef: string;
  code: RemoteWindowBridgeDiagnosticCode | "transport";
  message: string;
}

export interface RemoteWindowMonitorListResult {
  windows: readonly RemoteWindowMonitorListing[];
  diagnostics: readonly RemoteWindowMonitorDiagnostic[];
}

export interface RemoteWindowMonitorOptions {
  config: RemoteConfig;
  connectionFactory: RemoteConnectionFactory & { close?(): Promise<void> };
  monitorOwnerNonce: string;
  isCurrent: () => boolean;
  onNotification?: (target: string, notification: RemoteWindowNotification) => void;
  commandIdFactory?: () => string;
}

interface WorkspaceBinding {
  workspace: ResolvedRemoteWorkspace;
  connection: RemoteConnection;
  identity: RemoteWorkerIdentity;
  notificationPump: Promise<void>;
}

function stableTarget(capture: Pick<RemoteWindowCapture, "workspaceRef" | "ownerId">): string {
  return `ssh-window:${capture.workspaceRef}:${capture.ownerId}`;
}

function parseTarget(target: string): { workspaceRef: string; ownerId: string } | undefined {
  if (!target.startsWith("ssh-window:")) return undefined;
  const suffix = target.slice("ssh-window:".length);
  const separator = suffix.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const workspaceRef = suffix.slice(0, separator);
  const ownerId = suffix.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(workspaceRef) || !/^[a-f0-9]{32}$/.test(ownerId)) return undefined;
  return { workspaceRef, ownerId };
}

export class RemoteWindowMonitor {
  readonly #config: RemoteConfig;
  readonly #connectionFactory: RemoteWindowMonitorOptions["connectionFactory"];
  readonly #monitorOwnerNonce: string;
  readonly #isCurrent: () => boolean;
  readonly #onNotification?: RemoteWindowMonitorOptions["onNotification"];
  readonly #commandIdFactory: () => string;
  readonly #bindings = new Map<string, WorkspaceBinding>();
  readonly #windows = new Map<string, RemoteWindowMonitorListing>();
  #closed = false;

  constructor(options: RemoteWindowMonitorOptions) {
    this.#config = options.config;
    this.#connectionFactory = options.connectionFactory;
    this.#monitorOwnerNonce = options.monitorOwnerNonce;
    this.#isCurrent = options.isCurrent;
    this.#onNotification = options.onNotification;
    this.#commandIdFactory = options.commandIdFactory ?? randomUUID;
  }

  async list(signal?: AbortSignal): Promise<RemoteWindowMonitorListResult> {
    this.#assertCurrent();
    const windows: RemoteWindowMonitorListing[] = [];
    const diagnostics: RemoteWindowMonitorDiagnostic[] = [];
    for (const workspaceRef of Object.keys(this.#config.workspaces).sort()) {
      try {
        const binding = await this.#binding(workspaceRef, signal);
        this.#assertCurrentAfterAwait(binding, "remote window discovery");
        if (!binding.connection.windowList) throw new Error("Remote connection does not implement window/list");
        const result = normalizeRemoteWindowListResult(await binding.connection.windowList({
          commandId: this.#commandIdFactory(),
          monitorOwnerNonce: this.#monitorOwnerNonce,
          workspaceRef,
          authorityId: binding.workspace.host,
          transportVersion: 1,
        }));
        this.#assertCurrentAfterAwait(binding, "remote window discovery");
        for (const window of result.windows) {
          if (window.capture.gatewayWorkerId !== binding.identity.workerId
            || window.capture.gatewayInstanceNonce !== binding.identity.instanceNonce
            || window.capture.monitorOwnerNonce !== this.#monitorOwnerNonce
            || window.capture.workspaceRef !== workspaceRef
            || window.capture.authorityId !== binding.workspace.host) {
            throw new Error("Remote window list returned a stale or foreign capture");
          }
          const target = stableTarget(window.capture);
          const listing: RemoteWindowMonitorListing = Object.freeze({
            ...window,
            target,
            workspaceRef,
            authorityId: binding.workspace.host,
          });
          windows.push(listing);
          this.#windows.set(target, listing);
        }
        if (result.windows.length === 0) {
          diagnostics.push({ workspaceRef, code: "no-active-window", message: "Remote workspace has no active compatible teammate window" });
        }
      } catch (error) {
        await this.#dropBinding(workspaceRef);
        if (!this.#isCurrent()) throw new Error("Monitor authority changed during remote window discovery", { cause: error });
        diagnostics.push({
          workspaceRef,
          code: "transport",
          message: error instanceof Error ? error.message : "Remote window discovery failed",
        });
      }
    }
    const currentTargets = new Set(windows.map((window) => window.target));
    for (const target of this.#windows.keys()) {
      if (!currentTargets.has(target)) this.#windows.delete(target);
    }
    return Object.freeze({
      windows: Object.freeze(windows.sort((left, right) => left.target.localeCompare(right.target))),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  capture(target: string): RemoteWindowCapture | undefined {
    const parsed = parseTarget(target);
    if (!parsed) return undefined;
    const listing = this.#windows.get(target);
    if (!listing || listing.workspaceRef !== parsed.workspaceRef || listing.capture.ownerId !== parsed.ownerId) return undefined;
    return listing.capture;
  }

  listing(target: string): RemoteWindowMonitorListing | undefined {
    return this.#windows.get(target);
  }

  listings(): readonly RemoteWindowMonitorListing[] {
    return Object.freeze([...this.#windows.values()].sort((left, right) => left.target.localeCompare(right.target)));
  }

  async observe(target: string): Promise<RemoteWindowObserveResult> {
    const listing = this.#requireTarget(target);
    const binding = await this.#binding(listing.workspaceRef);
    this.#assertCurrentAfterAwait(binding, "remote window observation");
    if (!binding.connection.windowObserve) throw new Error("Remote connection does not implement window/observe");
    const result = normalizeRemoteWindowObserveResult(await binding.connection.windowObserve({
      commandId: this.#commandIdFactory(),
      monitorOwnerNonce: this.#monitorOwnerNonce,
      capture: listing.capture,
    }));
    this.#assertCurrentAfterAwait(binding, "remote window observation");
    if (!remoteWindowCaptureMatches(result.capture, listing.capture)) throw new Error("Remote window changed during observation");
    return result;
  }

  async send(
    target: string,
    mode: Extract<SessionMessageMode, "steer" | "follow_up">,
    message: string,
    options: {
      messageId: string;
      source: SessionMessageSource;
      messageKind: SessionMessageKind;
      ttlMs?: number;
    },
  ): Promise<RemoteWindowReceipt> {
    const listing = this.#requireTarget(target);
    if (!listing.capture.capabilities.includes(mode)) throw new Error(`Remote window does not support ${mode}`);
    const binding = await this.#binding(listing.workspaceRef);
    this.#assertCurrentAfterAwait(binding, "remote window delivery");
    if (!binding.connection.windowSend) throw new Error("Remote connection does not implement window/send");
    const result = await binding.connection.windowSend({
      commandId: this.#commandIdFactory(),
      monitorOwnerNonce: this.#monitorOwnerNonce,
      capture: listing.capture,
      messageId: options.messageId,
      mode,
      message,
      source: options.source,
      messageKind: options.messageKind,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    });
    this.#assertCurrentAfterAwait(binding, "remote window delivery");
    const receipt = normalizeRemoteWindowReceipt(result.receipt);
    if (!remoteWindowCaptureMatches(receipt.capture, listing.capture)) throw new Error("Remote window changed during delivery");
    return receipt;
  }

  async receipt(target: string, messageId: string): Promise<RemoteWindowReceipt | undefined> {
    const listing = this.#requireTarget(target);
    const binding = await this.#binding(listing.workspaceRef);
    this.#assertCurrentAfterAwait(binding, "remote window receipt reconciliation");
    if (!binding.connection.windowReceipt) throw new Error("Remote connection does not implement window/receipt");
    const result = normalizeRemoteWindowReceiptResult(await binding.connection.windowReceipt({
      commandId: this.#commandIdFactory(),
      monitorOwnerNonce: this.#monitorOwnerNonce,
      capture: listing.capture,
      messageId,
      direction: "outgoing",
    }));
    this.#assertCurrentAfterAwait(binding, "remote window receipt reconciliation");
    if (result.receipt && !remoteWindowCaptureMatches(result.receipt.capture, listing.capture)) {
      throw new Error("Remote window changed during receipt reconciliation");
    }
    return result.receipt;
  }

  async acknowledge(target: string, notification: RemoteWindowMessageNotification): Promise<boolean> {
    const listing = this.#requireTarget(target);
    if (!remoteWindowCaptureMatches(listing.capture, notification.capture)) return false;
    const binding = await this.#binding(listing.workspaceRef);
    this.#assertCurrentAfterAwait(binding, "remote window reply acknowledgement");
    if (!binding.connection.windowReceipt) throw new Error("Remote connection does not implement window/receipt");
    const result = normalizeRemoteWindowReceiptResult(await binding.connection.windowReceipt({
      commandId: this.#commandIdFactory(),
      monitorOwnerNonce: this.#monitorOwnerNonce,
      capture: listing.capture,
      messageId: notification.messageId,
      direction: "incoming",
      acknowledge: "injected",
    }));
    this.#assertCurrentAfterAwait(binding, "remote window reply acknowledgement");
    return result.acknowledged === true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const bindings = [...this.#bindings.values()];
    this.#bindings.clear();
    this.#windows.clear();
    await Promise.allSettled(bindings.map((binding) => binding.connection.close()));
    await this.#connectionFactory.close?.();
  }

  async #binding(workspaceRef: string, signal?: AbortSignal): Promise<WorkspaceBinding> {
    this.#assertCurrent();
    const existing = this.#bindings.get(workspaceRef);
    if (existing && existing.connection.status !== "disconnected" && existing.connection.status !== "lost") return existing;
    if (existing) await this.#dropBinding(workspaceRef);
    const workspace = resolveRemoteWorkspace(this.#config, workspaceRef);
    const connectWorkspace = this.#connectionFactory.connectWorkspace;
    if (!connectWorkspace) throw new Error("Remote connection factory does not support configured workspaces");
    const connection = await connectWorkspace.call(this.#connectionFactory, workspace, signal);
    if (!this.#isCurrent()) {
      await connection.close();
      throw new Error("Monitor authority changed while connecting to remote workspace");
    }
    try {
      const initialized = await connection.initialize({
        commandId: this.#commandIdFactory(),
        protocolVersions: ["remote/2"],
        monitorOwnerNonce: this.#monitorOwnerNonce,
      });
      if (!this.#isCurrent()) throw new Error("Monitor authority changed during remote window handshake");
      const negotiation = negotiateRemoteWindowBridge(workspace, initialized);
      if (negotiation.status !== "supported") throw new Error(negotiation.message);
      const identity = Object.freeze({ workerId: initialized.workerId, instanceNonce: initialized.instanceNonce });
      const binding: WorkspaceBinding = {
        workspace,
        connection,
        identity,
        notificationPump: Promise.resolve(),
      };
      this.#bindings.set(workspaceRef, binding);
      binding.notificationPump = this.#pumpNotifications(binding);
      return binding;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  async #pumpNotifications(binding: WorkspaceBinding): Promise<void> {
    try {
      for await (const envelope of binding.connection.notifications()) {
        if (this.#closed || !this.#isCurrent()) return;
        if (envelope.method !== "window/state" && envelope.method !== "window/message") continue;
        const notification = normalizeRemoteWindowNotification(envelope.params);
        if (notification.capture.gatewayWorkerId !== binding.identity.workerId
          || notification.capture.gatewayInstanceNonce !== binding.identity.instanceNonce
          || notification.capture.monitorOwnerNonce !== this.#monitorOwnerNonce) continue;
        const target = stableTarget(notification.capture);
        const listing = this.#windows.get(target);
        if (!listing || !remoteWindowCaptureMatches(listing.capture, notification.capture)) continue;
        this.#onNotification?.(target, notification);
        if (notification.type === "window/state" && notification.state === "unavailable") {
          this.#windows.delete(target);
        }
      }
    } catch {
      // A disconnected gateway is reconciled by the next explicit list/receipt.
    }
  }

  async #dropBinding(workspaceRef: string): Promise<void> {
    const binding = this.#bindings.get(workspaceRef);
    if (!binding) return;
    this.#bindings.delete(workspaceRef);
    for (const [target, listing] of this.#windows) {
      if (listing.workspaceRef === workspaceRef) this.#windows.delete(target);
    }
    await binding.connection.close().catch(() => undefined);
  }

  #requireTarget(target: string): RemoteWindowMonitorListing {
    this.#assertCurrent();
    const parsed = parseTarget(target);
    const listing = parsed ? this.#windows.get(target) : undefined;
    if (!listing || listing.workspaceRef !== parsed?.workspaceRef || listing.capture.ownerId !== parsed.ownerId) {
      const guidance = parsed
        ? " Remote ACP/CLI targets are run-only; use remote-worker and observe kind=remote."
        : "";
      throw new Error(`Remote window target ${JSON.stringify(target)} was not discovered by this Monitor session.${guidance}`);
    }
    return listing;
  }

  #assertCurrent(): void {
    if (this.#closed || !this.#isCurrent()) throw new Error("Remote window Monitor binding is not current");
  }

  #assertCurrentAfterAwait(binding: WorkspaceBinding, operation: string): void {
    if (this.#closed || !this.#isCurrent() || this.#bindings.get(binding.workspace.workspaceRef) !== binding
      || binding.connection.identity?.workerId !== binding.identity.workerId
      || binding.connection.identity.instanceNonce !== binding.identity.instanceNonce) {
      throw new Error(`Monitor authority changed during ${operation}`);
    }
  }
}

export { parseTarget as parseRemoteWindowTarget, stableTarget as remoteWindowTarget };
