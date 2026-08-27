import * as path from "node:path";
import { CompletionOutboxFileStore } from "./file-store.ts";
import { getRuntimeWorkspaceIdentity } from "../runtime-broker/private-state.ts";

interface ParsedOptions {
  command?: "cleanup";
  workspace: string;
  rootDir?: string;
  apply: boolean;
  json: boolean;
  maxEntries?: number;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: pi-teammate-outbox cleanup [options]",
    "",
    "Safely removes obsolete atomic-replacement remnants while preserving the",
    "latest recoverable transaction for every canonical outbox file.",
    "",
    "Options:",
    "  --workspace <path>   Workspace whose outbox is cleaned (default: cwd)",
    "  --root <path>        Completion outbox root directory",
    "  --apply              Delete candidates; without this flag cleanup is dry-run",
    "  --max-entries <n>    Refuse scans larger than n entries (default: 100000)",
    "  --json               Emit one JSON result",
    "  --help               Show this help",
    "",
    "Exit codes: 0 success, 2 usage error, 3 workspace outbox is busy.",
  ].join("\n");
}

function parsePositiveInteger(value: string | undefined, option: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${option} requires a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw new Error(`${option} must be between 1 and 1000000`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const first = args[0];
  const command = first === "cleanup" ? first : undefined;
  const help = args.includes("--help") || args.includes("-h");
  const options: ParsedOptions = {
    command,
    workspace: process.cwd(),
    apply: false,
    json: false,
    help,
  };
  for (let index = command ? 1 : (help ? 1 : 0); index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") continue;
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    const value = args[++index];
    if (argument === "--workspace") {
      if (!value) throw new Error("--workspace requires a path");
      options.workspace = path.resolve(value);
    } else if (argument === "--root") {
      if (!value) throw new Error("--root requires a path");
      options.rootDir = path.resolve(value);
    } else if (argument === "--max-entries") {
      options.maxEntries = parsePositiveInteger(value, argument);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseOptions(args);
  if (options.help || !options.command) {
    process.stdout.write(`${usage()}\n`);
    return options.help ? 0 : 2;
  }

  const identity = getRuntimeWorkspaceIdentity(options.workspace);
  const store = new CompletionOutboxFileStore({
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
  });
  const result = await store.cleanupRemnants(identity.workspaceId, {
    apply: options.apply,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
  const output = {
    workspace: identity.canonicalPath,
    workspaceId: identity.workspaceId,
    rootDir: store.rootDir,
    ...result,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else if (result.busy) {
    process.stderr.write(`Completion outbox is busy for ${identity.canonicalPath}; nothing was removed.\n`);
  } else {
    process.stdout.write([
      `Completion outbox cleanup: ${result.apply ? "applied" : "dry-run"}`,
      `Workspace: ${identity.canonicalPath}`,
      `Scanned: ${result.scannedEntries} entries (${result.replacementFiles} replacement remnants)`,
      `Preserved: ${result.preservedFiles}`,
      `Candidates: ${result.candidateFiles} files, ${result.candidateBytes} bytes`,
      `Removed: ${result.removedFiles} files, ${result.removedBytes} bytes`,
      ...(result.candidateSample.length === 0 ? [] : [
        "Candidate sample:",
        ...result.candidateSample.map((candidate) => `  ${candidate}`),
      ]),
      ...(!result.apply && result.candidateFiles > 0 ? ["Re-run with --apply to remove these candidates."] : []),
    ].join("\n") + "\n");
  }
  return result.busy ? 3 : 0;
}
