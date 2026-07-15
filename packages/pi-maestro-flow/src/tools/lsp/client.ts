import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";
import type { Diagnostic, LspClientLike, LspServerConfig } from "./types.ts";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class LspClient implements LspClientLike {
  readonly capabilities: Record<string, unknown> = {};
  #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #documents = new Map<string, { version: number; content: string }>();
  #diagnostics = new Map<string, Diagnostic[]>();
  #diagnosticWaiters = new Map<string, Set<() => void>>();
  #closed = false;
  #closing = false;
  #closeReported = false;

  private constructor(
    readonly config: LspServerConfig,
    readonly root: string,
    child: ChildProcessWithoutNullStreams,
    readonly onClose?: (error?: Error) => void,
  ) {
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stderr.resume();
    child.stdin.on("error", (error) => this.#closeWithError(error));
    child.on("error", (error) => this.#closeWithError(error));
    child.on("exit", (code, signal) => {
      if (this.#closing) this.#closeGracefully();
      else this.#closeWithError(new Error(`Language server ${config.name} exited (${code ?? signal ?? "unknown"}).`));
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  static async start(
    config: LspServerConfig,
    root: string,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    onClose?: (error?: Error) => void,
  ): Promise<LspClient> {
    const child = crossSpawn(config.command, config.args, {
      cwd: root,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const client = new LspClient(config, root, child, onClose);
    try {
      await waitForSpawn(child, config.name, signal, timeoutMs);
      const initialize = await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
        capabilities: {
          workspace: { applyEdit: false, workspaceEdit: { documentChanges: true }, configuration: true },
          textDocument: {
            synchronization: { didSave: true },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            codeAction: { resolveSupport: { properties: ["edit", "command"] } },
            diagnostic: {},
          },
        },
        initializationOptions: config.initializationOptions,
        clientInfo: { name: "pi-maestro-flow", version: "0.4.8" },
      }, signal, timeoutMs) as { capabilities?: Record<string, unknown> } | undefined;
      Object.assign(client.capabilities, initialize?.capabilities ?? {});
      client.notify("initialized", {});
      if (config.settings !== undefined) client.notify("workspace/didChangeConfiguration", { settings: config.settings });
      return client;
    } catch (error) {
      client.#terminate();
      throw error;
    }
  }

  async ensureFileOpen(file: string): Promise<string> {
    const absolute = path.resolve(file);
    const uri = pathToFileURL(absolute).href;
    const content = await fs.readFile(absolute, "utf8");
    const existing = this.#documents.get(uri);
    if (!existing) {
      this.#documents.set(uri, { version: 1, content });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(absolute), version: 1, text: content },
      });
    } else if (existing.content !== content) {
      const version = existing.version + 1;
      this.#documents.set(uri, { version, content });
      this.#diagnostics.delete(uri);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    return uri;
  }

  request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 20_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`Language server ${this.config.name} is closed.`));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        this.#pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.notify("$/cancelRequest", { id });
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const abort = () => {
        cleanup();
        this.notify("$/cancelRequest", { id });
        reject(abortError());
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
        timer,
        signal,
        abort,
      });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async getDiagnostics(uri: string, waitMs = 600, signal?: AbortSignal): Promise<Diagnostic[]> {
    const diagnosticProvider = this.capabilities.diagnosticProvider;
    if (diagnosticProvider) {
      try {
        const result = await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal, Math.max(waitMs, 1_000)) as { items?: Diagnostic[] } | undefined;
        if (Array.isArray(result?.items)) {
          this.#diagnostics.set(uri, result.items);
          return result.items;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    if (this.#diagnostics.has(uri)) return this.#diagnostics.get(uri) ?? [];
    await this.#waitForDiagnostics(uri, waitMs, signal);
    return this.#diagnostics.get(uri) ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    try {
      await this.request("shutdown", null, undefined, 2_000);
    } catch {}
    try { this.notify("exit", null); } catch {}
    let exited = await waitForExit(this.#child, 1_000);
    if (!exited) {
      try { this.#child.kill(); } catch {}
      exited = await waitForExit(this.#child, 1_000);
    }
    if (!exited) {
      try { this.#child.kill("SIGKILL"); } catch {}
      await waitForExit(this.#child, 1_000);
    }
    this.#closeGracefully();
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed || this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw new Error(`Language server ${this.config.name} input is closed.`);
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    this.#child.stdin.write(frame, (error) => {
      if (error) this.#closeWithError(error);
    });
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      try {
        void this.#handle(JSON.parse(body) as JsonRpcMessage);
      } catch {}
    }
  }

  async #handle(message: JsonRpcMessage): Promise<void> {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error(`LSP error ${message.error.code ?? "unknown"}: ${message.error.message ?? "Unknown error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: Diagnostic[] };
      if (params.uri && Array.isArray(params.diagnostics)) {
        this.#diagnostics.set(params.uri, params.diagnostics);
        for (const wake of this.#diagnosticWaiters.get(params.uri) ?? []) wake();
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      try {
        let result: unknown = null;
        if (message.method === "workspace/configuration") {
          const items = (message.params as { items?: unknown[] })?.items ?? [];
          result = items.map(() => this.config.settings ?? null);
        } else if (message.method === "workspace/applyEdit") {
          result = { applied: false, failureReason: "Workspace edits require an explicit lsp rename or code_actions transaction." };
        }
        this.#write({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }

  #waitForDiagnostics(uri: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.#diagnosticWaiters.get(uri) ?? new Set<() => void>();
      this.#diagnosticWaiters.set(uri, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiters.delete(finish);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        reject(abortError());
      };
      const timer = setTimeout(finish, waitMs);
      signal?.addEventListener("abort", abort, { once: true });
      waiters.add(finish);
    });
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #closeWithError(error: Error): void {
    if (this.#closed) return;
    this.#failAll(error);
    if (!this.#closeReported) {
      this.#closeReported = true;
      this.onClose?.(error);
    }
  }

  #closeGracefully(): void {
    if (!this.#closed) this.#failAll(new Error(`Language server ${this.config.name} shut down.`));
    if (!this.#closeReported) {
      this.#closeReported = true;
      this.onClose?.();
    }
  }

  #terminate(): void {
    this.#closed = true;
    try { this.#child.kill(); } catch {}
    this.#failAll(new Error(`Language server ${this.config.name} terminated.`));
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams, name: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(new Error(`Unable to start ${name}: ${error.message}`)); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    timer = setTimeout(() => { cleanup(); reject(new Error(`Starting language server ${name} timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    const onExit = () => { cleanup(); resolve(true); };
    timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

function languageId(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".py": "python", ".rs": "rust", ".go": "go", ".c": "c", ".h": "c", ".cpp": "cpp",
    ".json": "json", ".jsonc": "jsonc", ".yaml": "yaml", ".yml": "yaml",
  } as Record<string, string>)[extension] ?? (extension.slice(1) || "plaintext");
}

function abortError(): Error {
  const error = new Error("LSP request aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
