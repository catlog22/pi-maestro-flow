import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  loadSkillConfig,
  renderSkillConfigDefaults,
  type SkillPromptBudgets,
} from "./skill-config.ts";
import {
  SkillCache,
  type SkillCacheStats,
  type SkillCacheStatus,
} from "./skill-cache.ts";

export interface TodoSkillConfig {
  name: string;
  args?: string;
}

export interface LoadedTodoSkill {
  readonly name: string;
  readonly filePath: string;
  readonly prompt: string;
  readonly requiredFiles: string[];
  readonly deferredFiles: string[];
  readonly totalBytes: number;
  readonly loadedAt: string;
  readonly contentHash: string;
  readonly configHash: string;
  readonly requiredReadingHash: string;
  readonly compiledKey: string;
  readonly cacheHit: boolean;
  readonly cacheStatus: SkillCacheStatus;
}

export interface TodoSkillCacheStats {
  raw: Readonly<SkillCacheStats>;
  compiled: Readonly<SkillCacheStats>;
}

interface SkillDiscoveryLoader {
  reload(): Promise<void>;
  getSkills(): ReturnType<ResourceLoader["getSkills"]>;
}

export interface TodoSkillLoaderOptions {
  cwd: string;
  agentDir?: string;
  resourceLoader?: SkillDiscoveryLoader;
  rawCacheEntries?: number;
  compiledCacheEntries?: number;
  rawCacheBytes?: number;
  compiledCacheBytes?: number;
}

interface RawFileSnapshot {
  readonly filePath: string;
  readonly content: string;
  readonly contentHash: string;
  readonly bytes: number;
}

type CompiledTodoSkill = Omit<LoadedTodoSkill, "cacheHit" | "cacheStatus" | "totalBytes"> & {
  readonly promptBytes: number;
};

const DEFAULT_RAW_CACHE_ENTRIES = 64;
const DEFAULT_COMPILED_CACHE_ENTRIES = 32;
const DEFAULT_RAW_CACHE_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMPILED_CACHE_BYTES = 16 * 1024 * 1024;

export class TodoSkillLoadError extends Error {
  constructor(
    readonly code:
      | "E_SKILL_NOT_FOUND"
      | "E_SKILL_READ_FAILED"
      | "E_SKILL_REQUIRED_MISSING"
      | "E_SKILL_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "TodoSkillLoadError";
  }
}

export class TodoSkillLoader {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly resourceLoader: SkillDiscoveryLoader;
  private readonly rawCache: SkillCache<RawFileSnapshot>;
  private readonly compiledCache: SkillCache<CompiledTodoSkill>;
  private initialized = false;

  constructor(options: TodoSkillLoaderOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.rawCache = new SkillCache(options.rawCacheEntries ?? DEFAULT_RAW_CACHE_ENTRIES, {
      maxWeight: options.rawCacheBytes ?? DEFAULT_RAW_CACHE_BYTES,
      measure: (snapshot) => snapshot.bytes,
    });
    this.compiledCache = new SkillCache(options.compiledCacheEntries ?? DEFAULT_COMPILED_CACHE_ENTRIES, {
      maxWeight: options.compiledCacheBytes ?? DEFAULT_COMPILED_CACHE_BYTES,
      measure: (skill) => skill.promptBytes,
    });
    this.resourceLoader = options.resourceLoader ?? new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  }

  async refresh(): Promise<void> {
    await this.resourceLoader.reload();
    this.initialized = true;
  }

  async load(spec: TodoSkillConfig, inlineContext = ""): Promise<LoadedTodoSkill> {
    const name = spec.name.trim();
    if (!name) throw new TodoSkillLoadError("E_SKILL_NOT_FOUND", "skill name is empty");

    const skill = await this.findSkill(name);
    const { config, configHash } = await loadSkillConfig(this.cwd, this.agentDir);
    const budgets = config.limits;
    const main = await this.readRawFile(skill.filePath, budgets, "skill");
    const { body } = parseFrontmatter(main.content);
    const requiredRaw = extractBlockPaths(body, "required_reading");
    const deferredRaw = extractBlockPaths(body, "deferred_reading");
    const requiredFiles = requiredRaw.map((path) => expandSkillPath(path, skill.baseDir, this.cwd));
    const deferredFiles = deferredRaw.map((path) => expandSkillPath(path, skill.baseDir, this.cwd));
    const requiredBodies: Array<{ path: string; content: string; contentHash: string }> = [];

    for (const filePath of requiredFiles) {
      try {
        const required = await this.readRawFile(filePath, budgets, "required reading");
        requiredBodies.push({
          path: filePath,
          content: required.content,
          contentHash: required.contentHash,
        });
      } catch (error) {
        if (error instanceof TodoSkillLoadError && error.code === "E_SKILL_READ_FAILED") {
          throw new TodoSkillLoadError("E_SKILL_REQUIRED_MISSING", error.message);
        }
        throw error;
      }
    }

    const args = spec.args?.trim() ?? "";
    const requiredReadingHash = hashValue(requiredBodies.map(({ path, contentHash }) => ({ path, contentHash })));
    const compiledKey = hashValue({
      name,
      filePath: skill.filePath,
      contentHash: main.contentHash,
      configHash,
      requiredReadingHash,
      args,
    });
    const cached = await this.compiledCache.getOrCreateWithStatus(compiledKey, () => {
      const inlinedBody = inlineRequiredReading(body, requiredBodies);
      const defaultsSection = renderSkillConfigDefaults(name, config.skills[name], args);
      const promptParts = [inlinedBody.trim()];
      if (defaultsSection) promptParts.push(defaultsSection);
      if (args) promptParts.push(`## Skill Args\n${args}`);
      const prompt = promptParts.filter(Boolean).join("\n\n");
      const promptBytes = byteLength(prompt);

      return freezeCompiledSkill({
        name,
        filePath: skill.filePath,
        prompt,
        requiredFiles,
        deferredFiles,
        promptBytes,
        loadedAt: new Date().toISOString(),
        contentHash: main.contentHash,
        configHash,
        requiredReadingHash,
        compiledKey,
      });
    });
    const totalBytes = byteLength(inlineContext) + cached.value.promptBytes;
    assertTotalBudget(totalBytes, budgets);
    const { promptBytes: _promptBytes, ...compiled } = cached.value;

    return Object.freeze({
      ...compiled,
      totalBytes,
      cacheHit: cached.status !== "miss",
      cacheStatus: cached.status,
    });
  }

  async validateContext(inlineContext: string): Promise<number> {
    const { config } = await loadSkillConfig(this.cwd, this.agentDir);
    const totalBytes = byteLength(inlineContext);
    assertTotalBudget(totalBytes, config.limits);
    return totalBytes;
  }

  get cacheStats(): Readonly<TodoSkillCacheStats> {
    return this.getCacheStats();
  }

  getCacheStats(): Readonly<TodoSkillCacheStats> {
    return Object.freeze({
      raw: this.rawCache.stats(),
      compiled: this.compiledCache.stats(),
    });
  }

  private async findSkill(name: string): Promise<Skill> {
    if (!this.initialized) await this.refresh();
    let skill = this.resourceLoader.getSkills().skills.find((entry) => entry.name === name);
    if (skill) return skill;

    await this.refresh();
    skill = this.resourceLoader.getSkills().skills.find((entry) => entry.name === name);
    if (!skill) throw new TodoSkillLoadError("E_SKILL_NOT_FOUND", `skill "${name}" was not discovered`);
    return skill;
  }

  private async readRawFile(
    filePath: string,
    budgets: SkillPromptBudgets,
    kind: string,
  ): Promise<RawFileSnapshot> {
    let versionKey: string;
    try {
      const metadata = await stat(filePath, { bigint: true });
      versionKey = `${filePath}\0${metadata.size}\0${metadata.mtimeNs}`;
    } catch (error) {
      throw new TodoSkillLoadError("E_SKILL_READ_FAILED", `could not read ${kind} file "${filePath}": ${errorMessage(error)}`);
    }
    const snapshot = await this.rawCache.getOrCreate(versionKey, async () => {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (error) {
        throw new TodoSkillLoadError("E_SKILL_READ_FAILED", `could not read ${kind} file "${filePath}": ${errorMessage(error)}`);
      }
      return Object.freeze({
        filePath,
        content,
        contentHash: hashText(content),
        bytes: byteLength(content),
      });
    });
    if (snapshot.bytes > budgets.maxFileBytes) {
      throw new TodoSkillLoadError(
        "E_SKILL_BUDGET_EXCEEDED",
        `${kind} file "${filePath}" is ${snapshot.bytes} bytes; maxFileBytes is ${budgets.maxFileBytes}`,
      );
    }
    return snapshot;
  }
}

function extractBlockPaths(body: string, tag: "required_reading" | "deferred_reading"): string[] {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(body);
  if (!match) return [];
  const paths: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const atMatches = trimmed.match(/@[^\s,()<>]+/g);
    if (atMatches) {
      paths.push(...atMatches);
      continue;
    }
    const markdownLink = /^-\s+\[[^\]]*\]\(([^)]+)\)/.exec(trimmed);
    if (markdownLink) {
      paths.push(markdownLink[1]);
      continue;
    }
    const bullet = /^-\s+(\S+)/.exec(trimmed);
    if (bullet) paths.push(bullet[1]);
  }
  return paths;
}

function expandSkillPath(raw: string, baseDir: string, cwd: string): string {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) return path;
  if (path.startsWith(".pi/") || path.startsWith(".pi\\") || path.startsWith(".agents/") || path.startsWith(".agents\\")) {
    return resolve(cwd, path);
  }
  return resolve(baseDir || dirname(raw), path);
}

function inlineRequiredReading(
  body: string,
  requiredBodies: ReadonlyArray<{ path: string; content: string }>,
): string {
  const pattern = /<required_reading>([\s\S]*?)<\/required_reading>/i;
  const match = pattern.exec(body);
  if (!match) return body;
  const output: string[] = [];
  let index = 0;
  for (const line of match[1].split(/\r?\n/)) {
    const hasReference = /@\S+/.test(line) || /^\s*-\s+\S+/.test(line);
    if (hasReference && index < requiredBodies.length) {
      const item = requiredBodies[index++];
      output.push(`<!-- inlined ${item.path} -->`, item.content, "<!-- /inlined -->");
    } else {
      output.push(line);
    }
  }
  return body.slice(0, match.index)
    + `<required_reading>\n${output.join("\n")}\n</required_reading>`
    + body.slice(match.index + match[0].length);
}

function assertTotalBudget(totalBytes: number, budgets: SkillPromptBudgets): void {
  if (totalBytes > budgets.maxTotalBytes) {
    throw new TodoSkillLoadError(
      "E_SKILL_BUDGET_EXCEEDED",
      `combined context and skill prompt is ${totalBytes} bytes; maxTotalBytes is ${budgets.maxTotalBytes}`,
    );
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeCompiledSkill(skill: CompiledTodoSkill): CompiledTodoSkill {
  return Object.freeze({
    ...skill,
    requiredFiles: Object.freeze([...skill.requiredFiles]) as string[],
    deferredFiles: Object.freeze([...skill.deferredFiles]) as string[],
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashValue(value: unknown): string {
  return hashText(JSON.stringify(value));
}
