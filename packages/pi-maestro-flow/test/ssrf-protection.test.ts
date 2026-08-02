import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:net";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { fetchRemoteUrl, type Lookup } from "../src/tools/web-access/ssrf-protection.ts";

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
