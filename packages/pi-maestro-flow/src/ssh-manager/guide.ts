import type { EncryptedSshStore } from "./encrypted-store.ts";
import type { SshExecutor } from "./executor.ts";
import { validateSshGatewayBinding } from "./model.ts";

export const SSH_GATEWAY_COMMAND = "pi-maestro-gateway connect --stdio";
export const SSH_GATEWAY_BOOTSTRAP_COMMAND = "pi-maestro-gateway pair bootstrap --ttl 2592000 --label pi-maestro-flow-ssh";
const SSH_GATEWAY_REVOKE_PREFIX = "pi-maestro-gateway pair revoke ";

export interface SshGatewayPairingReceipt {
  readonly paired: true;
  readonly hostId: string;
  readonly expiresAt: number;
}

/** User-invoked, non-model-visible pairing seam. Raw bootstrap output is consumed only inside this function. */
export async function pairSshGateway(store: EncryptedSshStore, executor: SshExecutor, hostId: string, signal?: AbortSignal): Promise<SshGatewayPairingReceipt> {
  if (store.locked) throw new Error("SSH manager must be unlocked before Gateway pairing");
  await store.reload();
  let host = store.getHosts().find((candidate) => candidate.id === hostId);
  if (!host) throw new Error("SSH Gateway pairing target was not found");
  if (host.hostKey === null) throw new Error("SSH Gateway pairing requires a pinned host key");
  const previous = store.getGatewayBinding(hostId);
  if (previous) {
    const revoked = await executor.execute(host, { command: `${SSH_GATEWAY_REVOKE_PREFIX}${previous.pairingId}`, timeout: 30 }, { signal });
    if (revoked.exitCode !== 0) throw new Error("Existing secure Gateway pairing could not be revoked");
    await store.removeGatewayBinding(hostId);
    await store.reload();
    host = store.getHosts().find((candidate) => candidate.id === hostId);
    if (!host || host.hostKey === null) throw new Error("SSH Gateway pairing target changed during re-pairing");
  }
  const revision = store.revision;
  const effectiveHostDigest = store.getEffectiveHostDigest(hostId);
  const result = await executor.execute(host, { command: SSH_GATEWAY_BOOTSTRAP_COMMAND, timeout: 30 }, { signal });
  if (result.exitCode !== 0) throw new Error("Secure Gateway pairing bootstrap failed");
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { throw new Error("Secure Gateway pairing bootstrap returned an invalid receipt"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Secure Gateway pairing bootstrap returned an invalid receipt");
  const value = raw as Record<string, unknown>;
  if (value.serverName !== "pi-maestro-gateway" || value.protocolVersion !== 1 || typeof value.id !== "string" || typeof value.endpoint !== "string" || typeof value.token !== "string" || !Number.isSafeInteger(value.expiresAt)) throw new Error("Secure Gateway pairing bootstrap returned an incompatible receipt");
  const binding = validateSshGatewayBinding({ hostId, endpoint: value.endpoint, token: value.token, pairingId: value.id, expiresAt: value.expiresAt, effectiveHostDigest });
  try {
    await store.reload();
    await store.saveGatewayBinding(hostId, binding, revision, effectiveHostDigest);
  } catch (error) {
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(binding.pairingId)) {
      await executor.execute(host, { command: `${SSH_GATEWAY_REVOKE_PREFIX}${binding.pairingId}`, timeout: 30 }, { signal }).catch(() => undefined);
    }
    throw error;
  }
  return { paired: true, hostId, expiresAt: binding.expiresAt };
}

export async function unpairSshGateway(store: EncryptedSshStore, executor: SshExecutor, hostId: string, signal?: AbortSignal): Promise<boolean> {
  if (store.locked) throw new Error("SSH manager must be unlocked before Gateway unpairing");
  await store.reload();
  const host = store.getHosts().find((candidate) => candidate.id === hostId);
  const binding = store.getGatewayBinding(hostId);
  if (!host || !binding) return false;
  if (host.hostKey === null) throw new Error("SSH Gateway unpairing requires a pinned host key");
  const result = await executor.execute(host, { command: `${SSH_GATEWAY_REVOKE_PREFIX}${binding.pairingId}`, timeout: 30 }, { signal });
  if (result.exitCode !== 0) throw new Error("Secure Gateway unpairing failed");
  return store.removeGatewayBinding(hostId);
}

export function sshGatewayGuide(): string {
  return [
    "Pi Maestro Gateway runs on the selected SSH server and must be installed and started there.",
    "",
    "1. Install the package that provides `pi-maestro-gateway` on the remote server.",
    "2. Start the daemon with `pi-maestro-gateway serve`.",
    "3. Verify the installation with `pi-maestro-gateway version --json`.",
    "4. Send `#ssh` (or `#ssh:<id>`) to select that server, then use the ssh tool's status, list, describe, call, or start_pi action.",
    "",
    "start_pi accepts existing local Pi todoIds plus an optional objective/agent/timeout and a required requestId. The host constructs a bounded read-only prompt snapshot; local Pi Todo and remote Gateway Todo remain independent and are never updated from remote lifecycle events.",
    "Use the returned non-secret launch receipt with the general call action for remote Monitor observe/message/cancel/result operations. Disconnecting SSH does not cancel the remote execution.",
    "sync_pi_config accepts only a provider-owned targetId and fixed models/auth/teammate categories. The host resolves current-user files internally, transfers bounded bytes over stdin, and returns only sizes, digests, and backup receipts.",
    "",
    `Gateway actions always use the fixed remote command \`${SSH_GATEWAY_COMMAND}\`; host, authentication, command, remote cwd, raw snapshots, session ids, and callbacks are not accepted by start_pi.`,
  ].join("\n");
}
