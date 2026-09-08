/** Gateway-only, configured-root skill discovery and bounded content loading. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GatewaySkillSecurityConfig } from "./config.ts";
import type { GatewayPrincipal } from "./contracts.ts";
import type { GatewaySkillDescriptorV1, GatewaySkillResourceDescriptorV1 } from "./skill-contracts.ts";
import { GatewayPolicy, GatewayPolicyError } from "./policy.ts";

export interface GatewaySkillPolicyOptions {
  policy: GatewayPolicy;
  security: GatewaySkillSecurityConfig;
  baseCwd: string;
  maxFiles: number;
  maxFileBytes: number;
  maxResponseBytes: number;
}

export interface GatewayLoadedSkillResource {
  skill: GatewaySkillDescriptorV1;
  resourceId?: string;
  content: string;
  bytes: number;
  sha256: string;
}

type SkillSource = "workspace" | "external";
type ReferenceKind = "required" | "deferred";
interface SkillRoot { source: SkillSource; index: number; path: string; }
interface SkillReference { id: string; kind: ReferenceKind; raw: string; }
interface DiscoveredSkill { descriptor: GatewaySkillDescriptorV1; root: SkillRoot; directory: string; mainPath: string; references: SkillReference[]; }

export class GatewaySkillPolicyError extends GatewayPolicyError {
  constructor(message: string, code = "skill_policy_denied") {
    super(message, code);
    this.name = "GatewaySkillPolicyError";
  }
}

function within(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function rejectUnsafePath(value: string): void {
  if (!value || value.includes("\0")) throw new GatewaySkillPolicyError("Skill path is invalid");
  const normalized = value.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\") || normalized.startsWith("\\\\")) {
    throw new GatewaySkillPolicyError("UNC and device paths are not permitted");
  }
  const withoutDrive = /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(":")) throw new GatewaySkillPolicyError("Alternate data streams are not permitted");
}

async function assertNoLinks(root: string, target: string, targetMayBeMissing = false): Promise<void> {
  if (!within(root, target)) throw new GatewaySkillPolicyError("Skill target is outside its authorized root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new GatewaySkillPolicyError("Skill root must be a real directory");
  const rel = relative(root, target);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new GatewaySkillPolicyError("Symbolic links and junctions are not permitted in skill paths");
    } catch (error) {
      if (targetMayBeMissing && current === target && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function frontmatterField(content: string, field: string): string | undefined {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const line = match[1]!.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(`${field}:`));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  return value || undefined;
}

function blockReferences(content: string): SkillReference[] {
  const result: SkillReference[] = [];
  for (const kind of ["required", "deferred"] as const) {
    const expression = new RegExp(`<${kind}_reading>([\\s\\S]*?)<\\/${kind}_reading>`, "gi");
    let block: RegExpExecArray | null;
    while ((block = expression.exec(content)) !== null) {
      for (const line of block[1]!.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const values = trimmed.match(/@[^\s,()<>]+/g)
          ?? (() => {
            const markdown = /^-\s+\[[^\]]*\]\(([^)]+)\)/.exec(trimmed);
            if (markdown) return [markdown[1]!];
            const bullet = /^-\s+(\S+)/.exec(trimmed);
            return bullet ? [bullet[1]!] : [];
          })();
        for (const rawValue of values) {
          const raw = rawValue.startsWith("@") ? rawValue.slice(1) : rawValue;
          result.push({ id: `${kind}-${result.length + 1}`, kind, raw });
        }
      }
    }
  }
  return result;
}

export class GatewaySkillPolicy {
  constructor(private readonly options: GatewaySkillPolicyOptions) {}

  async list(principal: GatewayPrincipal, workspaceId: string): Promise<DiscoveredSkill[]> {
    const workspace = await this.authorize(principal, workspaceId);
    const roots = await this.roots(workspace);
    const skills: DiscoveredSkill[] = [];
    for (const root of roots) {
      let entries;
      try {
        await assertNoLinks(root.path, root.path);
        entries = await readdir(root.path, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (skills.length >= this.options.maxFiles) throw new GatewaySkillPolicyError("Configured skill file limit was exceeded", "skill_bounds_exceeded");
        if (!entry.isDirectory() || entry.isSymbolicLink() || !safeSegment(entry.name)) continue;
        const directory = resolve(root.path, entry.name);
        const mainPath = resolve(directory, "SKILL.md");
        try {
          await this.assertAuthorizedFile(mainPath, [root.path], true);
          const main = await this.readBounded(mainPath, [root.path]);
          const references = blockReferences(main);
          const resources: GatewaySkillResourceDescriptorV1[] = [];
          for (const reference of references.slice(0, 64)) resources.push(await this.describeReference(reference, directory, workspace, root));
          const name = frontmatterField(main, "name") ?? entry.name;
          const description = frontmatterField(main, "description");
          if (name.length > 256 || (description !== undefined && description.length > 16 * 1024)) {
            throw new GatewaySkillPolicyError("Skill metadata exceeds configured contract bounds", "skill_bounds_exceeded");
          }
          const id = `${root.source}:${root.index}:${entry.name}`;
          skills.push({
            descriptor: { id, name, ...(description ? { description } : {}), source: root.source, resources },
            root, directory, mainPath, references,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
    }
    return skills;
  }

  assertResponse(value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > this.options.maxResponseBytes) throw new GatewaySkillPolicyError("Skill response exceeds configured limit", "skill_bounds_exceeded");
  }

  async load(principal: GatewayPrincipal, workspaceId: string, skillId: string, resourceId?: string): Promise<GatewayLoadedSkillResource> {
    // Discovery is deliberately repeated: authorization and configured roots are re-evaluated on every load.
    const skills = await this.list(principal, workspaceId);
    const skill = skills.find((candidate) => candidate.descriptor.id === skillId);
    if (!skill) throw new GatewaySkillPolicyError("Skill was not found", "skill_not_found");
    if (resourceId === undefined) {
      const content = await this.readBounded(skill.mainPath, [skill.root.path]);
      const result = loaded(skill.descriptor, content);
      this.assertResponse(result);
      return result;
    }
    const reference = skill.references.find((candidate) => candidate.id === resourceId);
    if (!reference) throw new GatewaySkillPolicyError("Skill resource was not found", "skill_resource_not_found");
    const workspace = await this.authorize(principal, workspaceId);
    const resolution = await this.resolveReference(reference.raw, skill.directory, workspace, skill.root);
    if (!resolution.allowedRoots.length) throw new GatewaySkillPolicyError("Skill resource is not authorized");
    const content = await this.readBounded(resolution.target, resolution.allowedRoots);
    const result = loaded(skill.descriptor, content, resourceId);
    this.assertResponse(result);
    return result;
  }

  private async authorize(principal: GatewayPrincipal, workspaceId: string): Promise<string> {
    if (!this.options.security.enabled) throw new GatewaySkillPolicyError("Gateway skill access is disabled", "skill_disabled");
    const decision = await this.options.policy.authorizeWorkspace(principal, workspaceId);
    if (!decision.allowed || !decision.workspacePath) throw new GatewaySkillPolicyError("Workspace was not found", "skill_not_found");
    return decision.workspacePath;
  }

  private async roots(workspace: string): Promise<SkillRoot[]> {
    const result: SkillRoot[] = [];
    for (const [index, configured] of this.options.security.workspaceRoots.entries()) {
      rejectUnsafePath(configured);
      const path = resolve(workspace, configured);
      if (!within(workspace, path)) throw new GatewaySkillPolicyError("Configured workspace skill root escapes the workspace");
      result.push({ source: "workspace", index, path });
    }
    for (const [index, configured] of this.options.security.externalSkillRoots.entries()) {
      rejectUnsafePath(configured);
      const path = resolve(this.options.baseCwd, configured);
      result.push({ source: "external", index, path });
    }
    return result;
  }

  private async describeReference(reference: SkillReference, directory: string, workspace: string, root: SkillRoot): Promise<GatewaySkillResourceDescriptorV1> {
    try {
      const resolution = await this.resolveReference(reference.raw, directory, workspace, root);
      if (!resolution.allowedRoots.length) return { id: reference.id, state: "denied" };
      await this.assertAuthorizedFile(resolution.target, resolution.allowedRoots, true);
      return { id: reference.id, state: reference.kind === "deferred" ? "deferred" : "allowed" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: reference.id, state: "missing" };
      if (error instanceof GatewaySkillPolicyError) return { id: reference.id, state: "denied" };
      throw error;
    }
  }

  private async resolveReference(raw: string, directory: string, workspace: string, root: SkillRoot): Promise<{ target: string; allowedRoots: string[] }> {
    rejectUnsafePath(raw);
    const target = isAbsolute(raw)
      ? resolve(raw)
      : raw.startsWith(".pi/") || raw.startsWith(".pi\\") || raw.startsWith(".agents/") || raw.startsWith(".agents\\")
        ? resolve(workspace, raw)
        : resolve(directory, raw);
    const configuredExternal = this.options.security.externalReferenceRoots.map((candidate) => {
      rejectUnsafePath(candidate);
      return resolve(this.options.baseCwd, candidate);
    });
    const allowedRoots = [workspace, root.path, ...configuredExternal].filter((candidate, index, all) => all.indexOf(candidate) === index && within(candidate, target));
    return { target, allowedRoots };
  }

  private async assertAuthorizedFile(target: string, allowedRoots: string[], allowMissing = false): Promise<void> {
    const root = allowedRoots.find((candidate) => within(candidate, target));
    if (!root) throw new GatewaySkillPolicyError("Skill target is outside configured roots");
    await assertNoLinks(root, target, allowMissing);
    const canonicalRoot = await realpath(root);
    let canonicalTarget: string;
    try { canonicalTarget = await realpath(target); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw error;
    }
    if (!within(canonicalRoot, canonicalTarget)) throw new GatewaySkillPolicyError("Canonical skill target escaped its root");
    const info = await lstat(canonicalTarget);
    if (!info.isFile() || info.isSymbolicLink()) throw new GatewaySkillPolicyError("Skill target must be a regular file");
    if (info.size > this.options.maxFileBytes) throw new GatewaySkillPolicyError("Skill file exceeds configured limit", "skill_bounds_exceeded");
  }

  private async readBounded(target: string, allowedRoots: string[]): Promise<string> {
    await this.assertAuthorizedFile(target, allowedRoots);
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.options.maxFileBytes) throw new GatewaySkillPolicyError("Skill file exceeds configured limit", "skill_bounds_exceeded");
      const content = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(content, "utf8") > this.options.maxFileBytes) throw new GatewaySkillPolicyError("Skill file exceeds configured limit", "skill_bounds_exceeded");
      await this.assertAuthorizedFile(target, allowedRoots);
      return content;
    } finally {
      await handle.close();
    }
  }
}

function safeSegment(value: string): boolean {
  return value.length <= 200 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes(":") && !value.includes("\0");
}

function loaded(skill: GatewaySkillDescriptorV1, content: string, resourceId?: string): GatewayLoadedSkillResource {
  return {
    skill,
    ...(resourceId === undefined ? {} : { resourceId }),
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
