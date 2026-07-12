import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

function resolveOwnPackageJson(): string | undefined {
  try {
    return require.resolve("../../package.json");
  } catch {
    return undefined;
  }
}

export function resolveBundledAgentsPath(
  packageJsonPath = resolveOwnPackageJson(),
): string | undefined {
  if (!packageJsonPath) return undefined;

  const agentsPath = join(dirname(packageJsonPath), "AGENTS.md");
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
  const agentsPath = resolveBundledAgentsPath();
  const agentsInstructions = loadBundledAgentsInstructions(agentsPath);

  if (agentsPath && agentsInstructions) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n<project_instructions path="${agentsPath}">\n${agentsInstructions}\n</project_instructions>`,
    }));
  }
}
