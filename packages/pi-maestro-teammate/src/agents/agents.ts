/**
 * Agent discovery and configuration.
 *
 * Discovers agent definitions from three locations (in priority order):
 *   1. Project agents: .pi/agents/ in the nearest project root
 *   2. User agents: ~/.pi/agent/extensions/teammate/agents/
 *   3. Builtin agents: bundled agents/ directory in this package
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";

type SystemPromptMode = "append" | "replace";
export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentSummary {
  name: string;
  description: string;
  source: AgentSource;
}

const BUILTIN_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents",
);

function listMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".md")) continue;
    files.push(path.join(dir, entry.name));
  }

  return files.sort();
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  for (const filePath of listMarkdownFiles(dir)) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const rawTools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const systemPromptMode: SystemPromptMode =
      frontmatter.systemPromptMode === "replace"
        ? "replace"
        : frontmatter.systemPromptMode === "append"
          ? "append"
          : frontmatter.name === "delegate"
            ? "append"
            : "replace";

    const inheritProjectContext =
      frontmatter.inheritProjectContext === "true"
        ? true
        : frontmatter.inheritProjectContext === "false"
          ? false
          : frontmatter.name === "delegate";

    const inheritSkills = frontmatter.inheritSkills === "true";

    const defaultContext =
      frontmatter.defaultContext === "fork"
        ? ("fork" as const)
        : frontmatter.defaultContext === "fresh"
          ? ("fresh" as const)
          : undefined;

    const rawFallbackModels = frontmatter.fallbackModels
      ?.split(",")
      .map((m: string) => m.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: rawTools && rawTools.length > 0 ? rawTools : undefined,
      model: frontmatter.model,
      fallbackModels: rawFallbackModels && rawFallbackModels.length > 0 ? rawFallbackModels : undefined,
      thinking: frontmatter.thinking,
      systemPromptMode,
      inheritProjectContext,
      inheritSkills,
      defaultContext,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

/**
 * Discover all agent definitions, merged by priority:
 * project > user > builtin (name collisions: higher priority wins).
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  const userAgentsDir = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "teammate",
    "agents",
  );

  // Find project root (first ancestor with .pi/ directory)
  let projectAgentsDir: string | null = null;
  let currentDir = cwd;
  while (true) {
    const piDir = path.join(currentDir, ".pi", "agents");
    if (fs.existsSync(piDir)) {
      projectAgentsDir = piDir;
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
  const userAgents = loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : [];

  // Merge: project > user > builtin
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return Array.from(agentMap.values());
}

/**
 * Resolve a single agent by name.
 */
export function resolveAgent(
  cwd: string,
  agentName: string,
): AgentConfig | undefined {
  const agents = discoverAgents(cwd);
  return agents.find((a) => a.name === agentName);
}

/** Return resolved role metadata without exposing the role prompt body. */
export function listAgentSummaries(cwd: string): AgentSummary[] {
  return discoverAgents(cwd)
    .map(({ name, description, source }) => ({ name, description, source }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Format a compact, deterministic role catalog for teammate tool metadata. */
export function formatAgentCatalog(
  cwd: string,
  maxRoles = 32,
  maxDescriptionLength = 120,
): string {
  const summaries = listAgentSummaries(cwd);
  if (summaries.length === 0) return "(no discovered teammate roles)";

  const visible = summaries.slice(0, maxRoles);
  const lines = visible.map((agent) => {
    const normalized = agent.description.replace(/\s+/g, " ").trim();
    const description = normalized.length > maxDescriptionLength
      ? `${normalized.slice(0, Math.max(1, maxDescriptionLength - 1)).trimEnd()}…`
      : normalized;
    return `- ${agent.name} [${agent.source}]: ${description}`;
  });

  if (summaries.length > visible.length) {
    lines.push(`- … ${summaries.length - visible.length} more role(s) discovered`);
  }

  return lines.join("\n");
}
