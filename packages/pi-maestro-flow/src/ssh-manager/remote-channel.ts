import type { Duplex, Readable } from "node:stream";
import {
  SshHostProviderError,
  TEAMMATE_REMOTE_GATEWAY_COMMAND,
  type SshHostTeammateRemoteChannel,
} from "pi-maestro-teammate/v1/ssh-hosts";
import { SSH_HOST_ID_PATTERN, type SshHost } from "./model.ts";
import type { SshCommandChannel, SshExecutor } from "./executor.ts";

export const DEFAULT_TEAMMATE_REMOTE_CHANNELS_PER_HOST = 2;
export const DEFAULT_TEAMMATE_REMOTE_CHANNELS_GLOBAL = 8;

export interface TeammateRemoteChannelBrokerOptions {
  maxPerHost?: number;
  maxGlobal?: number;
}

interface RemoteChannelStore {
  readonly locked: boolean;
  readonly revision: number;
  reload(): Promise<void>;
  getHosts(): SshHost[];
  getEffectiveHostDigest(hostId: string): string;
}

interface RemoteChannelExecutor {
  openChannel: SshExecutor["openChannel"];
}

interface PendingOpen {
  readonly controller: AbortController;
  channel?: SshCommandChannel;
}

/** Preserve the teammate SSH compatibility boundary before any channel is opened. */
export function sshHostReferenceIssue(host: SshHost):
  | "untrusted-host"
  | "unsupported-jump-host"
  | "unsupported-shell"
  | "unsupported-password-authentication"
  | "unsupported-managed-key"
  | "unsupported-identity-passphrase"
  | undefined {
  if (host.hostKey === null) return "untrusted-host";
  if (host.jumpHostId !== null) return "unsupported-jump-host";
  if (host.shell !== "bash") return "unsupported-shell";
  if (host.auth.kind === "password") return "unsupported-password-authentication";
  if (host.auth.kind === "key") return "unsupported-managed-key";
  if (host.auth.kind === "identity" && host.auth.passphrase !== undefined) {
    return "unsupported-identity-passphrase";
  }
  return undefined;
}

/** Flow-owned, fixed-command-only admission broker for teammate remote channels. */
export class TeammateRemoteChannelBroker {
  private readonly maxPerHost: number;
  private readonly maxGlobal: number;
  private readonly activeByHost = new Map<string, number>();
  private readonly pending = new Set<PendingOpen>();
  private readonly active = new Set<() => void>();
  private activeCount = 0;
  private closed = false;

  constructor(
    private readonly store: RemoteChannelStore,
    private readonly executor: RemoteChannelExecutor,
    options: TeammateRemoteChannelBrokerOptions = {},
  ) {
    this.maxPerHost = boundedLimit(options.maxPerHost, DEFAULT_TEAMMATE_REMOTE_CHANNELS_PER_HOST);
    this.maxGlobal = boundedLimit(options.maxGlobal, DEFAULT_TEAMMATE_REMOTE_CHANNELS_GLOBAL);
  }

  async open(hostRef: string, signal?: AbortSignal): Promise<SshHostTeammateRemoteChannel> {
    if (!SSH_HOST_ID_PATTERN.test(hostRef)) throw new Error("SSH host reference is invalid");
    if (signal?.aborted) throw abortError();
    if (this.closed) throw unavailable("SSH teammate remote channels are unavailable during shutdown.");

    await this.refresh();
    const host = this.store.getHosts().find((candidate) => candidate.id === hostRef);
    if (!host) {
      throw new SshHostProviderError(
        "host-not-found",
        `SSH host reference ${JSON.stringify(hostRef)} was not found in the unlocked manager.`,
      );
    }
    const issue = sshHostReferenceIssue(host);
    if (issue) {
      throw new SshHostProviderError(
        "host-incompatible",
        `SSH host reference ${JSON.stringify(hostRef)} is incompatible with teammate SSH consumers: ${issue}.`,
      );
    }
    const revision = this.store.revision;
    const digest = this.store.getEffectiveHostDigest(hostRef);
    this.admit(hostRef);

    const controller = new AbortController();
    const pending: PendingOpen = { controller };
    this.pending.add(pending);
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    let admissionReleased = false;
    let admissionHandedOff = false;
    const releaseAdmission = (): void => {
      if (admissionReleased) return;
      admissionReleased = true;
      this.release(hostRef);
    };
    try {
      if (this.closed || signal?.aborted) throw abortError();
      const opened = await this.executor.openChannel(
        hostRef,
        { command: TEAMMATE_REMOTE_GATEWAY_COMMAND },
        { signal: controller.signal },
      );
      pending.channel = opened;
      let channelClosed = false;
      const markChannelClosed = (): void => { channelClosed = true; };
      opened.channel.once("close", markChannelClosed);
      if (this.closed || signal?.aborted) throw abortError();
      if (channelClosed || isClosedChannel(opened)) throw channelClosedError();
      if (opened.effectiveDigest !== undefined && opened.effectiveDigest !== digest) throw fenceError();

      await this.refresh();
      if (this.closed || signal?.aborted) throw abortError();
      if (channelClosed || isClosedChannel(opened)) throw channelClosedError();
      if (this.store.revision !== revision || this.store.getEffectiveHostDigest(hostRef) !== digest) {
        throw fenceError();
      }

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        this.active.delete(close);
        try { opened.close(); } catch { /* Provider cleanup is best effort. */ }
        releaseAdmission();
      };
      opened.channel.off("close", markChannelClosed);
      if (channelClosed || isClosedChannel(opened)) {
        close();
        throw channelClosedError();
      }
      this.active.add(close);
      signal?.removeEventListener("abort", relayAbort);
      opened.channel.once("close", close);
      admissionHandedOff = true;
      return {
        stream: opened.channel as Duplex & { readonly stderr: Readable },
        close,
        fence: `${revision}:${digest}`,
        digest,
      };
    } catch (error) {
      try { pending.channel?.close(); } catch { /* Best effort on rejected admission. */ }
      if (signal?.aborted || controller.signal.aborted) throw abortError();
      if (error instanceof SshHostProviderError) throw error;
      throw new SshHostProviderError(
        "refresh-failed",
        `SSH host reference ${JSON.stringify(hostRef)} fixed teammate remote channel could not be opened.`,
      );
    } finally {
      this.pending.delete(pending);
      signal?.removeEventListener("abort", relayAbort);
      if (!admissionHandedOff) releaseAdmission();
    }
  }

  /** Permanently stop admission and synchronously close pending and active channels. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of [...this.pending]) {
      request.controller.abort();
      try { request.channel?.close(); } catch { /* Best effort during shutdown. */ }
    }
    for (const close of [...this.active]) close();
  }

  private async refresh(): Promise<void> {
    if (this.store.locked) {
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager is locked. Open /ssh in the host session to unlock it.",
      );
    }
    try {
      await this.store.reload();
    } catch {
      throw new SshHostProviderError(
        "refresh-failed",
        "SSH manager could not be refreshed. Open /ssh in the host session and verify the encrypted store.",
      );
    }
    if (this.store.locked) {
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager is locked. Open /ssh in the host session to unlock it.",
      );
    }
  }

  private admit(hostRef: string): void {
    if (this.closed) throw unavailable("SSH teammate remote channels are unavailable during shutdown.");
    const hostCount = this.activeByHost.get(hostRef) ?? 0;
    if (this.activeCount >= this.maxGlobal || hostCount >= this.maxPerHost) {
      throw unavailable("SSH teammate remote channel capacity is currently exhausted.");
    }
    this.activeCount++;
    this.activeByHost.set(hostRef, hostCount + 1);
  }

  private release(hostRef: string): void {
    const count = this.activeByHost.get(hostRef) ?? 0;
    if (count <= 0) return;
    this.activeCount--;
    if (count === 1) this.activeByHost.delete(hostRef);
    else this.activeByHost.set(hostRef, count - 1);
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("SSH teammate remote channel limits must be integers between 1 and 256");
  return limit;
}

function unavailable(message: string): SshHostProviderError {
  return new SshHostProviderError("provider-unavailable", message);
}

function fenceError(): SshHostProviderError {
  return new SshHostProviderError(
    "refresh-failed",
    "SSH manager configuration changed while the fixed teammate remote channel was opening.",
  );
}

function isClosedChannel(channel: SshCommandChannel): boolean {
  const stream = channel.channel as typeof channel.channel & { closed?: boolean };
  return stream.destroyed === true || stream.closed === true;
}

function channelClosedError(): SshHostProviderError {
  return new SshHostProviderError(
    "refresh-failed",
    "SSH teammate remote channel closed before connection handoff.",
  );
}

function abortError(): Error {
  const error = new Error("SSH host channel request was aborted");
  error.name = "AbortError";
  return error;
}
