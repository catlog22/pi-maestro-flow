import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CODEX_HOOK_DEFS,
  getHooksForLevel,
  type HookLevel,
} from "maestro-flow/dist/src/commands/hooks.js";
import {
  CODEX_HOOK_EVENTS,
  loadCodexHooks,
  validateCodexHooks,
  type CodexCommandHook,
  type CodexHookEvent,
  type CodexHookHandler,
  type CodexHookMatcherGroup,
  type CodexHooksFile,
} from "./schema.ts";

export const MAESTRO_HOOK_LEVELS = ["none", "minimal", "standard", "full"] as const satisfies readonly HookLevel[];

const LEGACY_MAESTRO_HOOKS = new Set([
  "kg-context-injector",
  "kg-unified-injector",
  "kg-unified-injector-agent",
]);

const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(filePath: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
  }): Promise<() => Promise<void>>;
};

export interface MaestroHookDefinition {
  name: string;
  event: CodexHookEvent;
  matcher?: string;
  level: HookLevel;
  requiresWorkspace: boolean;
  statusMessage?: string;
  timeout?: number;
  permissionAdvisory: boolean;
}

export interface MaestroHookInstallerSnapshot {
  configPath: string;
  configExists: boolean;
  definitions: MaestroHookDefinition[];
  installedNames: string[];
  suggestedNames: string[];
  installedPreset: HookLevel | "custom";
  thirdPartyHandlers: number;
}

export class MaestroHookInstallerStore {
  readonly configPath: string;

  constructor(private readonly cwd: string) {
    this.configPath = join(cwd, ".pi", "hooks.json");
  }

  async load(): Promise<MaestroHookInstallerSnapshot> {
    const loaded = await loadCodexHooks(this.cwd);
    const definitions = maestroHookDefinitions();
    const installedNames = collectInstalledMaestroHooks(loaded.config);
    return {
      configPath: loaded.filePath,
      configExists: loaded.exists,
      definitions,
      installedNames,
      suggestedNames: installedNames.length > 0 ? installedNames : hooksForPreset("standard"),
      installedPreset: inferPreset(installedNames),
      thirdPartyHandlers: countThirdPartyHandlers(loaded.config),
    };
  }

  async apply(selectedNames: readonly string[]): Promise<MaestroHookInstallerSnapshot> {
    const known = new Set(maestroHookDefinitions().map((definition) => definition.name));
    const selected = [...new Set(selectedNames)];
    const unknown = selected.find((name) => !known.has(name));
    if (unknown) throw new Error(`Unknown Maestro Hook: ${unknown}`);

    await withConfigLock(this.configPath, async () => {
      const loaded = await loadCodexHooks(this.cwd);
      const merged = mergeMaestroHooks(loaded.config, selected);
      await atomicWriteConfig(this.configPath, merged);
    });
    return this.load();
  }

  async uninstall(): Promise<MaestroHookInstallerSnapshot> {
    return this.apply([]);
  }
}

export function maestroHookDefinitions(): MaestroHookDefinition[] {
  return Object.entries(CODEX_HOOK_DEFS).map(([name, raw]) => {
    const definition = raw as {
      event: CodexHookEvent;
      matcher?: string;
      level: HookLevel;
      requiresWorkspace?: boolean;
      statusMessage?: string;
      timeout?: number;
    };
    return {
      name,
      event: definition.event,
      ...(definition.matcher ? { matcher: definition.matcher } : {}),
      level: definition.level,
      requiresWorkspace: definition.requiresWorkspace === true,
      ...(definition.statusMessage ? { statusMessage: definition.statusMessage } : {}),
      ...(definition.timeout ? { timeout: definition.timeout } : {}),
      permissionAdvisory: definition.event === "PreToolUse",
    };
  });
}

export function hooksForPreset(level: HookLevel): string[] {
  return getHooksForLevel(level, "codex");
}

export function mergeMaestroHooks(
  config: CodexHooksFile,
  selectedNames: readonly string[],
): CodexHooksFile {
  const hooks: CodexHooksFile["hooks"] = {};
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = config.hooks[event];
    if (!groups) continue;
    const retained = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((handler) => !ownedMaestroHookName(handler)) }))
      .filter((group) => group.hooks.length > 0);
    if (retained.length > 0) hooks[event] = retained;
  }

  const selected = new Set(selectedNames);
  const knownNames = new Set(maestroHookDefinitions().map((definition) => definition.name));
  const unknown = [...selected].find((name) => !knownNames.has(name));
  if (unknown) throw new Error(`Unknown Maestro Hook: ${unknown}`);
  for (const definition of maestroHookDefinitions()) {
    if (!selected.has(definition.name)) continue;
    const groups = hooks[definition.event] ?? [];
    const handler: CodexCommandHook = {
      type: "command",
      command: `maestro hooks run ${definition.name}`,
      timeout: definition.timeout ?? 600,
      ...(definition.statusMessage ? { statusMessage: definition.statusMessage } : {}),
    };
    const group: CodexHookMatcherGroup = {
      ...(definition.matcher ? { matcher: definition.matcher } : {}),
      hooks: [handler],
    };
    hooks[definition.event] = [...groups, group];
  }

  return validateCodexHooks({ ...(config.$schema ? { $schema: config.$schema } : {}), hooks });
}

function collectInstalledMaestroHooks(config: CodexHooksFile): string[] {
  const installed = new Set<string>();
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups ?? []) {
      for (const handler of group.hooks) {
        const name = ownedMaestroHookName(handler);
        if (name && !LEGACY_MAESTRO_HOOKS.has(name)) installed.add(name);
      }
    }
  }
  return maestroHookDefinitions().map((definition) => definition.name).filter((name) => installed.has(name));
}

function ownedMaestroHookName(handler: CodexHookHandler): string | undefined {
  if (handler.type !== "command") return undefined;
  const match = /^\s*maestro(?:\.cmd)?\s+hooks\s+run\s+([a-z0-9-]+)\s*$/i.exec(handler.command);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return maestroHookDefinitions().some((definition) => definition.name === name) || LEGACY_MAESTRO_HOOKS.has(name)
    ? name
    : undefined;
}

function countThirdPartyHandlers(config: CodexHooksFile): number {
  let count = 0;
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups ?? []) {
      count += group.hooks.filter((handler) => !ownedMaestroHookName(handler)).length;
    }
  }
  return count;
}

function inferPreset(installedNames: readonly string[]): HookLevel | "custom" {
  const installed = new Set(installedNames);
  for (const level of MAESTRO_HOOK_LEVELS) {
    const preset = hooksForPreset(level);
    if (preset.length === installed.size && preset.every((name) => installed.has(name))) return level;
  }
  return "custom";
}

async function withConfigLock(filePath: string, operation: () => Promise<void>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const release = await properLockfile.lock(filePath, {
    realpath: false,
    stale: 5_000,
    update: 1_000,
    retries: { retries: 200, factor: 1, minTimeout: 15, maxTimeout: 50, randomize: true },
  });
  try {
    await operation();
  } finally {
    await release();
  }
}

async function atomicWriteConfig(filePath: string, config: CodexHooksFile): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    try {
      await handle?.close();
    } finally {
      if (created) await unlink(temporaryPath).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
