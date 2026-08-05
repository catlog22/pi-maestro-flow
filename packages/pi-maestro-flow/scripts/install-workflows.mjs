import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function copyDirectory(sourceDir, targetDir) {
  let files = 0;
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isDirectory()) files += copyDirectory(source, target);
    else if (entry.isFile()) {
      copyFileSync(source, target);
      files++;
    }
  }
  return files;
}

function assertArchKbComplete(archKbDir) {
  const indexPath = join(archKbDir, "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`Maestro arch-kb index not found: ${indexPath}`);
  }

  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    throw new Error(`Maestro arch-kb index is invalid: ${indexPath}`, { cause: error });
  }

  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error(`Maestro arch-kb index has no entries: ${indexPath}`);
  }
  const missing = index.entries
    .filter((entry) => typeof entry?.path !== "string" || !existsSync(join(archKbDir, entry.path)))
    .map((entry) => entry?.path ?? "<invalid path>");
  if (missing.length > 0) {
    throw new Error(`Maestro arch-kb source files are missing (${missing.length}): ${missing.slice(0, 3).join(", ")}`);
  }

  return index.entries.length;
}

export function resolveMaestroFlowRoot() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("maestro-flow/package.json"));
}

export function installMaestroWorkflows({
  packageRoot = resolveMaestroFlowRoot(),
  maestroHome = process.env.MAESTRO_HOME ?? join(homedir(), ".maestro"),
  runner = spawnSync,
  stdio = "inherit",
} = {}) {
  const binary = join(packageRoot, "bin", "maestro.js");
  const runtimeEntry = join(packageRoot, "dist", "src", "cli.js");
  const result = existsSync(binary) && existsSync(runtimeEntry)
    ? runner(process.execPath, [binary, "install", "workflows"], {
        stdio,
        windowsHide: true,
        env: { ...process.env, MAESTRO_HOME: maestroHome },
      })
    : { status: 1, error: new Error(`Runnable Maestro CLI not found under: ${packageRoot}`) };

  const workflowsTargetDir = join(maestroHome, "workflows");
  const archKbTargetDir = join(maestroHome, "arch-kb");
  let cliFailure = result.error;
  if (!result.error && result.status === 0) {
    try {
      const archKbEntriesInstalled = assertArchKbComplete(archKbTargetDir);
      return {
        mode: "maestro-cli",
        targetDir: workflowsTargetDir,
        archKbTargetDir,
        archKbEntriesInstalled,
      };
    } catch (error) {
      cliFailure = error;
    }
  }

  // Compatibility fallback for missing commands or incomplete CLI installs.
  const workflowsSourceDir = join(packageRoot, "workflows");
  if (!existsSync(workflowsSourceDir)) {
    throw cliFailure ?? new Error(`Maestro workflows directory not found: ${workflowsSourceDir}`);
  }
  const archKbSourceDir = join(packageRoot, "resources", "arch-kb");
  const archKbEntriesInstalled = assertArchKbComplete(archKbSourceDir);
  const filesInstalled = copyDirectory(workflowsSourceDir, workflowsTargetDir);
  const archKbFilesInstalled = copyDirectory(archKbSourceDir, archKbTargetDir);
  return {
    mode: "package-fallback",
    targetDir: workflowsTargetDir,
    filesInstalled,
    archKbTargetDir,
    archKbFilesInstalled,
    archKbEntriesInstalled,
  };
}

function run() {
  try {
    const result = installMaestroWorkflows();
    console.log(
      `[pi-maestro-flow] Installed Maestro workflows to ${result.targetDir} and ${result.archKbEntriesInstalled} arch-kb entries to ${result.archKbTargetDir} via ${result.mode}`,
    );
  } catch (error) {
    console.warn(`[pi-maestro-flow] Workflow installation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    console.warn("[pi-maestro-flow] Run 'maestro install workflows' manually to complete setup.");
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
