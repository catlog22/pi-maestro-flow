import { createHash } from "node:crypto";
import type {
  BackendRegistration,
  TeammateExecutionMode,
} from "pi-maestro-backend-core/v1/registry";
import type { ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { CliToolsConfig } from "../cli-tools/cli-tools-config.ts";
import type { TeammateThinkingLevel } from "../shared/thinking.ts";
import {
  TEAMMATE_THINKING_LEVELS,
  parseTeammateThinkingLevel,
} from "../shared/thinking.ts";
import {
  supportedThinkingLevels,
  type AvailableModelEntry,
} from "./model-catalog.ts";

export type ModelSelectorV2 =
  | { kind: "adapter-model"; value: string }
  | { kind: "deployment-default" }
  | { kind: "fixed" };

export interface ModelRegistrationCapabilitiesV2 {
  reasoning?: boolean;
  thinkingLevels?: readonly TeammateThinkingLevel[];
  input?: readonly ("text" | "image")[];
}

export interface ModelRegistrationV2 {
  modelId: string;
  deployment: string;
  selector: ModelSelectorV2;
  deploymentDefault?: boolean;
  displayName?: string;
  capabilities?: ModelRegistrationCapabilitiesV2;
}

export interface ModelRegistryCompatibilityV1 {
  version: 1;
  hostModelsDeployment?: string;
  teammateCliToolsProjection?: { enabled: boolean };
  modelAliases?: Record<string, string>;
  backendAliases?: Record<string, string>;
  remoteLocations?: Record<string, string>;
}

export interface ModelRegistryManifestV2 {
  version: 2;
  mode: "model-registry";
  default: string;
  defaultModel: string;
  backends: Record<string, BackendRegistration>;
  models: Record<string, ModelRegistrationV2>;
  compatibility?: ModelRegistryCompatibilityV1;
}

export interface ProjectionIdentity {
  revision: number;
  hash: string;
}

export type ModelRegistryHarness = "pi" | "dsh" | "acp" | "adapter-owned";

export type ModelRegistryTransport =
  | { kind: "local-process"; protocol: "pi-rpc" | "json-rpc-stdio" | "acp" }
  | { kind: "acp-direct-ssh"; protocol: "acp" }
  | { kind: "dsh-direct-ssh"; protocol: "json-rpc-stdio" }
  | {
      kind: "remote-worker";
      gateway: "ssh";
      protocol: "remote/2";
      driver: "pi-rpc" | "acp";
    }
  | { kind: "adapter-owned" };

export type ModelSelectionSupport = "native" | "unsupported" | "unknown";

export interface ModelRuntimeDescriptor {
  harness: ModelRegistryHarness;
  transport: ModelRegistryTransport;
  modelSelection: ModelSelectionSupport;
  resolvable: boolean;
  unavailableReason?: string;
}

export interface InternalModelCatalogRoute {
  modelRegistrationId: string;
  modelId: string;
  deploymentId: string;
  displayName?: string;
  capabilities?: ModelRegistrationCapabilitiesV2;
  deploymentDefault: boolean;
  runtime: ModelRuntimeDescriptor;
}

export interface ModelDispatchRoute {
  modelRegistrationId: string;
  modelId: string;
  deploymentId: string;
  selector: ModelSelectorV2;
  deploymentDefault: boolean;
  displayName?: string;
  capabilities?: ModelRegistrationCapabilitiesV2;
}

export interface ModelDeploymentRoute {
  deploymentId: string;
  registration: BackendRegistration;
  runtime: ModelRuntimeDescriptor;
}

export interface DiscoveryCatalogProjection extends ProjectionIdentity {
  defaultModel: string;
  entries: readonly InternalModelCatalogRoute[];
  diagnostics: readonly string[];
}

export interface DispatchAuthorityProjection extends ProjectionIdentity {
  registryVersion: ModelRegistryManifestV2["version"];
  defaultDeployment: string;
  defaultModel: string;
  routesByRegistrationId: ReadonlyMap<string, ModelDispatchRoute>;
  deploymentsById: ReadonlyMap<string, ModelDeploymentRoute>;
  modelAliases: ReadonlyMap<string, string>;
  backendAliases: ReadonlyMap<string, string>;
  remoteLocations: ReadonlyMap<string, string>;
  diagnostics: readonly string[];
}

export interface CompiledModelRegistryPair {
  discovery: DiscoveryCatalogProjection;
  dispatch: DispatchAuthorityProjection;
}

export interface ModelRegistryCompileInputs {
  hostModels?: readonly AvailableModelEntry[];
  cliToolsConfig?: CliToolsConfig | null;
  /** Sanitized failures from optional projection sources. */
  diagnostics?: readonly string[];
  previousIdentity?: ProjectionIdentity;
}

const TOP_LEVEL_KEYS = [
  "version",
  "mode",
  "default",
  "defaultModel",
  "backends",
  "models",
  "compatibility",
] as const;
const BACKEND_KEYS = ["module", "config"] as const;
const MODEL_KEYS = [
  "modelId",
  "deployment",
  "selector",
  "deploymentDefault",
  "displayName",
  "capabilities",
] as const;
const CAPABILITY_KEYS = ["reasoning", "thinkingLevels", "input"] as const;
const COMPATIBILITY_KEYS = [
  "version",
  "hostModelsDeployment",
  "teammateCliToolsProjection",
  "modelAliases",
  "backendAliases",
  "remoteLocations",
] as const;
const ACP_MODULE = "pi-maestro-teammate/v1/acp-cli";
const DSH_MODULE = "pi-maestro-backends/dsh";
const PI_MODULE = "pi-subprocess";
const REMOTE_MODULE = "remote-workers";
const MAX_SELECTOR_BYTES = 256;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const CANONICAL_REGISTRY_HASH = /^[0-9a-f]{64}$/;

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  has(key: K): boolean { return this.#values.has(key); }
  get(key: K): V | undefined { return this.#values.get(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field "${unknown}"`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || UNSAFE_TEXT.test(value)) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace or control characters`);
  }
  return value;
}

function selectorText(value: unknown, label: string): string {
  const selected = text(value, label);
  if (Buffer.byteLength(selected, "utf8") > MAX_SELECTOR_BYTES) {
    throw new Error(`${label} must be at most ${MAX_SELECTOR_BYTES} UTF-8 bytes`);
  }
  return selected;
}

function record(value: unknown, label: string): Record<string, unknown> {
  return object(value, label);
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return emptyRecord();
  const source = record(value, label);
  const result = emptyRecord<string>();
  for (const [key, raw] of Object.entries(source)) {
    const name = text(key, `${label} key`);
    result[name] = text(raw, `${label}["${name}"]`);
  }
  return result;
}

function configValue(value: unknown, label: string): ConfigValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
  throw new Error(`${label} must be a string, finite number, boolean, or string array`);
}

function parseBackendRegistration(value: unknown, deploymentId: string): BackendRegistration {
  const source = object(value, `model registry deployment "${deploymentId}"`);
  knownKeys(source, BACKEND_KEYS, `model registry deployment "${deploymentId}"`);
  const module = text(source.module, `model registry deployment "${deploymentId}" module`);
  let config: Record<string, ConfigValue> | undefined;
  if (source.config !== undefined) {
    const rawConfig = record(source.config, `model registry deployment "${deploymentId}" config`);
    config = Object.fromEntries(Object.entries(rawConfig).map(([key, raw]) => [
      text(key, `model registry deployment "${deploymentId}" config key`),
      configValue(raw, `model registry deployment "${deploymentId}" config "${key}"`),
    ]));
  }
  return config === undefined ? { module } : { module, config };
}

function parseSelector(value: unknown, registrationId: string): ModelSelectorV2 {
  const label = `model registration "${registrationId}" selector`;
  const source = object(value, label);
  if (source.kind === "adapter-model") {
    knownKeys(source, ["kind", "value"], label);
    return { kind: "adapter-model", value: selectorText(source.value, `${label} value`) };
  }
  if (source.kind === "deployment-default" || source.kind === "fixed") {
    knownKeys(source, ["kind"], label);
    return { kind: source.kind };
  }
  throw new Error(`${label} kind must be "adapter-model", "deployment-default", or "fixed"`);
}

function parseCapabilities(value: unknown, registrationId: string): ModelRegistrationCapabilitiesV2 | undefined {
  if (value === undefined) return undefined;
  const label = `model registration "${registrationId}" capabilities`;
  const source = object(value, label);
  knownKeys(source, CAPABILITY_KEYS, label);
  const capabilities: ModelRegistrationCapabilitiesV2 = {};
  if (source.reasoning !== undefined) {
    if (typeof source.reasoning !== "boolean") throw new Error(`${label} reasoning must be boolean`);
    capabilities.reasoning = source.reasoning;
  }
  if (source.thinkingLevels !== undefined) {
    if (!Array.isArray(source.thinkingLevels) || source.thinkingLevels.length === 0) {
      throw new Error(`${label} thinkingLevels must be a non-empty array`);
    }
    const levels = source.thinkingLevels.map((level) => {
      const parsed = parseTeammateThinkingLevel(level);
      if (parsed === undefined) {
        throw new Error(`${label} thinkingLevels must use ${TEAMMATE_THINKING_LEVELS.join(" | ")}`);
      }
      return parsed;
    });
    if (new Set(levels).size !== levels.length) throw new Error(`${label} thinkingLevels contains duplicates`);
    capabilities.thinkingLevels = levels;
  }
  if (source.input !== undefined) {
    if (!Array.isArray(source.input) || source.input.length === 0
      || source.input.some((entry) => entry !== "text" && entry !== "image")) {
      throw new Error(`${label} input must contain only "text" or "image"`);
    }
    const input = source.input as ("text" | "image")[];
    if (new Set(input).size !== input.length) throw new Error(`${label} input contains duplicates`);
    capabilities.input = [...input];
  }
  if (capabilities.reasoning === false
    && capabilities.thinkingLevels?.some((level) => level !== "off")) {
    throw new Error(`${label} cannot advertise reasoning false with enabled thinking levels`);
  }
  return capabilities;
}

function parseModelRegistration(value: unknown, registrationId: string): ModelRegistrationV2 {
  const label = `model registration "${registrationId}"`;
  const source = object(value, label);
  knownKeys(source, MODEL_KEYS, label);
  if (source.deploymentDefault !== undefined && typeof source.deploymentDefault !== "boolean") {
    throw new Error(`${label} deploymentDefault must be boolean`);
  }
  return {
    modelId: text(source.modelId, `${label} modelId`),
    deployment: text(source.deployment, `${label} deployment`),
    selector: parseSelector(source.selector, registrationId),
    ...(source.deploymentDefault === undefined ? {} : { deploymentDefault: source.deploymentDefault }),
    ...(source.displayName === undefined ? {} : { displayName: text(source.displayName, `${label} displayName`) }),
    ...(source.capabilities === undefined ? {} : { capabilities: parseCapabilities(source.capabilities, registrationId) }),
  };
}

function parseCompatibility(value: unknown): ModelRegistryCompatibilityV1 | undefined {
  if (value === undefined) return undefined;
  const source = object(value, "model registry compatibility");
  knownKeys(source, COMPATIBILITY_KEYS, "model registry compatibility");
  if (source.version !== 1) throw new Error(`model registry compatibility version must be 1`);
  let teammateCliToolsProjection: { enabled: boolean } | undefined;
  if (source.teammateCliToolsProjection !== undefined) {
    const projection = object(source.teammateCliToolsProjection, "model registry teammateCliToolsProjection");
    knownKeys(projection, ["enabled"], "model registry teammateCliToolsProjection");
    if (typeof projection.enabled !== "boolean") {
      throw new Error(`model registry teammateCliToolsProjection enabled must be boolean`);
    }
    teammateCliToolsProjection = { enabled: projection.enabled };
  }
  return {
    version: 1,
    ...(source.hostModelsDeployment === undefined
      ? {}
      : { hostModelsDeployment: text(source.hostModelsDeployment, "model registry hostModelsDeployment") }),
    ...(teammateCliToolsProjection === undefined ? {} : { teammateCliToolsProjection }),
    ...(source.modelAliases === undefined ? {} : { modelAliases: stringMap(source.modelAliases, "model registry modelAliases") }),
    ...(source.backendAliases === undefined ? {} : { backendAliases: stringMap(source.backendAliases, "model registry backendAliases") }),
    ...(source.remoteLocations === undefined ? {} : { remoteLocations: stringMap(source.remoteLocations, "model registry remoteLocations") }),
  };
}

export function parseModelRegistryManifest(raw: string, path = ".pi/teammate-backends.json"): ModelRegistryManifestV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`teammate model registry at ${path} is not valid JSON`, { cause });
  }
  const source = object(parsed, `teammate model registry at ${path}`);
  knownKeys(source, TOP_LEVEL_KEYS, `teammate model registry at ${path}`);
  if (source.version !== 2 || source.mode !== "model-registry") {
    throw new Error(`teammate model registry at ${path} requires version 2 with mode "model-registry"`);
  }

  const defaultDeployment = text(source.default, "model registry default deployment");
  const defaultModel = text(source.defaultModel, "model registry defaultModel");
  const rawBackends = record(source.backends, "model registry backends");
  const backends = emptyRecord<BackendRegistration>();
  for (const [rawId, registration] of Object.entries(rawBackends)) {
    const deploymentId = text(rawId, "model registry deployment id");
    backends[deploymentId] = parseBackendRegistration(registration, deploymentId);
  }
  if (!Object.hasOwn(backends, defaultDeployment)) {
    throw new Error(`model registry default deployment "${defaultDeployment}" is not registered`);
  }

  const rawModels = record(source.models, "model registry models");
  const models = emptyRecord<ModelRegistrationV2>();
  for (const [rawId, registration] of Object.entries(rawModels)) {
    const registrationId = text(rawId, "model registration id");
    models[registrationId] = parseModelRegistration(registration, registrationId);
  }
  const compatibility = parseCompatibility(source.compatibility);
  const manifest: ModelRegistryManifestV2 = {
    version: 2,
    mode: "model-registry",
    default: defaultDeployment,
    defaultModel,
    backends,
    models,
    ...(compatibility === undefined ? {} : { compatibility }),
  };
  validateManifestGraph(manifest);
  return deepFreeze(manifest);
}

function selectorKey(selector: ModelSelectorV2): string {
  return selector.kind === "adapter-model" ? `${selector.kind}:${selector.value}` : selector.kind;
}

function capabilitiesKey(capabilities: ModelRegistrationCapabilitiesV2 | undefined): string {
  return canonicalJson(capabilities ?? null);
}

function validateAliasMap(
  aliases: Record<string, string> | undefined,
  canonical: Record<string, unknown>,
  label: string,
): void {
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (Object.hasOwn(canonical, alias)) throw new Error(`${label} alias "${alias}" shadows a canonical entry`);
    if (!Object.hasOwn(canonical, target)) {
      const suffix = Object.hasOwn(aliases ?? {}, target) ? " (aliases cannot target aliases)" : "";
      throw new Error(`${label} alias "${alias}" targets unknown canonical entry "${target}"${suffix}`);
    }
    if (alias === target) throw new Error(`${label} alias "${alias}" forms a cycle`);
  }
}

function validateManifestGraph(manifest: ModelRegistryManifestV2): void {
  const defaults = new Map<string, string>();
  const selectors = new Map<string, string>();
  const modelCapabilities = new Map<string, { key: string; registrationId: string }>();

  for (const [registrationId, registration] of Object.entries(manifest.models)) {
    if (!Object.hasOwn(manifest.backends, registration.deployment)) {
      throw new Error(`model registration "${registrationId}" targets unknown deployment "${registration.deployment}"`);
    }
    if (registration.deploymentDefault === true) {
      const previous = defaults.get(registration.deployment);
      if (previous !== undefined) {
        throw new Error(`deployment "${registration.deployment}" has multiple deployment defaults: "${previous}" and "${registrationId}"`);
      }
      defaults.set(registration.deployment, registrationId);
    }
    const effective = `${registration.deployment}\u0000${selectorKey(registration.selector)}`;
    const duplicate = selectors.get(effective);
    if (duplicate !== undefined) {
      throw new Error(`model registrations "${duplicate}" and "${registrationId}" duplicate the same deployment selector; use a modelAlias`);
    }
    selectors.set(effective, registrationId);

    const key = capabilitiesKey(registration.capabilities);
    const previousCapabilities = modelCapabilities.get(registration.modelId);
    if (previousCapabilities !== undefined && previousCapabilities.key !== key) {
      throw new Error(`model registrations "${previousCapabilities.registrationId}" and "${registrationId}" declare conflicting intrinsic capabilities for modelId "${registration.modelId}"`);
    }
    modelCapabilities.set(registration.modelId, { key, registrationId });
  }

  if (!Object.hasOwn(manifest.models, manifest.defaultModel)) {
    throw new Error(`model registry defaultModel "${manifest.defaultModel}" is not an explicit model registration`);
  }
  const selectedDefault = manifest.models[manifest.defaultModel]!;
  if (selectedDefault.deploymentDefault !== true) {
    throw new Error(`model registry defaultModel "${manifest.defaultModel}" must set deploymentDefault true`);
  }
  if (selectedDefault.deployment !== manifest.default) {
    throw new Error(`model registry defaultModel "${manifest.defaultModel}" targets deployment "${selectedDefault.deployment}", not default deployment "${manifest.default}"`);
  }

  const compatibility = manifest.compatibility;
  validateAliasMap(compatibility?.modelAliases, manifest.models, "model");
  validateAliasMap(compatibility?.backendAliases, manifest.backends, "backend");
  for (const [location, target] of Object.entries(compatibility?.remoteLocations ?? {})) {
    if (!location.startsWith("remote:") || location.length === "remote:".length) {
      throw new Error(`model registry remote location "${location}" must use remote:<target>`);
    }
    if (!Object.hasOwn(manifest.models, target)) {
      throw new Error(`model registry remote location "${location}" targets unknown canonical model registration "${target}"`);
    }
  }
  if (compatibility?.hostModelsDeployment !== undefined) {
    if (!Object.hasOwn(manifest.backends, compatibility.hostModelsDeployment)) {
      throw new Error(`model registry hostModelsDeployment "${compatibility.hostModelsDeployment}" is not registered`);
    }
    const deployment = manifest.backends[compatibility.hostModelsDeployment]!;
    if (deployment.module !== PI_MODULE) {
      throw new Error(`model registry hostModelsDeployment "${compatibility.hostModelsDeployment}" must use module "${PI_MODULE}"`);
    }
  }
}

export function deriveModelRuntimeDescriptor(
  deploymentId: string,
  registration: BackendRegistration,
): ModelRuntimeDescriptor {
  const config = registration.config ?? {};
  switch (registration.module) {
    case PI_MODULE:
      return freezeDescriptor("pi", { kind: "local-process", protocol: "pi-rpc" }, "native");
    case DSH_MODULE: {
      const mode = config.mode ?? "local";
      if (mode !== "local" && mode !== "ssh") {
        return freezeDescriptor(
          "dsh",
          { kind: "local-process", protocol: "json-rpc-stdio" },
          "native",
          `deployment "${deploymentId}" has invalid DSH mode "${String(mode)}"`,
        );
      }
      return freezeDescriptor(
        "dsh",
        mode === "ssh"
          ? { kind: "dsh-direct-ssh", protocol: "json-rpc-stdio" }
          : { kind: "local-process", protocol: "json-rpc-stdio" },
        "native",
      );
    }
    case ACP_MODULE: {
      const mode = config.mode ?? "local";
      if (mode !== "local" && mode !== "ssh") {
        return freezeDescriptor(
          "acp",
          { kind: "local-process", protocol: "acp" },
          "native",
          `deployment "${deploymentId}" has invalid ACP mode "${String(mode)}"`,
        );
      }
      return freezeDescriptor(
        "acp",
        mode === "ssh" ? { kind: "acp-direct-ssh", protocol: "acp" } : { kind: "local-process", protocol: "acp" },
        "native",
      );
    }
    case REMOTE_MODULE: {
      const driver = config.driver === "acp" ? "acp" : "pi-rpc";
      const invalid = config.driver !== "pi-rpc" && config.driver !== "acp"
        ? `deployment "${deploymentId}" must configure remote driver "pi-rpc" or "acp"`
        : typeof config.targetId !== "string" || config.targetId.length === 0
          ? `deployment "${deploymentId}" must configure a non-empty remote targetId`
          : undefined;
      return freezeDescriptor(
        driver === "acp" ? "acp" : "pi",
        { kind: "remote-worker", gateway: "ssh", protocol: "remote/2", driver },
        "unsupported",
        invalid,
      );
    }
    default:
      return freezeDescriptor(
        "adapter-owned",
        { kind: "adapter-owned" },
        "unknown",
        `deployment "${deploymentId}" requires backend module resolution before it is dispatchable`,
      );
  }
}

function freezeDescriptor(
  harness: ModelRegistryHarness,
  transport: ModelRegistryTransport,
  modelSelection: ModelSelectionSupport,
  unavailableReason?: string,
): ModelRuntimeDescriptor {
  return Object.freeze({
    harness,
    transport: Object.freeze({ ...transport }) as ModelRegistryTransport,
    modelSelection,
    resolvable: unavailableReason === undefined,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  });
}

interface CompiledRouteSeed extends ModelRegistrationV2 {
  modelRegistrationId: string;
}

function validatePreviousIdentity(value: unknown): ProjectionIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model registry previousIdentity must be an object");
  }
  const identity = value as Record<string, unknown>;
  if (!Number.isSafeInteger(identity.revision) || (identity.revision as number) < 0) {
    throw new Error("model registry previousIdentity revision must be a safe non-negative integer");
  }
  if (typeof identity.hash !== "string" || !CANONICAL_REGISTRY_HASH.test(identity.hash)) {
    throw new Error("model registry previousIdentity hash must be a lowercase 64-character SHA-256 hexadecimal string");
  }
  return { revision: identity.revision as number, hash: identity.hash };
}

export function compileModelRegistryManifest(
  manifest: ModelRegistryManifestV2,
  inputs: ModelRegistryCompileInputs = {},
): CompiledModelRegistryPair {
  const previous = validatePreviousIdentity(inputs.previousIdentity);
  validateManifestGraph(manifest);
  const descriptors = new Map(Object.entries(manifest.backends).map(([id, registration]) => [
    id,
    deriveModelRuntimeDescriptor(id, registration),
  ]));
  validateSelectorTopology(manifest, descriptors);

  const routes = new Map<string, CompiledRouteSeed>();
  for (const [modelRegistrationId, registration] of Object.entries(manifest.models)) {
    routes.set(modelRegistrationId, cloneRouteSeed(modelRegistrationId, registration));
  }
  const diagnostics: string[] = [...(inputs.diagnostics ?? [])];
  projectHostModels(manifest, routes, inputs.hostModels ?? [], diagnostics);
  projectCliTools(manifest, routes, inputs.cliToolsConfig ?? null, diagnostics);
  validateCompiledRoutes(routes);

  const semantic = {
    manifest,
    hostModels: hostModelSignature(manifest, inputs.hostModels ?? []),
    cliTools: cliToolsSignature(manifest, inputs.cliToolsConfig ?? null),
    diagnostics: [...(inputs.diagnostics ?? [])],
  };
  const hash = createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
  const revision = previous === undefined
    ? 1
    : previous.hash === hash
      ? previous.revision
      : previous.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("model registry revision cannot advance beyond the maximum safe integer");
  }
  const identity = { revision, hash };

  const discoveryEntries = [...routes.values()]
    .sort((left, right) => left.modelRegistrationId.localeCompare(right.modelRegistrationId))
    .map((route) => freezeDiscoveryRoute(route, descriptors.get(route.deployment)!));
  const dispatchRoutes = [...routes.values()]
    .sort((left, right) => left.modelRegistrationId.localeCompare(right.modelRegistrationId))
    .map((route) => [route.modelRegistrationId, freezeDispatchRoute(route)] as const);
  const deployments = Object.entries(manifest.backends)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([deploymentId, registration]) => [
      deploymentId,
      deepFreeze({
        deploymentId,
        registration: cloneBackendRegistration(registration),
        runtime: cloneRuntimeDescriptor(descriptors.get(deploymentId)!),
      }),
    ] as const);
  const compatibility = manifest.compatibility;

  const discovery = Object.freeze({
    ...identity,
    defaultModel: manifest.defaultModel,
    entries: Object.freeze(discoveryEntries),
    diagnostics: Object.freeze([...diagnostics]),
  });
  const dispatch = Object.freeze({
    ...identity,
    registryVersion: manifest.version,
    defaultDeployment: manifest.default,
    defaultModel: manifest.defaultModel,
    routesByRegistrationId: new ImmutableMap(dispatchRoutes),
    deploymentsById: new ImmutableMap(deployments),
    modelAliases: immutableStringMap(compatibility?.modelAliases),
    backendAliases: immutableStringMap(compatibility?.backendAliases),
    remoteLocations: immutableStringMap(compatibility?.remoteLocations),
    diagnostics: Object.freeze([...diagnostics]),
  });
  if (discovery.hash !== dispatch.hash || discovery.revision !== dispatch.revision) {
    throw new Error("model registry compiler produced mismatched projection identities");
  }
  return Object.freeze({ discovery, dispatch });
}

function validateSelectorTopology(
  manifest: ModelRegistryManifestV2,
  descriptors: ReadonlyMap<string, ModelRuntimeDescriptor>,
): void {
  for (const [registrationId, registration] of Object.entries(manifest.models)) {
    const descriptor = descriptors.get(registration.deployment)!;
    if (registration.selector.kind === "adapter-model" && descriptor.modelSelection === "unsupported") {
      throw new Error(`model registration "${registrationId}" uses adapter-model with deployment "${registration.deployment}", whose backend modelSelection is unsupported`);
    }
    if (registration.selector.kind === "fixed" && descriptor.modelSelection !== "unsupported") {
      const qualification = descriptor.modelSelection === "unknown" ? "cannot be verified until its backend resolves" : "reports native modelSelection";
      throw new Error(`model registration "${registrationId}" uses fixed selector with deployment "${registration.deployment}", which ${qualification}`);
    }
  }
}

function cloneRouteSeed(modelRegistrationId: string, route: ModelRegistrationV2): CompiledRouteSeed {
  return {
    modelRegistrationId,
    modelId: route.modelId,
    deployment: route.deployment,
    selector: { ...route.selector },
    ...(route.deploymentDefault === undefined ? {} : { deploymentDefault: route.deploymentDefault }),
    ...(route.displayName === undefined ? {} : { displayName: route.displayName }),
    ...(route.capabilities === undefined ? {} : { capabilities: cloneCapabilities(route.capabilities) }),
  };
}

function validateCompiledRoutes(routes: ReadonlyMap<string, CompiledRouteSeed>): void {
  const selectors = new Map<string, string>();
  const capabilities = new Map<string, { key: string; registrationId: string }>();
  for (const route of routes.values()) {
    const effective = `${route.deployment}\u0000${selectorKey(route.selector)}`;
    const duplicate = selectors.get(effective);
    if (duplicate !== undefined) {
      throw new Error(`model registrations "${duplicate}" and "${route.modelRegistrationId}" duplicate the same deployment selector; use a modelAlias`);
    }
    selectors.set(effective, route.modelRegistrationId);

    const key = capabilitiesKey(route.capabilities);
    const previous = capabilities.get(route.modelId);
    if (previous !== undefined && previous.key !== key) {
      throw new Error(`model registrations "${previous.registrationId}" and "${route.modelRegistrationId}" declare conflicting intrinsic capabilities for modelId "${route.modelId}"`);
    }
    capabilities.set(route.modelId, { key, registrationId: route.modelRegistrationId });
  }
}

function projectHostModels(
  manifest: ModelRegistryManifestV2,
  routes: Map<string, CompiledRouteSeed>,
  hostModels: readonly AvailableModelEntry[],
  diagnostics: string[],
): void {
  const deployment = manifest.compatibility?.hostModelsDeployment;
  if (deployment === undefined) return;
  for (const model of normalizedHostModels(hostModels)) {
    const modelRegistrationId = `${model.provider}/${model.id}`;
    if (routes.has(modelRegistrationId)) continue;
    const selector = { kind: "adapter-model", value: modelRegistrationId } as const;
    const duplicate = [...routes.values()].find((route) =>
      route.deployment === deployment && selectorKey(route.selector) === selectorKey(selector));
    if (duplicate !== undefined) {
      throw new Error(`host model "${modelRegistrationId}" duplicates deployment selector owned by model registration "${duplicate.modelRegistrationId}"; add an explicit modelAlias`);
    }
    routes.set(modelRegistrationId, {
      modelRegistrationId,
      modelId: modelRegistrationId,
      deployment,
      selector,
      ...(model.name === undefined ? {} : { displayName: model.name }),
      capabilities: {
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(supportedThinkingLevels(model) === undefined ? {} : { thinkingLevels: supportedThinkingLevels(model) }),
        ...(model.input === undefined ? {} : { input: [...model.input] }),
      },
    });
  }
  if (hostModels.some((model) => !model.provider.trim() || !model.id.trim())) {
    diagnostics.push("authenticated host model projection omitted entries with an empty provider or model id");
  }
}

function projectCliTools(
  manifest: ModelRegistryManifestV2,
  routes: Map<string, CompiledRouteSeed>,
  config: CliToolsConfig | null,
  diagnostics: string[],
): void {
  if (manifest.compatibility?.teammateCliToolsProjection?.enabled !== true || config === null) return;
  const acpDeployments = Object.entries(manifest.backends).filter(([, registration]) => registration.module === ACP_MODULE);
  for (const [rawName, tool] of Object.entries(config.tools).sort(([left], [right]) => left.localeCompare(right))) {
    if (!tool.enabled) continue;
    const name = rawName.trim();
    if (!name || UNSAFE_TEXT.test(name)) {
      diagnostics.push(`teammate CLI tools projection omitted invalid enabled tool name "${rawName}"`);
      continue;
    }
    const registrationId = `cli/${name}`;
    if (routes.has(registrationId)) continue;
    const matches = acpDeployments.filter(([deploymentId, registration]) => {
      const configured = registration.config?.modelId;
      const route = typeof configured === "string" && configured.trim() ? configured.trim() : `cli/${deploymentId}`;
      return route === registrationId;
    });
    if (matches.length !== 1) {
      diagnostics.push(
        matches.length === 0
          ? `CLI compatibility model "${registrationId}" is unavailable: no ACP deployment owns that route`
          : `CLI compatibility model "${registrationId}" is unavailable: multiple ACP deployments own that route (${matches.map(([id]) => id).join(", ")})`,
      );
      continue;
    }
    const deployment = matches[0]![0];
    const duplicateDefault = [...routes.values()].find((route) =>
      route.deployment === deployment && route.selector.kind === "deployment-default");
    if (duplicateDefault !== undefined) {
      diagnostics.push(`CLI compatibility model "${registrationId}" is unavailable: deployment default is already owned by "${duplicateDefault.modelRegistrationId}"`);
      continue;
    }
    routes.set(registrationId, {
      modelRegistrationId: registrationId,
      modelId: registrationId,
      deployment,
      selector: { kind: "deployment-default" },
      displayName: name,
      capabilities: { reasoning: false, thinkingLevels: ["off"], input: ["text"] },
    });
  }
}

function normalizedHostModels(models: readonly AvailableModelEntry[]): AvailableModelEntry[] {
  const unique = new Map<string, AvailableModelEntry>();
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;
    const key = `${provider}/${id}`;
    if (!unique.has(key)) unique.set(key, { ...model, provider, id });
  }
  return [...unique.values()].sort((left, right) =>
    `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
}

function hostModelSignature(
  manifest: ModelRegistryManifestV2,
  models: readonly AvailableModelEntry[],
): unknown {
  if (manifest.compatibility?.hostModelsDeployment === undefined) return null;
  return normalizedHostModels(models).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name ?? null,
    reasoning: model.reasoning ?? null,
    thinkingLevels: supportedThinkingLevels(model) ?? null,
    input: model.input === undefined ? null : [...model.input],
  }));
}

function cliToolsSignature(manifest: ModelRegistryManifestV2, config: CliToolsConfig | null): unknown {
  if (manifest.compatibility?.teammateCliToolsProjection?.enabled !== true) return null;
  return Object.entries(config?.tools ?? {})
    .filter(([, tool]) => tool.enabled)
    .map(([name]) => name.trim())
    .sort();
}

function freezeDiscoveryRoute(
  route: CompiledRouteSeed,
  runtime: ModelRuntimeDescriptor,
): InternalModelCatalogRoute {
  return deepFreeze({
    modelRegistrationId: route.modelRegistrationId,
    modelId: route.modelId,
    deploymentId: route.deployment,
    ...(route.displayName === undefined ? {} : { displayName: route.displayName }),
    ...(route.capabilities === undefined ? {} : { capabilities: cloneCapabilities(route.capabilities) }),
    deploymentDefault: route.deploymentDefault === true,
    runtime: cloneRuntimeDescriptor(runtime),
  });
}

function freezeDispatchRoute(route: CompiledRouteSeed): ModelDispatchRoute {
  return deepFreeze({
    modelRegistrationId: route.modelRegistrationId,
    modelId: route.modelId,
    deploymentId: route.deployment,
    selector: { ...route.selector },
    deploymentDefault: route.deploymentDefault === true,
    ...(route.displayName === undefined ? {} : { displayName: route.displayName }),
    ...(route.capabilities === undefined ? {} : { capabilities: cloneCapabilities(route.capabilities) }),
  });
}

function cloneCapabilities(capabilities: ModelRegistrationCapabilitiesV2): ModelRegistrationCapabilitiesV2 {
  return {
    ...(capabilities.reasoning === undefined ? {} : { reasoning: capabilities.reasoning }),
    ...(capabilities.thinkingLevels === undefined ? {} : { thinkingLevels: [...capabilities.thinkingLevels] }),
    ...(capabilities.input === undefined ? {} : { input: [...capabilities.input] }),
  };
}

function cloneRuntimeDescriptor(descriptor: ModelRuntimeDescriptor): ModelRuntimeDescriptor {
  return {
    harness: descriptor.harness,
    transport: { ...descriptor.transport } as ModelRegistryTransport,
    modelSelection: descriptor.modelSelection,
    resolvable: descriptor.resolvable,
    ...(descriptor.unavailableReason === undefined ? {} : { unavailableReason: descriptor.unavailableReason }),
  };
}

function cloneBackendRegistration(registration: BackendRegistration): BackendRegistration {
  return {
    module: registration.module,
    ...(registration.config === undefined
      ? {}
      : { config: Object.fromEntries(Object.entries(registration.config).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ])) }),
  };
}

function immutableStringMap(value: Record<string, string> | undefined): ReadonlyMap<string, string> {
  return new ImmutableMap(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

export function isModelRegistryMode(mode: TeammateExecutionMode | undefined): mode is "model-registry" {
  return mode === "model-registry";
}
