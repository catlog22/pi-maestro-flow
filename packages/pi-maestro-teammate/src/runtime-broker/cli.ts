import * as path from "node:path";
import { probeRuntimeBrokerCapability } from "./capability.ts";
import { acquireRuntimeBrokerDaemonLease } from "./daemon-lease.ts";
import { getRuntimeBrokerStateDirectory } from "./private-state.ts";

interface ParsedOptions {
  command?: "probe" | "serve";
  stateDirectory: string;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: pi-teammate-broker <probe|serve> [options]",
    "",
    "Options:",
    "  --state-dir <path>  Private workspace broker state directory",
    "  --workspace <path>  Workspace used to derive the default state scope",
    "  --help              Show this help",
  ].join("\n");
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const first = args[0];
  const help = first === "--help" || first === "-h" || args.includes("--help") || args.includes("-h");
  const command = first === "probe" || first === "serve" ? first : undefined;
  let workspaceDirectory = process.cwd();
  let explicitStateDirectory: string | undefined;
  for (let index = command ? 1 : (help ? 1 : 0); index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") continue;
    if (argument !== "--state-dir" && argument !== "--workspace") throw new Error(`Unknown option: ${argument}`);
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a path`);
    if (argument === "--state-dir") explicitStateDirectory = path.resolve(value);
    else workspaceDirectory = path.resolve(value);
  }
  return {
    command,
    stateDirectory: explicitStateDirectory ?? getRuntimeBrokerStateDirectory(workspaceDirectory),
    help,
  };
}

async function serve(stateDirectory: string): Promise<void> {
  const { RuntimeBrokerServer } = await import("./server.ts");
  const lease = acquireRuntimeBrokerDaemonLease(stateDirectory);
  let server: InstanceType<typeof RuntimeBrokerServer> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await server?.close();
      } finally {
        lease.release();
      }
    })();
    return closing;
  };
  let resolveSignal: (() => void) | undefined;
  const signal = new Promise<void>((resolve) => { resolveSignal = resolve; });
  const onSignal = () => resolveSignal?.();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    server = new RuntimeBrokerServer({ stateDirectory });
    await server.listen();
    await signal;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await close();
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseOptions(args);
  if (options.help || !options.command) {
    process.stdout.write(`${usage()}\n`);
    return options.help ? 0 : 2;
  }
  if (options.command === "probe") {
    const capability = probeRuntimeBrokerCapability(options.stateDirectory);
    process.stdout.write(`${JSON.stringify(capability)}\n`);
    return capability.ok ? 0 : 1;
  }
  await serve(options.stateDirectory);
  return 0;
}
