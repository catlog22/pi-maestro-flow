import * as fs from "node:fs";
import * as path from "node:path";
import { parseModelsCliLocale, createModelsCliTranslator } from "./cli-i18n.ts";
import { buildModelList, renderLegacyUpgradeSkeleton, renderModelList, runLegacyPreviewFlow } from "./cli-list.ts";
import { runEditFlow, createReadlineEditIO, type EditFlowIO } from "./cli-edit.ts";
import { runAddFlow } from "./cli-add.ts";

export const DEFAULT_MANIFEST_PATH = ".pi/teammate-backends.json";

interface ParsedOptions {
  file: string;
  /** Undefined only after an invalid --locale value; defaults to "en". */
  locale?: ReturnType<typeof parseModelsCliLocale>;
  yes: boolean;
}

function usage(): string {
  return [
    "Usage: pi-teammate-models <list|path|edit|add> [options]",
    "",
    "Commands:",
    "  list                List registered model routes (static; no backend module loading)",
    "  path                Print the resolved registry document path",
    "  edit                Interactively edit a deployment's configuration",
    "  add                 Interactively register a new deployment and model",
    "",
    "Options:",
    `  --file <path>       Registry document path (default: ${DEFAULT_MANIFEST_PATH})`,
    "  --locale en|zh-CN   Output language (default: en)",
    "  --yes               Pre-confirm interactive confirmations (edit/add: overwrite external changes)",
    "  --help              Show this help",
    "",
    "Backups & undo:",
    "  Every write rotates backups: <file>.bak holds the previous document and",
    "  <file>.bak.1 the one before it. Undo a write by copying <file>.bak back",
    "  over <file>. Legacy documents are never written; list/edit offer an",
    "  explicitly written upgraded v2 copy (<file>.upgraded.json) instead.",
  ].join("\n");
}

function parseOptions(args: readonly string[]): { command?: string; options: ParsedOptions; help: boolean } {
  let command: string | undefined;
  const options: ParsedOptions = { file: DEFAULT_MANIFEST_PATH, locale: "en", yes: false };
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--file") {
      const value = args[++index];
      if (!value) throw new Error("--file requires a path");
      options.file = value;
    } else if (argument === "--locale") {
      const value = args[++index];
      if (!value) throw new Error("--locale requires a value");
      options.locale = parseModelsCliLocale(value);
    } else if (argument === "--yes") {
      // Pre-confirms the edit/add flows' external-change confirmation
      // (documented last-writer-wins).
      options.yes = true;
    } else if (argument !== undefined && !argument.startsWith("-") && command === undefined) {
      command = argument;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { command, options, help };
}

export async function main(args = process.argv.slice(2), io?: EditFlowIO): Promise<number> {
  const { command, options, help } = parseOptions(args);
  if (help || !command) {
    process.stdout.write(`${usage()}\n`);
    return help ? 0 : 2;
  }

  if (command === "path") {
    process.stdout.write(`${path.resolve(options.file)}\n`);
    return 0;
  }

  if (options.locale === undefined) throw new Error(`--locale must be one of en | zh-CN`);

  if (command === "list") {
    const raw = fs.readFileSync(path.resolve(options.file), "utf8");
    // When an IO seam exists (embedded or scripted runs), the preview renders
    // through it; bare CLI runs use the hook's stdout rendering.
    const result = buildModelList(raw, options.file, io === undefined ? {} : {
      legacyPreviewHook: (documentPath, parsed) => {
        io.write(renderLegacyUpgradeSkeleton(parsed, documentPath));
      },
    });
    process.stdout.write(renderModelList(result, createModelsCliTranslator(options.locale)));
    if (result.kind === "legacy") {
      // The preview skeleton was rendered by the hook during buildModelList;
      // what remains is the hard-refusal offer, whose default is abort.
      return runLegacyPreviewFlow({
        file: path.resolve(options.file),
        parsed: result.parsed,
        locale: options.locale,
        io: io ?? createReadlineEditIO(),
      });
    }
    return 0;
  }

  if (command === "edit") {
    return runEditFlow({
      file: path.resolve(options.file),
      yes: options.yes,
      locale: options.locale,
      ...(io === undefined ? {} : { io }),
    });
  }

  if (command === "add") {
    return runAddFlow({
      file: path.resolve(options.file),
      yes: options.yes,
      locale: options.locale,
      ...(io === undefined ? {} : { io }),
    });
  }

  throw new Error(`Unknown command: ${command}`);
}
