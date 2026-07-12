import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

function resolveInstalledPackageJson(): string | undefined {
  try {
    return require.resolve("maestro-flow/package.json");
  } catch {
    return undefined;
  }
}

export function resolveMaestroPackageSkillPath(
  packageJsonPath = resolveInstalledPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;

  const skillPath = join(dirname(packageJsonPath), ".agents", "skills");
  return existsSync(skillPath) ? skillPath : undefined;
}

export function registerMaestroPackageResources(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => {
    const skillPath = resolveMaestroPackageSkillPath();
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
}
