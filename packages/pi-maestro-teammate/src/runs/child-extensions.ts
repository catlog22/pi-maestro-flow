/**
 * Cross-package registry for teammate child extensions and the authorities
 * (permission broker, child tool brokers, IPC proxy caller) that the parent
 * session contributes to child processes.
 *
 * Ownership model — read before adding an authority: the `owner` on
 * {@link RegisterTeammateAuthorityOptions} is a *collaboration convention*, not
 * a security boundary. It is a self-declared string that the registry cannot
 * authenticate: any module sharing this globalThis registry may claim any owner
 * key. Its purpose is to let one package replace its own prior generation on
 * reload while making an unrelated package's collision a loud error instead of
 * a silent takeover. Do not treat a matching owner as proof of identity; the
 * real trust boundary is which modules get loaded into the process at all.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Environment marker carried only by independently managed workspace windows. */
export const MANAGED_WINDOW_ENV = "PI_TEAMMATE_MANAGED_WINDOW";

/** Environment marker carried only by the host-owned Monitor evaluator session. */
export const MONITOR_SESSION_ENV_VAR = "PI_TEAMMATE_MONITOR";

export function isManagedWorkerWindow(): boolean {
  return process.env[MANAGED_WINDOW_ENV] === "1";
}

export function isMonitorSession(): boolean {
  return process.env.PI_TEAMMATE_CHILD === "1"
    && process.env[MONITOR_SESSION_ENV_VAR] === "1";
}

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
  proxyCallers: Map<symbol, TeammateChildProxyCaller>;
  proxyCallerOwners: Map<symbol, RegistrationOwner>;
  /** Legacy single-slot mirror kept readable for older package generations. */
  proxyCaller?: TeammateChildProxyCaller;
}

type RegistrationOwner = string | symbol;

const registryKey = Symbol.for("pi-maestro-teammate.child-extensions");

/** Owner slot used when an IPC proxy caller is registered without an explicit owner. */
const DEFAULT_PROXY_CALLER_OWNER = "pi-maestro-teammate.child-proxy-caller";

export interface RegisterTeammateChildExtensionOptions {
  tools?: readonly string[];
}

export interface RegisterTeammateAuthorityOptions {
  /** Stable package/session authority key. Re-registering the same key replaces its prior generation. */
  owner?: string;
}

/** Why an authority lookup produced (or failed to produce) a broker. */
export type TeammateAuthorityStatus = "resolved" | "unregistered" | "conflict";

/**
 * Diagnostic result of an authority lookup. `broker` is populated only for
 * `status: "resolved"`; `unregistered` and `conflict` both leave it undefined
 * but stay distinguishable so callers can log why they fell back.
 */
export interface TeammateAuthorityResolution<TBroker> {
  status: TeammateAuthorityStatus;
  broker?: TBroker;
  /** Human-readable explanation, present whenever `broker` is undefined. */
  reason?: string;
  /** Owner labels of every registration considered, in registration order. */
  owners?: string[];
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
  /** Aborted when the requesting child gives up or its owning agent terminates. */
  signal?: AbortSignal;
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
  return resolveTeammatePermissionBroker().broker;
}

/**
 * Diagnostic form of {@link getTeammatePermissionBroker}: separates "nobody
 * registered" from "two generations are registered", which the plain getter
 * collapses into the same silent `undefined`.
 */
export function resolveTeammatePermissionBroker(): TeammateAuthorityResolution<TeammatePermissionBroker> {
  const registry = getRegistry();
  return resolveOwnedAuthority(
    [...registry.permissionBrokers].map(([token, broker]) => ({
      broker,
      owner: registry.permissionBrokerOwners.get(token),
    })),
    "teammate permission broker",
  );
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
  return resolveTeammateChildToolBroker(toolName).broker;
}

/**
 * Diagnostic form of {@link getTeammateChildToolBroker}: an unhandled tool and
 * a contested tool are different failures and must be reportable as such.
 */
export function resolveTeammateChildToolBroker(
  toolName: string,
): TeammateAuthorityResolution<TeammateChildToolBroker> {
  const registry = getRegistry();
  return resolveOwnedAuthority(
    [...registry.toolBrokers]
      .filter(([, registration]) => registration.toolName === toolName)
      .map(([token, registration]) => ({
        broker: registration.broker,
        owner: registry.toolBrokerOwners.get(token),
      })),
    `teammate child tool broker "${toolName}"`,
  );
}

/**
 * Installs the child-process IPC caller owned by the teammate extension.
 *
 * Shares the owner semantics of the broker registries: a foreign owner cannot
 * silently take over the channel (which would expose every proxied tool call),
 * and a stale disposer can no longer clear a newer generation. Callers that
 * pass no owner share the default teammate slot, preserving the historical
 * last-registration-wins behaviour for the package's own reload path.
 */
export function registerTeammateChildProxyCaller(
  caller: TeammateChildProxyCaller,
  options: RegisterTeammateAuthorityOptions = {},
): () => void {
  const registry = getRegistry();
  const token = Symbol("teammate-child-proxy-caller");
  const owner = options.owner === undefined
    ? DEFAULT_PROXY_CALLER_OWNER
    : registrationOwner(options.owner, token);
  replaceOwnedAuthority(
    registry.proxyCallers,
    registry.proxyCallerOwners,
    owner,
    "teammate child proxy caller",
  );
  registry.proxyCallers.set(token, caller);
  registry.proxyCallerOwners.set(token, owner);
  registry.proxyCaller = caller;
  return () => {
    registry.proxyCallerOwners.delete(token);
    // A superseded generation must not unset the caller that replaced it.
    if (!registry.proxyCallers.delete(token)) return;
    if (registry.proxyCaller === caller) registry.proxyCaller = undefined;
  };
}

export async function proxyTeammateChildTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult<T>> {
  const registry = getRegistry();
  // Prefer the owned registration; fall back to the legacy single slot so a
  // caller installed by an older package generation keeps working.
  const caller = [...registry.proxyCallers.values()].at(-1) ?? registry.proxyCaller;
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
    existing.proxyCallers ??= new Map();
    existing.proxyCallerOwners ??= new Map();
    for (const token of existing.permissionBrokers.keys()) {
      if (!existing.permissionBrokerOwners.has(token)) existing.permissionBrokerOwners.set(token, token);
    }
    for (const token of existing.toolBrokers.keys()) {
      if (!existing.toolBrokerOwners.has(token)) existing.toolBrokerOwners.set(token, token);
    }
    for (const token of existing.proxyCallers.keys()) {
      if (!existing.proxyCallerOwners.has(token)) existing.proxyCallerOwners.set(token, token);
    }
    return existing;
  }
  const created: ChildExtensionRegistry = {
    registrations: new Map(),
    permissionBrokers: new Map(),
    permissionBrokerOwners: new Map(),
    toolBrokers: new Map(),
    toolBrokerOwners: new Map(),
    proxyCallers: new Map(),
    proxyCallerOwners: new Map(),
  };
  globals[registryKey] = created;
  return created;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function resolveOwnedAuthority<TBroker>(
  candidates: readonly { broker: TBroker; owner?: RegistrationOwner }[],
  label: string,
): TeammateAuthorityResolution<TBroker> {
  if (candidates.length === 1) return { status: "resolved", broker: candidates[0].broker };
  if (candidates.length === 0) {
    return { status: "unregistered", reason: `No ${label} is registered.`, owners: [] };
  }
  const owners = candidates.map((candidate) => describeOwner(candidate.owner));
  return {
    status: "conflict",
    reason: `Ambiguous ${label}: ${candidates.length} conflicting registrations by ${formatOwners(owners)}.`,
    owners,
  };
}

function describeOwner(owner: RegistrationOwner | undefined): string {
  if (typeof owner === "string") return owner;
  if (owner === undefined) return "<unknown>";
  return owner.description ? `<anonymous:${owner.description}>` : "<anonymous>";
}

function formatOwners(owners: readonly string[]): string {
  const quoted = owners.map((owner) => `"${owner}"`).join(", ");
  return owners.length === 1 ? `owner ${quoted}` : `owners ${quoted}`;
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
    // Name the incumbent: replacement is refused, and the operator needs to
    // know which package already holds the slot to resolve it.
    const incumbents = tokens.map((token) => describeOwner(owners.get(token)));
    throw new Error(
      `Conflicting ${label} authority is already registered by ${formatOwners(incumbents)}.`
        + ` Dispose that registration first, or re-register with the same owner.`,
    );
  }
  for (const token of tokens) {
    registrations.delete(token);
    owners.delete(token);
  }
}
