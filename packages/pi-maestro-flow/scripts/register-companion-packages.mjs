import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const COMPANION_PACKAGES = ["pi-maestro-teammate", "pi-cockpit"];

function normalizePath(path) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalKey(path) {
  try {
    return normalizePath(realpathSync(path));
  } catch {
    return normalizePath(path);
  }
}

function packageName(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : undefined;
  } catch {
    return undefined;
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
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name === name) return dir;
      } catch {
        // keep walking up past an unreadable manifest
      }
    }
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
  settingsFile = join(homedir(), ".pi", "agent", "settings.json"),
  packageDirs = collectCompanionDirs(),
} = {}) {
  let settings = {};
  if (existsSync(settingsFile)) {
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  }
  const configuredPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const companionNames = new Set(packageDirs.map(packageName).filter(Boolean));
  const packages = [];
  const seen = new Set();
  const seenPackageNames = new Set();
  let pruned = false;
  for (const dir of configuredPackages) {
    const key = canonicalKey(dir);
    const name = packageName(dir);
    if (seen.has(key) || (name && companionNames.has(name) && seenPackageNames.has(name))) {
      pruned = true;
      continue;
    }
    packages.push(dir);
    seen.add(key);
    if (name) seenPackageNames.add(name);
  }

  const added = [];
  for (const dir of packageDirs) {
    const key = canonicalKey(dir);
    const name = packageName(dir);
    if (seen.has(key) || (name && seenPackageNames.has(name))) continue;
    packages.push(dir);
    seen.add(key);
    if (name) seenPackageNames.add(name);
    added.push(dir);
  }
  if (!pruned && added.length === 0) {
    return { changed: false, added, packages };
  }
  settings.packages = packages;
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { changed: true, added, packages };
}

function run() {
  try {
    const result = registerCompanionPackages();
    if (result.changed) {
      if (result.added.length > 0) {
        console.log(`[pi-maestro-flow] Registered companion packages: ${result.added.join(", ")}`);
      } else {
        console.log("[pi-maestro-flow] Removed duplicate companion package registrations");
      }
    } else {
      console.log("[pi-maestro-flow] Companion packages already registered");
    }
  } catch (error) {
    // Best-effort: a registration hiccup must not fail `npm install`; the packages
    // are already present in node_modules and can be registered manually.
    console.error(`[pi-maestro-flow] Companion package registration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
