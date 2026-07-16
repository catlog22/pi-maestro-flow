import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";
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

interface DocumentState {
  version: number;
  content: string;
  bytes: number;
}

export interface LspClientCacheLimits {
  maxDocumentEntries: number;
  maxDocumentBytes: number;
  maxDiagnosticEntries: number;
  maxDiagnosticBytes: number;
  maxDiagnosticWaiters: number;
}

export interface LspClientCacheStats {
  documentEntries: number;
  documentBytes: number;
  documentEvictions: number;
  diagnosticEntries: number;
  diagnosticBytes: number;
  diagnosticEvictions: number;
  diagnosticWaiterUris: number;
  diagnosticWaiters: number;
}

export interface LspTransportLimits {
  maxHeaderBytes: number;
  maxContentLengthBytes: number;
}

export const DEFAULT_LSP_CLIENT_CACHE_LIMITS: Readonly<LspClientCacheLimits> = Object.freeze({
  maxDocumentEntries: 64,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxDiagnosticEntries: 128,
  maxDiagnosticBytes: 4 * 1024 * 1024,
  maxDiagnosticWaiters: 256,
});

export const DEFAULT_LSP_TRANSPORT_LIMITS: Readonly<LspTransportLimits> = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  maxContentLengthBytes: 16 * 1024 * 1024,
});

export class LspClient implements LspClientLike {
  readonly capabilities: Record<string, unknown> = {};
  #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #documents = new Map<string, DocumentState>();
  #diagnostics = new Map<string, Diagnostic[]>();
  #diagnosticWeights = new Map<string, number>();
  #diagnosticWaiters = new Map<string, Set<() => void>>();
  #documentBytes = 0;
  #diagnosticBytes = 0;
  #diagnosticWaiterCount = 0;
  #documentEvictions = 0;
  #diagnosticEvictions = 0;
  #closed = false;
  #closing = false;
  #closeReported = false;

  private constructor(
    readonly config: LspServerConfig,
    readonly root: string,
    child: ChildProcessWithoutNullStreams,
    readonly onClose?: (error?: Error) => void,
    readonly cacheLimits: Readonly<LspClientCacheLimits> = DEFAULT_LSP_CLIENT_CACHE_LIMITS,
    readonly transportLimits: Readonly<LspTransportLimits> = DEFAULT_LSP_TRANSPORT_LIMITS,
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

  get cacheStats(): Readonly<LspClientCacheStats> {
    return Object.freeze({
      documentEntries: this.#documents.size,
      documentBytes: this.#documentBytes,
      documentEvictions: this.#documentEvictions,
      diagnosticEntries: this.#diagnostics.size,
      diagnosticBytes: this.#diagnosticBytes,
      diagnosticEvictions: this.#diagnosticEvictions,
      diagnosticWaiterUris: this.#diagnosticWaiters.size,
      diagnosticWaiters: this.#diagnosticWaiterCount,
    });
  }

  static async start(
    config: LspServerConfig,
    root: string,
    signal?: AbortSignal,
    timeoutMs = 20_000,
    onClose?: (error?: Error) => void,
    cacheLimits: Readonly<LspClientCacheLimits> = DEFAULT_LSP_CLIENT_CACHE_LIMITS,
    transportLimits: Readonly<LspTransportLimits> = DEFAULT_LSP_TRANSPORT_LIMITS,
  ): Promise<LspClient> {
    validateCacheLimits(cacheLimits);
    validateTransportLimits(transportLimits);
    const child = crossSpawn(config.command, config.args, {
      cwd: root,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const client = new LspClient(
      config,
      root,
      child,
      onClose,
      Object.freeze({ ...cacheLimits }),
      Object.freeze({ ...transportLimits }),
    );
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
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cacheLimits.maxDocumentBytes) {
      throw new RangeError(
        `LSP document ${absolute} is ${bytes} bytes, exceeding the ${this.cacheLimits.maxDocumentBytes}-byte client limit.`,
      );
    }
    const existing = this.#documents.get(uri);
    if (!existing) {
      this.#setDocument(uri, { version: 1, content, bytes });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(absolute), version: 1, text: content },
      });
    } else if (existing.content !== content) {
      const version = existing.version + 1;
      this.#setDocument(uri, { version, content, bytes });
      this.#deleteDiagnostics(uri);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    } else {
      this.#touchDocument(uri);
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
    if (this.#closed) throw new Error(`Language server ${this.config.name} is closed.`);
    const diagnosticProvider = this.capabilities.diagnosticProvider;
    if (diagnosticProvider) {
      try {
        const result = await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal, Math.max(waitMs, 1_000)) as { items?: Diagnostic[] } | undefined;
        if (Array.isArray(result?.items)) {
          this.#setDiagnostics(uri, result.items);
          return result.items;
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    if (this.#diagnostics.has(uri)) return this.#touchDiagnostics(uri);
    await this.#waitForDiagnostics(uri, waitMs, signal);
    return this.#diagnostics.has(uri) ? this.#touchDiagnostics(uri) : [];
  }

  async shutdown(): Promise<void> {
    if (this.#closed) {
      this.#clearCaches(false);
      if (!await waitForExit(this.#child, 1_000)) {
        try { this.#child.kill("SIGKILL"); } catch {}
        await waitForExit(this.#child, 1_000);
      }
      return;
    }
    this.#closing = true;
    this.#clearCaches(true);
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

  #setDocument(uri: string, document: DocumentState): void {
    const previous = this.#documents.get(uri);
    if (previous) this.#documentBytes -= previous.bytes;
    this.#documents.delete(uri);
    this.#documents.set(uri, document);
    this.#documentBytes += document.bytes;
    while (
      this.#documents.size > this.cacheLimits.maxDocumentEntries
      || this.#documentBytes > this.cacheLimits.maxDocumentBytes
    ) {
      const oldestUri = this.#documents.keys().next().value as string | undefined;
      if (!oldestUri) break;
      this.#evictDocument(oldestUri);
    }
  }

  #touchDocument(uri: string): void {
    const document = this.#documents.get(uri);
    if (!document) return;
    this.#documents.delete(uri);
    this.#documents.set(uri, document);
  }

  #evictDocument(uri: string): void {
    const document = this.#documents.get(uri);
    if (!document) return;
    this.#documents.delete(uri);
    this.#documentBytes -= document.bytes;
    this.#documentEvictions += 1;
    this.#deleteDiagnostics(uri);
    this.#wakeDiagnosticWaiters(uri);
    try {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    } catch {}
  }

  #setDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    const bytes = Buffer.byteLength(JSON.stringify(diagnostics), "utf8");
    this.#deleteDiagnostics(uri);
    if (bytes > this.cacheLimits.maxDiagnosticBytes) return;
    this.#diagnostics.set(uri, diagnostics);
    this.#diagnosticWeights.set(uri, bytes);
    this.#diagnosticBytes += bytes;
    while (
      this.#diagnostics.size > this.cacheLimits.maxDiagnosticEntries
      || this.#diagnosticBytes > this.cacheLimits.maxDiagnosticBytes
    ) {
      const oldestUri = this.#diagnostics.keys().next().value as string | undefined;
      if (!oldestUri) break;
      this.#deleteDiagnostics(oldestUri);
      this.#diagnosticEvictions += 1;
    }
  }

  #touchDiagnostics(uri: string): Diagnostic[] {
    const diagnostics = this.#diagnostics.get(uri) ?? [];
    this.#diagnostics.delete(uri);
    this.#diagnostics.set(uri, diagnostics);
    return diagnostics;
  }

  #deleteDiagnostics(uri: string): void {
    if (!this.#diagnostics.has(uri)) return;
    this.#diagnosticBytes -= this.#diagnosticWeights.get(uri) ?? 0;
    this.#diagnostics.delete(uri);
    this.#diagnosticWeights.delete(uri);
  }

  #wakeDiagnosticWaiters(uri: string): void {
    for (const wake of [...(this.#diagnosticWaiters.get(uri) ?? [])]) wake();
  }

  #clearCaches(notifyClose: boolean): void {
    const documentUris = [...this.#documents.keys()];
    this.#documents.clear();
    this.#documentBytes = 0;
    this.#diagnostics.clear();
    this.#diagnosticWeights.clear();
    this.#diagnosticBytes = 0;
    for (const uri of [...this.#diagnosticWaiters.keys()]) this.#wakeDiagnosticWaiters(uri);
    this.#diagnosticWaiters.clear();
    this.#diagnosticWaiterCount = 0;
    if (notifyClose) {
      for (const uri of documentUris) {
        try {
          this.notify("textDocument/didClose", { textDocument: { uri } });
        } catch {}
      }
    }
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed || this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw new Error(`Language server ${this.config.name} input is closed.`);
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > this.transportLimits.maxContentLengthBytes) {
      throw new RangeError(
        `LSP message is ${body.length} bytes, exceeding the ${this.transportLimits.maxContentLengthBytes}-byte frame limit.`,
      );
    }
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    this.#child.stdin.write(frame, (error) => {
      if (error) this.#closeWithError(error);
    });
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    const maxBufferedBytes = this.transportLimits.maxHeaderBytes + 4 + this.transportLimits.maxContentLengthBytes;
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      const available = maxBufferedBytes - this.#buffer.length;
      if (available <= 0) {
        this.#failProtocol(`buffer exceeded ${maxBufferedBytes} bytes`);
        return;
      }
      const end = Math.min(chunk.length, offset + available);
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(offset, end)]);
      offset = end;
      this.#drainBuffer();
    }
  }

  #drainBuffer(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.#buffer.length > this.transportLimits.maxHeaderBytes + 3) {
          this.#failProtocol(`header exceeded ${this.transportLimits.maxHeaderBytes} bytes without a terminator`);
        }
        return;
      }
      if (headerEnd > this.transportLimits.maxHeaderBytes) {
        this.#failProtocol(`header exceeded ${this.transportLimits.maxHeaderBytes} bytes`);
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const contentLengthHeaders = header
        .split("\r\n")
        .filter((line) => /^Content-Length\s*:/i.test(line));
      if (contentLengthHeaders.length !== 1) {
        this.#failProtocol(contentLengthHeaders.length === 0 ? "missing Content-Length header" : "duplicate Content-Length headers");
        return;
      }
      const match = /^Content-Length:\s*(\d+)\s*$/i.exec(contentLengthHeaders[0]!);
      const length = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(length) || length < 0) {
        this.#failProtocol("invalid Content-Length header");
        return;
      }
      if (length > this.transportLimits.maxContentLengthBytes) {
        this.#failProtocol(
          `Content-Length ${length} exceeds the ${this.transportLimits.maxContentLengthBytes}-byte frame limit`,
        );
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      try {
        void this.#handle(JSON.parse(body) as JsonRpcMessage);
      } catch {
        this.#failProtocol("body is not valid JSON");
        return;
      }
    }
  }

  #failProtocol(reason: string): void {
    const error = new Error(`Invalid LSP frame from ${this.config.name}: ${reason}.`);
    this.#closeWithError(error);
    try { this.#child.kill(); } catch {}
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
        this.#setDiagnostics(params.uri, params.diagnostics);
        this.#wakeDiagnosticWaiters(params.uri);
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
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.#diagnosticWaiterCount >= this.cacheLimits.maxDiagnosticWaiters) {
      return Promise.reject(new Error(`Too many pending LSP diagnostic waiters (max ${this.cacheLimits.maxDiagnosticWaiters}).`));
    }
    return new Promise((resolve, reject) => {
      const waiters = this.#diagnosticWaiters.get(uri) ?? new Set<() => void>();
      this.#diagnosticWaiters.set(uri, waiters);
      let settled = false;
      const remove = () => {
        if (!waiters.delete(finish)) return;
        this.#diagnosticWaiterCount -= 1;
        if (waiters.size === 0) this.#diagnosticWaiters.delete(uri);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        remove();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        remove();
        reject(abortError());
      };
      const timer = setTimeout(finish, waitMs);
      waiters.add(finish);
      this.#diagnosticWaiterCount += 1;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
    this.#clearCaches(false);
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

function validateCacheLimits(limits: Readonly<LspClientCacheLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`LSP client cache limit ${name} must be a positive integer.`);
    }
  }
}

function validateTransportLimits(limits: Readonly<LspTransportLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`LSP transport limit ${name} must be a positive integer.`);
    }
  }
  if (limits.maxHeaderBytes + 4 + limits.maxContentLengthBytes > bufferConstants.MAX_LENGTH) {
    throw new RangeError("Combined LSP transport limits exceed the maximum Buffer length.");
  }
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
