import * as fs from "node:fs";
import type {
  BackendConfigField,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  deriveModelRuntimeDescriptor,
  parseModelRegistryManifest,
  type ModelRegistrationV2,
  type ModelSelectorV2,
} from "./model-registry.ts";
import {
  createReadlineEditIO,
  createLinePrompter,
  displayValue,
  EditAborted,
  EditInterrupted,
  editIoAsWriteIo,
  kindLabel,
  parseConfigFieldInput,
  resolveConfigFieldsForModule,
  type EditFlowIO,
} from "./cli-edit.ts";
import {
  createModelsCliTranslator,
  type ModelsCliTranslator,
} from "./cli-i18n.ts";
import { publishModelRegistryDocument } from "./cli-write.ts";

/**
 * The `[A]dd` flow for the pi-teammate-models CLI — a guided
 * add-registration wizard.
 *
 * Shape of the interaction, in order:
 *
 * 1. backend family: `pi`, `dsh`, `acp`, or a third-party module id;
 * 2. transport variant where the family supports one (`local`/`ssh` for dsh
 *    and acp; ssh additionally requires `host`/`user` before any write);
 * 3. a new deployment id, checked live against the deployments already in
 *    the document;
 * 4. one prompt per declared configuration field, kind-validated with the
 *    declared default shown; credential-ref prompts take a variable NAME
 *    only;
 * 5. the model registration: registration id (live uniqueness check),
 *    intrinsic modelId, selector kind (+ value for `adapter-model`), and
 *    deployment default;
 * 6. the whole candidate manifest is recompiled through
 *    `parseModelRegistryManifest`; numbered failures are shown and the model
 *    registration block re-prompts until the candidate is valid;
 * 7. the confirmed candidate goes through {@link publishModelRegistryDocument}
 *    — the same validated, backup-rotating, atomically publishing write path
 *    the edit flow uses.
 *
 * Abnormal endings never write: EOF aborts with a partial-progress message
 * and a non-zero exit, the first Ctrl-C cancels the current prompt, the
 * second leaves the flow entirely — all shared with the edit flow through
 * {@link createLinePrompter}. A legacy document is never edited or extended;
 * it reports the refusal and exits.
 */

const FAMILY_MODULES = {
  pi: "pi-subprocess",
  dsh: "pi-maestro-backends/dsh",
  acp: "pi-maestro-teammate/v1/acp-cli",
} as const;

type BuiltinFamily = keyof typeof FAMILY_MODULES;

/** Exit codes used by the add command. */
export const ADD_EXIT_CODES = {
  /** External change present and the operator declined. */
  declinedExternalChange: 1,
  /** Explicit EOF mid-flow; nothing was written. */
  eof: 2,
  /** A legacy document cannot be extended by this flow; nothing was written. */
  legacyDocument: 2,
  /** Second Ctrl-C; nothing was written. */
  interrupted: 130,
} as const;

export interface AddFlowOptions {
  /** Absolute registry document path. Created when it does not exist yet. */
  file: string;
  /** Pre-confirm external-change overwrite (--yes). */
  yes?: boolean;
  locale?: SupportedSettingsLocale;
  /** Defaults to a stdio-bound readline interface. */
  io?: EditFlowIO;
  /** Test seam over dynamic module loading. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/** Same shape rule the strict parser applies to ids. */
export function isValidId(value: string): boolean {
  return value.length > 0 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function selectorKey(selector: ModelSelectorV2): string {
  return selector.kind === "adapter-model" ? `${selector.kind}:${selector.value}` : selector.kind;
}

export function selectorSummary(selector: ModelSelectorV2): string {
  return selector.kind === "adapter-model" ? `${selector.kind} ${selector.value}` : selector.kind;
}

function isLegacyDocumentShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const document = parsed as Record<string, unknown>;
  return document.mode !== "model-registry" || document.version !== 2;
}

/**
 * Conflicts the compiler will reject, collected before the authoritative
 * parse so an operator sees every reason at once instead of one per attempt.
 */
export function candidateConflicts(
  models: Readonly<Record<string, ModelRegistrationV2>>,
  backends: Readonly<Record<string, { module: string; config?: Record<string, ConfigValue> }>>,
  newRegistrationId: string,
): string[] {
  const errors: string[] = [];
  const added = models[newRegistrationId]!;
  const descriptor = deriveModelRuntimeDescriptor(added.deployment, backends[added.deployment]!);
  if (added.selector.kind === "fixed" && descriptor.modelSelection !== "unsupported") {
    const qualification = descriptor.modelSelection === "unknown"
      ? "cannot be verified until its backend resolves"
      : "reports native modelSelection";
    errors.push(`model registration "${newRegistrationId}" uses fixed selector with deployment "${added.deployment}", which ${qualification}`);
  }
  if (added.selector.kind === "adapter-model" && descriptor.modelSelection === "unsupported") {
    errors.push(`model registration "${newRegistrationId}" uses adapter-model with deployment "${added.deployment}", whose backend modelSelection is unsupported`);
  }
  for (const [otherId, other] of Object.entries(models)) {
    if (otherId === newRegistrationId) continue;
    if (other.deployment === added.deployment && selectorKey(other.selector) === selectorKey(added.selector)) {
      errors.push(`model registrations "${otherId}" and "${newRegistrationId}" duplicate the same deployment selector; use a modelAlias`);
    }
    if (added.deploymentDefault === true && other.deployment === added.deployment && other.deploymentDefault === true) {
      errors.push(`deployment "${added.deployment}" has multiple deployment defaults: "${otherId}" and "${newRegistrationId}"`);
    }
  }
  return [...new Set(errors)];
}

/**
 * Run the full add flow. Returns a process exit code; structural errors
 * (invalid baseline document, failed publish) propagate to the caller, while
 * interactive aborts report through the IO seam and return non-zero without
 * ever writing.
 */
export async function runAddFlow(options: AddFlowOptions): Promise<number> {
  const translator = createModelsCliTranslator(options.locale ?? "en");
  const file = options.file;
  const ownedIo = options.io === undefined;
  const io = options.io ?? createReadlineEditIO();
  const { ask } = createLinePrompter(io);

  /** Prompt until a non-empty valid id-shaped line arrives. */
  const askId = async (promptText: string): Promise<string> => {
    while (true) {
      const answer = (await ask(`${promptText}\n> `)).trim();
      if (isValidId(answer)) return answer;
      io.write(`${translator("models.cli.add.invalidId")}\n`);
    }
  };

  try {
    let baselineRaw: string | undefined;
    try {
      baselineRaw = fs.readFileSync(file, "utf8");
    } catch {
      baselineRaw = undefined;
    }
    let baseDocument: Record<string, unknown>;
    if (baselineRaw === undefined) {
      // A missing document starts a fresh v2 manifest; the wizard fills in
      // its mandatory defaults once the first deployment/registration exist.
      baseDocument = {
        version: 2,
        mode: "model-registry",
        default: "",
        defaultModel: "",
        backends: {},
        models: {},
      };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(baselineRaw);
      } catch (cause) {
        throw new Error(`teammate model registry at ${file} is not valid JSON`, { cause });
      }
      if (isLegacyDocumentShape(parsed)) {
        io.write(`${translator("models.cli.legacyDetected", { path: file })}\n`);
        io.write(`${translator("models.cli.legacyPreviewRefusal")}\n`);
        return ADD_EXIT_CODES.legacyDocument;
      }
      baseDocument = parseModelRegistryManifest(baselineRaw, file) as unknown as Record<string, unknown>;
    }

    // Step 1: backend family.
    io.write(`${translator("models.cli.add.familiesHeader")}\n`);
    io.write(`${translator("models.cli.add.family.pi")}\n`);
    io.write(`${translator("models.cli.add.family.dsh")}\n`);
    io.write(`${translator("models.cli.add.family.acp")}\n`);
    io.write(`${translator("models.cli.add.family.thirdParty")}\n`);
    let family: BuiltinFamily | "third-party" | undefined;
    while (family === undefined) {
      const choice = (await ask(`${translator("models.cli.add.familyPrompt")}\n> `)).trim().toLowerCase();
      family =
        choice === "1" || choice === "pi" ? "pi"
        : choice === "2" || choice === "dsh" ? "dsh"
        : choice === "3" || choice === "acp" ? "acp"
        : choice === "4" || choice === "third-party" || choice === "thirdparty" || choice === "third_party"
          ? "third-party"
          : undefined;
      if (family !== undefined) break;
      io.write(`${translator("models.cli.add.invalidFamily", { choice })}\n`);
    }
    const moduleId = family === "third-party" ? await askId(translator("models.cli.add.modulePrompt")) : FAMILY_MODULES[family];

    // Step 2: transport variant where the family declares one.
    const seededConfig: Record<string, ConfigValue> = {};
    if (family === "dsh" || family === "acp") {
      io.write(`${translator("models.cli.add.transportHeader")}\n`);
      io.write(`${translator("models.cli.add.transport.local")}\n`);
      io.write(`${translator("models.cli.add.transport.ssh")}\n`);
      while (true) {
        const choice = (await ask(`${translator("models.cli.add.transportPrompt")}\n> `)).trim().toLowerCase();
        if (choice === "" || choice === "1" || choice === "local") break;
        if (choice === "2" || choice === "ssh") {
          seededConfig.mode = "ssh";
          break;
        }
        io.write(`${translator("models.cli.add.invalidTransport", { choice })}\n`);
      }
    }

    // Step 3: deployment id with a live uniqueness check.
    const existingBackends = { ...(baseDocument.backends as Record<string, unknown>) };
    let deploymentId: string;
    while (true) {
      const candidate = (await ask(`${translator("models.cli.add.deploymentPrompt")}\n> `)).trim();
      if (!isValidId(candidate)) {
        io.write(`${translator("models.cli.add.invalidId")}\n`);
        continue;
      }
      if (Object.hasOwn(existingBackends, candidate)) {
        io.write(`${translator("models.cli.add.deploymentExists", { id: candidate })}\n`);
        continue;
      }
      deploymentId = candidate;
      break;
    }

    // Step 4: configuration fields, kind-validated, defaults shown.
    const fields = await resolveConfigFieldsForModule(moduleId, options.importModule);
    const config: Record<string, ConfigValue> = { ...seededConfig };
    for (const field of fields) {
      await promptAddField(io, translator, ask, field, config);
    }

    // Step 5 + 6: model registration, re-prompted on numbered compiler errors.
    // The registration may target the freshly entered deployment or any
    // existing one — attaching a second route to an existing deployment is
    // exactly how a duplicate-selector conflict becomes possible, and the
    // numbered-error loop is what surfaces it.
    const existingModels = { ...(baseDocument.models as Record<string, ModelRegistrationV2>) };
    const firstRegistration = Object.keys(existingModels).length === 0;
    const freshDocument = Object.keys(existingBackends).length === 0;
    let registrationId: string;
    let registration: ModelRegistrationV2;
    let targetDeploymentId: string;
    let candidateDocument: Record<string, unknown>;
    while (true) {
      const answered = await askModelRegistration(io, translator, ask, {
        newDeploymentId: deploymentId,
        knownDeployments: new Set(Object.keys(existingBackends)),
        takenIds: new Set(Object.keys(existingModels)),
        forcedDefault: firstRegistration,
      });
      registrationId = answered.id;
      registration = answered.registration;
      targetDeploymentId = answered.deploymentId;
      const backends: Record<string, unknown> = {
        ...existingBackends,
        [deploymentId]: Object.keys(config).length > 0 ? { module: moduleId, config } : { module: moduleId },
      };
      const models: Record<string, unknown> = {
        ...existingModels,
        [registrationId]: registration,
      };
      candidateDocument = {
        ...baseDocument,
        default: freshDocument ? deploymentId : baseDocument.default,
        defaultModel: firstRegistration ? registrationId : baseDocument.defaultModel,
        backends,
        models,
      };
      const conflicts = candidateConflicts(
        candidateDocument.models as Record<string, ModelRegistrationV2>,
        backends as Record<string, { module: string; config?: Record<string, ConfigValue> }>,
        registrationId,
      );
      try {
        parseModelRegistryManifest(JSON.stringify(candidateDocument, null, 2), file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!conflicts.includes(message)) conflicts.push(message);
      }
      if (conflicts.length === 0) break;
      io.write(`${translator("models.cli.add.compilerErrors")}\n`);
      conflicts.forEach((message, index) => {
        io.write(`  ${index + 1}. ${message}\n`);
      });
    }

    // Step 7: summary and the shared D12 write pipeline.
    io.write(`${translator("models.cli.add.summaryHeader")}\n`);
    io.write(`${translator("models.cli.add.summaryDeployment", { id: deploymentId, module: moduleId })}\n`);
    io.write(
      `${translator("models.cli.add.summaryRegistration", {
        id: registrationId,
        model: registration.modelId,
        selector: `${targetDeploymentId} · ${selectorSummary(registration.selector)}`,
      })}\n`,
    );
    if (freshDocument || firstRegistration) {
      io.write(
        `${translator("models.cli.add.summaryDefaults", { deployment: candidateDocument.default as string, model: candidateDocument.defaultModel as string })}\n`,
      );
    }
    const candidateRaw = `${JSON.stringify(candidateDocument, null, 2)}\n`;
    const result = await publishModelRegistryDocument({
      file,
      candidateRaw,
      baselineRaw,
      yes: options.yes === true,
      io: editIoAsWriteIo(io),
      translate: translator,
    });
    if (result.kind === "declined-external-change") {
      io.write(`${translator("models.cli.edit.abortedDeclined")}\n`);
      return ADD_EXIT_CODES.declinedExternalChange;
    }
    io.write(
      result.backupPath === undefined
        ? `${translator("models.cli.edit.written", { path: file })}\n`
        : `${translator("models.cli.edit.backupWritten", { path: file, backup: result.backupPath })}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof EditAborted) {
      io.write(`${translator("models.cli.edit.partialProgress", { path: file })}\n`);
      return ADD_EXIT_CODES.eof;
    }
    if (error instanceof EditInterrupted) {
      io.write(`${translator("models.cli.edit.interrupted", { path: file })}\n`);
      return ADD_EXIT_CODES.interrupted;
    }
    throw error;
  } finally {
    if (ownedIo) io.close();
  }
}

/** Ask one configuration-field question and merge the accepted value into `config`. */
async function promptAddField(
  io: EditFlowIO,
  translator: ModelsCliTranslator,
  ask: (promptText: string) => Promise<string>,
  field: BackendConfigField,
  config: Record<string, ConfigValue>,
): Promise<void> {
  const current = config[field.key] !== undefined ? config[field.key] : field.default;
  // An ssh launch cannot even compose without a host or user, so those two
  // are required the moment the transport variant chose "ssh".
  const requiredNow = field.required === true
    || (config.mode === "ssh" && (field.key === "host" || field.key === "user"));
  const promptText = `${translator("models.cli.add.fieldPrompt", {
    key: field.key,
    current: displayValue(translator, current),
    kind: kindLabel(field),
  })}\n> `;
  while (true) {
    const line = await ask(promptText);
    if (line.trim().length === 0) {
      if (current !== undefined) {
        // Empty input keeps the seeded transport value or the declared default.
        if (config[field.key] === undefined && field.default !== undefined) config[field.key] = field.default;
        return;
      }
      if (requiredNow) {
        io.write(`${translator("models.cli.add.requiredField", { key: field.key })}\n`);
        continue;
      }
      return; // leave unset
    }
    const result = parseConfigFieldInput(field, line);
    if (result.ok) {
      config[field.key] = result.value;
      return;
    }
    if (result.secretWarning === true) {
      io.write(`${translator("models.cli.edit.credentialSecretWarning", { key: field.key })}\n`);
    }
    io.write(`${translator("models.cli.edit.fieldRejected", { key: field.key, reason: result.reason })}\n`);
  }
}

/** Ask the model-registration questions (target deployment last, so it re-prompts as a block). */
async function askModelRegistration(
  io: EditFlowIO,
  translator: ModelsCliTranslator,
  ask: (promptText: string) => Promise<string>,
  context: {
    newDeploymentId: string;
    knownDeployments: ReadonlySet<string>;
    takenIds: ReadonlySet<string>;
    forcedDefault: boolean;
  },
): Promise<{ id: string; registration: ModelRegistrationV2; deploymentId: string }> {
  // Target deployment: empty picks the freshly entered deployment; naming an
  // existing one attaches the route there (where conflicts can arise).
  let deploymentId = context.newDeploymentId;
  if (!context.forcedDefault) {
    while (true) {
      const answer = (
        await ask(`${translator("models.cli.add.registrationDeploymentPrompt", { id: context.newDeploymentId })}\n> `)
      ).trim();
      if (answer.length === 0 || answer === context.newDeploymentId) break;
      if (!context.knownDeployments.has(answer)) {
        io.write(`${translator("models.cli.edit.invalidSelection", { choice: answer })}\n`);
        continue;
      }
      deploymentId = answer;
      break;
    }
  }

  let registrationId: string;
  while (true) {
    const candidate = (await ask(`${translator("models.cli.add.registrationIdPrompt")}\n> `)).trim();
    if (!isValidId(candidate)) {
      io.write(`${translator("models.cli.add.invalidId")}\n`);
      continue;
    }
    if (context.takenIds.has(candidate)) {
      io.write(`${translator("models.cli.add.registrationExists", { id: candidate })}\n`);
      continue;
    }
    registrationId = candidate;
    break;
  }

  let modelId: string;
  while (true) {
    const answer = (await ask(`${translator("models.cli.add.modelIdPrompt")}\n> `)).trim();
    if (answer.length > 0) {
      modelId = answer;
      break;
    }
    io.write(`${translator("models.cli.add.invalidId")}\n`);
  }

  io.write(`${translator("models.cli.add.selectorHeader")}\n`);
  io.write(`${translator("models.cli.add.selector.adapterModel")}\n`);
  io.write(`${translator("models.cli.add.selector.deploymentDefault")}\n`);
  io.write(`${translator("models.cli.add.selector.fixed")}\n`);
  let selector: ModelSelectorV2;
  while (true) {
    const choice = (await ask(`${translator("models.cli.add.selectorPrompt")}\n> `)).trim().toLowerCase();
    if (choice === "1" || choice === "adapter-model") {
      let value: string;
      while (true) {
        value = (await ask(`${translator("models.cli.add.selectorValuePrompt")}\n> `)).trim();
        if (value.length > 0 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)) break;
        io.write(`${translator("models.cli.add.selectorValueRequired")}\n`);
      }
      selector = { kind: "adapter-model", value };
      break;
    }
    if (choice === "2" || choice === "deployment-default") {
      selector = { kind: "deployment-default" };
      break;
    }
    if (choice === "3" || choice === "fixed") {
      selector = { kind: "fixed" };
      break;
    }
    io.write(`${translator("models.cli.add.invalidSelector", { choice })}\n`);
  }

  if (context.forcedDefault) {
    // A manifest must name a defaultModel on the default deployment; the
    // first registration in a document is conscripted, not asked.
    io.write(`${translator("models.cli.add.forcedDeploymentDefault")}\n`);
    return {
      id: registrationId,
      deploymentId,
      registration: {
        modelId,
        deployment: deploymentId,
        selector,
        deploymentDefault: true,
      },
    };
  }

  while (true) {
    const answer = (await ask(`${translator("models.cli.add.deploymentDefaultPrompt")}\n> `)).trim().toLowerCase();
    if (answer === "" || answer === "n" || answer === "no") {
      return {
        id: registrationId,
        deploymentId,
        registration: { modelId, deployment: deploymentId, selector },
      };
    }
    if (answer === "y" || answer === "yes") {
      return {
        id: registrationId,
        deploymentId,
        registration: { modelId, deployment: deploymentId, selector, deploymentDefault: true },
      };
    }
  }
}
