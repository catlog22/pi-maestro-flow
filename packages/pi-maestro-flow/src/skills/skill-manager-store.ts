import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  parseFrontmatter,
  type PackageSource,
  type PathMetadata,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { loadSkillConfig } from "./skill-config.ts";

export interface ManagedSkill {
  name: string;
  description: string;
  filePath: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  sourceDisableModelInvocation: boolean;
  scope: PathMetadata["scope"];
  source: string;
  origin: PathMetadata["origin"];
  baseDir?: string;
  readOnly: boolean;
}

export interface SkillManagerSnapshot {
  skills: ManagedSkill[];
  groups: ManagedSkillGroup[];
  projectConfigPath: string;
}

export interface ManagedSkillGroup {
  name: string;
  custom: boolean;
  skills: ManagedSkill[];
}

export class SkillManagerStore {
  private readonly settingsManager: SettingsManager;
  private readonly agentDir: string;

  constructor(
    private readonly cwd: string,
    agentDir = getAgentDir(),
  ) {
    this.agentDir = agentDir;
    this.settingsManager = SettingsManager.create(cwd, agentDir);
  }

  async load(): Promise<SkillManagerSnapshot> {
    await this.settingsManager.reload();
    const packageManager = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
    });
    const [resolved, loadedConfig] = await Promise.all([
      packageManager.resolve((_source) => Promise.resolve("skip")),
      loadSkillConfig(this.cwd, this.agentDir),
    ]);
    const skills = (await Promise.all(resolved.skills.map((resource) =>
      this.loadManagedSkill(resource, loadedConfig.config.skills)
    )))
      .filter((skill): skill is ManagedSkill => skill !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath));
    const groups = buildSkillGroups(skills, loadedConfig.config.groups);
    return { skills, groups, projectConfigPath: loadedConfig.projectPath };
  }

  async toggleEnabled(skill: ManagedSkill): Promise<SkillManagerSnapshot> {
    if (skill.readOnly) throw new Error(`Skill "${skill.name}" cannot be changed in temporary scope`);
    if (skill.origin === "package") {
      this.togglePackageResource(skill, !skill.enabled);
    } else {
      this.toggleTopLevelResource(skill, !skill.enabled);
    }
    await this.settingsManager.flush();
    return this.load();
  }

  async toggleModelInvocation(skill: ManagedSkill): Promise<SkillManagerSnapshot> {
    await this.writeProjectModelInvocation(skill.name, !skill.disableModelInvocation);
    return this.load();
  }

  async toggleGroupEnabled(group: ManagedSkillGroup): Promise<SkillManagerSnapshot> {
    const enabled = !group.skills.every((skill) => skill.enabled);
    for (const skill of group.skills) {
      if (skill.readOnly || skill.enabled === enabled) continue;
      if (skill.origin === "package") this.togglePackageResource(skill, enabled);
      else this.toggleTopLevelResource(skill, enabled);
    }
    await this.settingsManager.flush();
    return this.load();
  }

  async toggleGroupModelInvocation(group: ManagedSkillGroup): Promise<SkillManagerSnapshot> {
    const disabled = !group.skills.every((skill) => skill.disableModelInvocation);
    await this.updateProjectConfig((root) => {
      const skills = isRecord(root.skills) ? { ...root.skills } : {};
      for (const skill of group.skills) {
        const currentValue = skills[skill.name];
        const current = isRecord(currentValue) ? currentValue : {};
        skills[skill.name] = { ...current, "disable-model-invocation": disabled };
      }
      return { ...root, skills };
    });
    return this.load();
  }

  async createGroup(name: string): Promise<SkillManagerSnapshot> {
    const normalized = normalizeGroupName(name);
    await this.updateProjectConfig((root) => {
      const groups = isRecord(root.groups) ? { ...root.groups } : {};
      if (groups[normalized] !== undefined) throw new Error(`分组 "${normalized}" 已存在`);
      groups[normalized] = { skills: [] };
      return { ...root, groups };
    });
    return this.load();
  }

  async assignSkillToGroup(skillName: string, groupName?: string): Promise<SkillManagerSnapshot> {
    await this.updateProjectConfig((root) => {
      const groups = isRecord(root.groups) ? { ...root.groups } : {};
      for (const [name, value] of Object.entries(groups)) {
        if (!isRecord(value) || !Array.isArray(value.skills)) continue;
        groups[name] = { ...value, skills: value.skills.filter((skill) => skill !== skillName) };
      }
      if (groupName) {
        const normalized = normalizeGroupName(groupName);
        const target = groups[normalized];
        if (!isRecord(target) || !Array.isArray(target.skills)) {
          throw new Error(`分组 "${normalized}" 不存在`);
        }
        groups[normalized] = {
          ...target,
          skills: [...new Set([...target.skills.filter((skill): skill is string => typeof skill === "string"), skillName])],
        };
      }
      return { ...root, groups };
    });
    return this.load();
  }

  async deleteGroup(name: string): Promise<SkillManagerSnapshot> {
    await this.updateProjectConfig((root) => {
      const groups = isRecord(root.groups) ? { ...root.groups } : {};
      delete groups[name];
      return { ...root, groups };
    });
    return this.load();
  }

  private async loadManagedSkill(
    resource: ResolvedResource,
    configSkills: Awaited<ReturnType<typeof loadSkillConfig>>["config"]["skills"],
  ): Promise<ManagedSkill | undefined> {
    let content: string;
    try {
      content = await readFile(resource.path, "utf8");
    } catch {
      return undefined;
    }
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const fileName = basename(resource.path);
    const fallbackName = fileName === "SKILL.md"
      ? basename(dirname(resource.path))
      : fileName.replace(/\.md$/i, "");
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : fallbackName;
    const sourceDisableModelInvocation = frontmatter["disable-model-invocation"] === true;
    const configured = configSkills[name]?.["disable-model-invocation"];
    return {
      name,
      description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
      filePath: resource.path,
      enabled: resource.enabled,
      disableModelInvocation: configured ?? sourceDisableModelInvocation,
      sourceDisableModelInvocation,
      scope: resource.metadata.scope,
      source: resource.metadata.source,
      origin: resource.metadata.origin,
      ...(resource.metadata.baseDir ? { baseDir: resource.metadata.baseDir } : {}),
      readOnly: resource.metadata.scope === "temporary",
    };
  }

  private toggleTopLevelResource(skill: ManagedSkill, enabled: boolean): void {
    const settings = skill.scope === "project"
      ? this.settingsManager.getProjectSettings()
      : this.settingsManager.getGlobalSettings();
    const current = settings.skills ?? [];
    const baseDir = skill.baseDir
      ?? (skill.scope === "project" ? join(this.cwd, ".pi") : this.agentDir);
    const pattern = relative(baseDir, skill.filePath);
    const updated = replaceResourcePattern(current, pattern, enabled);
    if (skill.scope === "project") {
      this.settingsManager.setProjectSkillPaths(updated);
    } else {
      this.settingsManager.setSkillPaths(updated);
    }
  }

  private togglePackageResource(skill: ManagedSkill, enabled: boolean): void {
    const settings = skill.scope === "project"
      ? this.settingsManager.getProjectSettings()
      : this.settingsManager.getGlobalSettings();
    const packages = [...(settings.packages ?? [])];
    const packageIndex = packages.findIndex((entry) => packageSource(entry) === skill.source);
    if (packageIndex < 0) throw new Error(`Package "${skill.source}" is not configured`);

    const currentPackage = packages[packageIndex];
    const packageConfig = typeof currentPackage === "string"
      ? { source: currentPackage }
      : { ...currentPackage };
    const baseDir = skill.baseDir ?? dirname(skill.filePath);
    const pattern = relative(baseDir, skill.filePath);
    packageConfig.skills = replaceResourcePattern(packageConfig.skills ?? [], pattern, enabled);
    packages[packageIndex] = packageConfig;
    if (skill.scope === "project") {
      this.settingsManager.setProjectPackages(packages);
    } else {
      this.settingsManager.setPackages(packages);
    }
  }

  private async writeProjectModelInvocation(name: string, disabled: boolean): Promise<void> {
    await this.updateProjectConfig((root) => {
      const skills = isRecord(root.skills) ? { ...root.skills } : {};
      const current = isRecord(skills[name]) ? skills[name] : {};
      skills[name] = { ...current, "disable-model-invocation": disabled };
      return { ...root, skills };
    });
  }

  private async updateProjectConfig(
    update: (root: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const path = join(this.cwd, ".pi", "skill-config.json");
    const root = await readJsonObject(path);
    const updated = update(root);
    const next = {
      version: typeof updated.version === "string" ? updated.version : "1.0.0",
      ...updated,
    };
    await atomicWriteJson(path, next);
  }
}

function buildSkillGroups(
  skills: ManagedSkill[],
  configured: Readonly<Record<string, { skills: string[] }>>,
): ManagedSkillGroup[] {
  const assigned = new Set<string>();
  const groups: ManagedSkillGroup[] = [];
  for (const [name, config] of Object.entries(configured)) {
    const members = skills.filter((skill) => config.skills.includes(skill.name));
    for (const skill of members) assigned.add(skill.filePath);
    groups.push({ name, custom: true, skills: members });
  }
  const defaults = new Map<string, ManagedSkill[]>();
  for (const skill of skills) {
    if (assigned.has(skill.filePath)) continue;
    const prefix = defaultGroupName(skill.name);
    const members = defaults.get(prefix) ?? [];
    members.push(skill);
    defaults.set(prefix, members);
  }
  for (const [name, members] of [...defaults].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ name, custom: false, skills: members });
  }
  return groups;
}

function defaultGroupName(skillName: string): string {
  const separator = skillName.indexOf("-");
  return separator > 0 ? skillName.slice(0, separator) : "其他";
}

function normalizeGroupName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("分组名称不能为空");
  if (name.length > 64) throw new Error("分组名称不能超过 64 个字符");
  return name;
}

function replaceResourcePattern(current: readonly string[], pattern: string, enabled: boolean): string[] {
  const updated = current.filter((entry) => stripOverridePrefix(entry) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  return updated;
}

function stripOverridePrefix(value: string): string {
  return /^[!+-]/.test(value) ? value.slice(1) : value;
}

function packageSource(value: PackageSource): string {
  return typeof value === "string" ? value : value.source;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, path);
  } catch {
    await unlink(path).catch(() => undefined);
    await rename(temporaryPath, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
