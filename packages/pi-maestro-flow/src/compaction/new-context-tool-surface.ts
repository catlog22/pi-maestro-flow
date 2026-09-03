import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NEW_CONTEXT_TOOL_NAMES = ["compact_history", "new_context"] as const;

export interface NewContextToolSurface {
  readonly registered: boolean;
  sync(enabled: boolean): void;
  deactivate(): void;
}

/**
 * Registers the gated tools lazily and keeps them out of the model-facing
 * active set while the effective New Context setting is explicitly disabled.
 */
export function createNewContextToolSurface(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  register: () => void,
): NewContextToolSurface {
  let registered = false;

  const sync = (enabled: boolean): void => {
    if (enabled && !registered) {
      register();
      registered = true;
    }

    const current = pi.getActiveTools();
    const next = enabled && registered
      ? addNames(current, NEW_CONTEXT_TOOL_NAMES)
      : current.filter((name) => !NEW_CONTEXT_TOOL_NAMES.includes(name as typeof NEW_CONTEXT_TOOL_NAMES[number]));
    if (!sameNames(current, next)) pi.setActiveTools(next);
  };

  return {
    get registered() {
      return registered;
    },
    sync,
    deactivate() {
      sync(false);
    },
  };
}

function addNames(current: readonly string[], names: readonly string[]): string[] {
  const next = [...current];
  const seen = new Set(next);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}
