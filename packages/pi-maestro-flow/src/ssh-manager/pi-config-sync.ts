import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientChannel } from "ssh2";
import {
  isModelRoutingProfileId,
  validateModelRoutingV3Rules,
} from "pi-maestro-teammate/v1/model-routing";
import { SshExecutor } from "./executor.ts";
import type { SshHost } from "./model.ts";

export const PI_CONFIG_SYNC_COMMAND = "pi-maestro-gateway config-sync apply";
export const PI_CONFIG_SYNC_MAX_CATEGORY_BYTES = 1024 * 1024;
export const PI_CONFIG_SYNC_MAX_TOTAL_BYTES = 3 * PI_CONFIG_SYNC_MAX_CATEGORY_BYTES;
export const PI_CONFIG_CATEGORIES = ["models", "auth", "teammate"] as const;
export type PiConfigCategory = typeof PI_CONFIG_CATEGORIES[number];
export type PiConfigRecoveryDisposition = "rolled-back" | "committed" | "recovery-required";
export type PiConfigTransactionDisposition = "rejected" | Exclude<PiConfigRecoveryDisposition, "committed">;
export type PiConfigCleanupState = "complete" | "pending";

export interface PiConfigSyncReceipt {
  readonly category: PiConfigCategory;
  readonly bytes: number;
  readonly digest: string;
  readonly backup: boolean;
}

export interface PiConfigSyncResult {
  readonly ok: true;
  readonly receipts: readonly PiConfigSyncReceipt[];
  readonly status?: "committed-cleanup-pending";
}

export class PiConfigTransactionError extends Error {
  readonly disposition: PiConfigTransactionDisposition;
  readonly cleanup: PiConfigCleanupState;
  constructor(disposition: PiConfigTransactionDisposition, cleanup: PiConfigCleanupState = "complete") {
    super(disposition === "recovery-required" ? "Pi configuration recovery is required" : disposition === "rolled-back" ? "Pi configuration synchronization rolled back" : "Pi configuration synchronization was rejected");
    this.name = "PiConfigTransactionError";
    this.disposition = disposition;
    this.cleanup = cleanup;
  }
}

export interface PiConfigLocalSource { read(category: PiConfigCategory): Promise<Buffer | undefined>; }
export interface PiConfigSyncTransport { apply(payload: Buffer, signal?: AbortSignal): Promise<unknown>; }
export interface PiConfigSyncAudit { record(event: { action: "sync_pi_config"; categories: readonly PiConfigCategory[]; ok: boolean }): void; }

export class CurrentUserPiConfigSource implements PiConfigLocalSource {
  constructor(private readonly homeDirectory = homedir()) {}
  async read(category: PiConfigCategory): Promise<Buffer | undefined> {
    const name = category === "models" ? "models.json" : category === "auth" ? "auth.json" : "teammate-models.json";
    const path = join(this.homeDirectory, ".pi", "agent", name);
    let bytes: Buffer | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > PI_CONFIG_SYNC_MAX_CATEGORY_BYTES) throw new Error("invalid source");
      handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size) throw new Error("changed source");
      bytes = Buffer.alloc(Number(after.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new Error("changed source");
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      try { if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error("changed source"); }
      finally { extra.fill(0); }
      return bytes;
    } catch (error) {
      bytes?.fill(0);
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && category === "teammate") return undefined;
      throw new Error(`${category} configuration is missing, unsafe, unreadable, or too large`);
    } finally { await handle?.close().catch(() => undefined); }
  }
}

export class SshPiConfigSyncTransport implements PiConfigSyncTransport {
  constructor(private readonly executor: SshExecutor, private readonly host: SshHost, private readonly exchangeTimeoutMs = 60_000) {}
  async apply(payload: Buffer, signal?: AbortSignal): Promise<unknown> {
    const handle = await this.executor.openChannel(this.host, { command: PI_CONFIG_SYNC_COMMAND, timeout: 60 }, { signal });
    try { return await exchange(handle.channel, payload, signal, this.exchangeTimeoutMs); }
    finally { handle.close(); }
  }
}

export async function syncPiConfig(options: {
  categories: readonly PiConfigCategory[];
  source: PiConfigLocalSource;
  transport: PiConfigSyncTransport;
  signal?: AbortSignal;
  assertFence?: () => Promise<void>;
  audit?: PiConfigSyncAudit;
}): Promise<PiConfigSyncResult> {
  const categories = normalizeCategories(options.categories);
  const entries: Array<{ category: PiConfigCategory; bytes: Buffer; digest: string }> = [];
  let payload: Buffer | undefined;
  try {
    throwIfAborted(options.signal);
    let total = 0;
    for (const category of categories) {
      throwIfAborted(options.signal);
      const bytes = await options.source.read(category);
      if (bytes === undefined) continue;
      let retained = false;
      try {
        throwIfAborted(options.signal);
        if (bytes.length === 0 || bytes.length > PI_CONFIG_SYNC_MAX_CATEGORY_BYTES) throw new Error(`${category} configuration size is invalid`);
        total += bytes.length;
        if (total > PI_CONFIG_SYNC_MAX_TOTAL_BYTES) throw new Error("Pi configuration transfer exceeds the total size limit");
        validateLocal(category, bytes);
        entries.push({ category, bytes, digest: sha256(bytes) });
        retained = true;
      } finally { if (!retained) bytes.fill(0); }
    }
    for (const required of ["models", "auth"] as const) {
      if (categories.includes(required) && !entries.some((entry) => entry.category === required)) throw new Error(`${required} configuration is required`);
    }
    if (entries.length === 0) throw new Error("No selected Pi configuration is available");
    await options.assertFence?.();
    payload = encodePayload(entries);
    const result = validateReceipt(await options.transport.apply(payload, options.signal), entries);
    options.audit?.record({ action: "sync_pi_config", categories, ok: true });
    return result;
  } catch (error) {
    options.audit?.record({ action: "sync_pi_config", categories, ok: false });
    if (error instanceof PiConfigTransactionError || error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    const category = error instanceof Error ? PI_CONFIG_CATEGORIES.find((value) => error.message.startsWith(value)) : undefined;
    throw new Error(category ? `${category} configuration synchronization failed` : "Pi configuration synchronization failed");
  } finally {
    payload?.fill(0);
    for (const entry of entries) entry.bytes.fill(0);
  }
}

function normalizeCategories(values: readonly PiConfigCategory[]): PiConfigCategory[] {
  if (values.length === 0) throw new Error("At least one Pi configuration category is required");
  const unique = [...new Set(values)];
  if (unique.some((value) => !PI_CONFIG_CATEGORIES.includes(value))) throw new Error("Unsupported Pi configuration category");
  return unique;
}

function validateLocal(category: PiConfigCategory, bytes: Buffer): void {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${category} configuration is invalid`); }
  validatePiConfigShape(category, parsed);
}

export function validatePiConfigShape(category: PiConfigCategory, value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${category} configuration is invalid`);
  if (category === "models") {
    if (!isRecord(value.providers)) throw new Error("models configuration is invalid");
    for (const provider of Object.values(value.providers)) {
      if (!isRecord(provider) || (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((model) => !isRecord(model))))) throw new Error("models configuration is invalid");
    }
    return;
  }
  if (category !== "teammate") return;
  if (Object.keys(value).some((key) => !["version", "defaultProfile", "profiles", "retiredProfileIds", "askBeforeDispatch"].includes(key))
    || value.version !== 3 || !isModelRoutingProfileId(value.defaultProfile) || !isRecord(value.profiles) || !hasOwn(value.profiles, value.defaultProfile)) {
    throw new Error("teammate configuration is invalid");
  }
  for (const [profileId, rawProfile] of Object.entries(value.profiles)) {
    if (!isModelRoutingProfileId(profileId) || !isRecord(rawProfile) || typeof rawProfile.name !== "string" || !rawProfile.name.trim()) throw new Error("teammate configuration is invalid");
    const { name: _name, ...rules } = rawProfile;
    try { validateModelRoutingV3Rules(rules); } catch { throw new Error("teammate configuration is invalid"); }
  }
  if (value.retiredProfileIds !== undefined && (!Array.isArray(value.retiredProfileIds)
    || new Set(value.retiredProfileIds).size !== value.retiredProfileIds.length
    || value.retiredProfileIds.some((id) => !isModelRoutingProfileId(id) || hasOwn(value.profiles as Record<string, unknown>, id)))) {
    throw new Error("teammate configuration is invalid");
  }
  if (value.askBeforeDispatch !== undefined && typeof value.askBeforeDispatch !== "boolean") throw new Error("teammate configuration is invalid");
}

function encodePayload(entries: readonly { category: PiConfigCategory; bytes: Buffer; digest: string }[]): Buffer {
  const header = Buffer.from(`${JSON.stringify({ version: 1, entries: entries.map(({ category, bytes, digest }) => ({ category, bytes: bytes.length, digest })) })}\n`, "utf8");
  return Buffer.concat([header, ...entries.map((entry) => entry.bytes)]);
}

function validateReceipt(value: unknown, entries: readonly { category: PiConfigCategory; bytes: Buffer; digest: string }[]): PiConfigSyncResult {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.receipts) || value.receipts.length !== entries.length
    || value.status !== undefined && value.status !== "committed-cleanup-pending") throw new Error("Invalid config synchronization receipt");
  const receipts = value.receipts.map((receipt, index): PiConfigSyncReceipt => {
    const expected = entries[index]!;
    if (!isRecord(receipt) || receipt.category !== expected.category || receipt.bytes !== expected.bytes.length || receipt.digest !== expected.digest || typeof receipt.backup !== "boolean") throw new Error("Invalid config synchronization receipt");
    return { category: expected.category, bytes: expected.bytes.length, digest: expected.digest, backup: receipt.backup };
  });
  return { ok: true, receipts, ...(value.status === "committed-cleanup-pending" ? { status: value.status } : {}) };
}

function exchange(channel: ClientChannel, payload: Buffer, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const zero = (): void => { for (const bytes of [...stdout, ...stderr]) bytes.fill(0); stdout.length = 0; stderr.length = 0; };
    const onStdout = capture(stdout);
    const onStderr = capture(stderr);
    const onError = (): void => settleFailure(new Error("Config synchronization stream failed"));
    const onClose = (): void => {
      if (settled) return;
      let stdoutCombined: Buffer | undefined;
      let stderrCombined: Buffer | undefined;
      try {
        if (stderr.length > 0) {
          stderrCombined = Buffer.concat(stderr);
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(stderrCombined);
          throw parseRemoteError(raw);
        }
        stdoutCombined = Buffer.concat(stdout);
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(stdoutCombined);
        settle(undefined, JSON.parse(raw));
      } catch (error) {
        settleFailure(error instanceof PiConfigTransactionError ? error : new Error("Remote config synchronization failed"));
      } finally {
        // Decoded JavaScript strings are immutable and cannot be wiped; zero every mutable backing buffer.
        stdoutCombined?.fill(0);
        stderrCombined?.fill(0);
        zero();
      }
    };
    const onAbort = (): void => { const error = new Error("Pi configuration synchronization aborted"); error.name = "AbortError"; settleFailure(error); };
    const timer = setTimeout(() => { const error = new Error("Pi configuration synchronization timed out"); error.name = "TimeoutError"; settleFailure(error); }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      channel.removeListener("data", onStdout);
      channel.stderr.removeListener("data", onStderr);
      channel.removeListener("error", onError);
      channel.removeListener("close", onClose);
    }
    function settle(error?: Error, value?: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      zero();
      if (error) {
        try { channel.destroy(); } catch { /* terminal failure is already selected */ }
        reject(error);
      } else resolve(value);
    }
    function settleFailure(error: Error): void { settle(error); }
    function capture(target: Buffer[]): (chunk: Buffer | string) => void {
      return (chunk): void => {
        if (settled) return;
        const bytes = copyCaptureChunk(chunk);
        outputBytes += bytes.length;
        if (outputBytes > 64 * 1024) { bytes.fill(0); settleFailure(new Error("Config synchronization response exceeded limit")); return; }
        target.push(bytes);
      };
    }
    channel.on("data", onStdout);
    channel.stderr.on("data", onStderr);
    channel.once("error", onError);
    channel.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try { channel.end(payload); } catch { settleFailure(new Error("Config synchronization stream failed")); }
  });
}

function copyCaptureChunk(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
}

function parseRemoteError(raw: string): PiConfigTransactionError {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("invalid"); }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.ok !== false || !isRecord(parsed.error)
    || parsed.error.code !== "PI_CONFIG_APPLY_FAILED"
    || !["rejected", "rolled-back", "recovery-required"].includes(parsed.error.disposition as string)
    || !["complete", "pending"].includes(parsed.error.cleanup as string)
    || Object.keys(parsed.error).some((key) => !["code", "disposition", "cleanup"].includes(key))) throw new Error("invalid");
  return new PiConfigTransactionError(parsed.error.disposition as PiConfigTransactionDisposition, parsed.error.cleanup as PiConfigCleanupState);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Pi configuration synchronization aborted");
  error.name = "AbortError";
  throw error;
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
