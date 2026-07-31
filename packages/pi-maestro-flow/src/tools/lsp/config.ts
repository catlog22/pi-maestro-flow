import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LspServerConfig } from "./types.ts";

const DEFAULT_SERVERS: LspServerConfig[] = [
  server("typescript", "typescript-language-server", ["--stdio"], [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], ["tsconfig.json", "jsconfig.json", "package.json"]),
  server("python", "pyright-langserver", ["--stdio"], [".py", ".pyi"], ["pyproject.toml", "setup.py", "requirements.txt", ".git"]),
  server("rust", "rust-analyzer", [], [".rs"], ["Cargo.toml", ".git"]),
  server("go", "gopls", [], [".go"], ["go.work", "go.mod", ".git"]),
  server("clangd", "clangd", ["--background-index"], [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"], ["compile_commands.json", "compile_flags.txt", ".git"]),
  server("json", "vscode-json-language-server", ["--stdio"], [".json", ".jsonc"], ["package.json", ".git"]),
  server("yaml", "yaml-language-server", ["--stdio"], [".yaml", ".yml"], [".git"]),
];

interface LspConfigFile {
  servers?: Array<Partial<LspServerConfig> & Pick<LspServerConfig, "name" | "command">>;
  disabled?: string[];
}

const cache = new Map<string, LspServerConfig[]>();
const rootCache = new Map<string, Promise<string>>();
let cacheGeneration = 0;

export async function loadLspConfig(cwd: string): Promise<LspServerConfig[]> {
  const generation = cacheGeneration;
  const absoluteCwd = path.resolve(cwd);
  const cached = cache.get(absoluteCwd);
  if (cached) return cached;

  let servers = DEFAULT_SERVERS.map(cloneServer);
  for (const configPath of configPaths(absoluteCwd)) {
    const loaded = await readConfig(configPath);
    if (!loaded) continue;
    const disabled = new Set(loaded.disabled ?? []);
    servers = servers.filter((item) => !disabled.has(item.name));
    for (const override of loaded.servers ?? []) {
      const existing = servers.findIndex((item) => item.name === override.name);
      const merged = normalizeServer(existing >= 0 ? servers[existing] : undefined, override);
      if (existing >= 0) servers[existing] = merged;
      else servers.push(merged);
    }
  }
  if (generation === cacheGeneration) cache.set(absoluteCwd, servers);
  return servers;
}

export function clearLspConfigCache(): void {
  cacheGeneration += 1;
  cache.clear();
  rootCache.clear();
}

export function serversForFile(servers: LspServerConfig[], file: string): LspServerConfig[] {
  const basename = path.basename(file).toLowerCase();
  const extension = path.extname(file).toLowerCase();
  return servers.filter((item) => item.fileTypes.some((type) => {
    const normalized = type.toLowerCase();
    return normalized.startsWith(".") ? extension === normalized : basename === normalized;
  }));
}

export function findProjectRoot(file: string, cwd: string, markers: string[]): Promise<string> {
  const startDir = path.dirname(path.resolve(file));
  const resolvedCwd = path.resolve(cwd);
  const key = `${startDir}\0${resolvedCwd}\0${markers.join("\u0001")}`;
  const existing = rootCache.get(key);
  if (existing) return existing;
  // Generation-owned cache: a walk that settles after a reload/shutdown must
  // not repopulate the fresh generation's cache, so capture the generation and
  // only delete our own entry if it still belongs to the current one.
  const generation = cacheGeneration;
  const promise = resolveProjectRoot(startDir, resolvedCwd, markers).catch((error) => {
    if (generation === cacheGeneration && rootCache.get(key) === promise) rootCache.delete(key);
    throw error;
  });
  rootCache.set(key, promise);
  return promise;
}

async function resolveProjectRoot(startDir: string, resolvedCwd: string, markers: string[]): Promise<string> {
  const floor = path.parse(resolvedCwd).root;
  let current = startDir;
  while (true) {
    for (const marker of markers) {
      try {
        await fs.access(path.join(current, marker));
        return current;
      } catch {}
    }
    const parent = path.dirname(current);
    if (current === parent || current === floor) return resolvedCwd;
    current = parent;
  }
}

function configPaths(cwd: string): string[] {
  return [
    path.join(os.homedir(), ".omp", "lsp.json"),
    path.join(os.homedir(), ".pi", "agent", "lsp.json"),
    path.join(cwd, ".omp", "lsp.json"),
    path.join(cwd, ".pi", "lsp.json"),
  ];
}

async function readConfig(configPath: string): Promise<LspConfigFile | undefined> {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as LspConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid LSP config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function server(name: string, command: string, args: string[], fileTypes: string[], rootMarkers: string[]): LspServerConfig {
  return { name, command, args, fileTypes, rootMarkers };
}

function cloneServer(value: LspServerConfig): LspServerConfig {
  return { ...value, args: [...value.args], fileTypes: [...value.fileTypes], rootMarkers: [...value.rootMarkers], env: value.env ? { ...value.env } : undefined };
}

function normalizeServer(base: LspServerConfig | undefined, override: Partial<LspServerConfig> & Pick<LspServerConfig, "name" | "command">): LspServerConfig {
  return {
    name: override.name,
    command: override.command,
    args: override.args ? [...override.args] : [...(base?.args ?? [])],
    fileTypes: override.fileTypes ? [...override.fileTypes] : [...(base?.fileTypes ?? [])],
    rootMarkers: override.rootMarkers ? [...override.rootMarkers] : [...(base?.rootMarkers ?? [".git"])],
    initializationOptions: override.initializationOptions ?? base?.initializationOptions,
    settings: override.settings ?? base?.settings,
    env: override.env ? { ...override.env } : base?.env ? { ...base.env } : undefined,
  };
}
