import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TeammateChildExtensionRegistration {
  path: string;
  tools: readonly string[];
}

interface ChildExtensionRegistry {
  registrations: Map<symbol, TeammateChildExtensionRegistration>;
  permissionBrokers: Map<symbol, TeammatePermissionBroker>;
}

const registryKey = Symbol.for("pi-maestro-teammate.child-extensions");

export interface RegisterTeammateChildExtensionOptions {
  tools?: readonly string[];
}

export interface TeammatePermissionBrokerRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface TeammatePermissionBrokerResult {
  action: "allow_once" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export type TeammatePermissionBroker = (
  request: TeammatePermissionBrokerRequest,
  ctx: ExtensionContext,
) => Promise<TeammatePermissionBrokerResult>;

/**
 * Registers an extension that must also be loaded by every teammate child.
 *
 * The registry lives on globalThis so independently loaded package modules can
 * contribute child extensions without making pi-maestro-teammate depend on
 * those packages.
 */
export function registerTeammateChildExtension(
  extensionPath: string,
  options: RegisterTeammateChildExtensionOptions = {},
): () => void {
  const normalizedPath = extensionPath.trim();
  if (!normalizedPath) throw new Error("A teammate child extension path is required.");

  const token = Symbol(normalizedPath);
  const registry = getRegistry();
  registry.registrations.set(token, {
    path: normalizedPath,
    tools: [...new Set((options.tools ?? []).map((tool) => tool.trim()).filter(Boolean))],
  });
  return () => registry.registrations.delete(token);
}

export function getTeammateChildExtensions(): TeammateChildExtensionRegistration[] {
  const merged = new Map<string, { path: string; tools: Set<string> }>();
  for (const registration of getRegistry().registrations.values()) {
    const key = process.platform === "win32"
      ? registration.path.toLowerCase()
      : registration.path;
    const current = merged.get(key) ?? { path: registration.path, tools: new Set<string>() };
    for (const tool of registration.tools) current.tools.add(tool);
    merged.set(key, current);
  }
  return [...merged.values()].map((registration) => ({
    path: registration.path,
    tools: [...registration.tools],
  }));
}

/** Registers the live parent-session authority used to decide child tool calls. */
export function registerTeammatePermissionBroker(
  broker: TeammatePermissionBroker,
): () => void {
  const token = Symbol("teammate-permission-broker");
  const registry = getRegistry();
  registry.permissionBrokers.set(token, broker);
  return () => registry.permissionBrokers.delete(token);
}

export function getTeammatePermissionBroker(): TeammatePermissionBroker | undefined {
  return [...getRegistry().permissionBrokers.values()].at(-1);
}

function getRegistry(): ChildExtensionRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as ChildExtensionRegistry | undefined;
  if (existing) {
    existing.permissionBrokers ??= new Map();
    return existing;
  }
  const created: ChildExtensionRegistry = {
    registrations: new Map(),
    permissionBrokers: new Map(),
  };
  globals[registryKey] = created;
  return created;
}
