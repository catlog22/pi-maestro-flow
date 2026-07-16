/**
 * Agent discovery and configuration.
 *
 * Discovers agent definitions from compatible project and user locations.
 * Precedence: project .pi/agents > project .agents > ~/.agents > legacy user > builtin.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";
import { parseTeammateThinkingLevel, type TeammateThinkingLevel } from "../shared/thinking.ts";

type SystemPromptMode = "append" | "replace";
export type AgentSource = "builtin" | "user" | "project";

export const BUILTIN_AGENT_NAMES = ["delegate", "explorer", "goal-verifier", "workflow"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];

const LEGACY_AGENT_ALIASES: Readonly<Record<string, BuiltinAgentName>> = {
  coordinator: "workflow",
};

const AGENT_CATALOG_START_MARKER = "<!-- teammate-agent-catalog:start -->";
const AGENT_CATALOG_END_MARKER = "<!-- teammate-agent-catalog:end -->";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: TeammateThinkingLevel;
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

export interface AgentCatalogSnapshot {
  signature: string;
  systemPrompt: string;
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
      thinking: parseTeammateThinkingLevel(frontmatter.thinking),
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

export function isBuiltinAgentName(name: string): name is BuiltinAgentName {
  return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

function isReservedAgentName(name: string): boolean {
  return isBuiltinAgentName(name) || Object.hasOwn(LEGACY_AGENT_ALIASES, name);
}

function canonicalAgentName(name: string): string {
  return LEGACY_AGENT_ALIASES[name] ?? name;
}

/**
 * Discover all agent definitions, merged by priority:
 * project > user > builtin (name collisions: higher priority wins).
 */
export function discoverAgents(cwd: string, homeDir = os.homedir()): AgentConfig[] {
  const legacyUserAgentsDir = path.join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "teammate",
    "agents",
  );
  const userAgentsDir = path.join(homeDir, ".agents");

  // Find the nearest ancestor containing either supported project directory.
  let projectPiAgentsDir: string | null = null;
  let projectCompatAgentsDir: string | null = null;
  let currentDir = cwd;
  while (true) {
    const piAgentsDir = path.join(currentDir, ".pi", "agents");
    const compatAgentsDir = path.join(currentDir, ".agents");
    if (fs.existsSync(piAgentsDir) || fs.existsSync(compatAgentsDir)) {
      projectPiAgentsDir = fs.existsSync(piAgentsDir) ? piAgentsDir : null;
      projectCompatAgentsDir = fs.existsSync(compatAgentsDir) ? compatAgentsDir : null;
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const builtinByName = new Map(
    loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin")
      .filter((agent) => isBuiltinAgentName(agent.name))
      .map((agent) => [agent.name, agent]),
  );
  const builtinAgents = BUILTIN_AGENT_NAMES
    .map((name) => builtinByName.get(name))
    .filter((agent): agent is AgentConfig => agent !== undefined);
  const loadCustomAgents = (dir: string, source: AgentSource): AgentConfig[] =>
    loadAgentsFromDir(dir, source)
    .filter((agent) => !isReservedAgentName(agent.name));

  // Builtin names are reserved so project/user definitions cannot silently
  // replace the stable general, exploration, and DAG orchestration roles.
  const legacyUserAgents = loadCustomAgents(legacyUserAgentsDir, "user");
  const userAgents = loadCustomAgents(userAgentsDir, "user");
  const projectCompatAgents = projectCompatAgentsDir
    ? loadCustomAgents(projectCompatAgentsDir, "project")
    : [];
  const projectPiAgents = projectPiAgentsDir
    ? loadCustomAgents(projectPiAgentsDir, "project")
    : [];

  // Merge from lowest to highest priority.
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of legacyUserAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectCompatAgents) agentMap.set(agent.name, agent);
  for (const agent of projectPiAgents) agentMap.set(agent.name, agent);

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
  const canonicalName = canonicalAgentName(agentName);
  return agents.find((a) => a.name === canonicalName);
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

/** Build the compact role directory appended to the active parent prompt. */
export function createAgentCatalogSnapshot(
  cwd: string,
  maxDescriptionLength = 160,
): AgentCatalogSnapshot {
  const summaries = listAgentSummaries(cwd);
  const byName = new Map(summaries.map((agent) => [agent.name, agent]));
  const builtins = BUILTIN_AGENT_NAMES
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentSummary => agent !== undefined);
  const discovered = summaries
    .filter((agent) => !isBuiltinAgentName(agent.name));

  const formatLine = (agent: AgentSummary): string => {
    const normalized = agent.description.replace(/\s+/g, " ").trim();
    const description = normalized.length > maxDescriptionLength
      ? `${normalized.slice(0, Math.max(1, maxDescriptionLength - 1)).trimEnd()}…`
      : normalized;
    return `- ${agent.name}: ${description}`;
  };

  const lines = [
    AGENT_CATALOG_START_MARKER,
    "# Available Teammate Agents",
    "",
    "Built-in roles:",
    ...builtins.map(formatLine),
    "",
    "Discovered project and user roles:",
    ...(discovered.length > 0 ? discovered.map(formatLine) : ["(none)"]),
  ];

  lines.push(
    "",
    "Use the exact agent name. Unknown names are invalid. Agent prompt bodies are loaded only after a role is selected.",
    AGENT_CATALOG_END_MARKER,
  );

  return {
    signature: summaries
      .map((agent) => `${agent.name}:${agent.source}:${agent.description}`)
      .join("\n"),
    systemPrompt: lines.join("\n"),
  };
}

/** Replace an existing role directory or append a fresh one to the prompt. */
export function appendAgentCatalog(systemPrompt: string, cwd: string): string {
  const snapshot = createAgentCatalogSnapshot(cwd);
  const start = systemPrompt.indexOf(AGENT_CATALOG_START_MARKER);
  const end = systemPrompt.indexOf(AGENT_CATALOG_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${snapshot.systemPrompt}${systemPrompt.slice(end + AGENT_CATALOG_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${snapshot.systemPrompt}`;
}
