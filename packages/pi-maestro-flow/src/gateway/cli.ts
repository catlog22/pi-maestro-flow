/** Command line entry for the packaged Gateway daemon and stdio relay. */
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { GatewayDaemon } from "./daemon.ts";
import { connectGatewayIpc, requestGatewayIpcControl } from "./ipc.ts";
import { GatewayOwnerActiveError, GatewayOwnerStore } from "./owner-store.ts";
import type { GatewayOwnerRecord } from "./contracts.ts";
import { GATEWAY_OFFLINE_MESSAGE, relayGatewayStdio } from "./stdio-relay.ts";
import { GatewayResidentService } from "./resident-service.ts";
import { loadGatewayConfig } from "./config.ts";
import { applyPiConfigStream, serializePiConfigApplyError } from "./pi-config-apply.ts";

export interface GatewayCliIo {
  stdin?: Readable;
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

interface ServiceFlags {
  configPath?: string;
  json: boolean;
  detachedFallback: boolean;
  windowsStartup: boolean;
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

function parseServiceFlags(args: string[]): ServiceFlags {
  const result: ServiceFlags = { json: false, detachedFallback: false, windowsStartup: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") result.json = true;
    else if (arg === "--detached-fallback") result.detachedFallback = true;
    else if (arg === "--windows-startup") result.windowsStartup = true;
    else if (arg === "--config") result.configPath = requiredValue(args, ++index, arg);
    else throw new Error(`Unknown service option: ${arg}`);
  }
  if (result.detachedFallback && result.windowsStartup) throw new Error("--windows-startup and --detached-fallback are mutually exclusive");
  if (result.windowsStartup && process.platform !== "win32") throw new Error("--windows-startup is only available on Windows");
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
  const stdin = io.stdin ?? process.stdin;
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
    if (command === "config-sync") {
      if (args.length !== 1 || args[0] !== "apply") throw new Error("Usage: pi-maestro-gateway config-sync apply");
      write(stdout, JSON.stringify(await applyPiConfigStream(stdin)));
      return 0;
    }
    if (command === "service-run") {
      const tokenIndex = args.indexOf("--installation-token");
      if (tokenIndex < 0) throw new Error("service-run requires --installation-token");
      const installationToken = requiredValue(args, tokenIndex + 1, "--installation-token");
      const configIndex = args.indexOf("--config");
      const configPath = configIndex < 0 ? undefined : requiredValue(args, configIndex + 1, "--config");
      const serviceConfig = await loadGatewayConfig(configPath);
      const resident = new GatewayResidentService({
        configPath,
        manifestPath: serviceConfig.state.serviceManifestPath,
        ownerPath: serviceConfig.state.ownerPath,
        allowDetachedFallback: args.includes("--detached-fallback") || (process.platform !== "win32" && process.platform !== "linux"),
      });
      await resident.validateServiceRun(installationToken, process.execPath, process.argv.slice(1), process.cwd());
      const daemon = new GatewayDaemon({ configPath, commandIdentity: process.argv.join(" ") });
      await daemon.start();
      await waitForShutdown(async () => daemon.stop(), daemon.waitUntilStopped());
      return 0;
    }
    if (command === "service") {
      const action = args[0];
      if (!action || !["install", "ensure", "start", "stop", "restart", "status", "uninstall"].includes(action)) throw new Error("Usage: pi-maestro-gateway service install|ensure|start|stop|restart|status|uninstall [--json]");
      const flags = parseServiceFlags(args.slice(1));
      const executableArg = process.argv[1];
      const serviceConfig = await loadGatewayConfig(flags.configPath);
      const resident = new GatewayResidentService({
        configPath: flags.configPath,
        manifestPath: serviceConfig.state.serviceManifestPath,
        ownerPath: serviceConfig.state.ownerPath,
        command: process.execPath,
        argsPrefix: executableArg ? [executableArg] : [],
        allowDetachedFallback: flags.detachedFallback,
        ...(flags.windowsStartup ? { preferredKind: "windows-startup" as const } : {}),
      });
      const value = action === "install" ? await (() => resident.install().then((manifest) => ({
        installed: true,
        kind: manifest.kind,
        installationId: manifest.installationId,
        installedAt: manifest.installedAt,
      })))()
        : action === "ensure" ? await resident.ensure()
          : action === "start" ? await resident.start()
            : action === "stop" ? await resident.stop()
              : action === "restart" ? await resident.restart()
                : action === "status" ? await resident.status()
                  : await resident.uninstall();
      write(stdout, flags.json ? JSON.stringify(value) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
      return 0;
    }
    if (command === "pair") {
      const action = args[0];
      if (!action || !["create", "bootstrap", "list", "revoke"].includes(action)) throw new Error("Usage: pi-maestro-gateway pair create|bootstrap|list|revoke [ID] [--ttl SECONDS] [--label LABEL]");
      const configIndex = args.indexOf("--config");
      const config = await loadGatewayConfig(configIndex < 0 ? undefined : requiredValue(args, configIndex + 1, "--config"));
      const owner = await new GatewayOwnerStore({ ownerPath: config.state.ownerPath }).read();
      if (!owner?.socket) throw new Error(GATEWAY_OFFLINE_MESSAGE);
      const ttlIndex = args.indexOf("--ttl");
      const labelIndex = args.indexOf("--label");
      const data = action === "create" || action === "bootstrap" ? {
        ...(ttlIndex < 0 ? {} : { ttlMs: Number(requiredValue(args, ttlIndex + 1, "--ttl")) * 1000 }),
        ...(labelIndex < 0 ? {} : { label: requiredValue(args, labelIndex + 1, "--label") }),
      } : action === "revoke" ? { id: requiredValue(args, 1, "revoke") } : undefined;
      const value = await requestGatewayIpcControl({ address: owner.socket, ownerToken: owner.ownerToken, action: action === "create" ? "pair" : action === "bootstrap" ? "pair-bootstrap" : action === "list" ? "pair-list" : "pair-revoke", ...(data ? { data } : {}) });
      write(stdout, JSON.stringify(value));
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
        "  config-sync apply",
        "  service install|ensure|start|stop|restart|status|uninstall [--config PATH] [--json]",
        "    install|ensure [--windows-startup | --detached-fallback]",
        "    --windows-startup persists for the next interactive sign-in; it is not a Windows Service.",
        "    In a non-interactive SSH session, ensure guarantees readiness only until that session ends.",
        "  pair create|bootstrap|list|revoke [ID]",
        "  version [--json]",
      ].join("\n"));
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (command === "config-sync") write(stderr, serializePiConfigApplyError(error));
    else {
      const message = error instanceof Error ? error.message : String(error);
      write(stderr, message || GATEWAY_OFFLINE_MESSAGE);
    }
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
