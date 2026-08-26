import * as path from "node:path";
import { probeRuntimeBrokerCapability } from "./capability.ts";
import {
  acquireRuntimeBrokerDaemonLease,
  type RuntimeBrokerDaemonLease,
} from "./daemon-lease.ts";
import { getRuntimeBrokerStateDirectory } from "./private-state.ts";

interface ParsedOptions {
  command?: "probe" | "serve";
  stateDirectory: string;
  daemonToken?: string;
  daemonGeneration?: string;
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
  let daemonToken: string | undefined;
  let daemonGeneration: string | undefined;
  for (let index = command ? 1 : (help ? 1 : 0); index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") continue;
    if (argument !== "--state-dir"
      && argument !== "--workspace"
      && argument !== "--daemon-token"
      && argument !== "--daemon-generation") {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === "--state-dir") explicitStateDirectory = path.resolve(value);
    else if (argument === "--workspace") workspaceDirectory = path.resolve(value);
    else if (argument === "--daemon-token") daemonToken = value;
    else daemonGeneration = value;
  }
  if ((daemonToken === undefined) !== (daemonGeneration === undefined)) {
    throw new Error("--daemon-token and --daemon-generation must be provided together");
  }
  return {
    command,
    stateDirectory: explicitStateDirectory ?? getRuntimeBrokerStateDirectory(workspaceDirectory),
    daemonToken,
    daemonGeneration,
    help,
  };
}

async function serve(options: ParsedOptions): Promise<void> {
  const { RuntimeBrokerServer } = await import("./server.ts");
  let lease: RuntimeBrokerDaemonLease | undefined;
  let server: InstanceType<typeof RuntimeBrokerServer> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      const errors: unknown[] = [];
      const currentServer = server;
      const currentLease = lease;
      server = undefined;
      lease = undefined;
      try {
        await currentServer?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        currentLease?.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, "Runtime broker daemon shutdown failed");
    })();
    return closing;
  };
  let resolveSignal: (() => void) | undefined;
  let stopRequested = false;
  const signal = new Promise<void>((resolve) => { resolveSignal = resolve; });
  const onSignal = () => {
    stopRequested = true;
    resolveSignal?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    lease = await acquireRuntimeBrokerDaemonLease(options.stateDirectory, {
      ...(options.daemonToken === undefined ? {} : { token: () => options.daemonToken! }),
      ...(options.daemonGeneration === undefined ? {} : { generation: () => options.daemonGeneration! }),
    });
    if (stopRequested) return;
    const daemonLease = lease;
    server = new RuntimeBrokerServer({
      stateDirectory: options.stateDirectory,
      daemonToken: daemonLease.token,
      daemonGeneration: daemonLease.generation,
      assertDaemonAuthority: () => daemonLease.assertOwned(),
    });
    lease.assertOwned();
    if (stopRequested) return;
    await server.listen();
    lease.assertOwned();
    if (!stopRequested) await signal;
  } finally {
    resolveSignal = undefined;
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
  await serve(options);
  return 0;
}
