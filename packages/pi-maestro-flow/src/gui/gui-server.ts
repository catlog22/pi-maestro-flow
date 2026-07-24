import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
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

interface RouteEntry {
  method: GuiHttpMethod;
  segments: string[];
  handler: GuiRouteHandler;
}

interface EventLogEntry {
  id: number;
  name: string;
  payload: unknown;
}

export async function startGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const token = options.token ?? randomUUID();
  const sessionId = options.sessionId;
  const writeDiscovery = options.writeDiscovery ?? true;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const sseClients = new Set<ServerResponse>();
  const routes: RouteEntry[] = [];
  const eventLog: EventLogEntry[] = [];
  let nextEventId = 1;
  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let discoveryPath: string | undefined;

  const serializeEvent = (id: number, name: string, payload: unknown): string =>
    `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;

  const pushEvent = (name: string, payload: unknown): void => {
    if (closed) return;
    const id = nextEventId++;
    eventLog.push({ id, name, payload });
    if (eventLog.length > MAX_EVENT_LOG) eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    const chunk = serializeEvent(id, name, payload);
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
        res.write(serializeEvent(entry.id, entry.name, entry.payload));
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
    if (!discoveryPath) return;
    try {
      await rm(discoveryPath, { force: true });
    } catch (error) {
      log.debug("Failed to remove discovery file", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const close = (reason?: string): void => {
    if (closed) return;
    log.debug("Closing GUI server", { reason: reason ?? "closed" });
    stopHeartbeat();
    // Emit the final event before flipping `closed`, otherwise pushEvent suppresses it.
    pushEvent("server-close", { reason: reason ?? "closed" });
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

      if (writeDiscovery) {
        const discoveryDir = options.discoveryDir ?? join(options.cwd, ".workflow");
        discoveryPath = join(discoveryDir, GUI_DISCOVERY_FILENAME);
        const discovery: GuiDiscoveryFile = {
          version: 1,
          port,
          token,
          sessionId,
          url,
          eventsUrl,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        };
        try {
          await mkdir(discoveryDir, { recursive: true });
          await writeFile(discoveryPath, JSON.stringify(discovery, null, 2), { mode: 0o600 });
        } catch (error) {
          log.warn("Failed to write discovery file", { error: error instanceof Error ? error.message : String(error) });
          discoveryPath = undefined;
        }
      }

      log.info("GUI server started", { port, sessionId, discoveryPath });

      const handle: GuiServerHandle = {
        url,
        port,
        address: address.address,
        token,
        sessionId,
        discoveryPath,
        close,
        pushEvent,
        registerRoute,
        sseClientCount: () => sseClients.size,
      };
      resolve(handle);
    });
  });
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
