import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function preparePackagedSkills({
  sourceDir = resolve(packageRoot, "..", "..", ".pi", "skills"),
  targetDir = join(packageRoot, ".pi", "skills"),
} = {}) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Canonical Pi skills directory not found: ${sourceDir}`);
  }
  const legacyTeamSwarmDir = resolve(sourceDir, "team-swarm").replaceAll("\\", "/");
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const normalized = resolve(source).replaceAll("\\", "/");
      return normalized !== legacyTeamSwarmDir
        && !normalized.startsWith(`${legacyTeamSwarmDir}/`)
        && !normalized.includes("/__pycache__/")
        && !normalized.endsWith("/__pycache__")
        && !normalized.endsWith(".pyc");
    },
  });
  return { sourceDir, targetDir };
}

export function cleanPackagedSkills({
  targetDir = join(packageRoot, ".pi", "skills"),
} = {}) {
  rmSync(targetDir, { recursive: true, force: true });
  const piDir = dirname(targetDir);
  try { rmSync(piDir); } catch { /* keep non-empty or already removed directory */ }
  return { targetDir };
}

function run() {
  if (process.argv.includes("--clean")) {
    cleanPackagedSkills();
    return;
  }
  const result = preparePackagedSkills();
  console.log(`[pi-maestro-flow] Prepared canonical Pi skills from ${result.sourceDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
