import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TeammateChildExtensionRegistration {
  path: string;
  tools: readonly string[];
}

interface ChildExtensionRegistry {
  registrations: Map<symbol, TeammateChildExtensionRegistration>;
  permissionBrokers: Map<symbol, TeammatePermissionBroker>;
  permissionBrokerOwners: Map<symbol, RegistrationOwner>;
  toolBrokers: Map<symbol, { toolName: string; broker: TeammateChildToolBroker }>;
  toolBrokerOwners: Map<symbol, RegistrationOwner>;
  proxyCaller?: TeammateChildProxyCaller;
}

type RegistrationOwner = string | symbol;

const registryKey = Symbol.for("pi-maestro-teammate.child-extensions");

export interface RegisterTeammateChildExtensionOptions {
  tools?: readonly string[];
}

export interface RegisterTeammateAuthorityOptions {
  /** Stable package/session authority key. Re-registering the same key replaces its prior generation. */
  owner?: string;
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

export interface TeammateChildToolActor {
  correlationId: string;
  name?: string;
  agent?: string;
}

export interface TeammateChildToolBrokerRequest {
  toolName: string;
  input: Record<string, unknown>;
  actor: TeammateChildToolActor;
}

export interface TeammateChildToolResult {
  content: AgentToolResult<unknown>["content"];
  details?: unknown;
  isError?: boolean;
}

export type TeammateChildToolBroker = (
  request: TeammateChildToolBrokerRequest,
) => Promise<TeammateChildToolResult>;

export type TeammateChildProxyCaller = <T = unknown>(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<AgentToolResult<T>>;

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
  // The extension path is its stable authority key. A reload must replace the
  // previous generation instead of retaining tools that the new generation no
  // longer exposes. The token-specific disposer cannot remove the replacement.
  for (const [existingToken, registration] of registry.registrations) {
    if (pathKey(registration.path) === pathKey(normalizedPath)) {
      registry.registrations.delete(existingToken);
    }
  }
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
  options: RegisterTeammateAuthorityOptions = {},
): () => void {
  const token = Symbol("teammate-permission-broker");
  const registry = getRegistry();
  const owner = registrationOwner(options.owner, token);
  replaceOwnedAuthority(
    registry.permissionBrokers,
    registry.permissionBrokerOwners,
    owner,
    "teammate permission broker",
  );
  registry.permissionBrokers.set(token, broker);
  registry.permissionBrokerOwners.set(token, owner);
  return () => {
    registry.permissionBrokers.delete(token);
    registry.permissionBrokerOwners.delete(token);
  };
}

export function getTeammatePermissionBroker(): TeammatePermissionBroker | undefined {
  const brokers = [...getRegistry().permissionBrokers.values()];
  return brokers.length === 1 ? brokers[0] : undefined;
}

/** Registers a root-session handler for a tool exposed by an inherited child extension. */
export function registerTeammateChildToolBroker(
  toolName: string,
  broker: TeammateChildToolBroker,
  options: RegisterTeammateAuthorityOptions = {},
): () => void {
  const normalized = toolName.trim();
  if (!normalized) throw new Error("A teammate child tool broker name is required.");
  const token = Symbol(normalized);
  const registry = getRegistry();
  const owner = registrationOwner(options.owner, token);
  replaceOwnedAuthority(
    registry.toolBrokers,
    registry.toolBrokerOwners,
    owner,
    `teammate child tool broker "${normalized}"`,
    (registration) => registration.toolName === normalized,
  );
  registry.toolBrokers.set(token, { toolName: normalized, broker });
  registry.toolBrokerOwners.set(token, owner);
  return () => {
    registry.toolBrokers.delete(token);
    registry.toolBrokerOwners.delete(token);
  };
}

export function getTeammateChildToolBroker(toolName: string): TeammateChildToolBroker | undefined {
  const brokers = [...getRegistry().toolBrokers.values()]
    .filter((registration) => registration.toolName === toolName);
  return brokers.length === 1 ? brokers[0].broker : undefined;
}

/** Installs the child-process IPC caller owned by the teammate extension. */
export function registerTeammateChildProxyCaller(caller: TeammateChildProxyCaller): () => void {
  const registry = getRegistry();
  registry.proxyCaller = caller;
  return () => {
    if (registry.proxyCaller === caller) registry.proxyCaller = undefined;
  };
}

export async function proxyTeammateChildTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult<T>> {
  const caller = getRegistry().proxyCaller;
  if (caller) return caller<T>(toolName, input, signal);
  return {
    content: [{ type: "text", text: `Parent IPC proxy is unavailable for child tool "${toolName}".` }],
    details: undefined as T,
    isError: true,
  } as unknown as AgentToolResult<T>;
}

function getRegistry(): ChildExtensionRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as ChildExtensionRegistry | undefined;
  if (existing) {
    existing.permissionBrokers ??= new Map();
    existing.permissionBrokerOwners ??= new Map();
    existing.toolBrokers ??= new Map();
    existing.toolBrokerOwners ??= new Map();
    for (const token of existing.permissionBrokers.keys()) {
      if (!existing.permissionBrokerOwners.has(token)) existing.permissionBrokerOwners.set(token, token);
    }
    for (const token of existing.toolBrokers.keys()) {
      if (!existing.toolBrokerOwners.has(token)) existing.toolBrokerOwners.set(token, token);
    }
    return existing;
  }
  const created: ChildExtensionRegistry = {
    registrations: new Map(),
    permissionBrokers: new Map(),
    permissionBrokerOwners: new Map(),
    toolBrokers: new Map(),
    toolBrokerOwners: new Map(),
  };
  globals[registryKey] = created;
  return created;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function registrationOwner(owner: string | undefined, fallback: symbol): RegistrationOwner {
  if (owner === undefined) return fallback;
  const normalized = owner.trim();
  if (!normalized) throw new Error("A teammate registration owner must not be empty.");
  return normalized;
}

function replaceOwnedAuthority<T>(
  registrations: Map<symbol, T>,
  owners: Map<symbol, RegistrationOwner>,
  owner: RegistrationOwner,
  label: string,
  matches: (registration: T) => boolean = () => true,
): void {
  const tokens = [...registrations]
    .filter(([, registration]) => matches(registration))
    .map(([token]) => token);
  if (tokens.length === 0) return;
  const sameOwner = typeof owner === "string"
    && tokens.every((token) => owners.get(token) === owner);
  if (!sameOwner) {
    throw new Error(`Conflicting ${label} authority is already registered.`);
  }
  for (const token of tokens) {
    registrations.delete(token);
    owners.delete(token);
  }
}
