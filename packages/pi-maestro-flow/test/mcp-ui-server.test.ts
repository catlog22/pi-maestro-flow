import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildHostHtmlTemplate } from "../src/mcp/host-html-template.ts";
import type { ConsentManager } from "../src/mcp/consent-manager.ts";
import type { McpServerManager } from "../src/mcp/server-manager.ts";
import type { UiResourceCsp } from "../src/mcp/types.ts";
import { createUiSessionMessageBuffer, startUiServer } from "../src/mcp/ui-server.ts";

function renderHostHtml(
  resourceHtml = "<script>parent.postMessage({ jsonrpc: '2.0' }, '*')</script>",
  csp?: UiResourceCsp,
): string {
  return buildHostHtmlTemplate({
    sessionToken: "secret-session-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: resourceHtml, meta: { csp } },
    allowAttribute: "",
    requireToolConsent: true,
    cacheToolConsent: true,
  });
}

function collectSse(
  port: number,
  token: string,
  count: number,
  timeoutMs = 250,
  lastEventId?: number,
): Promise<Array<{ id: string; event: string; data: unknown }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ id: string; event: string; data: unknown }> = [];
    let settled = false;
    let timer: NodeJS.Timeout;
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/events?session=${encodeURIComponent(token)}`,
        headers: lastEventId === undefined ? undefined : { "Last-Event-ID": String(lastEventId) },
      },
      (response) => {
        let buffer = "";
        let current: Partial<{ id: string; event: string; data: string }> = {};
        response.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.startsWith(":")) continue;
            if (line === "") {
              if (current.data !== undefined) {
                events.push({
                  id: current.id ?? "",
                  event: current.event ?? "message",
                  data: JSON.parse(current.data),
                });
                if (events.length >= count) return finish();
              }
              current = {};
              continue;
            }
            const separator = line.indexOf(":");
            const field = separator >= 0 ? line.slice(0, separator) : line;
            const value = separator >= 0 ? line.slice(separator + 1).trimStart() : "";
            if (field === "id") current.id = value;
            else if (field === "event") current.event = value;
            else if (field === "data") current.data = value;
          }
        });
      },
    );
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(events);
    };
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    timer = setTimeout(finish, timeoutMs);
  });
}

async function postOpenLink(port: number, token: string, url: string): Promise<{
  status: number;
  body: { ok: boolean; result?: { isError?: boolean; url?: string }; error?: string };
}> {
  const response = await fetch(`http://127.0.0.1:${port}/proxy/ui/open-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, params: { url } }),
  });
  return {
    status: response.status,
    body: await response.json() as { ok: boolean; result?: { isError?: boolean; url?: string }; error?: string },
  };
}

function streamFrame(
  frameType: "patch" | "checkpoint" | "final",
  sequence: number,
  checkpoint?: Record<string, unknown>,
  streamId = "test-stream",
) {
  return {
    content: [],
    structuredContent: {
      "pi-mcp-adapter/stream": {
        streamId,
        sequence,
        frameType,
        phase: frameType === "final" ? "settled" : "detail",
        status: "ok",
        ...(checkpoint ? { checkpoint } : {}),
      },
    },
  };
}

test("MCP UI replay retention enforces its event-count budget", async () => {
  const handle = await startUiServer({
    sessionToken: "event-count-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 2,
    eventLogMaxBytes: 10_000,
    eventLogMaxEventBytes: 10_000,
  });

  try {
    handle.sendToolInput({ sequence: 1 });
    handle.sendToolInput({ sequence: 2 });
    handle.sendToolInput({ sequence: 3 });

    const replayed = await collectSse(handle.port, handle.sessionToken, 3);
    assert.deepEqual(replayed.map((event) => event.id), ["2", "3"]);
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI replay retention enforces its serialized UTF-8 byte budget", async () => {
  const maxBytes = 240;
  const handle = await startUiServer({
    sessionToken: "event-byte-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 10,
    eventLogMaxBytes: maxBytes,
    eventLogMaxEventBytes: maxBytes,
  });

  try {
    handle.sendToolInput({ sequence: 1, text: "a".repeat(48) });
    handle.sendToolInput({ sequence: 2, text: "b".repeat(48) });
    handle.sendToolInput({ sequence: 3, text: "c".repeat(48) });

    const replayed = await collectSse(handle.port, handle.sessionToken, 10);
    const replayBytes = replayed.reduce((total, event) => total + Buffer.byteLength(
      `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
      "utf8",
    ), 0);
    assert.ok(replayBytes <= maxBytes);
    assert.ok(replayed.length < 3, "the byte budget evicts at least one event before the count cap");
    assert.equal(replayed.at(-1)?.id, "3");
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI replay summarizes oversized multibyte events before retention", async () => {
  const handle = await startUiServer({
    sessionToken: "event-oversize-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 10,
    eventLogMaxBytes: 512,
    eventLogMaxEventBytes: 180,
  });

  try {
    const oversizedText = "é".repeat(80);
    handle.sendToolInput({ text: oversizedText });

    const replayed = await collectSse(handle.port, handle.sessionToken, 1);
    assert.equal(replayed[0]?.event, "replay-omitted");
    const summary = replayed[0]?.data as { event?: string; reason?: string; originalBytes?: number } | undefined;
    assert.equal(summary?.event, "tool-input");
    assert.equal(summary?.reason, "event-too-large");
    assert.ok((summary?.originalBytes ?? 0) > 180, "UTF-8 bytes, not character count, trigger the per-event limit");
    assert.doesNotMatch(JSON.stringify(summary), /é/u);
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI replay never retains a checkpoint with a gapped patch suffix", async () => {
  const handle = await startUiServer({
    sessionToken: "checkpoint-suffix-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 3,
    eventLogMaxBytes: 10_000,
    eventLogMaxEventBytes: 10_000,
  });

  try {
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "base" }));
    handle.sendResultPatch(streamFrame("patch", 2));
    handle.sendResultPatch(streamFrame("patch", 3));
    handle.sendResultPatch(streamFrame("patch", 4));

    const replayed = await collectSse(handle.port, handle.sessionToken, 4);
    assert.deepEqual(replayed.map((event) => event.id), ["2"]);
    assert.deepEqual(replayed.map((event) => event.event), ["resync-required"]);
    assert.deepEqual(replayed[0]?.data, {
      reason: "checkpoint-unavailable",
      streamId: "test-stream",
    });
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI Last-Event-ID replays a complete suffix after its checkpoint is evicted", async () => {
  const handle = await startUiServer({
    sessionToken: "checkpoint-contiguous-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 2,
    eventLogMaxBytes: 10_000,
    eventLogMaxEventBytes: 10_000,
  });

  try {
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "base" }));
    handle.sendResultPatch(streamFrame("patch", 2));
    handle.sendResultPatch(streamFrame("patch", 3));

    const replayed = await collectSse(handle.port, handle.sessionToken, 2, 250, 1);
    assert.deepEqual(replayed.map((event) => event.id), ["2", "3"]);
    assert.deepEqual(replayed.map((event) => event.event), ["result-patch", "result-patch"]);
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI Last-Event-ID replay replaces checkpoint1, missing2, patch3 with resync-required", async () => {
  const handle = await startUiServer({
    sessionToken: "checkpoint-gap-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 3,
    eventLogMaxBytes: 10_000,
    eventLogMaxEventBytes: 10_000,
  });

  try {
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "base" }));
    handle.sendToolInput({ unrelated: true });
    handle.sendResultPatch(streamFrame("patch", 3));

    const replayed = await collectSse(handle.port, handle.sessionToken, 3, 250, 1);
    assert.deepEqual(replayed.map((event) => event.id), ["2", "3"]);
    assert.deepEqual(replayed.map((event) => event.event), ["tool-input", "resync-required"]);
    assert.deepEqual(replayed[1]?.data, {
      reason: "checkpoint-unavailable",
      streamId: "test-stream",
    });
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI replay keeps concurrent visualization chains scoped to their own checkpoints", async () => {
  const handle = await startUiServer({
    sessionToken: "concurrent-stream-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 10,
    eventLogMaxBytes: 10_000,
    eventLogMaxEventBytes: 10_000,
  });

  try {
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "a" }, "stream-a"));
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "b" }, "stream-b"));
    handle.sendResultPatch(streamFrame("patch", 2, undefined, "stream-a"));
    handle.sendResultPatch(streamFrame("patch", 2, undefined, "stream-b"));

    const replayed = await collectSse(handle.port, handle.sessionToken, 4);
    const envelopes = replayed.map((event) =>
      (event.data as { structuredContent?: Record<string, { streamId?: string; frameType?: string }> })
        .structuredContent?.["pi-mcp-adapter/stream"],
    );
    assert.deepEqual(
      envelopes.map((envelope) => [envelope?.streamId, envelope?.frameType]),
      [
        ["stream-a", "checkpoint"],
        ["stream-b", "checkpoint"],
        ["stream-a", "patch"],
        ["stream-b", "patch"],
      ],
    );
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI replay replaces an oversized checkpoint and dependent patches with resync-required", async () => {
  const handle = await startUiServer({
    sessionToken: "checkpoint-oversize-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
    eventLogMaxEvents: 10,
    eventLogMaxBytes: 512,
    eventLogMaxEventBytes: 180,
  });

  try {
    handle.sendResultPatch(streamFrame("checkpoint", 1, { value: "x".repeat(512) }));
    const checkpointReplay = await collectSse(handle.port, handle.sessionToken, 1);
    assert.equal(checkpointReplay[0]?.event, "resync-required");
    assert.deepEqual(checkpointReplay[0]?.data, {
      reason: "checkpoint-too-large",
      streamId: "test-stream",
    });

    handle.sendResultPatch(streamFrame("patch", 2));
    const patchReplay = await collectSse(handle.port, handle.sessionToken, 2);
    assert.deepEqual(patchReplay.map((event) => event.event), ["resync-required"]);
    assert.equal(patchReplay[0]?.id, "2");
    assert.deepEqual(patchReplay[0]?.data, {
      reason: "checkpoint-unavailable",
      streamId: "test-stream",
    });
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI closes and releases an authenticated SSE client on write backpressure", async () => {
  const handle = await startUiServer({
    sessionToken: "slow-sse-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
  });

  let request: http.ClientRequest | undefined;
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.get(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: `/events?session=${encodeURIComponent(handle.sessionToken)}`,
        },
        resolve,
      );
      request.once("error", reject);
    });
    response.on("error", () => undefined);
    response.pause();

    const closed = new Promise<void>((resolve) => {
      response.once("aborted", resolve);
      response.once("close", resolve);
    });
    handle.sendToolInput({ text: "x".repeat(4 * 1024 * 1024) });
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow SSE client stayed open")), 2_000)),
    ]);

    assert.equal(response.destroyed, true);
    const health = await fetch(`http://127.0.0.1:${handle.port}/health?session=${handle.sessionToken}`);
    assert.equal(health.status, 200, "closing the slow client does not close the UI server");
    handle.sendToolInput({ sequence: "after-backpressure" });
  } finally {
    request?.destroy();
    handle.close("test-complete");
  }
});

test("MCP UI open-link server allows only normalized credential-free HTTP destinations", async () => {
  const handle = await startUiServer({
    sessionToken: "open-link-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "", meta: {} },
    manager: {} as McpServerManager,
    consentManager: { requiresPrompt: () => false, shouldCacheConsent: () => false } as ConsentManager,
  });

  try {
    const allowed = await postOpenLink(
      handle.port,
      handle.sessionToken,
      " HTTPS://Example.COM:443/a/../destination?q=hello%20world#full ",
    );
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body.result, {
      url: "https://example.com/destination?q=hello%20world#full",
    });

    const allowedHttp = await postOpenLink(handle.port, handle.sessionToken, "http://Example.COM:80/path");
    assert.deepEqual(allowedHttp.body.result, { url: "http://example.com/path" });

    for (const rejectedUrl of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///etc/passwd",
      "blob:https://example.com/id",
      "about:blank",
      "vscode://file/path",
      "https://user:password@example.com/private",
      "//example.com/relative",
    ]) {
      const rejected = await postOpenLink(handle.port, handle.sessionToken, rejectedUrl);
      assert.equal(rejected.status, 200, rejectedUrl);
      assert.deepEqual(rejected.body.result, { isError: true }, rejectedUrl);
    }
  } finally {
    handle.close("test-complete");
  }
});

test("MCP UI message retention keeps a bounded tail across message kinds", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 3, maxBytes: 1_024, maxItemBytes: 128 });
  buffer.addPrompt("first");
  buffer.addNotification("second");
  buffer.addIntent("third", { value: 3 });
  buffer.addPrompt("fourth");

  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.prompts, ["fourth"]);
  assert.deepEqual(snapshot.notifications, ["second"]);
  assert.deepEqual(snapshot.intents, [{ intent: "third", params: { value: 3 } }]);
  assert.equal(snapshot.retention?.droppedItems, 1);
});

test("MCP UI message retention truncates oversized strings and intent params", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 10, maxBytes: 1_024, maxItemBytes: 64 });
  buffer.addPrompt("x".repeat(256));
  buffer.addIntent("intent", { payload: "y".repeat(256) });

  const snapshot = buffer.snapshot();
  assert.ok(Buffer.byteLength(snapshot.prompts[0] ?? "", "utf8") <= 64);
  assert.deepEqual(snapshot.intents, [{ intent: "intent", params: { _truncated: true } }]);
  assert.equal(snapshot.retention?.truncatedItems, 2);
});

test("MCP UI message retention enforces a total byte budget", () => {
  const buffer = createUiSessionMessageBuffer({ maxItems: 10, maxBytes: 100, maxItemBytes: 80 });
  buffer.addPrompt("a".repeat(50));
  buffer.addNotification("b".repeat(50));
  buffer.addPrompt("c".repeat(50));

  const snapshot = buffer.snapshot();
  assert.ok((snapshot.retention?.retainedBytes ?? Number.POSITIVE_INFINITY) <= 100);
  assert.ok((snapshot.retention?.droppedItems ?? 0) >= 1);
  assert.deepEqual(snapshot.prompts, ["c".repeat(50)]);
});

test("MCP app HTML runs in an opaque script-only sandbox without the session token", () => {
  const html = renderHostHtml();
  const iframeTag = html.match(/<iframe\b[^>]*id="mcp-app"[^>]*>/)?.[0];

  assert.ok(iframeTag, "host renders the MCP app iframe");
  assert.match(iframeTag, /\bsandbox="allow-scripts"/);
  assert.doesNotMatch(iframeTag, /allow-same-origin|allow-forms|allow-top-navigation/);
  assert.match(html, /const UI_HTML = /);
  assert.match(html, /iframe\.srcdoc = UI_HTML/);
  assert.doesNotMatch(html, /iframe\.src\s*=\s*"\/ui-app\?session=/);
  assert.ok(
    html.indexOf("history.replaceState") < html.indexOf("iframe.srcdoc = UI_HTML"),
    "the token-bearing query is removed before the sandbox loads",
  );
});

test("MCP app HTML applies a restrictive host CSP when resource CSP is absent", () => {
  const html = renderHostHtml();

  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(html, /style-src 'unsafe-inline'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /worker-src 'none'/);
});

test("MCP app HTML intersects permissive resource policies with the host CSP", () => {
  const html = renderHostHtml(`<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *; form-action *; base-uri *">
  </head><body><script>parent.postMessage({ jsonrpc: "2.0" }, "*")</script></body></html>`, {
    connectDomains: ["*"],
    scriptDomains: ["*"],
    styleDomains: ["*"],
    imgDomains: ["*"],
    frameDomains: ["*"],
    workerDomains: ["*"],
    baseUriDomains: ["*"],
  });

  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /default-src \*; connect-src \*; form-action \*; base-uri \*/);
  assert.match(html, /default-src 'none'; script-src \*; style-src \*; img-src \*; connect-src \*; frame-src \*; worker-src \*; base-uri \*/);
  assert.ok(
    (html.match(/http-equiv=\\?"Content-Security-Policy\\?"/g) ?? []).length >= 3,
    "host, metadata, and resource HTML policies are all preserved for CSP intersection",
  );
});

test("MCP open-link confirmation is parent-owned and shows the normalized destination", () => {
  const html = renderHostHtml();
  const normalizeIndex = html.indexOf("const normalizedUrl = typeof result.url");
  const confirmIndex = html.indexOf("window.confirm(\"Open this link in your browser?");
  const openIndex = html.indexOf("window.open(normalizedUrl");

  assert.ok(normalizeIndex >= 0);
  assert.ok(confirmIndex > normalizeIndex);
  assert.ok(openIndex > confirmIndex);
  assert.match(html, /window\.confirm\("Open this link in your browser\?\\n\\n" \+ normalizedUrl\)/);
  assert.match(html, /params: \{ url: normalizedUrl \}/);
  assert.doesNotMatch(html, /window\.open\(params\.url/);
});

test("MCP bridge closes and stops forwarding after a second iframe load", () => {
  const html = renderHostHtml();

  assert.match(html, /iframe\.addEventListener\("load", \(\) => \{/);
  assert.match(html, /if \(!initialIframeLoadAccepted\)/);
  assert.match(html, /void invalidateBridge\(\)/);
  assert.match(html, /bridgeInvalidated = true/);
  assert.match(html, /eventSource\?\.close\(\)/);
  assert.match(html, /await bridge\.close\(\)/);
  assert.match(html, /bridgeInvalidated \|\| event\.source !== iframe\.contentWindow/);
});

test("privileged MCP outer host sends a strict functional CSP header", async () => {
  const handle = await startUiServer({
    sessionToken: "header-test-token",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: { uri: "ui://test", html: "<script>parent.postMessage({}, '*')</script>", meta: {} },
    manager: {} as McpServerManager,
    consentManager: {
      requiresPrompt: () => true,
      shouldCacheConsent: () => true,
    } as unknown as ConsentManager,
  });

  try {
    const response = await fetch(handle.url);
    const csp = response.headers.get("content-security-policy") ?? "";

    assert.equal(response.status, 200);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  } finally {
    handle.close("test-complete");
  }
});

test("MCP bridge accepts messages only from the sandboxed app window", () => {
  const html = renderHostHtml();

  assert.match(html, /event\.source !== iframe\.contentWindow/);
  assert.match(html, /new PostMessageTransport\(iframe\.contentWindow, iframe\.contentWindow\)/);
});

test("MCP tool consent and privileged calls remain parent-owned", () => {
  const html = renderHostHtml();

  assert.match(html, /window\.confirm\("Allow this UI to call server tools for this session\?"\)/);
  assert.match(html, /post\("\/proxy\/ui\/consent", \{ approved: true \}\)/);
  assert.match(html, /post\("\/proxy\/tools\/call", params\)/);
  assert.ok(
    html.indexOf("const UI_HTML = ") < html.indexOf("bridge.oncalltool = async"),
    "the supplied app is data consumed by the parent bridge, not parent script",
  );
});
