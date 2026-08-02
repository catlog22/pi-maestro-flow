import assert from "node:assert/strict";
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
