import type { LoadedTodoSkill, TodoSkillConfig } from "./skill-loader.ts";

export type TodoSkillRole = "primary" | "guard" | "support";

export interface TodoSkillBinding extends TodoSkillConfig {
  role: TodoSkillRole;
}

export interface LoadedTodoSkillBinding {
  role: TodoSkillRole;
  skill: LoadedTodoSkill;
}

export class SkillCompositionError extends Error {
  constructor(
    readonly code: "E_SKILL_PRIMARY_COUNT" | "E_SKILL_DUPLICATE",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SkillCompositionError";
  }
}

const ROLE_ORDER: readonly TodoSkillRole[] = ["guard", "primary", "support"];

export function composeSkillBindings(
  bindings: readonly TodoSkillBinding[],
): TodoSkillBinding[] {
  const names = new Set<string>();
  let primaryCount = 0;

  for (const binding of bindings) {
    if (names.has(binding.name)) {
      throw new SkillCompositionError(
        "E_SKILL_DUPLICATE",
        `skill "${binding.name}" is bound more than once`,
      );
    }
    names.add(binding.name);
    if (binding.role === "primary") primaryCount += 1;
  }

  if (bindings.length > 0 && primaryCount !== 1) {
    throw new SkillCompositionError(
      "E_SKILL_PRIMARY_COUNT",
      `non-empty skill bindings require exactly one primary; received ${primaryCount}`,
    );
  }

  return ROLE_ORDER.flatMap((role) =>
    bindings.filter((binding) => binding.role === role).map((binding) => ({ ...binding })),
  );
}

export function renderSkillStack(bindings: readonly LoadedTodoSkillBinding[]): string {
  if (bindings.length === 0) return "";
  const seenRequiredFiles = new Set<string>();
  const sections = bindings.map(({ role, skill }) => {
    let prompt = skill.prompt;
    for (const filePath of skill.requiredFiles) {
      if (seenRequiredFiles.has(filePath)) prompt = removeRepeatedInline(prompt, filePath);
      else seenRequiredFiles.add(filePath);
    }
    return [
      `<skill role="${role}" name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">`,
      prompt,
      "</skill>",
    ].join("\n");
  });
  return [
    "<active_skill_stack>",
    "Follow guard skills as constraints, the primary skill as the main workflow, and support skills as supplemental guidance.",
    ...sections,
    "</active_skill_stack>",
  ].join("\n\n");
}

function removeRepeatedInline(prompt: string, filePath: string): string {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<!-- inlined ${escaped} -->[\\s\\S]*?<!-- \/inlined -->`, "g");
  return prompt.replace(pattern, `<!-- required reading reused from earlier skill: ${filePath} -->`);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
