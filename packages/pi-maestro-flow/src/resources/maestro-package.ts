import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

export function resolveOwnPackageJson(): string | undefined {
  try {
    return require.resolve("../../package.json");
  } catch {
    return undefined;
  }
}

function resolveWorkspaceRoot(packageDir: string): string | undefined {
  let current = dirname(packageDir);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      if (Array.isArray(manifest.workspaces)) return current;
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolvePackageOrWorkspaceResource(
  segments: readonly string[],
  packageJsonPath = resolveOwnPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;
  const packageDir = dirname(packageJsonPath);
  const packaged = join(packageDir, ...segments);
  if (existsSync(packaged)) return packaged;

  const workspaceRoot = resolveWorkspaceRoot(packageDir);
  if (!workspaceRoot) return undefined;
  const workspaceResource = join(workspaceRoot, ...segments);
  return existsSync(workspaceResource) ? workspaceResource : undefined;
}

export function configureTeammateAgentsDiscovery(
  packageJsonPath = resolveOwnPackageJson(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PI_TEAMMATE_PACKAGE_AGENTS_DIR !== undefined) {
    return env.PI_TEAMMATE_PACKAGE_AGENTS_DIR;
  }
  const agentsDir = resolvePackageOrWorkspaceResource([".pi", "agents"], packageJsonPath);
  if (agentsDir) env.PI_TEAMMATE_PACKAGE_AGENTS_DIR = agentsDir;
  return agentsDir;
}

export function resolveBundledAgentsPath(
  packageJsonPath = resolveOwnPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;

  const pkgDir = dirname(packageJsonPath);

  // Prefer .pi/SYSTEM.md (canonical location after packaging);
  // fall back to AGENTS.md at the package root for backward compat.
  const systemMd = join(pkgDir, ".pi", "SYSTEM.md");
  if (existsSync(systemMd)) return systemMd;

  const agentsPath = join(pkgDir, "AGENTS.md");
  return existsSync(agentsPath) ? agentsPath : undefined;
}

export function loadBundledAgentsInstructions(
  agentsPath = resolveBundledAgentsPath(),
): string | undefined {
  if (!agentsPath) return undefined;

  const content = readFileSync(agentsPath, "utf8").trim();
  return content || undefined;
}

export function registerMaestroPackageResources(pi: ExtensionAPI): void {
  configureTeammateAgentsDiscovery();
  const agentsPath = resolveBundledAgentsPath();
  const agentsInstructions = loadBundledAgentsInstructions(agentsPath);

  if (agentsPath && agentsInstructions) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n<project_instructions path="${agentsPath}">\n${agentsInstructions}\n</project_instructions>`,
    }));
  }
}
