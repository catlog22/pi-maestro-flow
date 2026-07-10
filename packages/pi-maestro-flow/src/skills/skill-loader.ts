import { readFile } from "node:fs/promises";
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

export interface TodoSkillConfig {
  name: string;
  args?: string;
}

export interface LoadedTodoSkill {
  name: string;
  filePath: string;
  prompt: string;
  requiredFiles: string[];
  deferredFiles: string[];
  totalBytes: number;
  loadedAt: string;
}

interface SkillDiscoveryLoader {
  reload(): Promise<void>;
  getSkills(): ReturnType<ResourceLoader["getSkills"]>;
}

export interface TodoSkillLoaderOptions {
  cwd: string;
  agentDir?: string;
  resourceLoader?: SkillDiscoveryLoader;
}

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
  private initialized = false;

  constructor(options: TodoSkillLoaderOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir ?? getAgentDir();
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
    const { config } = await loadSkillConfig(this.cwd, this.agentDir);
    const budgets = config.limits;
    const mainText = await readBudgetedFile(skill.filePath, budgets, "skill");
    const { body } = parseFrontmatter(mainText);
    const requiredRaw = extractBlockPaths(body, "required_reading");
    const deferredRaw = extractBlockPaths(body, "deferred_reading");
    const requiredFiles = requiredRaw.map((path) => expandSkillPath(path, skill.baseDir, this.cwd));
    const deferredFiles = deferredRaw.map((path) => expandSkillPath(path, skill.baseDir, this.cwd));
    const requiredBodies: Array<{ path: string; content: string }> = [];

    for (const filePath of requiredFiles) {
      try {
        requiredBodies.push({
          path: filePath,
          content: await readBudgetedFile(filePath, budgets, "required reading"),
        });
      } catch (error) {
        if (error instanceof TodoSkillLoadError && error.code === "E_SKILL_READ_FAILED") {
          throw new TodoSkillLoadError("E_SKILL_REQUIRED_MISSING", error.message);
        }
        throw error;
      }
    }

    const inlinedBody = inlineRequiredReading(body, requiredBodies);
    const defaultsSection = renderSkillConfigDefaults(name, config.skills[name], spec.args);
    const promptParts = [inlinedBody.trim()];
    if (defaultsSection) promptParts.push(defaultsSection);
    if (spec.args?.trim()) {
      promptParts.push(`## Skill Args\n${spec.args.trim()}`);
    }
    const prompt = promptParts.filter(Boolean).join("\n\n");
    const totalBytes = byteLength(inlineContext) + byteLength(prompt);
    assertTotalBudget(totalBytes, budgets);

    return {
      name,
      filePath: skill.filePath,
      prompt,
      requiredFiles,
      deferredFiles,
      totalBytes,
      loadedAt: new Date().toISOString(),
    };
  }

  async validateContext(inlineContext: string): Promise<number> {
    const { config } = await loadSkillConfig(this.cwd, this.agentDir);
    const totalBytes = byteLength(inlineContext);
    assertTotalBudget(totalBytes, config.limits);
    return totalBytes;
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

async function readBudgetedFile(
  filePath: string,
  budgets: SkillPromptBudgets,
  kind: string,
): Promise<string> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new TodoSkillLoadError("E_SKILL_READ_FAILED", `could not read ${kind} file "${filePath}": ${errorMessage(error)}`);
  }
  const bytes = byteLength(content);
  if (bytes > budgets.maxFileBytes) {
    throw new TodoSkillLoadError(
      "E_SKILL_BUDGET_EXCEEDED",
      `${kind} file "${filePath}" is ${bytes} bytes; maxFileBytes is ${budgets.maxFileBytes}`,
    );
  }
  return content;
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
