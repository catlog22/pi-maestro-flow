import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { lockSettingsResource } from "../settings/resource-lock.ts";

interface HookTrustFile {
  version: 1;
  trusted: Record<string, string>;
  toggles: Record<string, Record<string, boolean>>;
}

const EMPTY_TRUST: HookTrustFile = { version: 1, trusted: {}, toggles: {} };
const mutationQueues = new Map<string, Promise<void>>();

export async function isHookConfigTrusted(
  trustFilePath: string,
  configPath: string,
  hash: string,
): Promise<boolean> {
  const trust = await readTrustFile(trustFilePath);
  return trust.trusted[trustKey(configPath)] === hash;
}

export async function trustHookConfig(
  trustFilePath: string,
  configPath: string,
  hash: string,
): Promise<void> {
  await serializeMutation(trustFilePath, async () => {
    const trust = await readTrustFile(trustFilePath);
    trust.trusted[trustKey(configPath)] = hash;
    await writeTrustFile(trustFilePath, trust);
  });
}

export async function revokeHookConfigTrust(
  trustFilePath: string,
  configPath: string,
): Promise<void> {
  await serializeMutation(trustFilePath, async () => {
    const trust = await readTrustFile(trustFilePath);
    delete trust.trusted[trustKey(configPath)];
    await writeTrustFile(trustFilePath, trust);
  });
}

export async function setHookEnabled(
  trustFilePath: string,
  configPath: string,
  hookId: string,
  enabled: boolean,
): Promise<void> {
  await serializeMutation(trustFilePath, async () => {
    const trust = await readTrustFile(trustFilePath);
    const key = trustKey(configPath);
    trust.toggles[key] ??= {};
    trust.toggles[key][hookId] = enabled;
    await writeTrustFile(trustFilePath, trust);
  });
}

export async function loadHookToggles(
  trustFilePath: string,
  configPath: string,
): Promise<Record<string, boolean>> {
  const trust = await readTrustFile(trustFilePath);
  return { ...(trust.toggles[trustKey(configPath)] ?? {}) };
}

async function readTrustFile(filePath: string): Promise<HookTrustFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return structuredClone(EMPTY_TRUST);
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Hook trust file JSON: ${filePath}`, { cause: error });
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.trusted)) {
    throw new Error(`Invalid Hook trust file structure: ${filePath}`);
  }

  const trusted: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.trusted)) {
    if (typeof value !== "string") throw new Error(`Invalid Hook trust hash for ${key}`);
    trusted[key] = value;
  }
  const toggles: Record<string, Record<string, boolean>> = {};
  if (raw.toggles !== undefined) {
    if (!isRecord(raw.toggles)) throw new Error(`Invalid Hook toggle state: ${filePath}`);
    for (const [configKey, values] of Object.entries(raw.toggles)) {
      if (!isRecord(values)) throw new Error(`Invalid Hook toggles for ${configKey}`);
      const parsed: Record<string, boolean> = {};
      for (const [hookId, enabled] of Object.entries(values)) {
        if (typeof enabled !== "boolean") throw new Error(`Invalid Hook toggle ${hookId}`);
        parsed[hookId] = enabled;
      }
      toggles[configKey] = parsed;
    }
  }
  return { version: 1, trusted, toggles };
}

async function writeTrustFile(filePath: string, trust: HookTrustFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await temporaryHandle.writeFile(`${JSON.stringify(trust, null, 2)}\n`, "utf8");
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    try {
      await temporaryHandle?.close();
    } finally {
      if (temporaryCreated) await removeTemporaryFile(temporaryPath);
    }
  }
}

async function serializeMutation(filePath: string, mutate: () => Promise<void>): Promise<void> {
  const key = trustKey(filePath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const mutation = previous.catch(() => undefined).then(async () => {
    const release = await lockSettingsResource(filePath);
    try {
      await mutate();
    } finally {
      await release();
    }
  });
  const settled = mutation.then(() => undefined, () => undefined);
  mutationQueues.set(key, settled);
  try {
    await mutation;
  } finally {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  }
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function trustKey(filePath: string): string {
  const path = resolve(filePath);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return isRecord(value) && value.code === code;
}
