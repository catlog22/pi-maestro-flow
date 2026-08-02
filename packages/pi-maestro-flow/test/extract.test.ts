import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-extract-stream-cleanup-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
await writeFile(join(root, "web-search.json"), JSON.stringify({
	ssrf: { allowRanges: ["127.0.0.1/32"] },
}));

const { extractViaHttp } = await import("../src/tools/web-access/extract.ts");

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
});

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
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function waitForConnectionClose(closed: Promise<void>): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			closed,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("response connection remained open")), 2_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function extractEndlessResponse(status: number, contentType: string) {
	let resolveClosed: (() => void) | undefined;
	const connectionClosed = new Promise<void>(resolve => {
		resolveClosed = resolve;
	});
	const server = createServer((request, response) => {
		const interval = setInterval(() => response.write("endless body\n"), 25);
		request.socket.once("close", () => {
			clearInterval(interval);
			resolveClosed?.();
		});
		response.writeHead(status, { "content-type": contentType });
		response.write("endless body\n");
	});
	const port = await listen(server);
	const url = `http://stream.example:${port}/endless`;

	try {
		const result = await extractViaHttp(url, undefined, {
			timeoutMs: 10_000,
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		await waitForConnectionClose(connectionClosed);
		return { result, url };
	} finally {
		server.closeAllConnections();
		await close(server);
	}
}

test("native extraction closes an endless non-2xx response", async () => {
	const { result, url } = await extractEndlessResponse(404, "text/plain");
	assert.deepEqual(result, {
		url,
		title: "",
		content: "",
		error: "HTTP 404: Not Found",
	});
});

test("native extraction closes an endless unsupported response", async () => {
	const { result, url } = await extractEndlessResponse(200, "video/mp4");
	assert.deepEqual(result, {
		url,
		title: "",
		content: "",
		error: "Unsupported content type: video/mp4",
	});
});
