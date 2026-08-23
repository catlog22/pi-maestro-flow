---
title: Request blocking/mocking, response-body rewrite via CDP Fetch, XHR harvesting
type: recipe
tools: [browser]
sop_topic: network-mocking
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Network interception & mocking — full access to requests/responses without a proxy server.

REQUEST-LEVEL (puppeteer native, inside run code)
- await page.setRequestInterception(true); page.on('request', (req) => { if (/analytics|ads|fonts/.test(req.url())) req.abort(); else req.continue(); });
- Blocking third-party noise speeds up loads and reduces detection surface.
- Mock an API fixture: req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }) — stabler than clicking through UI to reach state.

RESPONSE-BODY REWRITE (puppeteer cannot do this natively; use a CDP session)
- const s = await page.createCDPSession();
- await s.send('Fetch.enable', { patterns: [{ urlPattern: '**/api/*', requestStage: 'Response' }] });
- s.on('Fetch.requestPaused', async (e) => { const r = await s.send('Fetch.getResponseBody', { requestId: e.requestId }); /* modify */ await s.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: e.responseStatusCode ?? 200, body: newBody }); });
- PITFALL: every matching request pauses while Fetch is enabled — fulfill/fail/continue EACH paused event or the page hangs forever.
- Capture-only alternative: page.on('response') + response.json()/text() to harvest XHR payloads (batch APIs, tokens) without touching traffic.

