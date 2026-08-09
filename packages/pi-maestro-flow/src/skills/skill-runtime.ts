import { createHash, randomUUID } from "node:crypto";
import {
  composeSkillBindings,
  renderSkillStack,
  type LoadedTodoSkillBinding,
  type TodoSkillBinding,
} from "./skill-composer.ts";
import { TodoSkillLoader, type SkillSessionMode } from "./skill-loader.ts";

export type SkillActivationState = "active" | "stale";

export interface SkillActivationBindingMetadata {
  role: TodoSkillBinding["role"];
  name: string;
  sessionMode?: SkillSessionMode;
  args?: string;
  filePath: string;
  contentHash: string;
  configHash: string;
  requiredReadingHash: string;
  requiredReadingContentHashes?: string[];
  compiledKey: string;
  requiredFiles: string[];
  deferredFiles: string[];
  totalBytes: number;
}

function bindingsSemanticallyMatch(
  restored: readonly SkillActivationBindingMetadata[],
  loaded: readonly SkillActivationBindingMetadata[],
): boolean {
  return restored.length === loaded.length && restored.every((previous, index) => {
    const current = loaded[index];
    return current !== undefined
      && previous.role === current.role
      && previous.name === current.name
      && previous.args === current.args
      && previous.contentHash === current.contentHash
      && previous.configHash === current.configHash
      && requiredReadingSemanticallyMatches(previous, current);
  });
}

function requiredReadingSemanticallyMatches(
  previous: SkillActivationBindingMetadata,
  current: SkillActivationBindingMetadata,
): boolean {
  if (previous.requiredReadingHash === current.requiredReadingHash) return true;
  const contentHashes = current.requiredReadingContentHashes ?? [];
  if (previous.requiredFiles.length !== contentHashes.length) return false;
  const relocatedLegacyHash = createHash("sha256")
    .update(JSON.stringify(previous.requiredFiles.map((path, index) => ({
      path,
      contentHash: contentHashes[index],
    }))))
    .digest("hex");
  return previous.requiredReadingHash === relocatedLegacyHash;
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

/**
 * Stand-in for an activation that could not be produced, synthesized by the Todo layer
 * when re-activation throws so a broken skill file degrades the turn instead of killing
 * it. See `ensureSkillActivation`.
 *
 * It is a separate type on purpose: `state: "degraded"` is not a
 * {@link SkillActivationState}, so it cannot be written into the persisted
 * {@link SkillActivationMetadata} or cached alongside real activations without the
 * compiler objecting.
 */
export interface DegradedSkillActivation extends Omit<SkillActivation, "state"> {
  state: "degraded";
}

export type AnySkillActivation = SkillActivation | DegradedSkillActivation;

export class SkillRuntime {
  constructor(private readonly loader: TodoSkillLoader) {}

  async activate(
    bindings: readonly TodoSkillBinding[],
    context = "",
    restored?: SkillActivationMetadata,
  ): Promise<SkillActivation> {
    const ordered = composeSkillBindings(bindings);
    // One config read per activation, shared across validation and every
    // binding load; each activation still reads fresh from disk.
    const configSnapshot = await this.loader.loadConfig();
    await this.loader.validateContext(context, configSnapshot);
    const loaded = await Promise.all(
      ordered.map(async (binding) => ({
        role: binding.role,
        skill: await this.loader.load(binding, context, {
          allowModelInvocationDisabled: restored !== undefined,
          configSnapshot,
        }),
      })),
    );
    const stackRevision = createHash("sha256")
      .update(JSON.stringify(loaded.map(({ role, skill }) => ({
        role,
        name: skill.name,
        compiledKey: skill.compiledKey,
      }))))
      .digest("hex");
    const now = Date.now();
    const metadataBindings = loaded.map(({ role, skill }, index) => ({
      role,
      name: skill.name,
      sessionMode: skill.sessionMode,
      ...(ordered[index]?.args ? { args: ordered[index].args } : {}),
      filePath: skill.filePath,
      contentHash: skill.contentHash,
      configHash: skill.configHash,
      requiredReadingHash: skill.requiredReadingHash,
      requiredReadingContentHashes: [...skill.requiredReadingContentHashes],
      compiledKey: skill.compiledKey,
      requiredFiles: [...skill.requiredFiles],
      deferredFiles: [...skill.deferredFiles],
      totalBytes: skill.totalBytes,
    }));
    const canRestore = restored?.stackRevision === stackRevision
      || (restored !== undefined && bindingsSemanticallyMatch(restored.bindings, metadataBindings));

    return Object.freeze({
      activationId: restored?.activationId ?? randomUUID(),
      stackRevision,
      activatedAt: restored?.activatedAt ?? now,
      validatedAt: now,
      state: restored && !canRestore ? "stale" : "active",
      bindings: Object.freeze(metadataBindings) as SkillActivationBindingMetadata[],
      skills: Object.freeze(loaded) as LoadedTodoSkillBinding[],
      prompt: renderSkillStack(loaded),
    });
  }
}
