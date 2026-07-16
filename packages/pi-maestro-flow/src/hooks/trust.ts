import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface HookTrustFile {
  version: 1;
  trusted: Record<string, string>;
}

const EMPTY_TRUST: HookTrustFile = { version: 1, trusted: {} };
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

async function readTrustFile(filePath: string): Promise<HookTrustFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.trusted)) return structuredClone(EMPTY_TRUST);
    const trusted: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.trusted)) {
      if (typeof value === "string") trusted[key] = value;
    }
    return { version: 1, trusted };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return structuredClone(EMPTY_TRUST);
    return structuredClone(EMPTY_TRUST);
  }
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
  const mutation = previous.catch(() => undefined).then(mutate);
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
