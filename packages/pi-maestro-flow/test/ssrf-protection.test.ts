import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import {
	fetchRemoteUrl,
	readBoundedResponseBytes,
	readBoundedResponseText,
	type Lookup,
} from "../src/tools/web-access/ssrf-protection.ts";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return address.port;
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("production fetch pins the validated address and preserves the original Host", async () => {
	let receivedHost: string | undefined;
	const server = createServer((request, response) => {
		receivedHost = request.headers.host;
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("pinned");
	});
	const port = await listen(server);

	try {
		const response = await fetchRemoteUrl(`http://origin.example:${port}/resource?q=1`, {}, {
			allowRanges: ["127.0.0.1/32"],
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		assert.equal(await response.text(), "pinned");
		assert.equal(receivedHost, `origin.example:${port}`);
	} finally {
		await close(server);
	}
});

test("production HTTPS fetch preserves the original hostname for TLS SNI", async () => {
	let receivedServername: string | undefined;
	const server = createTlsServer({
		SNICallback(servername, callback) {
			receivedServername = servername;
			callback(new Error("stop after SNI"));
		},
	});
	server.on("tlsClientError", () => undefined);
	const port = await listen(server);

	try {
		await assert.rejects(fetchRemoteUrl(`https://secure.example:${port}/`, {}, {
			allowRanges: ["127.0.0.1/32"],
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		}));
		assert.equal(receivedServername, "secure.example");
	} finally {
		await close(server);
	}
});

test("production fetch does not reconnect to a private rebinding answer", async () => {
	let privateConnections = 0;
	const privateServer = createServer((_request, response) => {
		privateConnections += 1;
		response.end("private");
	});
	const port = await listen(privateServer);
	let lookupCalls = 0;
	const rebindingLookup: Lookup = async () => {
		lookupCalls += 1;
		return lookupCalls === 1
			? [{ address: "203.0.113.1", family: 4 }]
			: [{ address: "127.0.0.1", family: 4 }];
	};

	try {
		await assert.rejects(fetchRemoteUrl(
			`http://rebind.example:${port}/secret`,
			{ signal: AbortSignal.timeout(500) },
			{ lookup: rebindingLookup },
		));
		assert.equal(lookupCalls, 1);
		assert.equal(privateConnections, 0);
	} finally {
		await close(privateServer);
	}
});

test("redirects are resolved and validated again while injected fetch remains supported", async () => {
	const lookups: string[] = [];
	const requests: string[] = [];
	const lookup: Lookup = async (hostname) => {
		lookups.push(hostname);
		return [{ address: "93.184.216.34", family: 4 }];
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
		requests.push(url.toString());
		assert.equal(init?.redirect, "manual");
		return url.hostname === "first.example"
			? new Response(null, { status: 302, headers: { location: "https://second.example/final" } })
			: new Response("done", { status: 200 });
	};

	const response = await fetchRemoteUrl("https://first.example/start", {}, { fetch: fetchImpl, lookup });
	assert.equal(await response.text(), "done");
	assert.deepEqual(lookups, ["first.example", "second.example"]);
	assert.deepEqual(requests, ["https://first.example/start", "https://second.example/final"]);
});

function redirectResponse(status: number, location: string, onCancel: () => void = () => undefined): Response {
	return new Response(new ReadableStream({ cancel: onCancel }), { status, headers: { location } });
}

function publicLookup(): Promise<Array<{ address: string; family: number }>> {
	return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
}

test("trustEnvProxy never treats proxy environment presence as DNS validation", async () => {
	const previous = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = "http://proxy.example:8080";
	let lookupCalls = 0;
	try {
		await assert.rejects(fetchRemoteUrl("http://target.example/", {}, {
			trustEnvProxy: true,
			lookup: async () => {
				lookupCalls += 1;
				return [{ address: "127.0.0.1", family: 4 }];
			},
			fetch: async () => new Response("must not fetch"),
		}), /Blocked internal address/);
		assert.equal(lookupCalls, 1);
	} finally {
		if (previous === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = previous;
	}
});

test("redirect validation blocks DNS rebinding and cancels the redirect body", async () => {
	let lookupCalls = 0;
	let fetchCalls = 0;
	let cancellations = 0;
	await assert.rejects(fetchRemoteUrl("https://rebind.example/start", {}, {
		lookup: async () => {
			lookupCalls += 1;
			return lookupCalls === 1
				? [{ address: "93.184.216.34", family: 4 }]
				: [{ address: "127.0.0.1", family: 4 }];
		},
		fetch: async () => {
			fetchCalls += 1;
			return redirectResponse(302, "/private", () => { cancellations += 1; });
		},
	}), /Blocked internal address/);
	assert.equal(lookupCalls, 2);
	assert.equal(fetchCalls, 1);
	assert.equal(cancellations, 1);
});

test("redirect limit cancellation cleans up every discarded response", async () => {
	let fetchCalls = 0;
	let cancellations = 0;
	await assert.rejects(fetchRemoteUrl("https://loop.example/start", {}, {
		lookup: publicLookup,
		maxRedirects: 1,
		fetch: async () => {
			fetchCalls += 1;
			return redirectResponse(307, "/again", () => { cancellations += 1; });
		},
	}), /Too many redirects/);
	assert.equal(fetchCalls, 2);
	assert.equal(cancellations, 2);
});

test("301, 302, and 303 redirects follow Fetch method and body-header rules", async () => {
	const cases = [
		{ status: 301, method: "POST", expectedMethod: "GET", expectedBody: "" },
		{ status: 302, method: "POST", expectedMethod: "GET", expectedBody: "" },
		{ status: 301, method: "PUT", expectedMethod: "PUT", expectedBody: "payload" },
		{ status: 302, method: "PUT", expectedMethod: "PUT", expectedBody: "payload" },
		{ status: 303, method: "PUT", expectedMethod: "GET", expectedBody: "" },
	] as const;

	for (const redirect of cases) {
		const requests: Array<{ method: string; body: string; headers: Headers }> = [];
		const response = await fetchRemoteUrl("https://method.example/start", {
			method: redirect.method,
			body: "payload",
			headers: {
				"content-encoding": "identity",
				"content-location": "/source",
				"content-type": "text/plain",
			},
		}, {
			lookup: publicLookup,
			fetch: async (_input, init) => {
				requests.push({
					method: init?.method ?? "GET",
					body: init?.body ? await new Response(init.body).text() : "",
					headers: new Headers(init?.headers),
				});
				return requests.length === 1
					? redirectResponse(redirect.status, "/next")
					: new Response("done");
			},
		});
		assert.equal(await response.text(), "done");
		assert.equal(requests[1].method, redirect.expectedMethod, `${redirect.status} ${redirect.method}`);
		assert.equal(requests[1].body, redirect.expectedBody, `${redirect.status} ${redirect.method}`);
		for (const header of ["content-encoding", "content-location", "content-type"]) {
			assert.equal(requests[1].headers.has(header), redirect.expectedBody !== "", `${redirect.status} ${redirect.method} ${header}`);
		}
	}

	const methods: string[] = [];
	await fetchRemoteUrl("https://method.example/start", { method: "HEAD" }, {
		lookup: publicLookup,
		fetch: async (_input, init) => {
			methods.push(init?.method ?? "GET");
			return methods.length === 1 ? redirectResponse(303, "/next") : new Response(null);
		},
	});
	assert.deepEqual(methods, ["HEAD", "HEAD"]);
});

test("cross-origin redirects remove sensitive headers", async () => {
	const redirectedHeaders: Headers[] = [];
	await fetchRemoteUrl("https://first.example/start", {
		headers: {
			Authorization: "Bearer secret",
			Cookie: "session=secret",
			"X-API-Key": "secret",
			"X-Safe": "kept",
		},
	}, {
		lookup: publicLookup,
		fetch: async (_input, init) => {
			redirectedHeaders.push(new Headers(init?.headers));
			return redirectedHeaders.length === 1
				? redirectResponse(302, "https://second.example/next")
				: new Response("done");
		},
	});
	assert.equal(redirectedHeaders[1].has("authorization"), false);
	assert.equal(redirectedHeaders[1].has("cookie"), false);
	assert.equal(redirectedHeaders[1].has("x-api-key"), false);
	assert.equal(redirectedHeaders[1].get("x-safe"), "kept");
});

test("307 and 308 redirects replay bounded request bodies", async () => {
	for (const status of [307, 308]) {
		const requests: Array<{ method: string; body: string }> = [];
		await fetchRemoteUrl("https://replay.example/start", { method: "POST", body: "replay me" }, {
			lookup: publicLookup,
			fetch: async (_input, init) => {
				requests.push({
					method: init?.method ?? "GET",
					body: init?.body ? await new Response(init.body).text() : "",
				});
				return requests.length === 1 ? redirectResponse(status, "/next") : new Response("done");
			},
		});
		assert.deepEqual(requests, [
			{ method: "POST", body: "replay me" },
			{ method: "POST", body: "replay me" },
		]);
	}
});

test("request replay enforces the body ceiling before network access", async () => {
	let fetchCalls = 0;
	await assert.rejects(fetchRemoteUrl("https://size.example/", { method: "POST", body: "four" }, {
		lookup: publicLookup,
		maxReplayBodyBytes: 3,
		fetch: async () => {
			fetchCalls += 1;
			return new Response("unexpected");
		},
	}), /exceeds replay limit of 3 bytes/);
	assert.equal(fetchCalls, 0);
});

test("IANA special-purpose IPv4 and IPv6 destinations are blocked", async () => {
	const specialAddresses = [
		{ address: "192.0.0.9", family: 4 },
		{ address: "192.0.2.1", family: 4 },
		{ address: "192.31.196.1", family: 4 },
		{ address: "192.52.193.1", family: 4 },
		{ address: "192.88.99.1", family: 4 },
		{ address: "192.175.48.1", family: 4 },
		{ address: "198.18.0.1", family: 4 },
		{ address: "198.51.100.1", family: 4 },
		{ address: "203.0.113.1", family: 4 },
		{ address: "224.0.0.1", family: 4 },
		{ address: "240.0.0.1", family: 4 },
		{ address: "64:ff9b::808:808", family: 6 },
		{ address: "2001:2::1", family: 6 },
		{ address: "2001:db8::1", family: 6 },
		{ address: "3fff::1", family: 6 },
		{ address: "5f00::1", family: 6 },
		{ address: "fec0::1", family: 6 },
		{ address: "ff02::1", family: 6 },
		{ address: "4000::1", family: 6 },
		{ address: "::ffff:8.8.8.8", family: 6 },
	] as const;

	for (const resolved of specialAddresses) {
		let fetchCalls = 0;
		await assert.rejects(fetchRemoteUrl("https://special.example/", {}, {
			lookup: async () => [resolved],
			fetch: async () => {
				fetchCalls += 1;
				return new Response("unexpected");
			},
		}), /Blocked internal address or special-purpose destination/, resolved.address);
		assert.equal(fetchCalls, 0, resolved.address);
	}
});

test("globally routable IPv4 and IPv6 unicast destinations are allowed", async () => {
	for (const resolved of [
		{ address: "93.184.216.34", family: 4 },
		{ address: "2606:4700:4700::1111", family: 6 },
	]) {
		const response = await fetchRemoteUrl("https://public.example/", {}, {
			lookup: async () => [resolved],
			fetch: async () => new Response("public"),
		});
		assert.equal(await response.text(), "public");
	}
});

test("allowRanges overrides special-purpose and mapped IPv4 classifications", async () => {
	for (const testCase of [
		{ address: "192.0.0.9", family: 4, allowRanges: ["192.0.0.0/24"] },
		{ address: "::ffff:127.0.0.1", family: 6, allowRanges: ["127.0.0.0/8"] },
	] as const) {
		const response = await fetchRemoteUrl("https://allowed.example/", {}, {
			allowRanges: [...testCase.allowRanges],
			lookup: async () => [{ address: testCase.address, family: testCase.family }],
			fetch: async () => new Response("allowed"),
		});
		assert.equal(await response.text(), "allowed");
	}
});

test("bounded response readers cancel when streamed bytes exceed the ceiling", async () => {
	let cancellations = 0;
	const response = new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.enqueue(new Uint8Array([4, 5, 6]));
		},
		cancel() {
			cancellations += 1;
		},
	}));
	await assert.rejects(readBoundedResponseBytes(response, 5), /exceeds limit of 5 bytes/);
	assert.equal(cancellations, 1);
});

test("bounded response readers cancel an oversized declared body before reading", async () => {
	let cancellations = 0;
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array([1]));
		},
		cancel() {
			cancellations += 1;
		},
	}), { headers: { "content-length": "6" } });
	await assert.rejects(readBoundedResponseBytes(response, 5), /exceeds limit of 5 bytes/);
	assert.equal(cancellations, 1);
});

test("bounded response text preserves UTF-8 split across stream chunks", async () => {
	const expected = `A${String.fromCodePoint(0x20ac)}Z`;
	const encoded = new TextEncoder().encode(expected);
	const response = new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoded.slice(0, 2));
			controller.enqueue(encoded.slice(2));
			controller.close();
		},
	}));
	assert.equal(await readBoundedResponseText(response, encoded.byteLength), expected);
});

test("non-replayable streaming request bodies are rejected before network access", async () => {
	let fetchCalls = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("stream"));
			controller.close();
		},
	});
	await assert.rejects(fetchRemoteUrl("https://stream.example/", { method: "POST", body }, {
		lookup: publicLookup,
		fetch: async () => {
			fetchCalls += 1;
			return new Response("unexpected");
		},
	}), /Streaming request bodies cannot be safely replayed/);
	assert.equal(fetchCalls, 0);
});

test("Firecrawl requests and redirects use the pinned transport", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-firecrawl-pinned-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousBaseUrl = process.env.FIRECRAWL_BASE_URL;
	const previousApiKey = process.env.FIRECRAWL_API_KEY;
	const previousFreshScrape = process.env.FIRECRAWL_FRESH_SCRAPE;
	const previousFetch = globalThis.fetch;
	const requests: Array<{ host: string | undefined; method: string | undefined; body: string }> = [];
	let port = 0;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf8");
		requests.push({ host: request.headers.host, method: request.method, body });
		if (requests.length === 1) {
			response.writeHead(307, { location: `http://redirect.example:${port}/final` });
			response.end("redirect");
			return;
		}
		const targetUrl = (JSON.parse(body) as { url?: unknown }).url;
		if (targetUrl === "https://oversized-success.example/article") {
			response.writeHead(200, { "content-type": "application/json", "content-length": String(5 * 1024 * 1024 + 1) });
			response.end("{}");
			return;
		}
		if (targetUrl === "https://oversized-error.example/article") {
			response.writeHead(500, { "content-type": "application/json", "content-length": String(64 * 1024 + 1) });
			response.end("{}");
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ success: true, data: { title: "Pinned", markdown: "content" } }));
	});
	port = await listen(server);

	process.env.PI_CODING_AGENT_DIR = root;
	process.env.FIRECRAWL_BASE_URL = `http://firecrawl.example:${port}`;
	delete process.env.FIRECRAWL_API_KEY;
	delete process.env.FIRECRAWL_FRESH_SCRAPE;
	let globalFetchCalls = 0;
	globalThis.fetch = async () => {
		globalFetchCalls += 1;
		throw new Error("global fetch must not be used");
	};

	try {
		const { extractWithFirecrawl } = await import("../src/tools/web-access/firecrawl.ts");
		const result = await extractWithFirecrawl("https://target.example/article", undefined, {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			ssrf: { allowRanges: ["127.0.0.1/32"], trustEnvProxy: true },
		});
		assert.deepEqual(result, {
			url: "https://target.example/article",
			title: "Pinned",
			content: "content",
			error: null,
		});
		assert.equal(globalFetchCalls, 0);
		assert.deepEqual(requests.map(request => request.host), [
			`firecrawl.example:${port}`,
			`redirect.example:${port}`,
		]);
		assert.deepEqual(requests.map(request => request.method), ["POST", "POST"]);
		assert.equal(requests[1].body, requests[0].body);
		assert.equal(JSON.parse(requests[0].body).lockdown, true);

		await assert.rejects(extractWithFirecrawl("https://oversized-success.example/article", undefined, {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			ssrf: { allowRanges: ["127.0.0.1/32"], trustEnvProxy: true },
		}), /Firecrawl scrape response exceeds 5242880 bytes/);
		await assert.rejects(extractWithFirecrawl("https://oversized-error.example/article", undefined, {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			ssrf: { allowRanges: ["127.0.0.1/32"], trustEnvProxy: true },
		}), /Firecrawl scrape error 500: response body exceeds 65536 bytes/);

		process.env.FIRECRAWL_FRESH_SCRAPE = "true";
		await assert.rejects(extractWithFirecrawl("https://target.example/article", undefined, {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			ssrf: { allowRanges: ["127.0.0.1/32"], trustEnvProxy: true },
		}), /fresh scrape deferred.*local DNS pinning/i);
		assert.equal(requests.length, 4);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
		else process.env.FIRECRAWL_BASE_URL = previousBaseUrl;
		if (previousApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
		else process.env.FIRECRAWL_API_KEY = previousApiKey;
		if (previousFreshScrape === undefined) delete process.env.FIRECRAWL_FRESH_SCRAPE;
		else process.env.FIRECRAWL_FRESH_SCRAPE = previousFreshScrape;
		await close(server);
		await rm(root, { recursive: true, force: true });
	}
});
