import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadRemoteConfig,
  resolveRemoteTarget,
  resolveRemoteWorkspace,
} from "./config.ts";
import {
  ensurePrivateRemoteDirectory,
  getRemoteStateDirectory,
  REMOTE_PRIVATE_FILE_MODE,
} from "./journal.ts";
import {
  createRemoteRequest,
  parseRemoteEnvelopeLine,
  type RemoteJsonRpcEnvelope,
} from "./protocol.ts";
import {
  connectRemoteSocket,
  relayBoundedRemoteStream,
  RemoteBridgeServer,
  REMOTE_DAEMON_LOCK_FILE,
} from "./server.ts";
import { REMOTE_PROTOCOL_VERSION } from "./types.ts";

interface ParsedOptions {
  stateDirectory: string;
  configCwd: string;
  help: boolean;
}

interface DaemonLease {
  release(): void;
}

function usage(): string {
  return [
    "Usage: pi-teammate-remote <serve|connect|doctor> [options]",
    "",
    "Options:",
    "  --state-dir <path>   Private daemon state directory",
    "  --config-cwd <path>  Project directory used to resolve configured targets",
    "  --stdio              Required gateway transport for connect",
    "  --help               Show this help",
  ].join("\n");
}

function parseOptions(args: readonly string[]): { command?: string; options: ParsedOptions; stdio: boolean } {
  const command = args[0] === "--help" || args[0] === "-h" ? undefined : args[0];
  let stateDirectory = getRemoteStateDirectory();
  let configCwd = process.cwd();
  let help = args[0] === "--help" || args[0] === "-h";
  let stdio = false;
  for (let index = command ? 1 : args.length; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--stdio") stdio = true;
    else if (argument === "--state-dir" || argument === "--config-cwd") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === "--state-dir") stateDirectory = path.resolve(value);
      else configCwd = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { command, options: { stateDirectory, configCwd, help }, stdio };
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireDaemonLease(stateDirectory: string): DaemonLease {
  ensurePrivateRemoteDirectory(stateDirectory);
  const lockPath = path.join(stateDirectory, REMOTE_DAEMON_LOCK_FILE);
  const token = randomUUID();
  const create = (): number => fs.openSync(lockPath, "wx", REMOTE_PRIVATE_FILE_MODE);
  let fd: number;
  try {
    fd = create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid remote daemon lock");
      const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      stale = typeof record.pid === "number" && Number.isInteger(record.pid) && !processExists(record.pid);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") stale = true;
      else throw readError;
    }
    if (!stale) throw new Error("Remote bridge daemon is already running");
    fs.rmSync(lockPath, { force: true });
    fd = create();
  }
  fs.writeFileSync(fd, `${JSON.stringify({ version: 1, pid: process.pid, token, startedAt: Date.now() })}\n`, "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return {
    release() {
      try {
        const record = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
        if (record.token === token) fs.rmSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

async function serve(options: ParsedOptions): Promise<void> {
  const lease = acquireDaemonLease(options.stateDirectory);
  let server: RemoteBridgeServer | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      if (server) await server.close();
    } finally {
      lease.release();
    }
  };
  const onSignal = () => { void close(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const config = loadRemoteConfig(options.configCwd);
    const targets = Object.keys(config.targets).map((id) => resolveRemoteTarget(config, id));
    const workspaces = Object.keys(config.workspaces).map((workspaceRef) => resolveRemoteWorkspace(config, workspaceRef));
    server = new RemoteBridgeServer({ stateDirectory: options.stateDirectory, targets, workspaces });
    await server.listen();
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await close();
  }
}

async function connectStdio(options: ParsedOptions): Promise<void> {
  const socket = await connectRemoteSocket(options.stateDirectory);
  const upstream = relayBoundedRemoteStream(process.stdin, socket).finally(() => socket.end());
  const downstream = relayBoundedRemoteStream(socket, process.stdout);
  await Promise.all([upstream, downstream]);
}

async function readOneResponse(socket: NodeJS.ReadWriteStream, request: string, id: string): Promise<RemoteJsonRpcEnvelope> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Timed out waiting for remote daemon")), 3_000);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", finish);
    };
    const finish = (error?: Error, value?: RemoteJsonRpcEnvelope) => {
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish(new Error("Remote doctor response exceeded the line limit"));
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline + 1).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          const envelope = parseRemoteEnvelopeLine(line);
          if ("id" in envelope && envelope.id === id) return finish(undefined, envelope);
        } catch (error) {
          return finish(error as Error);
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", finish);
    socket.write(request);
  });
}

async function doctor(options: ParsedOptions): Promise<boolean> {
  ensurePrivateRemoteDirectory(options.stateDirectory);
  const id = `doctor-${randomUUID()}`;
  try {
    const socket = await connectRemoteSocket(options.stateDirectory);
    const request = createRemoteRequest(id, "remote/initialize", {
      commandId: id,
      protocolVersions: [REMOTE_PROTOCOL_VERSION],
      monitorOwnerNonce: `doctor-${randomUUID()}`,
    });
    const response = await readOneResponse(socket, `${JSON.stringify(request)}\n`, id);
    socket.destroy();
    if (!("result" in response)) throw new Error("Remote daemon rejected initialization");
    process.stdout.write(`${JSON.stringify({ ok: true, stateDirectory: options.stateDirectory, daemon: response.result })}\n`);
    return true;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, stateDirectory: options.stateDirectory, error: error instanceof Error ? error.message : String(error) })}\n`);
    return false;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { command, options, stdio } = parseOptions(args);
  if (options.help || !command) {
    process.stdout.write(`${usage()}\n`);
    return options.help ? 0 : 2;
  }
  if (command === "serve") {
    await serve(options);
    return 0;
  }
  if (command === "connect") {
    if (!stdio) throw new Error("connect currently requires the versioned --stdio gateway transport");
    await connectStdio(options);
    return 0;
  }
  if (command === "doctor") return await doctor(options) ? 0 : 1;
  throw new Error(`Unknown command: ${command}`);
}
