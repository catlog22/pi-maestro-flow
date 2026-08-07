import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Gitignored local-only entries in the canonical .pi directory; never packaged.
const localOnlyEntries = new Set(["settings.local.json", "model-failover.json", "scratch"]);

// Runtime capture records under .pi/agents (<correlationId>.json) are
// gitignored but would still ship because the npm "files" whitelist for .pi/
// bypasses gitignore. Role definitions (*.md) and their schema (*.schema.json)
// must ship — the packaged role catalog is what the teammate extension
// discovers from any cwd.
function isPackagedAgentsEntry(relative) {
  if (!relative.startsWith("agents/")) return true;
  if (relative.endsWith(".md")) return true;
  if (relative.endsWith(".schema.json")) return true;
  return false;
}

// Names retained for script/test compatibility; syncs the whole canonical .pi directory
// (SYSTEM.md, agents, hooks, settings, skills, ...), not just skills.
export function preparePackagedSkills({
  sourceDir = resolve(packageRoot, "..", "..", ".pi"),
  targetDir = join(packageRoot, ".pi"),
} = {}) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Canonical Pi directory not found: ${sourceDir}`);
  }
  const sourcePrefix = resolve(sourceDir).replaceAll("\\", "/");
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const normalized = resolve(source).replaceAll("\\", "/");
      if (normalized.includes("/__pycache__/")
        || normalized.endsWith("/__pycache__")
        || normalized.endsWith(".pyc")) {
        return false;
      }
      const relative = normalized === sourcePrefix ? "" : normalized.slice(sourcePrefix.length + 1);
      if (localOnlyEntries.has(relative.split("/")[0])) return false;
      return isPackagedAgentsEntry(relative);
    },
  });
  return { sourceDir, targetDir };
}

export function cleanPackagedSkills({
  targetDir = join(packageRoot, ".pi"),
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
  console.log(`[pi-maestro-flow] Prepared canonical Pi directory from ${result.sourceDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
