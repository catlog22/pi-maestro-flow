import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { guiLogger as log } from "./logger.ts";
import {
  GUI_DISCOVERY_FILENAME,
  type GuiDiscoveryFile,
  type GuiEnvelope,
  type GuiHttpMethod,
  type GuiRequest,
  type GuiRouteHandler,
  type GuiRouteResult,
  type GuiServerHandle,
  type GuiServerOptions,
} from "./types.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_EVENT_LOG = 256;
const MAX_EVENT_LOG_BYTES = 2 * 1024 * 1024;

interface RouteEntry {
  method: GuiHttpMethod;
  segments: string[];
  handler: GuiRouteHandler;
}

interface EventLogEntry {
  id: number;
  name: string;
  chunk: string;
  bytes: number;
}

const discoveryOwners = new Map<string, string>();
const discoveryOperations = new Map<string, Promise<void>>();

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function withDiscoveryPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = discoveryOperations.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  discoveryOperations.set(path, settled);
  try {
    return await current;
  } finally {
    if (discoveryOperations.get(path) === settled) discoveryOperations.delete(path);
  }
}

async function ensurePrivateDiscoveryDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unsafe GUI discovery directory: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unsafe GUI discovery directory: ${path}`);
    }
  }
  await chmod(path, 0o700);
}

async function assertRegularDiscoveryDestination(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to replace non-regular GUI discovery file: ${path}`);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

async function publishDiscoveryFile(
  directory: string,
  path: string,
  discovery: GuiDiscoveryFile,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  return withDiscoveryPathLock(path, async () => {
    if (!isCurrent()) return false;
    await ensurePrivateDiscoveryDirectory(directory);
    if (!isCurrent()) return false;
    await assertRegularDiscoveryDestination(path);

    const tempPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(tempPath, "wx", 0o600);
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(discovery, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;

      await assertRegularDiscoveryDestination(path);
      if (!isCurrent()) return false;
      await rename(tempPath, path);
      discoveryOwners.set(path, discovery.ownerToken);
      return true;
    } finally {
      if (file) {
        try {
          await file.close();
        } catch {
          // Preserve the publication failure; the temp path is removed below.
        }
      }
      await rm(tempPath, { force: true });
    }
  });
}

async function removeOwnedDiscovery(path: string, ownerToken: string): Promise<void> {
  await withDiscoveryPathLock(path, async () => {
    if (discoveryOwners.get(path) !== ownerToken) return;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      const parsed = JSON.parse(await readFile(path, "utf8")) as { ownerToken?: unknown };
      if (parsed.ownerToken !== ownerToken) {
        discoveryOwners.delete(path);
        return;
      }
      await rm(path);
      if (discoveryOwners.get(path) === ownerToken) discoveryOwners.delete(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        if (discoveryOwners.get(path) === ownerToken) discoveryOwners.delete(path);
        return;
      }
      throw error;
    }
  });
}

export async function createGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const token = options.token ?? randomUUID();
  const sessionId = options.sessionId;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const eventLogMaxBytes = Math.max(1, options.eventLogMaxBytes ?? MAX_EVENT_LOG_BYTES);

  const sseClients = new Set<ServerResponse>();
  const closeHandlers = new Set<(reason: string) => void>();
  const routes: RouteEntry[] = [];
  const eventLog: EventLogEntry[] = [];
  let eventLogBytes = 0;
  let nextEventId = 1;
  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let discoveryPath: string | undefined;
  const discoveryOwnerToken = randomUUID();

  const serializeEvent = (id: number, name: string, payload: unknown): string =>
    `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

  const pushEvent = (name: string, payload: unknown): void => {
    if (closed) return;
    const id = nextEventId++;
    const chunk = serializeEvent(id, name, payload);
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (bytes <= eventLogMaxBytes) {
      eventLog.push({ id, name, chunk, bytes });
      eventLogBytes += bytes;
      while (eventLog.length > MAX_EVENT_LOG || eventLogBytes > eventLogMaxBytes) {
        const evicted = eventLog.shift();
        if (!evicted) break;
        eventLogBytes -= evicted.bytes;
      }
    }
    for (const client of sseClients) {
      try {
        client.write(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const replayEvents = (res: ServerResponse, lastEventIdHeader?: string | null): void => {
    const parsed = lastEventIdHeader ? Number(lastEventIdHeader) : Number.NaN;
    const toReplay = Number.isFinite(parsed)
      ? eventLog.filter((entry) => entry.id > parsed)
      : eventLog;
    for (const entry of toReplay) {
      try {
        res.write(entry.chunk);
      } catch {
        sseClients.delete(res);
        return;
      }
    }
  };

  const registerRoute = (method: GuiHttpMethod, pattern: string, handler: GuiRouteHandler): void => {
    const segments = pattern.split("/").filter((segment) => segment.length > 0);
    routes.push({ method, segments, handler });
  };

  const matchRoute = (
    method: string,
    pathname: string,
  ): { handler: GuiRouteHandler; params: Record<string, string> } | undefined => {
    const pathSegments = pathname.split("/").filter((segment) => segment.length > 0);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const expected = route.segments[i];
        const actual = pathSegments[i];
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  };

  const sendEnvelope = <T>(res: ServerResponse, status: number, payload: GuiEnvelope<T>): void => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
  };

  const extractToken = (req: IncomingMessage, url: URL, body?: Record<string, unknown>): string | null => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
    const queryToken = url.searchParams.get("session") ?? url.searchParams.get("token");
    if (queryToken) return queryToken;
    if (body && typeof body.token === "string") return body.token;
    return null;
  };

  const authorize = (req: IncomingMessage, url: URL, body: Record<string, unknown> | undefined, res: ServerResponse): boolean => {
    if (extractToken(req, url, body) !== token) {
      sendEnvelope(res, 403, { ok: false, error: "Invalid session", code: "unauthorized" });
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      // Built-in: SSE event stream (token via query/header; no body on GET).
      if (method === "GET" && url.pathname === "/events") {
        if (!authorize(req, url, undefined, res)) return;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        sseClients.add(res);
        replayEvents(res, req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : null);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // Built-in: health check.
      if (method === "GET" && url.pathname === "/health") {
        if (!authorize(req, url, undefined, res)) return;
        const extra = options.getHealth ? await options.getHealth() : {};
        sendEnvelope(res, 200, {
          ok: true,
          result: { healthy: true, sessionId, ...extra },
        });
        return;
      }

      // Registered routes (Phase 1+: /tools, /tools/:name, /state, /state/:sub).
      const match = matchRoute(method, url.pathname);
      if (!match) {
        sendEnvelope(res, 404, { ok: false, error: `No route for ${method} ${url.pathname}`, code: "not_found" });
        return;
      }

      let body: Record<string, unknown> | undefined;
      if (method === "POST") {
        const parsed = await readBody(req, res);
        if (parsed === null) return;
        body = parsed;
      }

      if (!authorize(req, url, body, res)) return;

      const guiRequest: GuiRequest = { params: match.params, query: url.searchParams, body, raw: req };
      const result: GuiRouteResult = await match.handler(guiRequest);

      if (result.error !== undefined) {
        sendEnvelope(res, result.status ?? 400, { ok: false, error: result.error, code: result.code });
        return;
      }
      sendEnvelope(res, result.status ?? 200, { ok: true, result: result.result ?? null });
    } catch (error) {
      log.error("Request handler failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        sendEnvelope(res, 500, { ok: false, error: error instanceof Error ? error.message : "Internal error", code: "internal" });
      }
    }
  });

  const closeSse = (): void => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
  };

  const stopHeartbeat = (): void => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const removeDiscovery = async (): Promise<void> => {
    const path = discoveryPath;
    if (!path) return;
    try {
      await removeOwnedDiscovery(path, discoveryOwnerToken);
    } catch (error) {
      log.debug("Failed to remove discovery file", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const onClose = (handler: (reason: string) => void): (() => void) => {
    if (closed) {
      handler("closed");
      return () => {};
    }
    closeHandlers.add(handler);
    return () => closeHandlers.delete(handler);
  };

  const close = (reason?: string): void => {
    if (closed) return;
    const closeReason = reason ?? "closed";
    log.debug("Closing GUI server", { reason: closeReason });
    stopHeartbeat();
    for (const handler of closeHandlers) {
      try {
        handler(closeReason);
      } catch (error) {
        log.debug("GUI close handler failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    closeHandlers.clear();
    // Emit the final event before flipping `closed`, otherwise pushEvent suppresses it.
    pushEvent("server-close", { reason: closeReason });
    closed = true;
    closeSse();
    try {
      server.close();
    } catch (error) {
      log.debug("Failed to close server", { error: error instanceof Error ? error.message : String(error) });
    }
    void removeDiscovery();
  };

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", async () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Invalid server address"));
        return;
      }
      const port = address.port;
      const url = `http://127.0.0.1:${port}/?session=${token}`;
      const eventsUrl = `http://127.0.0.1:${port}/events?session=${token}`;

      heartbeat = setInterval(() => {
        for (const client of sseClients) {
          try {
            client.write(": ping\n\n");
          } catch {
            sseClients.delete(client);
          }
        }
      }, heartbeatMs);
      heartbeat.unref();

      const publishDiscovery = async (isCurrent: () => boolean = () => true): Promise<boolean> => {
        if (closed || !isCurrent()) return false;
        const discoveryDir = options.discoveryDir ?? join(options.cwd, ".workflow");
        const path = join(discoveryDir, GUI_DISCOVERY_FILENAME);
        const discovery: GuiDiscoveryFile = {
          version: 1,
          ownerToken: discoveryOwnerToken,
          port,
          token,
          sessionId,
          url,
          eventsUrl,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        };
        try {
          const published = await publishDiscoveryFile(
            discoveryDir,
            path,
            discovery,
            () => !closed && isCurrent(),
          );
          if (!published) return false;
          if (closed || !isCurrent()) {
            await removeOwnedDiscovery(path, discoveryOwnerToken);
            return false;
          }
          discoveryPath = path;
          handle.discoveryPath = path;
          return true;
        } catch (error) {
          log.warn("Failed to write discovery file", { error: error instanceof Error ? error.message : String(error) });
          return false;
        }
      };

      const handle: GuiServerHandle = {
        url,
        port,
        address: address.address,
        token,
        sessionId,
        discoveryPath,
        publishDiscovery,
        close,
        onClose,
        pushEvent,
        registerRoute,
        sseClientCount: () => sseClients.size,
      };
      log.info("GUI server listening", { port, sessionId });
      resolve(handle);
    });
  });
}

export async function startGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const server = await createGuiServer(options);
  if (options.writeDiscovery ?? true) await server.publishDiscovery();
  return server;
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        sendJsonStatic(res, 413, { ok: false, error: "Request body too large", code: "body_too_large" });
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendJsonStatic(res, 400, { ok: false, error: "Body must be a JSON object", code: "invalid_body" });
          resolve(null);
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        sendJsonStatic(res, 400, { ok: false, error: "Invalid JSON body", code: "invalid_body" });
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJsonStatic(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
