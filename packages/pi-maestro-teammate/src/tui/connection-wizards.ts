import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BackendConfigField,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import {
  candidateConflicts,
  isValidId,
  selectorSummary,
} from "../models/cli-add.ts";
import {
  applyConfigEdits,
  resolveConfigFieldsForModule,
} from "../models/cli-edit.ts";
import type { ModelCliRow } from "../models/cli-list.ts";
import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
  type ModelRegistrationV2,
  type ModelRegistryManifestV2,
  type ModelSelectorV2,
} from "../models/model-registry.ts";
import { publishModelRegistryDocument } from "../models/cli-write.ts";
import {
  replaceRemoteConfigStores,
  validateHostId,
  validateRemoteHostDraft,
  validateRemoteTargetDraft,
  validateRemoteWorkspaceDraft,
  validateTargetId,
  validateWorkspaceRef,
  type RemoteConfigState,
  type RemoteConfigStorePair,
} from "../remote/config.ts";
import {
  REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
  type RemoteHostConfig,
  type RemoteTargetConfig,
  type RemoteWorkspaceConfig,
} from "../remote/types.ts";
import type { RemotePaneScope } from "./remote-config-pane.ts";
import {
  createTuiTranslator,
  type TuiTranslationKey,
} from "./locale.ts";
import {
  promptConfigFields,
  promptNumberedErrorRetry,
  type ConnectionFormUi,
} from "./connection-forms.ts";

/** Prompt adapter used by connection wizards and scripted tests. */
export interface WizardUi extends ConnectionFormUi {
  select(prompt: string, options: readonly string[]): Promise<string | undefined>;
  /** Optional status channel for redacted publisher diagnostics. */
  write?(text: string): void;
}

function wizardText(
  ui: WizardUi,
  key: TuiTranslationKey,
  params?: Record<string, string | number>,
): string {
  return (ui.t ?? createTuiTranslator("en"))(key, params);
}

export type ConnectionWizardOutcome =
  | { ok: boolean; message?: string; reloadCatalog?: boolean }
  | { cancelled: true };

export interface DeploymentWizardDeps {
  /** Full document bytes collected before opening the wizard. */
  manifestRaw?: string;
  /** Destination path and parser diagnostic identity. */
  filePath: string;
  /** Pre-confirms only the external-change last-writer-wins prompt. */
  yes?: boolean;
  /** Dynamic module-loading seam, reached only after a module is selected. */
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface DeploymentEditWizardDeps extends DeploymentWizardDeps {
  /** Rows already produced by buildModelList; the wizard does not rebuild them. */
  rows: readonly ModelCliRow[];
}

interface CandidateResult {
  raw: string;
  errors: string[];
}

function cancelled(): { cancelled: true } {
  return { cancelled: true };
}

function asDocument(raw: string, filePath: string): Record<string, unknown> {
  parseModelRegistryManifest(raw, filePath);
  return JSON.parse(raw) as Record<string, unknown>;
}

function candidateRaw(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function compileErrors(raw: string, filePath: string): string[] {
  try {
    const manifest = parseModelRegistryManifest(raw, filePath);
    compileModelRegistryManifest(manifest);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function publisherUi(ui: WizardUi): {
  write(text: string): void;
  confirm(prompt: string): Promise<boolean>;
} {
  return {
    // publishModelRegistryDocument owns redaction; adapters that render status
    // can surface its external-change and last-writer-wins notices verbatim.
    write: (text) => ui.write?.(text),
    confirm: (prompt) => ui.confirm(prompt),
  };
}

async function publishCandidate(
  ui: WizardUi,
  deps: DeploymentWizardDeps,
  raw: string,
): Promise<ConnectionWizardOutcome> {
  const result = await publishModelRegistryDocument({
    file: deps.filePath,
    candidateRaw: raw,
    baselineRaw: deps.manifestRaw,
    yes: deps.yes === true,
    translate: ui.t ?? createTuiTranslator("en"),
    io: publisherUi(ui),
  });
  if (result.kind === "declined-external-change") {
    return { ok: false, message: wizardText(ui, "connections.externalChangeDeclined"), reloadCatalog: false };
  }
  return {
    ok: true,
    message: result.backupPath === undefined
      ? wizardText(ui, "connections.wroteFile", { path: deps.filePath })
      : wizardText(ui, "connections.wroteFileBackup", {
          path: deps.filePath,
          backupPath: result.backupPath,
        }),
    reloadCatalog: true,
  };
}

function effectiveEditFields(
  fields: readonly BackendConfigField[],
  current: Readonly<Record<string, ConfigValue>>,
): BackendConfigField[] {
  return fields.map((field) => ({
    ...field,
    ...(current[field.key] === undefined ? {} : { default: current[field.key] }),
  }));
}

async function buildEditCandidate(
  ui: WizardUi,
  document: Record<string, unknown>,
  deploymentId: string,
  fields: readonly BackendConfigField[],
  filePath: string,
): Promise<CandidateResult | { cancelled: true } | { noChanges: true }> {
  const backends = document.backends as Record<string, Record<string, unknown>>;
  const registration = backends[deploymentId]!;
  const current = (registration.config ?? {}) as Record<string, ConfigValue>;
  const form = await promptConfigFields(ui, effectiveEditFields(fields, current), current);
  if (!form.ok) return cancelled();

  const edits = new Map<string, ConfigValue>();
  for (const field of fields) {
    const value = form.values[field.key];
    const effectiveCurrent = current[field.key] ?? field.default;
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(effectiveCurrent)) {
      edits.set(field.key, value);
    }
  }
  if (edits.size === 0) return { noChanges: true };
  // Mirror the add flow's ssh-required rule against the candidate config: an
  // ssh launch cannot compose without a host or user, so the edit must not
  // publish a manifest the backend would only reject at dispatch.
  const candidate = { ...current };
  for (const [key, value] of edits) candidate[key] = value;
  const missing = candidate.mode === "ssh"
    ? ["host", "user"].filter((key) =>
      candidate[key] === undefined || String(candidate[key]).trim().length === 0)
    : [];
  const next = applyConfigEdits(document, deploymentId, edits);
  const errors = [
    ...missing.map((key) => wizardText(ui, "remote.validationFailed", {
      error: `${key} is required when mode is "ssh"`,
    })),
    ...compileErrors(candidateRaw(next), filePath),
  ];
  return { raw: candidateRaw(next), errors };
}

/** Edit one deployment selected through its supplied model-list registration row. */
export async function wizardDeploymentEdit(
  ui: WizardUi,
  deps: DeploymentEditWizardDeps,
): Promise<ConnectionWizardOutcome> {
  if (deps.manifestRaw === undefined) {
    return { ok: false, message: wizardText(ui, "connections.deploymentManifestRequired"), reloadCatalog: false };
  }
  const document = asDocument(deps.manifestRaw, deps.filePath);
  const registrationId = await ui.select(
    wizardText(ui, "connections.modelRegistration"),
    deps.rows.map((row) => row.registrationId),
  );
  if (registrationId === undefined) return cancelled();
  const row = deps.rows.find((candidate) => candidate.registrationId === registrationId);
  if (row === undefined) return { ok: false, message: wizardText(ui, "connections.unknownRegistration"), reloadCatalog: false };

  const manifest = parseModelRegistryManifest(deps.manifestRaw, deps.filePath);
  const deployment = manifest.backends[row.deploymentId];
  if (deployment === undefined) {
    return {
      ok: false,
      message: wizardText(ui, "connections.unknownDeployment", { id: row.deploymentId }),
      reloadCatalog: false,
    };
  }
  // Non-builtin modules are loaded only after the operator has committed to a
  // registration, matching the CLI edit boundary.
  const fields = await resolveConfigFieldsForModule(deployment.module, deps.importModule);
  let built = await buildEditCandidate(ui, document, row.deploymentId, fields, deps.filePath);
  if ("cancelled" in built) return built;
  if ("noChanges" in built) return { ok: true, message: wizardText(ui, "connections.noChanges"), reloadCatalog: false };

  if (built.errors.length > 0) {
    let accepted: CandidateResult | undefined;
    const proceeded = await promptNumberedErrorRetry(ui, built.errors, async () => {
      const retried = await buildEditCandidate(ui, document, row.deploymentId, fields, deps.filePath);
      if ("cancelled" in retried || "noChanges" in retried) return { success: true };
      if (retried.errors.length > 0) return { success: false, errors: retried.errors };
      accepted = retried;
      return { success: true };
    });
    if (!proceeded || accepted === undefined) return cancelled();
    built = accepted;
  }
  return publishCandidate(ui, deps, built.raw);
}

const FAMILY_MODULES = {
  pi: "pi-subprocess",
  dsh: "pi-maestro-backends/dsh",
  acp: "pi-maestro-teammate/v1/acp-cli",
} as const;

type DeploymentFamily = keyof typeof FAMILY_MODULES | "third-party";

async function promptId(
  ui: WizardUi,
  prompt: string,
  taken: ReadonlySet<string>,
): Promise<string | undefined> {
  while (true) {
    const answer = await ui.input(prompt);
    if (answer === undefined) return undefined;
    const value = answer.trim();
    if (isValidId(value) && !taken.has(value)) return value;
  }
}

async function promptOneConfigField(
  ui: WizardUi,
  field: BackendConfigField,
  current: Readonly<Record<string, ConfigValue>>,
  required: boolean,
): Promise<{ cancelled: true } | { value?: ConfigValue }> {
  const effective = current[field.key] === undefined
    ? field
    : { ...field, default: current[field.key] };
  while (true) {
    const result = await promptConfigFields(ui, [effective], current);
    if (!result.ok) return cancelled();
    const value = result.values[field.key];
    if (!required || value !== undefined) return value === undefined ? {} : { value };
  }
}

async function promptAddConfig(
  ui: WizardUi,
  fields: readonly BackendConfigField[],
  seed: Readonly<Record<string, ConfigValue>>,
): Promise<{ cancelled: true } | { config: Record<string, ConfigValue> }> {
  const config: Record<string, ConfigValue> = { ...seed };
  for (const field of fields) {
    const required = field.required === true
      || (config.mode === "ssh" && (field.key === "host" || field.key === "user"));
    const answer = await promptOneConfigField(ui, field, config, required);
    if ("cancelled" in answer) return answer;
    if (answer.value !== undefined) config[field.key] = answer.value;
  }
  return { config };
}

interface RegistrationAnswer {
  id: string;
  registration: ModelRegistrationV2;
}

async function promptRegistration(
  ui: WizardUi,
  context: {
    newDeploymentId: string;
    existingDeploymentIds: readonly string[];
    takenRegistrationIds: ReadonlySet<string>;
    forcedDefault: boolean;
  },
): Promise<RegistrationAnswer | { cancelled: true }> {
  let deploymentId = context.newDeploymentId;
  if (!context.forcedDefault) {
    const selected = await ui.select(
      wizardText(ui, "connections.registrationDeployment"),
      [context.newDeploymentId, ...context.existingDeploymentIds],
    );
    if (selected === undefined) return cancelled();
    if (selected !== context.newDeploymentId && !context.existingDeploymentIds.includes(selected)) {
      return cancelled();
    }
    deploymentId = selected;
  }

  const id = await promptId(ui, wizardText(ui, "connections.modelRegistrationId"), context.takenRegistrationIds);
  if (id === undefined) return cancelled();
  let modelId: string | undefined;
  while (modelId === undefined) {
    const answer = await ui.input(wizardText(ui, "connections.intrinsicModelId"));
    if (answer === undefined) return cancelled();
    if (answer.trim().length > 0) modelId = answer.trim();
  }

  const selectorKind = await ui.select(wizardText(ui, "connections.selector"), ["adapter-model", "deployment-default", "fixed"]);
  if (selectorKind === undefined) return cancelled();
  let selector: ModelSelectorV2;
  if (selectorKind === "adapter-model") {
    let value: string | undefined;
    while (value === undefined) {
      const answer = await ui.input(wizardText(ui, "connections.adapterModelSelector"));
      if (answer === undefined) return cancelled();
      if (isValidId(answer.trim())) value = answer.trim();
    }
    selector = { kind: "adapter-model", value };
  } else if (selectorKind === "deployment-default") {
    selector = { kind: "deployment-default" };
  } else if (selectorKind === "fixed") {
    selector = { kind: "fixed" };
  } else {
    return cancelled();
  }

  const deploymentDefault = context.forcedDefault
    ? true
    : await ui.confirm(wizardText(ui, "connections.deploymentDefaultConfirm"));
  return {
    id,
    registration: {
      modelId,
      deployment: deploymentId,
      selector,
      ...(deploymentDefault ? { deploymentDefault: true } : {}),
    },
  };
}

function addCandidate(
  base: Record<string, unknown>,
  filePath: string,
  deploymentId: string,
  moduleId: string,
  config: Readonly<Record<string, ConfigValue>>,
  answer: RegistrationAnswer,
): CandidateResult {
  const existingBackends = base.backends as ModelRegistryManifestV2["backends"];
  const existingModels = base.models as ModelRegistryManifestV2["models"];
  const firstBackend = Object.keys(existingBackends).length === 0;
  const firstRegistration = Object.keys(existingModels).length === 0;
  const backends: ModelRegistryManifestV2["backends"] = {
    ...existingBackends,
    [deploymentId]: Object.keys(config).length === 0
      ? { module: moduleId }
      : { module: moduleId, config: { ...config } },
  };
  const models: ModelRegistryManifestV2["models"] = {
    ...existingModels,
    [answer.id]: answer.registration,
  };
  const document: Record<string, unknown> = {
    ...base,
    default: firstBackend ? deploymentId : base.default,
    defaultModel: firstRegistration ? answer.id : base.defaultModel,
    backends,
    models,
  };
  const raw = candidateRaw(document);
  const errors = candidateConflicts(models, backends, answer.id);
  for (const error of compileErrors(raw, filePath)) {
    if (!errors.includes(error)) errors.push(error);
  }
  return { raw, errors };
}

/** Add a deployment and its first model registration to a v2 manifest. */
export async function wizardDeploymentAdd(
  ui: WizardUi,
  deps: DeploymentWizardDeps,
): Promise<ConnectionWizardOutcome> {
  const base: Record<string, unknown> = deps.manifestRaw === undefined
    ? { version: 2, mode: "model-registry", default: "", defaultModel: "", backends: {}, models: {} }
    : asDocument(deps.manifestRaw, deps.filePath);

  const selectedFamily = await ui.select(wizardText(ui, "connections.backendFamily"), ["pi", "dsh", "acp", "third-party"]);
  if (selectedFamily === undefined) return cancelled();
  if (!["pi", "dsh", "acp", "third-party"].includes(selectedFamily)) return cancelled();
  const family = selectedFamily as DeploymentFamily;
  let moduleId: string;
  if (family === "third-party") {
    const entered = await promptId(ui, wizardText(ui, "connections.backendModuleId"), new Set());
    if (entered === undefined) return cancelled();
    moduleId = entered;
  } else {
    moduleId = FAMILY_MODULES[family];
  }

  const seededConfig: Record<string, ConfigValue> = {};
  if (family === "dsh" || family === "acp") {
    const transport = await ui.select(wizardText(ui, "connections.transport"), ["local", "ssh"]);
    if (transport === undefined) return cancelled();
    if (transport !== "local" && transport !== "ssh") return cancelled();
    seededConfig.mode = transport;
  }

  const existingBackends = base.backends as Record<string, unknown>;
  const deploymentId = await promptId(ui, wizardText(ui, "connections.deploymentId"), new Set(Object.keys(existingBackends)));
  if (deploymentId === undefined) return cancelled();
  // Third-party resolution occurs only after its module id and deployment have
  // been selected; builtins still resolve from static field constants.
  const fields = await resolveConfigFieldsForModule(moduleId, deps.importModule);
  const configured = await promptAddConfig(ui, fields, seededConfig);
  if ("cancelled" in configured) return configured;

  const existingModels = base.models as Record<string, ModelRegistrationV2>;
  const registrationContext = {
    newDeploymentId: deploymentId,
    existingDeploymentIds: Object.keys(existingBackends),
    takenRegistrationIds: new Set(Object.keys(existingModels)),
    forcedDefault: Object.keys(existingModels).length === 0,
  };
  let answer = await promptRegistration(ui, registrationContext);
  if ("cancelled" in answer) return answer;
  let built = addCandidate(base, deps.filePath, deploymentId, moduleId, configured.config, answer);

  if (built.errors.length > 0) {
    let accepted: { answer: RegistrationAnswer; candidate: CandidateResult } | undefined;
    const proceeded = await promptNumberedErrorRetry(ui, built.errors, async () => {
      const retried = await promptRegistration(ui, registrationContext);
      if ("cancelled" in retried) return { success: true };
      const candidate = addCandidate(base, deps.filePath, deploymentId, moduleId, configured.config, retried);
      if (candidate.errors.length > 0) return { success: false, errors: candidate.errors };
      accepted = { answer: retried, candidate };
      return { success: true };
    });
    if (!proceeded || accepted === undefined) return cancelled();
    answer = accepted.answer;
    built = accepted.candidate;
  }

  const result = await publishCandidate(ui, deps, built.raw);
  if ("ok" in result && result.ok) {
    result.message = wizardText(ui, "connections.savedRegistration", {
      message: result.message ?? wizardText(ui, "connections.saved"),
      id: answer.id,
      selector: selectorSummary(answer.registration.selector),
    });
  }
  return result;
}

export interface RemotePaneOutcome {
  ok: boolean;
  message: string;
  reloadRemote: boolean;
}

export type RemoteStorePersistence = (
  cwd: string,
  expected: RemoteConfigStorePair,
  next: RemoteConfigStorePair,
  globalFilePath?: string,
) => void | Promise<void>;

interface RemoteWizardDeps {
  state: RemoteConfigState;
  scope: RemotePaneScope;
  cwd?: string;
  globalFilePath?: string;
  persist?: RemoteStorePersistence;
}

export interface RemoteHostWizardDeps extends RemoteWizardDeps {
  id?: string;
  current?: RemoteHostConfig;
}

export interface RemoteTargetWizardDeps extends RemoteWizardDeps {
  id?: string;
  current?: RemoteTargetConfig;
}

export interface RemoteWorkspaceWizardDeps extends RemoteWizardDeps {
  workspaceRef?: string;
  current?: RemoteWorkspaceConfig;
}

function cloneStores(state: RemoteConfigState): RemoteConfigStorePair {
  return {
    global: {
      ...state.global,
      hosts: { ...state.global.hosts },
      targets: { ...state.global.targets },
      workspaces: { ...state.global.workspaces },
    },
    project: {
      ...state.project,
      hosts: { ...state.project.hosts },
      targets: { ...state.project.targets },
      workspaces: { ...state.project.workspaces },
    },
  };
}

async function persistRemote(
  ui: WizardUi,
  deps: RemoteWizardDeps,
  next: RemoteConfigStorePair,
): Promise<void> {
  const expected = cloneStores(deps.state);
  if (deps.persist !== undefined) {
    await deps.persist(deps.cwd ?? "", expected, next, deps.globalFilePath);
    return;
  }
  if (deps.cwd === undefined) throw new Error(wizardText(ui, "connections.remotePersistenceCwdRequired"));
  replaceRemoteConfigStores(deps.cwd, expected, next, deps.globalFilePath);
}

function remoteCancelled(): RemotePaneOutcome {
  return { ok: true, message: "", reloadRemote: false };
}

async function promptRemoteId(
  ui: WizardUi,
  label: string,
  current: string | undefined,
  validate: (id: string) => void,
): Promise<string | undefined> {
  if (current !== undefined) return current;
  while (true) {
    const answer = await ui.input(label, "");
    if (answer === undefined) return undefined;
    const id = answer.trim();
    try {
      validate(id);
      return id;
    } catch {
      // Keep the failed field active; the validation helpers remain the final
      // authority once the complete draft is assembled.
    }
  }
}

async function promptRemoteValue(
  ui: WizardUi,
  field: BackendConfigField,
  current: ConfigValue | undefined,
  valid: (value: ConfigValue | undefined) => boolean,
  preserveOnEmpty = true,
): Promise<{ cancelled: true } | { value: ConfigValue | undefined }> {
  const effective = current === undefined || !preserveOnEmpty ? field : { ...field, default: current };
  while (true) {
    const form = await promptConfigFields(
      ui,
      [effective],
      current === undefined ? {} : { [field.key]: current },
    );
    if (!form.ok) return cancelled();
    const value = form.values[field.key];
    if (valid(value)) return { value };
  }
}

const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;

/** Create or edit a remote host while preserving the remote-store CAS path. */
export async function wizardRemoteHost(
  ui: WizardUi,
  deps: RemoteHostWizardDeps,
): Promise<RemotePaneOutcome> {
  const id = await promptRemoteId(ui, wizardText(ui, "remote.hostId"), deps.id, validateHostId);
  if (id === undefined) return remoteCancelled();

  const host = await promptRemoteValue(
    ui,
    { key: "host", kind: "text", labelKey: "remote.hostAddress", required: true },
    deps.current?.host,
    (value) => typeof value === "string" && value.length <= 253 && !/\s/.test(value),
  );
  if ("cancelled" in host) return remoteCancelled();
  const user = await promptRemoteValue(
    ui,
    { key: "user", kind: "text", labelKey: "remote.hostUser", required: true },
    deps.current?.user,
    (value) => typeof value === "string" && value.length <= 128 && !/\s/.test(value),
  );
  if ("cancelled" in user) return remoteCancelled();
  const port = await promptRemoteValue(
    ui,
    { key: "port", kind: "integer", labelKey: "remote.hostPort", default: 22, required: true },
    deps.current?.port ?? 22,
    (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535,
  );
  if ("cancelled" in port) return remoteCancelled();
  const hostKey = await promptRemoteValue(
    ui,
    { key: "hostKeySha256", kind: "text", labelKey: "remote.hostKey", required: true },
    deps.current?.hostKeySha256,
    (value) => typeof value === "string" && HOST_KEY_PATTERN.test(value),
  );
  if ("cancelled" in hostKey) return remoteCancelled();
  const identity = await promptRemoteValue(
    ui,
    { key: "identityFile", kind: "path", labelKey: "remote.identityFile" },
    deps.current?.identityFile,
    (value) => value === undefined || (typeof value === "string" && value.length <= 4096),
    false,
  );
  if ("cancelled" in identity) return remoteCancelled();

  const draft: RemoteHostConfig = {
    host: host.value as string,
    user: user.value as string,
    port: port.value as number,
    hostKeySha256: hostKey.value as string,
    ...(typeof identity.value === "string" && identity.value.trim().length > 0
      ? { identityFile: identity.value.trim() }
      : {}),
  };
  const validation = validateRemoteHostDraft(id, draft);
  if (!validation.ok) return { ok: false, message: wizardText(ui, "remote.validationFailed", { error: validation.error }), reloadRemote: false };

  const next = cloneStores(deps.state);
  const target = deps.scope === "global" ? next.global : next.project;
  target.hosts[id] = draft;
  await persistRemote(ui, deps, next);
  return {
    ok: true,
    message: wizardText(ui, "remote.hostSaved", { id }),
    reloadRemote: true,
  };
}

function parseStringArray(value: ConfigValue | undefined, required: boolean): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || (required && parsed.length === 0)) return undefined;
    if (parsed.some((entry) => typeof entry !== "string" || (required && entry.length === 0))) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Create or edit a remote target while preserving the remote-store CAS path. */
export async function wizardRemoteTarget(
  ui: WizardUi,
  deps: RemoteTargetWizardDeps,
): Promise<RemotePaneOutcome> {
  const id = await promptRemoteId(ui, wizardText(ui, "remote.targetId"), deps.id, validateTargetId);
  if (id === undefined) return remoteCancelled();
  const hostIds = Object.keys(deps.state.config.hosts);
  const host = await ui.select(wizardText(ui, "remote.targetHost"), hostIds);
  if (host === undefined || !hostIds.includes(host)) return remoteCancelled();

  const cwd = await promptRemoteValue(
    ui,
    { key: "cwd", kind: "path", labelKey: "remote.targetCwd", required: true },
    deps.current?.cwd,
    (value) => typeof value === "string" && path.posix.isAbsolute(value),
  );
  if ("cancelled" in cwd) return remoteCancelled();
  const driver = await ui.select(wizardText(ui, "remote.targetDriver"), ["pi-rpc", "acp"]);
  if (driver === undefined || (driver !== "pi-rpc" && driver !== "acp")) return remoteCancelled();

  let command: string[] | undefined;
  while (command === undefined) {
    const prompted = await promptRemoteValue(
      ui,
      { key: "command", kind: "text", labelKey: "remote.targetCommand" },
      JSON.stringify(deps.current?.command ?? ["pi"]),
      (value) => parseStringArray(value, true) !== undefined,
    );
    if ("cancelled" in prompted) return remoteCancelled();
    command = parseStringArray(prompted.value, true);
  }
  let env: string[] | undefined;
  while (env === undefined) {
    const prompted = await promptRemoteValue(
      ui,
      { key: "env", kind: "text", labelKey: "remote.targetEnv" },
      JSON.stringify(deps.current?.env ?? []),
      (value) => parseStringArray(value, false) !== undefined,
    );
    if ("cancelled" in prompted) return remoteCancelled();
    env = parseStringArray(prompted.value, false);
  }

  const draft = {
    host,
    cwd: cwd.value as string,
    driver,
    command: command as [string, ...string[]],
    ...(env.length === 0 ? {} : { env }),
  } satisfies RemoteTargetConfig;
  const validation = validateRemoteTargetDraft(id, draft);
  if (!validation.ok) return { ok: false, message: wizardText(ui, "remote.validationFailed", { error: validation.error }), reloadRemote: false };

  const next = cloneStores(deps.state);
  const target = deps.scope === "global" ? next.global : next.project;
  target.targets[id] = draft;
  await persistRemote(ui, deps, next);
  return {
    ok: true,
    message: wizardText(ui, "remote.targetSaved", { id }),
    reloadRemote: true,
  };
}

/** Create or edit an explicitly trusted remote Pi workspace. */
export async function wizardRemoteWorkspace(
  ui: WizardUi,
  deps: RemoteWorkspaceWizardDeps,
): Promise<RemotePaneOutcome> {
  const workspaceRef = await promptRemoteId(
    ui,
    wizardText(ui, "remote.workspaceRef"),
    deps.workspaceRef,
    validateWorkspaceRef,
  );
  if (workspaceRef === undefined) return remoteCancelled();
  const hostIds = Object.keys(deps.state.config.hosts);
  const host = await ui.select(wizardText(ui, "remote.workspaceHost"), hostIds);
  if (host === undefined || !hostIds.includes(host)) return remoteCancelled();

  const cwd = await promptRemoteValue(
    ui,
    { key: "cwd", kind: "path", labelKey: "remote.workspaceCwd", required: true },
    deps.current?.cwd,
    (value) => typeof value === "string"
      && path.posix.isAbsolute(value)
      && path.posix.normalize(value) === value,
  );
  if ("cancelled" in cwd) return remoteCancelled();
  const minimumWindowProtocol = await promptRemoteValue(
    ui,
    { key: "minimumWindowProtocol", kind: "integer", labelKey: "remote.workspaceProtocol", default: 1, required: true },
    deps.current?.minimumWindowProtocol ?? 1,
    (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535,
  );
  if ("cancelled" in minimumWindowProtocol) return remoteCancelled();

  const draft = {
    host,
    cwd: cwd.value as string,
    requiredPlugin: REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
    minimumWindowProtocol: minimumWindowProtocol.value as number,
  } satisfies RemoteWorkspaceConfig;
  const validation = validateRemoteWorkspaceDraft(workspaceRef, draft);
  if (!validation.ok) {
    return {
      ok: false,
      message: wizardText(ui, "remote.validationFailed", { error: validation.error }),
      reloadRemote: false,
    };
  }

  const next = cloneStores(deps.state);
  const target = deps.scope === "global" ? next.global : next.project;
  target.workspaces[workspaceRef] = draft;
  await persistRemote(ui, deps, next);
  return {
    ok: true,
    message: wizardText(ui, "remote.workspaceSaved", { workspace: workspaceRef }),
    reloadRemote: true,
  };
}

function extractSkeletonDocument(ui: WizardUi, skeletonText: string): string {
  const trimmed = skeletonText.trim();
  try {
    return `${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`;
  } catch {
    const start = trimmed.indexOf("{");
    if (start < 0) throw new Error(wizardText(ui, "connections.legacySkeletonMissing"));
    for (let end = trimmed.lastIndexOf("}"); end > start; end = trimmed.lastIndexOf("}", end - 1)) {
      try {
        return `${JSON.stringify(JSON.parse(trimmed.slice(start, end + 1)), null, 2)}\n`;
      } catch {
        // Try the preceding closing brace; JSON.parse remains authoritative.
      }
    }
    throw new Error(wizardText(ui, "connections.legacySkeletonInvalid"));
  }
}

/** Explicitly write a legacy preview to a new sibling, never the source path. */
export async function wizardLegacyUpgrade(
  ui: WizardUi,
  skeletonText: string,
  filePath: string,
): Promise<ConnectionWizardOutcome> {
  const copyPath = `${filePath}.upgraded.json`;
  const confirmed = await ui.confirm(
    wizardText(ui, "connections.legacyUpgradeConfirm", { skeleton: skeletonText, path: copyPath }),
  );
  if (!confirmed) return cancelled();
  const raw = extractSkeletonDocument(ui, skeletonText);
  try {
    fs.writeFileSync(copyPath, raw, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        message: wizardText(ui, "connections.upgradedCopyExists", { path: copyPath }),
        reloadCatalog: false,
      };
    }
    throw error;
  }
  return {
    ok: true,
    message: wizardText(ui, "connections.wroteFile", { path: copyPath }),
    reloadCatalog: false,
  };
}
