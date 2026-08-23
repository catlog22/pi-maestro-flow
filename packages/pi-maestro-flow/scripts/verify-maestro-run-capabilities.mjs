import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_RUN_COMMANDS = ["next", "create", "complete"];

export function resolveMaestroFlowRoot() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("maestro-flow/package.json"));
}

export function verifyMaestroRunCapabilities({
  packageRoot = resolveMaestroFlowRoot(),
  runner = spawnSync,
} = {}) {
  const binary = join(packageRoot, "bin", "maestro.js");
  const runtimeEntry = join(packageRoot, "dist", "src", "cli.js");
  if (!existsSync(binary) || !existsSync(runtimeEntry)) {
    throw new Error(`maestro-flow must provide a runnable CLI under ${packageRoot}; install a current published package before generating Pi skills.`);
  }

  for (const command of REQUIRED_RUN_COMMANDS) {
    const result = runner(process.execPath, [binary, "run", command, "--help"], {
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
    const output = `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`;
    if (!result.error && result.status === 0 && hasRunCommandUsage(output, command)) continue;

    const detail = result.error?.message
      ?? (output.trim() || `exit status ${result.status}`);
    throw new Error(`maestro-flow lacks required command \`maestro run ${command}\`: ${detail}. Update maestro-flow before generating Pi skills.`);
  }

  return { packageRoot, commands: [...REQUIRED_RUN_COMMANDS] };
}

function hasRunCommandUsage(output, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Usage:\\s+maestro\\s+run\\s+${escaped}(?:\\s|$)`, 'i').test(output);
}

function main() {
  try {
    const result = verifyMaestroRunCapabilities();
    console.log(`[pi-maestro-flow] Verified Maestro Run CLI: ${result.commands.join(", ")}`);
  } catch (error) {
    console.error(`[pi-maestro-flow] Maestro Run CLI capability check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) main();
