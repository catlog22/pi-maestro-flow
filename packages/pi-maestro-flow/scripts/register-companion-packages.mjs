import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMPANION_PACKAGES = ["pi-maestro-teammate", "pi-cockpit"];
const SIDECAR_FILE = "pi-maestro-flow-companions.json";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function getCompanionStatePath(agentDir = getAgentDir()) {
  return join(agentDir, SIDECAR_FILE);
}

function normalizePath(filePath) {
  const resolved = resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalKey(filePath) {
  try {
    return normalizePath(realpathSync(filePath));
  } catch {
    return normalizePath(filePath);
  }
}

function sourceOf(entry) {
  if (typeof entry === "string" && entry.trim()) return entry;
  if (isRecord(entry) && typeof entry.source === "string" && entry.source.trim()) return entry.source;
  return undefined;
}

function replaceSource(entry, source) {
  return typeof entry === "string" ? source : { ...entry, source };
}

function enableManagedCompanionExtensions(entry) {
  if (!isRecord(entry) || !Array.isArray(entry.extensions) || entry.extensions.length > 0) return entry;
  const { extensions: _disabledExtensions, ...enabledEntry } = entry;
  return Object.keys(enabledEntry).length === 1 && typeof enabledEntry.source === "string"
    ? enabledEntry.source
    : enabledEntry;
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid ${label}: root value must be an object`);
  return parsed;
}

function readPackageManifest(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function packageIdentity(source) {
  const manifest = readPackageManifest(source);
  if (!manifest || typeof manifest.name !== "string" || !manifest.name.trim()) return undefined;
  return {
    name: manifest.name.trim(),
    version: typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : undefined,
    source,
    canonicalSource: canonicalKey(source),
  };
}

function findPackageRoot(startDir, name) {
  let current = startDir;
  while (true) {
    if (readPackageManifest(current)?.name === name) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function expectedCompanionVersions(fromUrl = import.meta.url) {
  const flowRoot = findPackageRoot(dirname(fileURLToPath(fromUrl)), "pi-maestro-flow");
  const dependencies = flowRoot ? readPackageManifest(flowRoot)?.dependencies : undefined;
  if (!isRecord(dependencies)) return {};
  return Object.fromEntries(COMPANION_PACKAGES.flatMap((name) => {
    const version = dependencies[name];
    return typeof version === "string" ? [[name, version]] : [];
  }));
}

function readSettings(settingsFile) {
  if (!existsSync(settingsFile)) return { settings: {}, packages: [] };
  const settings = readJsonObject(settingsFile, "Pi settings");
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
    throw new Error("Invalid Pi settings: packages must be an array when present");
  }
  return { settings, packages: settings.packages ?? [] };
}

function readCompanionState(stateFile) {
  if (!existsSync(stateFile)) return { companions: {} };
  const state = readJsonObject(stateFile, "Maestro companion state");
  if (state.version !== 1 || !isRecord(state.companions)) {
    throw new Error("Invalid Maestro companion state");
  }
  const companions = {};
  for (const [name, entry] of Object.entries(state.companions)) {
    if (!isRecord(entry) || typeof entry.source !== "string" || !entry.source.trim()) {
      throw new Error(`Invalid Maestro companion state entry: ${name}`);
    }
    if (entry.canonicalSource !== undefined && (typeof entry.canonicalSource !== "string" || !entry.canonicalSource.trim())) {
      throw new Error(`Invalid Maestro companion state canonical source: ${name}`);
    }
    if (entry.version !== undefined && (typeof entry.version !== "string" || !entry.version.trim())) {
      throw new Error(`Invalid Maestro companion state version: ${name}`);
    }
    companions[name] = {
      source: entry.source,
      canonicalSource: typeof entry.canonicalSource === "string" ? entry.canonicalSource : canonicalKey(entry.source),
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
    };
  }
  return { companions };
}

function isNestedInFlowInstallation(source) {
  // Only a direct dependency path is attributable to a legacy Flow install.
  // A repository checkout may also be nested below a pi-maestro-flow root, but
  // its companion lives under packages/ and must remain a local override.
  const dependencyDir = dirname(resolve(source));
  return basename(dependencyDir) === "node_modules"
    && readPackageManifest(dirname(dependencyDir))?.name === "pi-maestro-flow";
}

function makeStateEntry(target) {
  return {
    source: target.source,
    canonicalSource: target.canonicalSource,
    ...(target.version ? { version: target.version } : {}),
  };
}

function sameStateEntry(left, right) {
  return left?.source === right?.source
    && left?.canonicalSource === right?.canonicalSource
    && left?.version === right?.version;
}

function classifyEntries(packages, target, stateEntry) {
  return packages.flatMap((entry, index) => {
    const source = sourceOf(entry);
    if (!source) return [];
    const canonicalSource = canonicalKey(source);
    const identity = packageIdentity(source);
    const isTarget = canonicalSource === target.canonicalSource;
    const isState = canonicalSource === stateEntry?.canonicalSource;
    const hasName = identity?.name === target.name;
    if (!isTarget && !isState && !hasName) return [];
    return [{
      entry,
      index,
      source,
      canonicalSource,
      isTarget,
      isState,
      isLegacy: Boolean(hasName && isNestedInFlowInstallation(source)),
    }];
  });
}

function comparableObjectEntry(entry, source) {
  return JSON.stringify({ ...entry, source });
}

function preferredManagedEntry(matches, target) {
  const configuredObjects = matches.filter((entry) => isRecord(entry.entry));
  if (configuredObjects.length > 1) {
    const first = comparableObjectEntry(configuredObjects[0].entry, target.source);
    if (configuredObjects.some((entry) => comparableObjectEntry(entry.entry, target.source) !== first)) {
      throw new Error(`Cannot safely dedupe companion aliases with conflicting resource configuration: ${target.name}`);
    }
  }
  return configuredObjects[0] ?? matches.find((entry) => entry.isTarget) ?? matches[0];
}

function removeIndexes(packages, indexes) {
  return packages.filter((_entry, index) => !indexes.has(index));
}

function writeJsonAtomically(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") {
      let directoryDescriptor;
      try {
        directoryDescriptor = openSync(dirname(filePath), "r");
        fsyncSync(directoryDescriptor);
      } catch {
        // The replacement itself is durable even when the filesystem rejects directory fsync.
      } finally {
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original write error */ }
    }
    try { rmSync(temporaryPath, { force: true }); } catch { /* preserve the original write error */ }
    throw error;
  }
}

// Pi only reads the `pi` field of packages listed in settings.packages; it never
// walks a package's dependencies. Companion extensions must therefore be registered
// explicitly, and their directories are located by resolving the package entry point
// (exports maps here do not expose ./package.json) then walking up to the package root.
export function resolvePackageDir(name, fromUrl = import.meta.url) {
  const require = createRequire(fromUrl);
  let entry;
  try {
    entry = require.resolve(name);
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  while (true) {
    if (readPackageManifest(dir)?.name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function collectCompanionDirs({
  names = COMPANION_PACKAGES,
  fromUrl = import.meta.url,
} = {}) {
  const dirs = [];
  for (const name of names) {
    const dir = resolvePackageDir(name, fromUrl);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

export function registerCompanionPackages({
  agentDir = getAgentDir(),
  settingsFile = join(agentDir, "settings.json"),
  stateFile = getCompanionStatePath(dirname(settingsFile)),
  packageDirs = collectCompanionDirs(),
  expectedVersions = expectedCompanionVersions(),
  writeFile = writeJsonAtomically,
} = {}) {
  const { settings, packages: configuredPackages } = readSettings(settingsFile);
  const state = readCompanionState(stateFile);
  const targets = [];
  const targetNames = new Set();
  const versionMismatch = [];

  for (const dir of packageDirs) {
    const identity = packageIdentity(dir);
    if (!identity || !COMPANION_PACKAGES.includes(identity.name) || targetNames.has(identity.name)) continue;
    const target = {
      ...identity,
      expectedVersion: typeof expectedVersions[identity.name] === "string" ? expectedVersions[identity.name] : undefined,
    };
    targets.push(target);
    targetNames.add(target.name);
    if (target.expectedVersion && target.version !== target.expectedVersion) {
      versionMismatch.push({ name: target.name, expected: target.expectedVersion, actual: target.version });
    }
  }

  let packages = [...configuredPackages];
  const companions = { ...state.companions };
  const added = [];
  const replaced = [];
  const adopted = [];
  const preservedUnowned = [];

  for (const target of targets) {
    const priorState = companions[target.name];
    const matches = classifyEntries(packages, target, priorState);
    const unowned = matches.filter((entry) => !entry.isTarget && !entry.isState && !entry.isLegacy);
    if (unowned.length > 0) {
      preservedUnowned.push({ name: target.name, source: unowned[0].source });
      continue;
    }

    const exact = matches.filter((entry) => entry.isTarget);
    if (exact.length > 0) {
      const kept = preferredManagedEntry(matches, target);
      const replacedSource = kept.source;
      const nextEntry = kept.isTarget ? kept.entry : replaceSource(kept.entry, target.source);
      packages[kept.index] = enableManagedCompanionExtensions(nextEntry);
      if (!kept.isTarget) {
        replaced.push({ name: target.name, from: replacedSource, to: target.source });
      }
      const removable = new Set(matches
        .filter((entry) => entry.index !== kept.index)
        .map((entry) => entry.index));
      packages = removeIndexes(packages, removable);
      const nextState = makeStateEntry(target);
      if (!sameStateEntry(priorState, nextState)) adopted.push(target.name);
      companions[target.name] = nextState;
      continue;
    }

    const owned = matches.filter((entry) => entry.isState || entry.isLegacy);
    if (owned.length > 0) {
      const replacedEntry = owned[0];
      packages[replacedEntry.index] = enableManagedCompanionExtensions(
        replaceSource(replacedEntry.entry, target.source),
      );
      packages = removeIndexes(packages, new Set(owned.slice(1).map((entry) => entry.index)));
      companions[target.name] = makeStateEntry(target);
      replaced.push({ name: target.name, from: replacedEntry.source, to: target.source });
      continue;
    }

    packages.push(target.source);
    companions[target.name] = makeStateEntry(target);
    added.push(target.source);
  }

  const settingsChanged = JSON.stringify(packages) !== JSON.stringify(configuredPackages);
  const nextState = { version: 1, companions };
  const stateChanged = JSON.stringify(nextState) !== JSON.stringify({ version: 1, companions: state.companions });
  if (settingsChanged) {
    writeFile(settingsFile, `${JSON.stringify({ ...settings, packages }, null, 2)}\n`);
  }
  if (stateChanged) {
    writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
  }

  return {
    changed: settingsChanged || stateChanged,
    added,
    replaced,
    adopted,
    preservedUnowned,
    versionMismatch,
    packages,
    settingsFile,
    stateFile,
  };
}

function run() {
  try {
    const result = registerCompanionPackages();
    if (result.added.length > 0) {
      console.log(`[pi-maestro-flow] Registered companion packages: ${result.added.join(", ")}`);
    } else if (result.replaced.length > 0) {
      console.log(`[pi-maestro-flow] Upgraded companion package registrations: ${result.replaced.map((entry) => entry.name).join(", ")}`);
    } else if (result.adopted.length > 0) {
      console.log(`[pi-maestro-flow] Recorded companion package ownership: ${result.adopted.join(", ")}`);
    } else {
      console.log("[pi-maestro-flow] Companion packages already registered");
    }
    for (const entry of result.preservedUnowned) {
      console.warn(`[pi-maestro-flow] Preserved local companion override for ${entry.name}: ${entry.source}`);
    }
    for (const entry of result.versionMismatch) {
      console.warn(`[pi-maestro-flow] ${entry.name} resolved ${entry.actual ?? "unknown"}, but Flow requires ${entry.expected}; reinstall the versioned Flow package.`);
    }
  } catch (error) {
    // Best-effort: a registration hiccup must not fail `npm install`; the packages
    // are already present in node_modules and can be registered manually.
    console.error(`[pi-maestro-flow] Companion package registration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
