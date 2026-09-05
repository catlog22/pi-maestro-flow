/** Command line entry for the packaged Gateway daemon and stdio relay. */
import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";
import { GatewayDaemon } from "./daemon.ts";
import { connectGatewayIpc } from "./ipc.ts";
import { GatewayOwnerActiveError } from "./owner-store.ts";
import type { GatewayOwnerRecord } from "./contracts.ts";
import { GATEWAY_OFFLINE_MESSAGE, relayGatewayStdio } from "./stdio-relay.ts";

export interface GatewayCliIo {
  stdout?: Writable;
  stderr?: Writable;
}

interface ServeFlags {
  configPath?: string;
  host?: string;
  port?: number;
  http?: boolean;
  json: boolean;
}

function write(stream: Writable, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function parseServeFlags(args: string[]): ServeFlags {
  const result: ServeFlags = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--no-http") result.http = false;
    else if (arg === "--http") result.http = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else if (arg === "--host") result.host = requiredValue(args, ++index, arg);
    else if (arg === "--port") {
      const value = Number(requiredValue(args, ++index, arg));
      if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer in [0, 65535]");
      result.port = value;
    } else throw new Error(`Unknown serve option: ${arg}`);
  }
  return result;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch { /* packaging errors are reported with a stable protocol version */ }
  return "0.0.0";
}

export async function main(argv = process.argv.slice(2), io: GatewayCliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const [command = "help", ...args] = argv;
  try {
    if (command === "version" || command === "--version" || command === "-v") {
      const version = await packageVersion();
      if (args.includes("--json")) write(stdout, JSON.stringify({ name: "pi-maestro-gateway", version, protocolVersion: 1 }));
      else write(stdout, `pi-maestro-gateway ${version}`);
      return 0;
    }
    if (command === "connect") {
      if (args.length !== 1 || args[0] !== "--stdio") throw new Error("Usage: pi-maestro-gateway connect --stdio");
      await relayGatewayStdio();
      return 0;
    }
    if (command === "serve") {
      const flags = parseServeFlags(args);
      const daemon = new GatewayDaemon({
        configPath: flags.configPath,
        http: flags.http,
        httpHost: flags.host,
        httpPort: flags.port,
      });
      try {
        await daemon.start();
      } catch (error) {
        if (!(error instanceof GatewayOwnerActiveError) || !error.owner.socket) throw error;
        await waitForExistingGateway(error.owner);
        write(stdout, flags.json ? JSON.stringify({ ok: true, status: "already-running", owner: error.owner }) : `Pi Maestro Gateway is already running (pid ${error.owner.pid}).`);
        return 0;
      }
      const summary = {
        ok: true,
        status: "running",
        pid: process.pid,
        socket: daemon.ipc?.address,
        http: daemon.http?.url,
      };
      write(stdout, flags.json ? JSON.stringify(summary) : `Pi Maestro Gateway running${summary.http ? ` at ${summary.http}` : ""}.`);
      await waitForShutdown(async () => daemon.stop(), daemon.waitUntilStopped());
      return 0;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      write(stdout, [
        "Usage: pi-maestro-gateway <command>",
        "",
        "Commands:",
        "  serve [--config PATH] [--host HOST] [--port PORT] [--no-http] [--json]",
        "  connect --stdio",
        "  version [--json]",
      ].join("\n"));
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(stderr, message || GATEWAY_OFFLINE_MESSAGE);
    return 1;
  }
}

async function waitForExistingGateway(owner: GatewayOwnerRecord): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const socket = await connectGatewayIpc({ address: owner.socket!, ownerToken: owner.ownerToken, timeoutMs: 500 });
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Existing Gateway did not become healthy");
}

async function waitForShutdown(stop: () => Promise<void>, stopped: Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    const onSignal = (): void => {
      if (stopping) return;
      void stop().finally(finish);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    void stopped.then(finish);
  });
}
