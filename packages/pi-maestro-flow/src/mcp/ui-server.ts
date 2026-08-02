import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolRequest,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConsentManager } from "./consent-manager.ts";
import { ServerError, wrapError } from "./errors.ts";
import {
  applyCspMeta,
  buildCspMetaContent,
  buildHostHtmlTemplate,
  OUTER_HOST_CSP,
} from "./host-html-template.ts";
import { logger } from "./logger.ts";
import type { McpServerManager } from "./server-manager.ts";
import {
  extractUiPromptText,
  getVisualizationStreamEnvelope,
  type UiDisplayMode,
  type UiDisplayModeRequest,
  type UiDisplayModeResult,
  type UiHostContext,
  type UiMessageParams,
  type UiModelContextParams,
  type UiOpenLinkResult,
  type UiProxyRequestBody,
  type UiProxyResult,
  type UiResourceContent,
  type UiSessionMessages,
  type UiStreamSummary,
  type VisualizationStreamFrameType,
} from "./types.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;
const MAX_UI_SESSION_MESSAGE_ITEMS = 128;
const MAX_UI_SESSION_MESSAGE_BYTES = 256 * 1024;
const MAX_UI_SESSION_MESSAGE_ITEM_BYTES = 32 * 1024;
const ABANDONED_GRACE_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_EVENT_LOG = 128;
const MAX_EVENT_LOG_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;

type ReplayEntry = {
  id: number;
  name: string;
  payload: unknown;
  chunk: string;
  bytes: number;
  streamId?: string;
  sequence?: number;
  frameType?: VisualizationStreamFrameType;
};

type StreamReplayState = {
  checkpointEventId: number;
  checkpointSequence: number;
  lastSequence: number;
  evictedThroughEventId?: number;
  evictedThroughSequence?: number;
};

export interface UiServerOptions {
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  manager: McpServerManager;
  consentManager: ConsentManager;
  hostContext?: UiHostContext;
  initialResultPromise?: Promise<CallToolResult>;
  sessionToken?: string;
  port?: number;
  onMessage?: (params: UiMessageParams) => Promise<void> | void;
  onContextUpdate?: (params: UiModelContextParams) => Promise<void> | void;
  onComplete?: (reason: string) => void;
  /** @internal Override replay limits for deterministic tests. */
  eventLogMaxEvents?: number;
  /** @internal Override replay limits for deterministic tests. */
  eventLogMaxBytes?: number;
  /** @internal Override replay limits for deterministic tests. */
  eventLogMaxEventBytes?: number;
}

export interface UiServerHandle {
  url: string;
  port: number;
  sessionToken: string;
  serverName: string;
  toolName: string;
  close: (reason?: string) => void;
  sendToolInput: (args: Record<string, unknown>) => void;
  sendToolResult: (result: CallToolResult) => void;
  sendResultPatch: (result: CallToolResult) => void;
  sendToolCancelled: (reason: string) => void;
  sendHostContext: (context: UiHostContext) => void;
  /** Get accumulated messages from this session */
  getSessionMessages: () => UiSessionMessages;
  getStreamSummary: () => UiStreamSummary | undefined;
}

export interface UiSessionMessageBudget {
  maxItems: number;
  maxBytes: number;
  maxItemBytes: number;
}

export interface UiSessionMessageBuffer {
  addPrompt(text: string): void;
  addNotification(text: string): void;
  addIntent(intent: string, params?: Record<string, unknown>): void;
  snapshot(): UiSessionMessages;
}

type UiMessageBucket = "prompts" | "notifications" | "intents";

export function createUiSessionMessageBuffer(
  budget: UiSessionMessageBudget = {
    maxItems: MAX_UI_SESSION_MESSAGE_ITEMS,
    maxBytes: MAX_UI_SESSION_MESSAGE_BYTES,
    maxItemBytes: MAX_UI_SESSION_MESSAGE_ITEM_BYTES,
  },
): UiSessionMessageBuffer {
  const maxItems = Math.max(1, budget.maxItems);
  const maxBytes = Math.max(1, budget.maxBytes);
  const maxItemBytes = Math.max(1, Math.min(budget.maxItemBytes, maxBytes));
  const messages: UiSessionMessages = { prompts: [], notifications: [], intents: [] };
  const order: Array<{ bucket: UiMessageBucket; bytes: number }> = [];
  let retainedBytes = 0;
  let droppedItems = 0;
  let truncatedItems = 0;

  const truncateText = (value: string): string => {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.byteLength <= maxItemBytes) return value;
    truncatedItems += 1;
    return encoded.subarray(0, maxItemBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  };

  const retain = (bucket: UiMessageBucket, value: string | { intent: string; params?: Record<string, unknown> }): void => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bucket === "intents") messages.intents.push(value as { intent: string; params?: Record<string, unknown> });
    else messages[bucket].push(value as string);
    order.push({ bucket, bytes });
    retainedBytes += bytes;

    while (order.length > maxItems || retainedBytes > maxBytes) {
      const oldest = order.shift();
      if (!oldest) break;
      messages[oldest.bucket].shift();
      retainedBytes -= oldest.bytes;
      droppedItems += 1;
    }
  };

  return {
    addPrompt(text) { retain("prompts", truncateText(text)); },
    addNotification(text) { retain("notifications", truncateText(text)); },
    addIntent(intent, params) {
      const normalizedIntent = truncateText(intent);
      let value: { intent: string; params?: Record<string, unknown> } = {
        intent: normalizedIntent,
        ...(params === undefined ? {} : { params }),
      };
      let serializedBytes = Number.POSITIVE_INFINITY;
      try { serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { /* circular values are replaced below */ }
      if (serializedBytes > maxItemBytes) {
        truncatedItems += 1;
        value = { intent: normalizedIntent, params: { _truncated: true } };
      }
      retain("intents", value);
    },
    snapshot() {
      return {
        prompts: [...messages.prompts],
        notifications: [...messages.notifications],
        intents: messages.intents.map((entry) => ({ ...entry })),
        retention: { retainedBytes, droppedItems, truncatedItems },
      };
    },
  };
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const sessionToken = options.sessionToken ?? randomUUID();
  const log = logger.child({
    component: "UiServer",
    server: options.serverName,
    tool: options.toolName,
    session: sessionToken.slice(0, 8),
  });

  log.debug("Starting UI server");

  const sseClients = new Set<ServerResponse>();
  let completed = false;
  let lastHeartbeatAt = Date.now();
  let watchdog: NodeJS.Timeout | null = null;
  let currentDisplayMode: UiDisplayMode = options.hostContext?.displayMode ?? "inline";
  let nextEventId = 1;
  const maxEventLogEvents = replayLimit(options.eventLogMaxEvents, MAX_EVENT_LOG);
  const maxEventLogBytes = replayLimit(options.eventLogMaxBytes, MAX_EVENT_LOG_BYTES);
  const maxEventBytes = Math.min(
    replayLimit(options.eventLogMaxEventBytes, MAX_EVENT_BYTES),
    maxEventLogBytes,
  );
  const eventLog: ReplayEntry[] = [];
  const streamReplayStates = new Map<string, StreamReplayState>();
  const unreplayableStreams = new Set<string>();
  let eventLogBytes = 0;
  let streamSummary: UiStreamSummary | undefined;

  const trimStreamReplayTracking = () => {
    while (streamReplayStates.size > maxEventLogEvents) {
      const oldestStreamId = streamReplayStates.keys().next().value;
      if (oldestStreamId === undefined) break;
      streamReplayStates.delete(oldestStreamId);
      unreplayableStreams.delete(oldestStreamId);
    }
    while (unreplayableStreams.size > maxEventLogEvents) {
      const oldestStreamId = unreplayableStreams.values().next().value;
      if (oldestStreamId === undefined) break;
      unreplayableStreams.delete(oldestStreamId);
    }
  };

  const markStreamUnreplayable = (streamId: string) => {
    unreplayableStreams.delete(streamId);
    unreplayableStreams.add(streamId);
    trimStreamReplayTracking();
  };

  // Retain only a bounded tail; each authenticated message request can be up
  // to MAX_BODY_SIZE, so a session-count cap alone does not bound heap usage.
  const sessionMessageBuffer = createUiSessionMessageBuffer();

  const hostContext: UiHostContext = {
    displayMode: currentDisplayMode,
    availableDisplayModes: ["inline", "fullscreen", "pip"],
    platform: "desktop",
    ...options.hostContext,
    // Only include toolInfo if caller provides full tool definition with inputSchema
    // The App validates toolInfo.tool.inputSchema as required object
  };

  const initialStreamContext = hostContext["pi-mcp-adapter/stream"];
  if (initialStreamContext && typeof initialStreamContext === "object") {
    const streamId = (initialStreamContext as { streamId?: unknown }).streamId;
    const mode = (initialStreamContext as { mode?: unknown }).mode;
    if (typeof streamId === "string" && (mode === "eager" || mode === "stream-first")) {
      streamSummary = {
        streamId,
        mode,
        frames: 0,
        phases: [],
      };
    }
  }

  const touchHeartbeat = () => {
    lastHeartbeatAt = Date.now();
  };

  const updateStreamSummary = (payload: unknown) => {
    const envelope = getVisualizationStreamEnvelope((payload as { structuredContent?: unknown } | null)?.structuredContent);
    if (!envelope) return;
    if (!streamSummary) {
      streamSummary = {
        streamId: envelope.streamId,
        mode: "eager",
        frames: 0,
        phases: [],
      };
    }
    streamSummary.frames += 1;
    if (!streamSummary.phases.includes(envelope.phase)) {
      streamSummary.phases.push(envelope.phase);
    }
    streamSummary.finalStatus = envelope.status;
    streamSummary.lastMessage = envelope.message;
  };

  const serializeEvent = (eventId: number, name: string, payload: unknown): string => {
    return `id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  };

  const removeEventLogEntry = (index: number) => {
    const [removed] = eventLog.splice(index, 1);
    if (!removed) return;
    eventLogBytes -= removed.bytes;
    if (removed.streamId === undefined || removed.sequence === undefined) return;
    const state = streamReplayStates.get(removed.streamId);
    if (!state || removed.id < state.checkpointEventId) return;
    state.evictedThroughEventId = removed.id;
    state.evictedThroughSequence = removed.sequence;
  };

  const clearStreamReplayEntries = (streamId: string) => {
    for (let index = eventLog.length - 1; index >= 0; index -= 1) {
      if (eventLog[index]?.streamId === streamId) removeEventLogEntry(index);
    }
  };

  const makeResyncEntry = (
    eventId: number,
    reason: "checkpoint-too-large" | "checkpoint-unavailable",
    streamId?: string,
  ): ReplayEntry | null => {
    const payloads: unknown[] = [
      { reason, ...(streamId ? { streamId } : {}) },
      { reason },
      {},
    ];
    for (const payload of payloads) {
      const chunk = serializeEvent(eventId, "resync-required", payload);
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (bytes > maxEventBytes || bytes > maxEventLogBytes) continue;
      return {
        id: eventId,
        name: "resync-required",
        payload,
        chunk,
        bytes,
        streamId,
      };
    }
    return null;
  };

  const replaceStreamReplayWithResync = (
    eventId: number,
    reason: "checkpoint-too-large" | "checkpoint-unavailable",
    streamId: string,
  ): ReplayEntry | null => {
    clearStreamReplayEntries(streamId);
    const entry = makeResyncEntry(eventId, reason, streamId);
    if (!entry) return null;
    eventLog.push(entry);
    eventLogBytes += entry.bytes;
    return entry;
  };

  const pruneEventLog = () => {
    const overBudget = () => eventLog.length > maxEventLogEvents || eventLogBytes > maxEventLogBytes;
    while (overBudget() && eventLog.length > 0) removeEventLogEntry(0);
  };

  const makeReplayEntry = (
    eventId: number,
    name: string,
    payload: unknown,
    chunk: string | null,
    streamId?: string,
    sequence?: number,
    frameType?: VisualizationStreamFrameType,
  ): ReplayEntry | null => {
    const originalBytes = Buffer.byteLength(chunk ?? "", "utf8");
    if (chunk && originalBytes <= maxEventBytes) {
      return { id: eventId, name, payload, chunk, bytes: originalBytes, streamId, sequence, frameType };
    }

    if (frameType !== undefined) {
      return makeResyncEntry(
        eventId,
        frameType === "checkpoint" || frameType === "final"
          ? "checkpoint-too-large"
          : "checkpoint-unavailable",
        streamId,
      );
    }

    const summaryPayload = {
      event: name,
      reason: chunk ? "event-too-large" : "serialization-failed",
      ...(chunk ? { originalBytes } : {}),
    };
    const summaryName = "replay-omitted";
    const summaryChunk = serializeEvent(eventId, summaryName, summaryPayload);
    const summaryBytes = Buffer.byteLength(summaryChunk, "utf8");
    if (summaryBytes > maxEventBytes || summaryBytes > maxEventLogBytes) return null;
    return {
      id: eventId,
      name: summaryName,
      payload: summaryPayload,
      chunk: summaryChunk,
      bytes: summaryBytes,
    };
  };

  const disconnectSseClient = (client: ServerResponse) => {
    sseClients.delete(client);
    try {
      client.destroy();
    } catch {
      // The response is already unusable; ownership was removed above.
    }
  };

  const writeSseChunk = (client: ServerResponse, chunk: string): boolean => {
    try {
      if (client.write(chunk)) return true;
    } catch {
      // Failed writes are handled by closing the response below.
    }
    disconnectSseClient(client);
    return false;
  };

  const pushEvent = (name: string, payload: unknown) => {
    if (completed) return;
    const eventId = nextEventId++;
    updateStreamSummary(payload);
    const envelope = getVisualizationStreamEnvelope(
      (payload as { structuredContent?: unknown } | null)?.structuredContent,
    );

    let liveChunk: string | null = null;
    try {
      liveChunk = serializeEvent(eventId, name, payload);
    } catch {
      // An unserializable payload cannot be delivered, but its omission can
      // still be represented safely in the bounded replay tail.
    }

    if (envelope?.frameType === "checkpoint" || envelope?.frameType === "final") {
      streamReplayStates.delete(envelope.streamId);
      streamReplayStates.set(envelope.streamId, {
        checkpointEventId: eventId,
        checkpointSequence: envelope.sequence,
        lastSequence: envelope.sequence,
      });
      unreplayableStreams.delete(envelope.streamId);
      trimStreamReplayTracking();
    } else if (envelope?.frameType === "patch") {
      const state = streamReplayStates.get(envelope.streamId);
      if (!state || unreplayableStreams.has(envelope.streamId) || envelope.sequence !== state.lastSequence + 1) {
        markStreamUnreplayable(envelope.streamId);
      } else {
        state.lastSequence = envelope.sequence;
      }
    }

    let replayEntry = makeReplayEntry(
      eventId,
      name,
      payload,
      liveChunk,
      envelope?.streamId,
      envelope?.sequence,
      envelope?.frameType,
    );
    let replacementChunk: string | undefined;

    if (envelope?.frameType === "checkpoint" || envelope?.frameType === "final") {
      if (replayEntry?.name === "resync-required") {
        markStreamUnreplayable(envelope.streamId);
        replayEntry = replaceStreamReplayWithResync(
          eventId,
          "checkpoint-too-large",
          envelope.streamId,
        );
        replacementChunk = replayEntry?.chunk;
        replayEntry = null;
      }
    } else if (
      envelope?.frameType === "patch"
      && (unreplayableStreams.has(envelope.streamId) || replayEntry?.name === "resync-required")
    ) {
      markStreamUnreplayable(envelope.streamId);
      replayEntry = replaceStreamReplayWithResync(
        eventId,
        "checkpoint-unavailable",
        envelope.streamId,
      );
      replacementChunk = replayEntry?.chunk;
      replayEntry = null;
    }

    if (replayEntry) {
      eventLog.push(replayEntry);
      eventLogBytes += replayEntry.bytes;
    }
    pruneEventLog();

    const chunk = liveChunk ?? replayEntry?.chunk ?? replacementChunk;
    if (!chunk) return;
    for (const client of sseClients) writeSseChunk(client, chunk);
  };

  const replayEvents = (res: ServerResponse, lastEventIdHeader?: string | null): boolean => {
    const parsedLastId = lastEventIdHeader ? Number(lastEventIdHeader) : Number.NaN;
    const hasLastEventId = Number.isFinite(parsedLastId);
    const eventsToReplay = hasLastEventId
      ? eventLog.filter((entry) => entry.id > parsedLastId)
      : [...eventLog];
    const latestCheckpointIndexes = new Map<string, number>();

    for (let index = 0; index < eventsToReplay.length; index += 1) {
      const entry = eventsToReplay[index];
      if (
        entry?.streamId
        && (entry.frameType === "checkpoint" || entry.frameType === "final")
      ) {
        latestCheckpointIndexes.set(entry.streamId, index);
      }
    }

    const replaySequences = new Map<string, number>();
    if (hasLastEventId) {
      for (const [streamId, state] of streamReplayStates) {
        if (state.checkpointEventId > parsedLastId) continue;
        if (state.evictedThroughEventId === undefined) {
          replaySequences.set(streamId, state.checkpointSequence);
        } else if (state.evictedThroughEventId <= parsedLastId) {
          replaySequences.set(streamId, state.evictedThroughSequence ?? state.checkpointSequence);
        }
      }

      for (const entry of eventLog) {
        if (entry.id > parsedLastId || !entry.streamId) continue;
        const streamState = streamReplayStates.get(entry.streamId);
        if (streamState && entry.id < streamState.checkpointEventId) continue;
        if (entry.name === "resync-required") {
          replaySequences.delete(entry.streamId);
        } else if (
          (entry.frameType === "checkpoint" || entry.frameType === "final")
          && entry.sequence !== undefined
        ) {
          replaySequences.set(entry.streamId, entry.sequence);
        } else if (entry.frameType === "patch" && entry.sequence !== undefined) {
          const previousSequence = replaySequences.get(entry.streamId);
          if (previousSequence === undefined || entry.sequence !== previousSequence + 1) {
            replaySequences.delete(entry.streamId);
          } else {
            replaySequences.set(entry.streamId, entry.sequence);
          }
        }
      }
    }

    const resyncedStreams = new Set<string>();
    for (let index = 0; index < eventsToReplay.length; index += 1) {
      const entry = eventsToReplay[index];
      if (!entry) continue;
      if (entry.streamId) {
        const latestCheckpointIndex = latestCheckpointIndexes.get(entry.streamId);
        if (latestCheckpointIndex !== undefined && index < latestCheckpointIndex) continue;

        if (entry.name === "resync-required") {
          replaySequences.delete(entry.streamId);
          resyncedStreams.add(entry.streamId);
        } else if (
          (entry.frameType === "checkpoint" || entry.frameType === "final")
          && entry.sequence !== undefined
        ) {
          replaySequences.set(entry.streamId, entry.sequence);
          resyncedStreams.delete(entry.streamId);
        } else if (entry.frameType === "patch") {
          const previousSequence = replaySequences.get(entry.streamId);
          if (
            entry.sequence === undefined
            || previousSequence === undefined
            || entry.sequence !== previousSequence + 1
          ) {
            if (resyncedStreams.has(entry.streamId)) continue;
            const resyncEntry = makeResyncEntry(entry.id, "checkpoint-unavailable", entry.streamId);
            if (resyncEntry && !writeSseChunk(res, resyncEntry.chunk)) return false;
            replaySequences.delete(entry.streamId);
            resyncedStreams.add(entry.streamId);
            continue;
          }
          replaySequences.set(entry.streamId, entry.sequence);
        }
      }
      if (!writeSseChunk(res, entry.chunk)) return false;
    }
    return true;
  };

  const closeSse = () => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch (error) {
        log.debug("Failed to close SSE client", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    sseClients.clear();
  };

  const stopWatchdog = () => {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  };

  const markCompleted = (reason: string) => {
    if (completed) return;
    log.debug("Session completed", { reason });
    pushEvent("session-complete", { reason });
    completed = true;
    stopWatchdog();
    options.onComplete?.(reason);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (method === "GET" && url.pathname === "/") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        touchHeartbeat();

        const html = buildHostHtmlTemplate({
          sessionToken,
          serverName: options.serverName,
          toolName: options.toolName,
          toolArgs: options.toolArgs,
          resource: options.resource,
          allowAttribute: buildAllowAttribute(options.resource.meta.permissions),
          requireToolConsent: options.consentManager.requiresPrompt(options.serverName),
          cacheToolConsent: options.consentManager.shouldCacheConsent(),
          hostContext,
        });

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": OUTER_HOST_CSP,
        });
        res.end(html);
        return;
      }

      if (method === "GET" && url.pathname === "/events") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        touchHeartbeat();
        log.debug("SSE client connected", { clientCount: sseClients.size + 1 });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        sseClients.add(res);
        const releaseClient = () => {
          sseClients.delete(res);
        };
        req.once("close", releaseClient);
        res.once("close", releaseClient);
        res.once("error", releaseClient);
        if (!writeSseChunk(res, ": connected\n\n")) return;
        replayEvents(res, req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : null);
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        sendJson(res, 200, { ok: true, result: { healthy: true } });
        return;
      }

      if (method === "GET" && url.pathname === "/ui-app") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        touchHeartbeat();
        // Serve the MCP app's UI HTML directly (avoids blob URL security issues)
        // Apply CSP meta tag if specified in resource metadata
        const cspContent = buildCspMetaContent(options.resource.meta.csp);
        const appHtml = applyCspMeta(options.resource.html, cspContent);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(appHtml);
        return;
      }

      if (method === "GET" && url.pathname === "/app-bridge.bundle.js") {
        // Serve the pre-bundled AppBridge module
        const bundlePath = path.join(import.meta.dirname, "app-bridge.bundle.js");
        try {
          const content = await fs.readFile(bundlePath, "utf-8");
          res.writeHead(200, {
            "Content-Type": "application/javascript",
            "Cache-Control": "public, max-age=31536000",
          });
          res.end(content);
        } catch {
          sendJson(res, 500, { ok: false, error: "Bundle not found" });
        }
        return;
      }

      if (method !== "POST") {
        sendJson(res, 404, { ok: false, error: "Not found" });
        return;
      }

      const body = await parseBody(req, res);
      if (!body) return;
      if (!validateTokenBody(body, sessionToken, res)) return;
      const params = body.params ?? {};
      touchHeartbeat();

      if (url.pathname === "/proxy/tools/call") {
        options.consentManager.ensureApproved(options.serverName);
        const callParams = params as CallToolRequest["params"];
        if (!callParams || typeof callParams.name !== "string" || !callParams.name.trim()) {
          sendJson(res, 400, { ok: false, error: "Invalid tools/call params" });
          return;
        }

        const lease = options.manager.acquireConnection(options.serverName);
        if (!lease) {
          sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is not connected` });
          return;
        }
        const connection = lease.connection;

        try {
          const result = await connection.client.callTool({
            name: callParams.name,
            arguments:
              callParams.arguments && typeof callParams.arguments === "object" && !Array.isArray(callParams.arguments)
                ? callParams.arguments
                : {},
          }, undefined, lease.requestOptions);
          sendJson(res, 200, { ok: true, result });
        } finally {
          lease.release();
        }
        return;
      }

      if (url.pathname === "/proxy/ui/consent") {
        const approved = !!(params as { approved?: boolean }).approved;
        options.consentManager.registerDecision(options.serverName, approved);
        sendJson(res, 200, { ok: true, result: { approved } });
        return;
      }

      if (url.pathname === "/proxy/ui/message") {
        const msgParams = params as UiMessageParams;
        const promptText = extractUiPromptText(msgParams);

        // Track messages by type (order: prompt → intent → notify)
        // Must match the order in index.ts onMessage handler
        if (promptText) {
          sessionMessageBuffer.addPrompt(promptText);
          log.debug("UI prompt received", { prompt: promptText.slice(0, 100) });
        } else if (msgParams.type === "intent" || msgParams.intent) {
          const intentName = msgParams.intent ?? "";
          if (intentName) {
            sessionMessageBuffer.addIntent(intentName, msgParams.params);
            log.debug("UI intent received", { intent: intentName });
          }
        } else if (msgParams.type === "notify" || msgParams.message) {
          const notifyText = msgParams.message ?? "";
          if (notifyText) {
            sessionMessageBuffer.addNotification(notifyText);
            log.debug("UI notification", { message: notifyText.slice(0, 100) });
          }
        }

        await options.onMessage?.(msgParams);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/context") {
        const ctxParams = params as UiModelContextParams;
        log.debug("UI context update", { hasContent: !!ctxParams.content });
        await options.onContextUpdate?.(ctxParams);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/open-link") {
        const openParams = params as { url?: string };
        if (!openParams?.url || typeof openParams.url !== "string") {
          sendJson(res, 400, { ok: false, error: "Invalid open-link params" });
          return;
        }
        const normalizedUrl = normalizeOpenLinkUrl(openParams.url);
        const result: UiOpenLinkResult = normalizedUrl
          ? { url: normalizedUrl }
          : { isError: true };
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/proxy/ui/download-file") {
        sendJson(res, 200, { ok: true, result: { isError: true } });
        return;
      }

      if (url.pathname === "/proxy/ui/request-display-mode") {
        const displayParams = params as UiDisplayModeRequest;
        const requested = displayParams?.mode;
        const available = hostContext.availableDisplayModes ?? ["inline"];
        if (requested && available.includes(requested)) {
          currentDisplayMode = requested;
        }
        hostContext.displayMode = currentDisplayMode;
        pushEvent("host-context", { displayMode: currentDisplayMode });
        const result: UiDisplayModeResult = { mode: currentDisplayMode };
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/proxy/ui/heartbeat") {
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/complete") {
        const reason = typeof (params as { reason?: string }).reason === "string"
          ? (params as { reason?: string }).reason!
          : "done";
        markCompleted(reason);
        sendJson(res, 200, { ok: true, result: {} });
        setTimeout(() => {
          try {
            server.close();
          } catch (error) {
            log.debug("Failed to close completed UI server", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          closeSse();
        }, 20).unref();
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const wrapped = wrapError(error, { server: options.serverName, tool: options.toolName });
      const status = /approval required|denied/i.test(wrapped.message) ? 403 : 500;
      if (status === 500) {
        log.error("Request handler error", error instanceof Error ? error : undefined);
      }
      sendJson(res, status, { ok: false, error: wrapped.message });
    }
  });

  if (options.initialResultPromise) {
    options.initialResultPromise.then(
      (result) => pushEvent("tool-result", result),
      (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        pushEvent("tool-cancelled", { reason });
      }
    );
  }

  watchdog = setInterval(() => {
    if (completed) return;
    if (Date.now() - lastHeartbeatAt <= ABANDONED_GRACE_MS) return;
    markCompleted("stale");
    try {
      server.close();
    } catch (error) {
      log.debug("Failed to close stale UI server", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    closeSse();
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      log.error("Failed to start server", error);
      reject(new ServerError(error.message, { port: options.port, cause: error }));
    };

    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        const err = new ServerError("invalid address");
        log.error("Invalid server address", err);
        reject(err);
        return;
      }

      log.debug("Server started", { port: address.port });

      const handle: UiServerHandle = {
        url: `http://localhost:${address.port}/?session=${sessionToken}`,
        port: address.port,
        sessionToken,
        serverName: options.serverName,
        toolName: options.toolName,
        close: (reason?: string) => {
          markCompleted(reason ?? "closed");
          try {
            server.close();
          } catch (error) {
            log.debug("Failed to close UI server", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          closeSse();
        },
        sendToolInput: (args: Record<string, unknown>) => {
          pushEvent("tool-input", { arguments: args });
        },
        sendToolResult: (result: CallToolResult) => {
          pushEvent("tool-result", result);
        },
        sendResultPatch: (result: CallToolResult) => {
          pushEvent("result-patch", result);
        },
        sendToolCancelled: (reason: string) => {
          pushEvent("tool-cancelled", { reason });
        },
        sendHostContext: (context: UiHostContext) => {
          Object.assign(hostContext, context);
          pushEvent("host-context", context);
        },
        getSessionMessages: () => sessionMessageBuffer.snapshot(),
        getStreamSummary: () => streamSummary ? { ...streamSummary, phases: [...streamSummary.phases] } : undefined,
      };

      resolve(handle);
    });
  });
}

function replayLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function normalizeOpenLinkUrl(value: string): string | null {
  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    return null;
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") return null;
  if (destination.username || destination.password) return null;
  return destination.href;
}

async function parseBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UiProxyRequestBody<Record<string, unknown>> | null> {
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return null;
    }
    return body as UiProxyRequestBody<Record<string, unknown>>;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid body" });
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function validateTokenQuery(url: URL, expected: string, res: ServerResponse): boolean {
  const token = url.searchParams.get("session");
  if (token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

function validateTokenBody(
  body: UiProxyRequestBody<Record<string, unknown>>,
  expected: string,
  res: ServerResponse,
): boolean {
  if (body.token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

function sendJson<T>(
  res: ServerResponse,
  status: number,
  payload: UiProxyResult<T>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
