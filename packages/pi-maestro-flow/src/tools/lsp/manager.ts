import * as path from "node:path";
import * as fs from "node:fs/promises";
import { LspClient } from "./client.ts";
import {
  clearLspConfigCache,
  findProjectRoot,
  loadLspConfig,
  serversForFile,
} from "./config.ts";
import type {
  LspClientLike,
  LspManagerLike,
  LspServerConfig,
  ServerStatus,
} from "./types.ts";

export class LspManager implements LspManagerLike {
  #clients = new Map<string, Promise<LspClientLike>>();
  #errors = new Map<string, string>();
  #lifecycle = new AbortController();

  constructor(readonly clientFactory: ClientFactory = (config, root, signal, timeoutMs, onClose) => LspClient.start(config, root, signal, timeoutMs, onClose)) {}

  async clientForFile(file: string, cwd: string, serverName?: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<LspClientLike> {
    const lifecycleSignal = this.#lifecycle.signal;
    const absolute = path.resolve(cwd, file);
    const configs = serversForFile(await loadLspConfig(cwd), absolute)
      .filter((config) => !serverName || config.name === serverName);
    if (configs.length === 0) {
      throw new Error(`No language server is configured for ${path.extname(absolute) || path.basename(absolute)} files.`);
    }
    const errors: string[] = [];
    for (const config of configs) {
      try {
        return await this.#getOrCreate(config, await findProjectRoot(absolute, cwd, config.rootMarkers), signal, timeoutMs, lifecycleSignal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        errors.push(`${config.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Unable to start a language server for ${absolute}: ${errors.join("; ")}`);
  }

  async clientsForWorkspace(cwd: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<LspClientLike[]> {
    const lifecycleSignal = this.#lifecycle.signal;
    const clients: LspClientLike[] = [];
    const errors: string[] = [];
    const configured = await loadLspConfig(cwd);
    const relevant = (await Promise.all(configured.map(async (config) => ({ config, root: await workspaceRootForServer(config, cwd) }))))
      .filter((item): item is { config: LspServerConfig; root: string } => item.root !== undefined);
    const settled = await Promise.allSettled(relevant.map(({ config, root }) => this.#getOrCreate(config, root, signal, timeoutMs, lifecycleSignal)));
    for (let index = 0; index < settled.length; index += 1) {
      const item = settled[index]!;
      if (item.status === "fulfilled") clients.push(item.value);
      else errors.push(`${relevant[index]!.config.name}: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`);
    }
    if (clients.length === 0 && errors.length > 0) {
      throw new Error(`No configured language server could start: ${errors.join("; ")}`);
    }
    return clients;
  }

  async status(cwd: string): Promise<ServerStatus[]> {
    const statuses: ServerStatus[] = [];
    for (const config of await loadLspConfig(cwd)) {
      const matchingKeys = [...this.#clients.keys()].filter((key) => key.startsWith(`${config.name}\0`));
      if (matchingKeys.length === 0) {
        const failedKeys = [...this.#errors.keys()].filter((key) => key.startsWith(`${config.name}\0`));
        if (failedKeys.length > 0) {
          for (const key of failedKeys) {
            statuses.push({
              name: config.name,
              command: config.command,
              root: key.slice(config.name.length + 1),
              state: "error",
              error: this.#errors.get(key),
            });
          }
        } else {
          statuses.push({ name: config.name, command: config.command, root: path.resolve(cwd), state: "configured" });
        }
        continue;
      }
      for (const key of matchingKeys) {
        const root = key.slice(config.name.length + 1);
        const error = this.#errors.get(key);
        if (error) {
          statuses.push({ name: config.name, command: config.command, root, state: "error", error });
          continue;
        }
        try {
          const client = await this.#clients.get(key);
          statuses.push({
            name: config.name,
            command: config.command,
            root,
            state: client?.closed ? "stopped" : "ready",
            capabilities: client?.capabilities,
          });
        } catch (failure) {
          statuses.push({ name: config.name, command: config.command, root, state: "error", error: failure instanceof Error ? failure.message : String(failure) });
        }
      }
    }
    return statuses;
  }

  async reload(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    this.#lifecycle.abort();
    this.#lifecycle = new AbortController();
    clearLspConfigCache();
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#errors.clear();
    await Promise.allSettled(clients.map(async (client) => {
      const ready = await within(client, 3_000);
      if (ready) await within(ready.shutdown(), 3_000);
    }));
  }

  #getOrCreate(
    config: LspServerConfig,
    root: string,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    lifecycleSignal = this.#lifecycle.signal,
  ): Promise<LspClientLike> {
    const key = `${config.name}\0${root}`;
    const existing = this.#clients.get(key);
    if (existing) return existing;
    const combined = combineSignals(signal, lifecycleSignal);
    let created: Promise<LspClientLike>;
    created = this.clientFactory(config, root, combined.signal, timeoutMs, (error) => {
      if (this.#clients.get(key) === created) {
        this.#clients.delete(key);
        if (error) this.#errors.set(key, error.message);
        else this.#errors.delete(key);
      }
      combined.dispose();
    }).then(async (client) => {
      if (this.#clients.get(key) !== created || lifecycleSignal.aborted) {
        combined.dispose();
        await within(client.shutdown(), 3_000);
        throw lifecycleAbortError();
      }
      this.#errors.delete(key);
      combined.dispose();
      return client;
    }).catch((error) => {
      if (this.#clients.get(key) === created) {
        this.#errors.set(key, error instanceof Error ? error.message : String(error));
        this.#clients.delete(key);
      }
      combined.dispose();
      throw error;
    });
    this.#clients.set(key, created);
    return created;
  }
}

type ClientFactory = (
  config: LspServerConfig,
  root: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onClose: (error?: Error) => void,
) => Promise<LspClientLike>;

async function workspaceRootForServer(config: LspServerConfig, cwd: string): Promise<string | undefined> {
  const specificMarkers = config.rootMarkers.filter((marker) => marker !== ".git");
  if (specificMarkers.length === 0) return path.resolve(cwd);
  let current = path.resolve(cwd);
  while (true) {
    for (const marker of specificMarkers) {
      try { await fs.access(path.join(current, marker)); return current; }
      catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() { for (const signal of signals) signal?.removeEventListener("abort", abort); },
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs) as unknown as ReturnType<typeof setTimeout>;
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

function lifecycleAbortError(): Error {
  const error = new Error("LSP startup belongs to a closed lifecycle.");
  error.name = "AbortError";
  return error;
}

export const lspManager = new LspManager();
