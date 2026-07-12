import { createHash, randomUUID } from "node:crypto";
import {
  composeSkillBindings,
  renderSkillStack,
  type LoadedTodoSkillBinding,
  type TodoSkillBinding,
} from "./skill-composer.ts";
import { TodoSkillLoader } from "./skill-loader.ts";

export type SkillActivationState = "active" | "stale";

export interface SkillActivationBindingMetadata {
  role: TodoSkillBinding["role"];
  name: string;
  args?: string;
  filePath: string;
  contentHash: string;
  configHash: string;
  requiredReadingHash: string;
  compiledKey: string;
  requiredFiles: string[];
  deferredFiles: string[];
  totalBytes: number;
}

export interface SkillActivationMetadata {
  activationId: string;
  stackRevision: string;
  activatedAt: number;
  validatedAt: number;
  state: SkillActivationState;
  bindings: SkillActivationBindingMetadata[];
}

export interface SkillActivation extends SkillActivationMetadata {
  skills: LoadedTodoSkillBinding[];
  prompt: string;
}

export class SkillRuntime {
  constructor(private readonly loader: TodoSkillLoader) {}

  async activate(
    bindings: readonly TodoSkillBinding[],
    context = "",
    restored?: SkillActivationMetadata,
  ): Promise<SkillActivation> {
    const ordered = composeSkillBindings(bindings);
    await this.loader.validateContext(context);
    const loaded = await Promise.all(
      ordered.map(async (binding) => ({
        role: binding.role,
        skill: await this.loader.load(binding, context),
      })),
    );
    const stackRevision = createHash("sha256")
      .update(JSON.stringify(loaded.map(({ role, skill }) => ({
        role,
        name: skill.name,
        compiledKey: skill.compiledKey,
      }))))
      .digest("hex");
    const canRestore = restored?.stackRevision === stackRevision;
    const now = Date.now();
    const metadataBindings = loaded.map(({ role, skill }, index) => ({
      role,
      name: skill.name,
      ...(ordered[index]?.args ? { args: ordered[index].args } : {}),
      filePath: skill.filePath,
      contentHash: skill.contentHash,
      configHash: skill.configHash,
      requiredReadingHash: skill.requiredReadingHash,
      compiledKey: skill.compiledKey,
      requiredFiles: [...skill.requiredFiles],
      deferredFiles: [...skill.deferredFiles],
      totalBytes: skill.totalBytes,
    }));

    return Object.freeze({
      activationId: restored?.activationId ?? randomUUID(),
      stackRevision,
      activatedAt: restored?.activatedAt ?? now,
      validatedAt: now,
      state: restored && (!canRestore || restored.state === "stale") ? "stale" : "active",
      bindings: Object.freeze(metadataBindings) as SkillActivationBindingMetadata[],
      skills: Object.freeze(loaded) as LoadedTodoSkillBinding[],
      prompt: renderSkillStack(loaded),
    });
  }
}
