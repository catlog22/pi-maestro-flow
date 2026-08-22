import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import type {
  BackendConfigField,
  ConfigValue,
} from "pi-maestro-backend-core/v1/backend";
import { PI_SUBPROCESS_CONFIG_FIELDS } from "../backends/pi-subprocess.ts";
import { ACP_CLI_CONFIG_FIELDS } from "../backends/acp-cli.ts";
import { DSH_CONFIG_FIELDS } from "pi-maestro-backends/dsh";
import { parseModelRegistryManifest } from "./model-registry.ts";
import {
  createModelsCliTranslator,
  type ModelsCliTranslator,
} from "./cli-i18n.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { publishModelRegistryDocument, type WriteConfirmIO } from "./cli-write.ts";
import { checkCredentialRefInput } from "./cli-redact.ts";

/**
 * The `[E]dit` flow for the pi-teammate-models CLI.
 *
 * Shape of the interaction, in order:
 *
 * 1. list the registered deployments (statically, from the parsed manifest);
 * 2. after the operator commits to one deployment, resolve its configuration
 *    fields — the three builtin families come from in-package constants and
 *    are never imported; any other deployment's backend module is dynamically
 *    imported exactly here and nowhere earlier;
 * 3. run a readline form loop over the fields with per-kind validators,
 *    echoing current values and defaults; credential-ref prompts take a
 *    variable NAME only;
 * 4. hand the resulting candidate to {@link publishModelRegistryDocument}.
 *
 * Abnormal endings never write: an explicit EOF aborts with a partial-progress
 * message and a non-zero exit, the first Ctrl-C cancels the current prompt,
 * the second leaves the flow entirely, and piped (non-TTY) input drives the
 * same loop one line per prompt. Raw mode is never enabled — the interface is
 * created with `terminal: false`, so ^C arrives through the terminal driver's
 * SIGINT rather than readline's raw-mode path.
 */

/** End of input reached mid-flow. Never leads to a write. */
export class EditAborted extends Error {
  constructor() {
    super("edit aborted: end of input");
    this.name = "EditAborted";
  }
}

/** The current prompt was cancelled (first Ctrl-C). */
export class EditCancelled extends Error {
  constructor() {
    super("edit prompt cancelled");
    this.name = "EditCancelled";
  }
}

/** A second Ctrl-C ended the flow. Never leads to a write. */
export class EditInterrupted extends Error {
  constructor() {
    super("edit interrupted");
    this.name = "EditInterrupted";
  }
}

/**
 * Input/output seam of the edit flow. Tests substitute a scripted
 * implementation; the default binds readline over stdio.
 */
export interface EditFlowIO {
  /** Write one chunk of output (terminate lines yourself). */
  write(text: string): void;
  /**
   * Ask one question. `registerCancel` receives the function that cancels the
   * pending prompt (rejecting with {@link EditCancelled}); rejecting with
   * {@link EditAborted} signals end of input.
   */
  prompt(
    promptText: string,
    registerCancel: (cancel: () => void) => void,
  ): Promise<string>;
  /** Register a Ctrl-C handler for the lifetime of the flow. */
  onInterrupt(handler: () => void): void;
  /** Release the input/output resources. */
  close(): void;
}

/**
 * Default stdio binding.
 *
 * `terminal: false` keeps raw mode off unconditionally: piped input works one
 * line per prompt, and an interactive ^C surfaces as the terminal driver's
 * process-level SIGINT, which is bridged into the flow's interrupt handlers.
 */
export function createReadlineEditIO(
  options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): EditFlowIO {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = readline.createInterface({ input, output, terminal: false });
  let closed = false;
  const queuedLines: string[] = [];
  type PendingQuestion = {
    resolve: (line: string) => void;
    reject: (error: unknown) => void;
  };
  const pendingQuestions: PendingQuestion[] = [];
  rl.on("line", (line) => {
    const pending = pendingQuestions.shift();
    if (pending === undefined) queuedLines.push(line);
    else pending.resolve(line);
  });
  rl.once("close", () => {
    closed = true;
    while (pendingQuestions.length > 0) pendingQuestions.shift()!.reject(new EditAborted());
  });
  const handlers: Array<() => void> = [];
  const emitInterrupt = (): void => {
    for (const handler of [...handlers]) handler();
  };
  rl.on("SIGINT", emitInterrupt);
  process.on("SIGINT", emitInterrupt);

  return {
    write: (text) => output.write(text),
    prompt(promptText, registerCancel) {
      if (closed && queuedLines.length === 0) return Promise.reject(new EditAborted());
      output.write(promptText);
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const pending: PendingQuestion = {
          resolve: (line) => {
            if (!settled) {
              settled = true;
              resolve(line);
            }
          },
          reject: (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        };
        registerCancel(() => {
          if (settled) return;
          settled = true;
          const index = pendingQuestions.indexOf(pending);
          if (index >= 0) pendingQuestions.splice(index, 1);
          reject(new EditCancelled());
        });
        const queued = queuedLines.shift();
        if (queued !== undefined) pending.resolve(queued);
        else if (closed) pending.reject(new EditAborted());
        else pendingQuestions.push(pending);
      });
    },
    onInterrupt(handler) {
      handlers.push(handler);
    },
    close() {
      process.removeListener("SIGINT", emitInterrupt);
      rl.close();
    },
  };
}

/** Adapt an edit flow's IO into the write pipeline's confirmation seam. */
export function editIoAsWriteIo(io: EditFlowIO): WriteConfirmIO {
  return {
    write: (text) => io.write(text),
    confirm: async (promptText) => {
      while (true) {
        let answer: string;
        try {
          answer = await io.prompt(`${promptText}\n> `, () => {});
        } catch (error) {
          if (error instanceof EditCancelled) continue;
          // End of input never confirms destructive continuation.
          if (error instanceof EditAborted) return false;
          throw error;
        }
        const normalized = answer.trim().toLowerCase();
        if (normalized === "y" || normalized === "yes") return true;
        if (normalized === "" || normalized === "n" || normalized === "no") return false;
      }
    },
  };
}

const ACP_CLI_MODULE = "pi-maestro-teammate/v1/acp-cli";

/**
 * Builtin families resolve from shipped constants: reading the field table
 * costs no module load, so choosing a builtin deployment triggers no import
 * of any backend module.
 */
const BUILTIN_CONFIG_FIELDS: ReadonlyMap<string, readonly BackendConfigField[]> = new Map([
  ["pi-subprocess", PI_SUBPROCESS_CONFIG_FIELDS],
  ["pi-maestro-backends/dsh", DSH_CONFIG_FIELDS],
  [ACP_CLI_MODULE, ACP_CLI_CONFIG_FIELDS],
]);

/**
 * Resolve a deployment module's configuration fields.
 *
 * Builtin families return immediately from constants. Anything else is
 * dynamically imported — the caller must only reach this after the operator
 * committed to editing the deployment — and the module's backend-shaped
 * export must carry a non-empty `configFields`.
 *
 * @throws when a non-builtin module cannot be loaded or declares no fields.
 */
export async function resolveConfigFieldsForModule(
  moduleId: string,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<readonly BackendConfigField[]> {
  const builtin = BUILTIN_CONFIG_FIELDS.get(moduleId);
  if (builtin !== undefined) return builtin;
  const loaded = await importModule(moduleId) as
    | { default?: unknown; configFields?: unknown }
    | null
    | undefined;
  const backend = loaded !== null && typeof loaded === "object"
    ? (loaded.default ?? loaded)
    : loaded;
  const fields = backend !== null && typeof backend === "object"
    ? (backend as { configFields?: unknown }).configFields
    : undefined;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(`module "${moduleId}" exposes no configuration fields`);
  }
  return fields as readonly BackendConfigField[];
}

export type FieldParseResult =
  | { ok: true; value: ConfigValue }
  | { ok: false; reason: string; secretWarning?: boolean };

/**
 * Validate one entered line against its declared field kind.
 *
 * Empty input never reaches here: the form loop treats it as "keep the
 * current value".
 */
export function parseConfigFieldInput(field: BackendConfigField, input: string): FieldParseResult {
  const value = input.trim();
  const bad = (reason: string, secretWarning?: boolean): FieldParseResult =>
    secretWarning === undefined ? { ok: false, reason } : { ok: false, reason, secretWarning };
  switch (field.kind) {
    case "text":
    case "path":
    // Membership of a dynamic choice lives in the executing system; stored and
    // validated as text exactly like registration-time parsing.
    case "dynamic-enum":
      return value.length > 0 ? { ok: true, value } : bad("expected non-empty text");
    case "integer": {
      if (!/^[+-]?\d+$/.test(value)) return bad("expected an integer");
      const parsed = Number.parseInt(value, 10);
      return Number.isSafeInteger(parsed)
        ? { ok: true, value: parsed }
        : bad("expected an integer within the safe range");
    }
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : bad("expected a finite number");
    }
    case "boolean": {
      const lowered = value.toLowerCase();
      if (["true", "yes", "y", "on"].includes(lowered)) return { ok: true, value: true };
      if (["false", "no", "n", "off"].includes(lowered)) return { ok: true, value: false };
      return bad("expected true or false");
    }
    case "enum": {
      const allowed = (field.options ?? []).map((option) => option.value);
      return allowed.includes(value)
        ? { ok: true, value }
        : bad(`expected one of ${allowed.join(" | ")}`);
    }
    case "string-list": {
      const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      return items.length > 0
        ? { ok: true, value: items }
        : bad("expected a comma-separated list of values");
    }
    case "credential-ref": {
      const check = checkCredentialRefInput(value);
      return check.kind === "accept"
        ? { ok: true, value: check.value }
        : bad(check.reason, check.secretWarning);
    }
  }
}

export function kindLabel(field: BackendConfigField): string {
  switch (field.kind) {
    case "enum":
      return `enum: ${field.options?.map((option) => option.value).join(" | ") ?? "?"}`;
    case "boolean":
      return "true/false";
    case "string-list":
      return "comma-separated list";
    case "credential-ref":
      return "variable name";
    default:
      return field.kind;
  }
}

function currentValue(field: BackendConfigField, config: Record<string, ConfigValue>): ConfigValue | undefined {
  return config[field.key] !== undefined ? config[field.key] : field.default;
}

export function displayValue(translator: ModelsCliTranslator, value: ConfigValue | undefined): string {
  if (value === undefined) return translator("models.cli.edit.unset");
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export interface EditFlowOptions {
  /** Absolute registry document path. */
  file: string;
  /** Pre-confirm external-change overwrite (--yes). */
  yes?: boolean;
  locale?: SupportedSettingsLocale;
  /** Defaults to a stdio-bound readline interface. */
  io?: EditFlowIO;
  /** Test seam over dynamic module loading. */
  importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * Shared interrupt-aware prompting loop for the interactive flows.
 *
 * The first Ctrl-C cancels the active prompt (the caller simply asks again);
 * the second marks the flow dead, and the pending prompt unwinds through
 * cancellation so {@link runEditFlow}-style callers observe
 * {@link EditInterrupted} on their next ask.
 */
export function createLinePrompter(io: EditFlowIO): {
  ask(promptText: string): Promise<string>;
} {
  let cancelCurrent: (() => void) | null = null;
  let interruptStrikes = 0;
  let pendingInterrupted = false;
  io.onInterrupt(() => {
    interruptStrikes += 1;
    if (interruptStrikes >= 2) pendingInterrupted = true;
    const cancel = cancelCurrent;
    cancelCurrent = null;
    // The first Ctrl-C cancels the active prompt (re-prompted below); the
    // second marks the flow dead and the pending prompt unwinds through it.
    cancel?.();
  });
  return {
    async ask(promptText: string): Promise<string> {
      while (true) {
        if (pendingInterrupted) throw new EditInterrupted();
        try {
          const answer = await io.prompt(promptText, (cancel) => {
            cancelCurrent = cancel;
          });
          interruptStrikes = 0;
          return answer;
        } catch (error) {
          if (error instanceof EditCancelled) continue;
          throw error;
        }
      }
    },
  };
}

/** Exit codes used by the edit command. */
export const EDIT_EXIT_CODES = {
  /** External change present and the operator declined. */
  declinedExternalChange: 1,
  /** Explicit EOF mid-flow; nothing was written. */
  eof: 2,
  /** A legacy document cannot be edited by this flow; nothing was written. */
  legacyDocument: 2,
  /** Second Ctrl-C; nothing was written. */
  interrupted: 130,
} as const;

function configValuesEqual(left: ConfigValue | undefined, right: ConfigValue | undefined): boolean {
  // String lists are fresh arrays on every parse, so identity would record a
  // no-op retyping as an edit.
  return JSON.stringify(left) === JSON.stringify(right);
}

function isLegacyDocumentShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const document = parsed as Record<string, unknown>;
  return document.mode !== "model-registry" || document.version !== 2;
}

/**
 * Apply accepted edits onto a parsed document, preserving every untouched key
 * and value plus the enumeration order of all objects. Existing config keys
 * keep their positions (values replaced in place); newly-set keys append in
 * field declaration order.
 */
export function applyConfigEdits(
  document: Record<string, unknown>,
  deploymentId: string,
  edits: ReadonlyMap<string, ConfigValue>,
): Record<string, unknown> {
  const backends = document.backends as Record<string, Record<string, unknown>>;
  const registration = { ...(backends[deploymentId] ?? {}) };
  const base = (registration.config ?? {}) as Record<string, ConfigValue>;
  const merged: Record<string, ConfigValue> = {};
  for (const key of Object.keys(base)) {
    merged[key] = edits.has(key) ? (edits.get(key) as ConfigValue) : base[key];
  }
  for (const [key, value] of edits) {
    if (!Object.hasOwn(base, key)) merged[key] = value;
  }
  const next: Record<string, unknown> = { ...registration };
  if (Object.keys(merged).length > 0) next.config = merged;
  else delete next.config;
  return { ...document, backends: { ...backends, [deploymentId]: next } };
}

/**
 * Run the full edit flow. Returns a process exit code; structural errors
 * (unreadable file, invalid manifest, failed publish) propagate to the
 * caller, while interactive aborts (EOF, double Ctrl-C, declined overwrite)
 * report through the IO seam and return non-zero without ever writing.
 */
export async function runEditFlow(options: EditFlowOptions): Promise<number> {
  const translator = createModelsCliTranslator(options.locale ?? "en");
  const file = options.file;
  const ownedIo = options.io === undefined;
  const io = options.io ?? createReadlineEditIO();
  const { ask } = createLinePrompter(io);

  try {
    const baselineRaw = fs.readFileSync(file, "utf8");
    let parsedDocument: unknown;
    try {
      parsedDocument = JSON.parse(baselineRaw);
    } catch (cause) {
      throw new Error(`teammate model registry at ${file} is not valid JSON`, { cause });
    }
    if (isLegacyDocumentShape(parsedDocument)) {
      io.write(`${translator("models.cli.legacyDetected", { path: file })}\n`);
      io.write(`${translator("models.cli.legacyPreviewRefusal")}\n`);
      return EDIT_EXIT_CODES.legacyDocument;
    }
    const manifest = parseModelRegistryManifest(baselineRaw, file);

    const deploymentIds = Object.keys(manifest.backends);
    io.write(`${translator("models.cli.edit.deploymentsHeader")}\n`);
    deploymentIds.forEach((deploymentId, index) => {
      io.write(
        `${translator("models.cli.edit.deploymentEntry", {
          index: String(index + 1),
          id: deploymentId,
          module: manifest.backends[deploymentId]!.module,
        })}\n`,
      );
    });

    let deploymentId: string | undefined;
    while (deploymentId === undefined) {
      const choice = (await ask(`${translator("models.cli.edit.selectDeployment")}\n> `)).trim();
      const byIndex = /^\d+$/.test(choice) ? deploymentIds[Number.parseInt(choice, 10) - 1] : undefined;
      const resolved = byIndex ?? (deploymentIds.includes(choice) ? choice : undefined);
      if (resolved === undefined) {
        io.write(`${translator("models.cli.edit.invalidSelection", { choice })}\n`);
        continue;
      }
      deploymentId = resolved;
    }

    const registration = manifest.backends[deploymentId]!;
    let fields: readonly BackendConfigField[];
    try {
      // Only now — after the operator committed to this deployment — may a
      // non-builtin backend module be loaded.
      fields = await resolveConfigFieldsForModule(registration.module, options.importModule);
    } catch (cause) {
      io.write(
        `${translator("models.cli.edit.moduleLoadFailed", {
          module: registration.module,
          reason: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
      return EDIT_EXIT_CODES.declinedExternalChange;
    }

    const existingConfig = (registration.config ?? {}) as Record<string, ConfigValue>;
    const edits = new Map<string, ConfigValue>();
    for (const field of fields) {
      const current = currentValue(field, existingConfig);
      const edited = edits.has(field.key) ? edits.get(field.key) : current;
      const promptText =
        `${translator("models.cli.edit.fieldPrompt", {
          key: field.key,
          current: displayValue(translator, edited),
          kind: kindLabel(field),
        })}\n> `;
      let accepted: ConfigValue | undefined;
      while (accepted === undefined) {
        const line = await ask(promptText);
        if (line.trim().length === 0) {
          // Empty input keeps what is already configured.
          accepted = edited;
          break;
        }
        const result = parseConfigFieldInput(field, line);
        if (result.ok) {
          accepted = result.value;
          break;
        }
        if (result.secretWarning === true) {
          io.write(
            `${translator("models.cli.edit.credentialSecretWarning", { key: field.key })}\n`,
          );
        }
        io.write(
          `${translator("models.cli.edit.fieldRejected", { key: field.key, reason: result.reason })}\n`,
        );
      }
      if (accepted !== undefined && !configValuesEqual(accepted, current)) edits.set(field.key, accepted);
    }

    if (edits.size === 0) {
      io.write(`${translator("models.cli.edit.noChanges")}\n`);
      return 0;
    }

    const candidateDocument = applyConfigEdits(
      parsedDocument as Record<string, unknown>,
      deploymentId,
      edits,
    );
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
      return EDIT_EXIT_CODES.declinedExternalChange;
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
      return EDIT_EXIT_CODES.eof;
    }
    if (error instanceof EditInterrupted) {
      io.write(`${translator("models.cli.edit.interrupted", { path: file })}\n`);
      return EDIT_EXIT_CODES.interrupted;
    }
    throw error;
  } finally {
    if (ownedIo) io.close();
  }
}
