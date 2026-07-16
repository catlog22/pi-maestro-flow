import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PERMISSION_MODES, type PermissionBehavior, type PermissionMode, type PermissionRuleSettings } from "./types.ts";

export interface LoadedPermissionSettings {
  permissions: PermissionRuleSettings;
  sources: string[];
  errors: string[];
  warnings: string[];
  localSettingsPath: string;
}

const EMPTY_PERMISSIONS: PermissionRuleSettings = { allow: [], ask: [], deny: [] };
const mutationQueues = new Map<string, Promise<void>>();

export async function loadPermissionSettings(
  cwd: string,
  userSettingsPath: string,
): Promise<LoadedPermissionSettings> {
  const localSettingsPath = join(cwd, ".pi", "settings.local.json");
  const candidates: Array<{ path: string; scope: "user" | "project" | "local" }> = [
    { path: userSettingsPath, scope: "user" },
    { path: join(cwd, ".pi", "settings.json"), scope: "project" },
    { path: localSettingsPath, scope: "local" },
  ];
  const permissions: PermissionRuleSettings = { ...EMPTY_PERMISSIONS, allow: [], ask: [], deny: [] };
  const sources: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const loaded = await readPermissionFile(candidate.path);
    if (!loaded.exists) continue;
    sources.push(candidate.path);
    if (loaded.error) {
      errors.push(loaded.error);
      continue;
    }
    const scoped = candidate.scope === "project"
      ? restrictUntrustedProjectPermissions(loaded.permissions, candidate.path, warnings)
      : loaded.permissions;
    mergePermissions(permissions, scoped);
  }
  return { permissions, sources, errors, warnings, localSettingsPath };
}

export async function addPermissionRule(
  filePath: string,
  behavior: PermissionBehavior,
  rule: string,
): Promise<void> {
  await updatePermissionRules(filePath, behavior, "add", [rule]);
}

export async function updatePermissionRules(
  filePath: string,
  behavior: PermissionBehavior,
  operation: "add" | "replace" | "remove",
  rules: string[],
): Promise<void> {
  await serializeMutation(filePath, async () => {
    const root = await readSettingsRoot(filePath);
    const rawPermissions = isRecord(root.permissions) ? root.permissions : {};
    const existing = Array.isArray(rawPermissions[behavior])
      ? rawPermissions[behavior].filter((entry): entry is string => typeof entry === "string")
      : [];
    if (operation === "replace") rawPermissions[behavior] = [...new Set(rules)];
    if (operation === "add") rawPermissions[behavior] = [...new Set([...existing, ...rules])];
    if (operation === "remove") {
      const removals = new Set(rules);
      rawPermissions[behavior] = existing.filter((rule) => !removals.has(rule));
    }
    root.permissions = rawPermissions;
    await atomicWriteJson(filePath, root);
  });
}

export async function setPermissionDefaultMode(filePath: string, mode: PermissionMode): Promise<void> {
  await serializeMutation(filePath, async () => {
    const root = await readSettingsRoot(filePath);
    const rawPermissions = isRecord(root.permissions) ? root.permissions : {};
    rawPermissions.defaultMode = mode;
    root.permissions = rawPermissions;
    await atomicWriteJson(filePath, root);
  });
}

async function readSettingsRoot(filePath: string): Promise<Record<string, unknown>> {
  let root: Record<string, unknown> = {};
  try {
    const text = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("root must be an object");
    root = parsed;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return root;
}

async function readPermissionFile(filePath: string): Promise<{
  exists: boolean;
  permissions?: Partial<PermissionRuleSettings>;
  error?: string;
}> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    return { exists: true, error: `${filePath}: ${errorMessage(error)}` };
  }
  try {
    const root: unknown = JSON.parse(text);
    if (!isRecord(root)) throw new Error("root must be an object");
    if (root.permissions === undefined) return { exists: true, permissions: {} };
    if (!isRecord(root.permissions)) throw new Error("permissions must be an object");
    return { exists: true, permissions: validatePermissions(root.permissions) };
  } catch (error) {
    return { exists: true, error: `${filePath}: ${errorMessage(error)}` };
  }
}

function validatePermissions(raw: Record<string, unknown>): Partial<PermissionRuleSettings> {
  const result: Partial<PermissionRuleSettings> = {};
  for (const behavior of ["allow", "ask", "deny"] as const) {
    if (raw[behavior] === undefined) continue;
    if (!Array.isArray(raw[behavior]) || raw[behavior].some((entry) => typeof entry !== "string")) {
      throw new Error(`permissions.${behavior} must be an array of strings`);
    }
    result[behavior] = raw[behavior] as string[];
  }
  if (raw.defaultMode !== undefined) {
    if (typeof raw.defaultMode !== "string" || !PERMISSION_MODES.includes(raw.defaultMode as PermissionMode)) {
      throw new Error(`permissions.defaultMode must be one of ${PERMISSION_MODES.join(", ")}`);
    }
    result.defaultMode = raw.defaultMode as PermissionMode;
  }
  if (raw.disableBypassPermissionsMode !== undefined) {
    if (raw.disableBypassPermissionsMode !== "disable") {
      throw new Error('permissions.disableBypassPermissionsMode must be "disable"');
    }
    result.disableBypassPermissionsMode = "disable";
  }
  return result;
}

function mergePermissions(target: PermissionRuleSettings, source: Partial<PermissionRuleSettings> | undefined): void {
  if (!source) return;
  for (const behavior of ["allow", "ask", "deny"] as const) {
    target[behavior] = [...new Set([...target[behavior], ...(source[behavior] ?? [])])];
  }
  if (source.defaultMode) target.defaultMode = source.defaultMode;
  if (source.disableBypassPermissionsMode) {
    target.disableBypassPermissionsMode = source.disableBypassPermissionsMode;
  }
}

function restrictUntrustedProjectPermissions(
  source: Partial<PermissionRuleSettings> | undefined,
  filePath: string,
  warnings: string[],
): Partial<PermissionRuleSettings> | undefined {
  if (!source) return source;
  const restricted: Partial<PermissionRuleSettings> = {
    ask: source.ask ?? [],
    deny: source.deny ?? [],
    ...(source.disableBypassPermissionsMode ? {
      disableBypassPermissionsMode: source.disableBypassPermissionsMode,
    } : {}),
  };
  if (source.allow?.length) {
    warnings.push(`${filePath}: project allow rules were ignored; approve them into local settings first`);
  }
  if (source.defaultMode === "default" || source.defaultMode === "plan" || source.defaultMode === "dontAsk") {
    restricted.defaultMode = source.defaultMode;
  } else if (source.defaultMode) {
    warnings.push(`${filePath}: project defaultMode ${source.defaultMode} was ignored because it weakens permissions`);
  }
  return restricted;
}

async function atomicWriteJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  let tempCreated = false;
  try {
    tempHandle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    await tempHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await tempHandle.close();
    tempHandle = undefined;
    await rename(tempPath, filePath);
  } finally {
    try {
      await tempHandle?.close();
    } finally {
      if (tempCreated) await removeTemporaryFile(tempPath);
    }
  }
}

async function serializeMutation(filePath: string, mutate: () => Promise<void>): Promise<void> {
  const key = canonicalFilePath(filePath);
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

function canonicalFilePath(filePath: string): string {
  const canonical = resolve(filePath);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return isRecord(value) && value.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
