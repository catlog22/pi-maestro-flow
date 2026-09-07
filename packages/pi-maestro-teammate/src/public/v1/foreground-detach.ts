import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** One session-scoped Alt+B listener shared by every foreground tool owner. */
type ForegroundDetachOwner = {
  active: boolean;
  detach(): void;
};

type ForegroundDetachRegistry = {
  ui?: ExtensionUIContext;
  unsubscribe?: () => void;
  owners: ForegroundDetachOwner[];
};

const REGISTRY_KEY = Symbol.for("pi-maestro.foreground-detach.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function registry(): ForegroundDetachRegistry {
  const existing = globals[REGISTRY_KEY];
  if (existing && typeof existing === "object" && Array.isArray((existing as ForegroundDetachRegistry).owners)) {
    return existing as ForegroundDetachRegistry;
  }
  const created: ForegroundDetachRegistry = { owners: [] };
  globals[REGISTRY_KEY] = created;
  return created;
}

function uninstallForegroundDetachListener(state: ForegroundDetachRegistry): void {
  const unsubscribe = state.unsubscribe;
  state.unsubscribe = undefined;
  unsubscribe?.();
}

function installForegroundDetachListener(state: ForegroundDetachRegistry): void {
  if (!state.ui || state.unsubscribe || state.owners.length === 0) return;
  state.unsubscribe = state.ui.onTerminalInput((data: string) => {
    if (data !== "\x1bb") return undefined;
    const owner = state.owners.shift();
    if (!owner) return undefined;
    owner.active = false;
    if (state.owners.length === 0) uninstallForegroundDetachListener(state);
    owner.detach();
    return { consume: true };
  });
}

export function setPersistentUi(
  ui: ExtensionUIContext | undefined,
  resetOwners = false,
): void {
  const state = registry();
  if (state.ui !== ui || resetOwners) {
    uninstallForegroundDetachListener(state);
    state.ui = ui;
  }
  if (!ui || resetOwners) {
    for (const owner of state.owners) owner.active = false;
    state.owners.length = 0;
    if (!ui) return;
  }
  installForegroundDetachListener(state);
}

/** Registers one foreground owner; unregister is idempotent on every race path. */
export function registerForegroundDetach(
  detach: () => void,
  ui?: ExtensionUIContext,
): () => void {
  if (ui) setPersistentUi(ui);
  const state = registry();
  const owner: ForegroundDetachOwner = { active: true, detach };
  state.owners.push(owner);
  try {
    installForegroundDetachListener(state);
  } catch (error) {
    owner.active = false;
    const index = state.owners.indexOf(owner);
    if (index >= 0) state.owners.splice(index, 1);
    if (state.owners.length === 0) uninstallForegroundDetachListener(state);
    throw error;
  }

  return () => {
    if (!owner.active) return;
    owner.active = false;
    const index = state.owners.indexOf(owner);
    if (index >= 0) state.owners.splice(index, 1);
    if (state.owners.length === 0) uninstallForegroundDetachListener(state);
  };
}
