import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

  if (!result.error && result.status === 0) {
    return { mode: "maestro-cli", targetDir: join(maestroHome, "workflows") };
  }

  // Compatibility fallback for maestro-flow versions before `install workflows`.
  const sourceDir = join(packageRoot, "workflows");
  if (!existsSync(sourceDir)) {
    throw result.error ?? new Error(`Maestro workflows directory not found: ${sourceDir}`);
  }
  const targetDir = join(maestroHome, "workflows");
  const filesInstalled = copyDirectory(sourceDir, targetDir);
  return { mode: "package-fallback", targetDir, filesInstalled };
}

function run() {
  try {
    const result = installMaestroWorkflows();
    console.log(`[pi-maestro-flow] Installed Maestro workflows to ${result.targetDir} via ${result.mode}`);
  } catch (error) {
    console.error(`[pi-maestro-flow] Workflow installation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
