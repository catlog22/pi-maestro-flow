import {
  compileModelRegistryManifest,
  parseModelRegistryManifest,
  type ProjectionIdentity,
} from "../public/v1/backends.ts";
import { createModelsCliTranslator, type ModelsCliTranslator } from "./cli-i18n.ts";
import { redactText } from "./cli-redact.ts";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import {
  createLinePrompter,
  EditAborted,
  type EditFlowIO,
} from "./cli-edit.ts";
import * as fs from "node:fs";

/**
 * Static model listing for the pi-teammate-models CLI.
 *
 * Rows are built purely from `parseModelRegistryManifest` +
 * `compileModelRegistryManifest` (both re-exported by public/v1/backends.ts).
 * No backend module is imported, no process is spawned, and no network probe
 * is made: topology comes from the runtime descriptor that the compiler
 * derives statically via `deriveModelRuntimeDescriptor`, and health is the
 * static resolvability gate rather than live circuit-breaker state. Session
 * availability depends on root-monitor authority, which a CLI process does not
 * hold, so it is reported as "n/a".
 */

/** One diagnostic row per registered model route, sorted by registration id. */
export interface ModelCliRow {
  registrationId: string;
  modelId: string;
  deploymentId: string;
  deploymentDefault: boolean;
  /** Statically derived harness (pi | dsh | acp | adapter-owned). */
  harness: string;
  transportKind: string;
  protocol: string;
  modelSelection: string;
  registered: true;
  resolvable: boolean;
  /** Static health: without a session there is no live breaker state to consult. */
  healthyStatic: boolean;
  sessionAvailable: "n/a";
}

export type ModelListResult =
  | {
      kind: "registry";
      identity: ProjectionIdentity;
      defaultModel: string;
      rows: readonly ModelCliRow[];
      diagnostics: readonly string[];
    }
  | { kind: "legacy"; documentPath: string; parsed: unknown };

/**
 * D14 hook invoked when `list` meets a legacy/backend-registry document.
 *
 * The shipped implementation renders the computed v2 upgrade skeleton plus
 * the hard-refusal statement; it never writes anything by itself. The
 * interactive `[E]xplicitly write upgraded copy / [A]bort` offer lives in
 * {@link runLegacyPreviewFlow}, which the CLI awaits after listing.
 */
export type LegacyPreviewHook = (documentPath: string, parsed: unknown) => void;

export const LEGACY_PREVIEW_HOOK: LegacyPreviewHook = (documentPath, parsed) => {
  process.stdout.write(renderLegacyUpgradeSkeleton(parsed, documentPath));
};

export interface ModelListOptions {
  /** Defaults to {@link LEGACY_PREVIEW_HOOK}; tests may pass a spy. */
  legacyPreviewHook?: LegacyPreviewHook;
}

function isLegacyDocumentShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const document = parsed as Record<string, unknown>;
  return document.mode !== "model-registry" || document.version !== 2;
}

export function buildModelList(
  raw: string,
  documentPath = ".pi/teammate-backends.json",
  options: ModelListOptions = {},
): ModelListResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`teammate model registry at ${documentPath} is not valid JSON`, { cause });
  }
  // Legacy documents return before manifest parsing so an old file produces a
  // pointer to the migration path instead of a parser error.
  if (isLegacyDocumentShape(parsed)) {
    (options.legacyPreviewHook ?? LEGACY_PREVIEW_HOOK)(documentPath, parsed);
    return { kind: "legacy", documentPath, parsed };
  }

  const manifest = parseModelRegistryManifest(raw, documentPath);
  const pair = compileModelRegistryManifest(manifest);
  const rows: ModelCliRow[] = pair.discovery.entries.map((entry) => ({
    registrationId: entry.modelRegistrationId,
    modelId: entry.modelId,
    deploymentId: entry.deploymentId,
    deploymentDefault: entry.deploymentDefault,
    harness: entry.runtime.harness,
    transportKind: entry.runtime.transport.kind,
    protocol: "protocol" in entry.runtime.transport ? entry.runtime.transport.protocol : "-",
    modelSelection: entry.runtime.modelSelection,
    registered: true,
    resolvable: entry.runtime.resolvable,
    healthyStatic: entry.runtime.resolvable,
    sessionAvailable: "n/a",
  }));
  return {
    kind: "registry",
    identity: { revision: pair.discovery.revision, hash: pair.discovery.hash },
    defaultModel: pair.discovery.defaultModel,
    rows,
    diagnostics: [...pair.discovery.diagnostics],
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * Compute the v2 upgrade skeleton a legacy document would become.
 *
 * The backends section carries over verbatim — deployment ids and module
 * bindings survive migration unchanged — while `models`, `defaultModel`, and
 * the explicit `version`/`mode` pair are placeholders the operator (or the
 * add wizard) completes. Placeholder strings keep the copy valid JSON but
 * deliberately NOT a dispatchable manifest: an empty `models` map can never
 * satisfy `defaultModel`, so a half-migrated file cannot be loaded by
 * accident.
 */
export function buildUpgradedCopyDocument(parsed: unknown): Record<string, unknown> {
  const source = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const backends = source.backends !== null && typeof source.backends === "object" && !Array.isArray(source.backends)
    ? source.backends
    : {};
  const defaultDeployment = typeof source.default === "string" && source.default.trim().length > 0
    ? source.default
    : "<default-deployment-id>";
  return {
    version: 2,
    mode: "model-registry",
    default: defaultDeployment,
    defaultModel: "<registration-id-of-default-model>",
    backends,
    models: {},
  };
}

/**
 * Render the computed v2 upgrade skeleton for a legacy document.
 *
 * This is the preview text only — it states on its own that nothing has been
 * written and that writes to the legacy document itself are refused.
 */
export function renderLegacyUpgradeSkeleton(parsed: unknown, documentPath: string): string {
  // A legacy document predates the credential-ref discipline and may hold
  // secret values inline in backends[*].config; the preview, the confirm
  // prompt, and the sibling write all ride this text, so it passes the same
  // redaction gate as the external-change diff.
  const skeleton = redactText(JSON.stringify(buildUpgradedCopyDocument(parsed), null, 2));
  return [
    `Legacy upgrade preview for ${documentPath} — computed v2 skeleton (nothing has been written):`,
    skeleton,
    'Fill in "models" with one entry per selectable route (exactly one deploymentDefault per deployment),',
    'point "defaultModel" at that registration, then reload extensions.',
    `Writes to the legacy document are refused. [E] explicitly writes this skeleton to ${documentPath}.upgraded.json; [A] aborts (default).`,
  ].join("\n") + "\n";
}

/** Exit codes for the legacy preview offer. */
export const LEGACY_PREVIEW_EXIT_CODES = {
  /** The operator explicitly chose the upgraded copy, which was written. */
  wroteUpgradedCopy: 0,
  /** Abort (the default), declined overwrite of an existing copy, or end of input. Nothing was written. */
  refused: 1,
} as const;

export interface LegacyPreviewOptions {
  /** Absolute legacy document path. */
  file: string;
  /** Parsed legacy document from {@link buildModelList}. */
  parsed: unknown;
  locale?: SupportedSettingsLocale;
  io: EditFlowIO;
}

/**
 * The interactive half of the legacy preview: the hard refusal to write the
 * legacy document, plus the explicit `[E]` escape hatch that writes the
 * computed v2 skeleton to `<file>.upgraded.json` — a NEW sibling path, never
 * the legacy document itself.
 */
export async function runLegacyPreviewFlow(options: LegacyPreviewOptions): Promise<number> {
  const translator = createModelsCliTranslator(options.locale ?? "en");
  const io = options.io;
  const { ask } = createLinePrompter(io);
  try {
    while (true) {
      let answer: string;
      try {
        answer = await ask(`${translator("models.cli.legacyPreviewPrompt")}\n> `);
      } catch (error) {
        if (error instanceof EditAborted) {
          io.write(`${translator("models.cli.edit.abortedDeclined")}\n`);
          return LEGACY_PREVIEW_EXIT_CODES.refused;
        }
        throw error;
      }
      const choice = answer.trim().toLowerCase();
      if (choice === "a" || choice === "") {
        io.write(`${translator("models.cli.edit.abortedDeclined")}\n`);
        return LEGACY_PREVIEW_EXIT_CODES.refused;
      }
      if (choice === "e") break;
    }

    const copyPath = `${options.file}.upgraded.json`;
    // The one write this flow may ever perform targets the explicit sibling
    // path, and even that refuses to clobber an existing file.
    if (fs.existsSync(copyPath)) {
      io.write(`${translator("models.cli.legacyPreviewUpgradedExists", { path: copyPath })}\n`);
      return LEGACY_PREVIEW_EXIT_CODES.refused;
    }
    const candidateRaw = `${JSON.stringify(buildUpgradedCopyDocument(options.parsed), null, 2)}\n`;
    fs.writeFileSync(copyPath, candidateRaw, "utf8");
    io.write(`${translator("models.cli.legacyPreviewUpgraded", { path: copyPath })}\n`);
    return LEGACY_PREVIEW_EXIT_CODES.wroteUpgradedCopy;
  } finally {
    io.close();
  }
}

export function renderModelList(
  result: ModelListResult,
  translator: ModelsCliTranslator = createModelsCliTranslator("en"),
): string {
  if (result.kind === "legacy") {
    return [
      translator("models.cli.legacyDetected", { path: result.documentPath }),
      translator("models.cli.legacyPreviewRefusal"),
    ].join("\n") + "\n";
  }

  if (result.rows.length === 0) return `${translator("models.cli.empty")}\n`;

  const yes = translator("models.cli.flagYes");
  const no = translator("models.cli.flagNo");
  const flag = (value: boolean) => (value ? yes : no);
  interface Cells {
    registration: string;
    model: string;
    deployment: string;
    topology: string;
    selection: string;
    deflt: string;
    registered: string;
    resolvable: string;
    healthy: string;
    session: string;
  }
  const headerCells: Cells = {
    registration: translator("models.cli.header.registration"),
    model: translator("models.cli.header.model"),
    deployment: translator("models.cli.header.deployment"),
    topology: translator("models.cli.header.topology"),
    selection: translator("models.cli.header.selection"),
    deflt: translator("models.cli.header.default"),
    registered: translator("models.cli.header.registered"),
    resolvable: translator("models.cli.header.resolvable"),
    healthy: translator("models.cli.header.healthy"),
    session: translator("models.cli.header.session"),
  };
  const cellsOf = (row: ModelCliRow): Cells => ({
    registration: row.registrationId,
    model: row.modelId,
    deployment: row.deploymentId,
    topology: `${row.harness}/${row.transportKind}${row.protocol === "-" ? "" : `/${row.protocol}`}`,
    selection: row.modelSelection,
    deflt: row.deploymentDefault ? "*" : "",
    registered: flag(row.registered),
    resolvable: flag(row.resolvable),
    healthy: flag(row.healthyStatic),
    session: translator("models.cli.sessionNa"),
  });

  const columns = Object.keys(headerCells) as (keyof Cells)[];
  const widths = columns.map((column) =>
    Math.max(headerCells[column].length, ...result.rows.map((row) => cellsOf(row)[column].length)));
  const line = (cells: Cells) =>
    columns
      .map((column, index) => pad(cells[column], widths[index]!))
      .join("  ")
      .trimEnd();

  const lines = [line(headerCells)];
  for (const row of result.rows) lines.push(line(cellsOf(row)));

  if (result.diagnostics.length > 0) {
    lines.push("", translator("models.cli.diagnostics"));
    for (const message of result.diagnostics) lines.push(`- ${message}`);
  }
  return lines.join("\n") + "\n";
}
