/**
 * Agent discovery and configuration.
 *
 * Discovers agent definitions from package, compatible project, and user locations.
 * Precedence: package > project .pi/agents > project .agents > user global dirs > builtin.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.ts";
import { parseTeammateTaskType, type TeammateTaskType } from "../shared/task-types.ts";
import { parseTeammateThinkingLevel, type TeammateThinkingLevel } from "../shared/thinking.ts";

type SystemPromptMode = "append" | "replace";
export type AgentSource = "builtin" | "package" | "user" | "project";

export const BUILTIN_AGENT_NAMES = [
  "general",
  "explorer",
  "planner",
  "analyst",
  "research",
  "verifier",
  "workflow",
] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];
export const PUBLIC_BUILTIN_AGENT_NAMES = [
  "general",
  "explorer",
  "planner",
  "analyst",
  "research",
  "verifier",
  "workflow",
] as const satisfies readonly BuiltinAgentName[];

const AGENT_CATALOG_START_MARKER = "<!-- teammate-agent-catalog:start -->";
const AGENT_CATALOG_END_MARKER = "<!-- teammate-agent-catalog:end -->";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  taskType?: TeammateTaskType;
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
      ?.split(/[\n,]+/)
      .map((tool) => tool.replace(/^\s*-\s*/, "").trim().toLowerCase())
      .filter(Boolean);

    const systemPromptMode: SystemPromptMode =
      frontmatter.systemPromptMode === "replace"
        ? "replace"
        : frontmatter.systemPromptMode === "append"
          ? "append"
          : frontmatter.name === "general"
            ? "append"
            : "replace";

    const inheritProjectContext =
      frontmatter.inheritProjectContext === "true"
        ? true
        : frontmatter.inheritProjectContext === "false"
          ? false
          : frontmatter.name === "general";

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
      taskType: parseTeammateTaskType(frontmatter.taskType),
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
  return isBuiltinAgentName(name);
}

interface DiscoveryDirs {
  legacyUserAgentsDir: string;
  userPiAgentsDir: string;
  userAgentsDir: string;
  userNestedAgentsDir: string;
  packageAgentsDirs: string[];
  projectPiAgentsDir: string | null;
  projectCompatAgentsDir: string | null;
  projectNestedAgentsDir: string | null;
}

// The installed pi-maestro-flow package ships its role catalog at
// <pkgRoot>/.pi/agents. Resolving the package root keeps those roles
// discoverable from ANY working directory (global npm installs, arbitrary
// projects), instead of only inside the repo tree via the project tier.
// PI_TEAMMATE_PACKAGE_AGENTS_DIR overrides the location (tests / forks).
let cachedPackageAgentsDirs: string[] | undefined;

function packageRootFromAncestors(startDir: string): string | null {
  // The package has no main and no "exports" covering ./package.json, so
  // require.resolve cannot name it. Walk the ancestor chain instead, checking
  // both a sibling and a node_modules child at each level — this covers the
  // global install (both packages under one node_modules) and the monorepo
  // (workspace symlink under the repo root node_modules).
  let currentDir = startDir;
  while (true) {
    for (const candidate of [
      path.join(currentDir, "pi-maestro-flow"),
      path.join(currentDir, "node_modules", "pi-maestro-flow"),
    ]) {
      try {
        const packageJsonPath = path.join(candidate, "package.json");
        if (!fs.existsSync(packageJsonPath)) continue;
        const { name } = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
        if (name !== "pi-maestro-flow") continue;
        return fs.realpathSync(candidate);
      } catch {
        // unreadable package.json — keep walking
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function workspaceRootFromPackage(packageRoot: string): string | null {
  // The prepack pipeline materializes the workspace-root canonical .pi into the
  // package dir, so the repo-root .pi/agents is the packaged catalog's source.
  // In the monorepo the package dir's own .pi is empty outside pack time;
  // falling back to the nearest workspace root (package.json "workspaces")
  // keeps dev/npm-link discovery working. Global installs have no workspaces
  // ancestor, so this adds nothing there.
  let currentDir = path.dirname(packageRoot);
  while (true) {
    try {
      const { workspaces } = JSON.parse(
        fs.readFileSync(path.join(currentDir, "package.json"), "utf8"),
      ) as { workspaces?: unknown };
      if (Array.isArray(workspaces)) return currentDir;
    } catch {
      // not a workspace root — keep walking
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function resolvePackageAgentsDirs(): string[] {
  const override = process.env.PI_TEAMMATE_PACKAGE_AGENTS_DIR;
  if (override !== undefined) {
    const dir = path.resolve(override);
    return fs.existsSync(dir) ? [dir] : [];
  }
  if (cachedPackageAgentsDirs !== undefined) return cachedPackageAgentsDirs;
  const dirs: string[] = [];
  const packageRoot = packageRootFromAncestors(path.dirname(fileURLToPath(import.meta.url)));
  if (packageRoot) {
    const packageAgents = path.join(packageRoot, ".pi", "agents");
    if (fs.existsSync(packageAgents)) dirs.push(packageAgents);
    const workspaceRoot = workspaceRootFromPackage(packageRoot);
    if (workspaceRoot) {
      const workspaceAgents = path.join(workspaceRoot, ".pi", "agents");
      if (fs.existsSync(workspaceAgents) && workspaceAgents !== packageAgents) {
        dirs.push(workspaceAgents);
      }
    }
  }
  cachedPackageAgentsDirs = dirs;
  return dirs;
}

function resolveDiscoveryDirs(cwd: string, homeDir: string): DiscoveryDirs {
  const legacyUserAgentsDir = path.join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "teammate",
    "agents",
  );
  const userPiAgentsDir = path.join(homeDir, ".pi", "agents");
  const userAgentsDir = path.join(homeDir, ".agents");
  const userNestedAgentsDir = path.join(userAgentsDir, "agents");
  const packageAgentsDirs = resolvePackageAgentsDirs();

  // Find the nearest ancestor containing either supported project directory.
  let projectPiAgentsDir: string | null = null;
  let projectCompatAgentsDir: string | null = null;
  let projectNestedAgentsDir: string | null = null;
  let currentDir = cwd;
  while (true) {
    const piAgentsDir = path.join(currentDir, ".pi", "agents");
    const compatAgentsDir = path.join(currentDir, ".agents");
    const nestedAgentsDir = path.join(compatAgentsDir, "agents");
    if (fs.existsSync(piAgentsDir) || fs.existsSync(compatAgentsDir)) {
      projectPiAgentsDir = fs.existsSync(piAgentsDir) ? piAgentsDir : null;
      projectCompatAgentsDir = fs.existsSync(compatAgentsDir) ? compatAgentsDir : null;
      projectNestedAgentsDir = fs.existsSync(nestedAgentsDir) ? nestedAgentsDir : null;
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return {
    legacyUserAgentsDir,
    userPiAgentsDir,
    userAgentsDir,
    userNestedAgentsDir,
    packageAgentsDirs,
    projectPiAgentsDir,
    projectCompatAgentsDir,
    projectNestedAgentsDir,
  };
}

/**
 * Discover all agent definitions, merged by priority:
 * package > project > user > builtin (name collisions: higher priority wins).
 */
export function discoverAgents(cwd: string, homeDir = os.homedir()): AgentConfig[] {
  const {
    legacyUserAgentsDir,
    userPiAgentsDir,
    userAgentsDir,
    userNestedAgentsDir,
    packageAgentsDirs,
    projectPiAgentsDir,
    projectCompatAgentsDir,
    projectNestedAgentsDir,
  } = resolveDiscoveryDirs(cwd, homeDir);

  const builtinByName = new Map(
    loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin")
      .filter((agent) => isBuiltinAgentName(agent.name))
      .map((agent) => [agent.name, agent]),
  );
  const builtinAgents = PUBLIC_BUILTIN_AGENT_NAMES
    .map((name) => builtinByName.get(name))
    .filter((agent): agent is AgentConfig => agent !== undefined);
  const loadCustomAgents = (dir: string, source: AgentSource): AgentConfig[] =>
    loadAgentsFromDir(dir, source)
    .filter((agent) => !isReservedAgentName(agent.name));

  // Builtin names are reserved so project/user definitions cannot silently
  // replace the stable general, exploration, and DAG orchestration roles.
  const packageAgents = packageAgentsDirs.flatMap((dir) => loadCustomAgents(dir, "package"));
  const legacyUserAgents = loadCustomAgents(legacyUserAgentsDir, "user");
  const userPiAgents = loadCustomAgents(userPiAgentsDir, "user");
  const userNestedAgents = loadCustomAgents(userNestedAgentsDir, "user");
  const userAgents = loadCustomAgents(userAgentsDir, "user");
  const projectNestedAgents = projectNestedAgentsDir
    ? loadCustomAgents(projectNestedAgentsDir, "project")
    : [];
  const projectCompatAgents = projectCompatAgentsDir
    ? loadCustomAgents(projectCompatAgentsDir, "project")
    : [];
  const projectPiAgents = projectPiAgentsDir
    ? loadCustomAgents(projectPiAgentsDir, "project")
    : [];

  // Merge from lowest to highest priority: builtin < user < project < package.
  // Map replacement is the deduplication contract: each exact role name is
  // emitted once, with the highest-priority definition as its final value.
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of legacyUserAgents) agentMap.set(agent.name, agent);
  for (const agent of userPiAgents) agentMap.set(agent.name, agent);
  for (const agent of userNestedAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectNestedAgents) agentMap.set(agent.name, agent);
  for (const agent of projectCompatAgents) agentMap.set(agent.name, agent);
  for (const agent of projectPiAgents) agentMap.set(agent.name, agent);
  for (const agent of packageAgents) agentMap.set(agent.name, agent);

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
  return agents.find((agent) => agent.name === agentName);
}

/** Return resolved role metadata without exposing the role prompt body. */
export function listAgentSummaries(cwd: string, homeDir = os.homedir()): AgentSummary[] {
  return discoverAgents(cwd, homeDir)
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

// ---------------------------------------------------------------------------
// Turn-start catalog cache
//
// before_agent_start rebuilds the role catalog on every model turn, rereading
// and reparsing every role Markdown file although the result is byte-identical
// until a role is added, edited, or removed. The cache below keys an immutable
// snapshot by resolved cwd/home plus a lightweight directory manifest (file
// name, size, mtime), so unchanged turns only stat the role directories while
// additions/edits invalidate themselves through the manifest. Output bytes are
// identical to the uncached path; only the filesystem work changes.
// ---------------------------------------------------------------------------

interface AgentCatalogCacheEntry {
  manifestSignature: string;
  snapshot: AgentCatalogSnapshot;
}

const AGENT_CATALOG_CACHE_LIMIT = 16;
const agentCatalogCache = new Map<string, AgentCatalogCacheEntry>();

/**
 * Hit/miss counters for the role catalog cache, reset by
 * {@link invalidateAgentCatalogCache}. Observability only; never consulted
 * for cache decisions.
 */
export const agentCatalogCacheStats = { hits: 0, misses: 0 };

/**
 * Drop every cached catalog snapshot. Called when the extension re-registers
 * (reload); cwd changes and role additions/edits invalidate themselves via the
 * cache key and manifest signature respectively.
 */
export function invalidateAgentCatalogCache(): void {
  agentCatalogCache.clear();
  agentCatalogCacheStats.hits = 0;
  agentCatalogCacheStats.misses = 0;
}

function directoryManifestSignature(dir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "absent";
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  const parts: string[] = [];
  for (const name of names) {
    try {
      const stats = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${stats.size}:${stats.mtimeMs}`);
    } catch {
      parts.push(`${name}:unreadable`);
    }
  }
  return parts.join(",") || "empty";
}

function discoveryManifestSignature(dirs: DiscoveryDirs): string {
  return [
    `builtin=${directoryManifestSignature(BUILTIN_AGENTS_DIR)}`,
    `package=${dirs.packageAgentsDirs.map((dir) => directoryManifestSignature(dir)).join(",") || "none"}`,
    `legacyUser=${directoryManifestSignature(dirs.legacyUserAgentsDir)}`,
    `userPi=${directoryManifestSignature(dirs.userPiAgentsDir)}`,
    `userNested=${directoryManifestSignature(dirs.userNestedAgentsDir)}`,
    `user=${directoryManifestSignature(dirs.userAgentsDir)}`,
    `projectPi=${dirs.projectPiAgentsDir ? directoryManifestSignature(dirs.projectPiAgentsDir) : "none"}`,
    `projectNested=${dirs.projectNestedAgentsDir ? directoryManifestSignature(dirs.projectNestedAgentsDir) : "none"}`,
    `projectCompat=${dirs.projectCompatAgentsDir ? directoryManifestSignature(dirs.projectCompatAgentsDir) : "none"}`,
  ].join("|");
}

/** Build the compact role directory appended to the active parent prompt. */
export function createAgentCatalogSnapshot(
  cwd: string,
  maxDescriptionLength = 160,
): AgentCatalogSnapshot {
  const homeDir = os.homedir();
  const cacheKey = `${cwd}\0${homeDir}\0${maxDescriptionLength}`;
  const manifestSignature = discoveryManifestSignature(resolveDiscoveryDirs(cwd, homeDir));
  const cached = agentCatalogCache.get(cacheKey);
  if (cached && cached.manifestSignature === manifestSignature) {
    agentCatalogCacheStats.hits += 1;
    return cached.snapshot;
  }
  agentCatalogCacheStats.misses += 1;

  const summaries = listAgentSummaries(cwd, homeDir);
  const byName = new Map(summaries.map((agent) => [agent.name, agent]));
  const builtins = PUBLIC_BUILTIN_AGENT_NAMES
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
    "Discovered package, project, and user roles:",
    ...(discovered.length > 0 ? discovered.map(formatLine) : ["(none)"]),
  ];

  lines.push(
    "",
    "Use the exact agent name. Unknown names are invalid. Agent prompt bodies are loaded only after a role is selected.",
    AGENT_CATALOG_END_MARKER,
  );

  const snapshot: AgentCatalogSnapshot = {
    signature: summaries
      .map((agent) => `${agent.name}:${agent.source}:${agent.description}`)
      .join("\n"),
    systemPrompt: lines.join("\n"),
  };

  if (agentCatalogCache.size >= AGENT_CATALOG_CACHE_LIMIT) {
    const oldest = agentCatalogCache.keys().next();
    if (!oldest.done) agentCatalogCache.delete(oldest.value);
  }
  agentCatalogCache.set(cacheKey, { manifestSignature, snapshot });
  return snapshot;
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
