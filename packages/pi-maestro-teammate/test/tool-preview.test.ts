import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { previewToolCallArgs } from "../src/runs/shared/tool-preview.ts";

test("onToolStart forwards the redacted args preview into progress", () => {
	// The child-event forwarding path lives in the Pi subprocess attempt module.
	const source = fs.readFileSync(new URL("../src/runs/execution.ts", import.meta.url), "utf-8")
		+ fs.readFileSync(new URL("../src/runs/pi-subprocess-attempt.ts", import.meta.url), "utf-8");
	assert.match(source, /previewToolCallArgs\(event\.args, toolName\)/);
	assert.match(source, /argsPreview === undefined/);
	assert.match(source, /\{ name: toolName, status: "running", argsPreview \}\);/);
});

test("previewToolCallArgs prefers the first informative key in priority order", () => {
	assert.equal(previewToolCallArgs({ command: "git diff", cwd: "/tmp" }), "command=git diff");
	assert.equal(previewToolCallArgs({ file_path: "src/a.ts", pattern: "foo" }), "file_path=src/a.ts");
	assert.equal(previewToolCallArgs({ queries: ["one", "two"], query: "x" }), "query=x");
});

test("previewToolCallArgs truncates long scalar values", () => {
	const long = "a".repeat(200);
	assert.equal(previewToolCallArgs({ command: long }), `command=${"a".repeat(49)}…`);
});

test("previewToolCallArgs redacts secret-shaped keys wholesale", () => {
	assert.equal(previewToolCallArgs({ command: "curl -H x", authorization: "Bearer abc123" }), "command=curl -H x");
	assert.equal(previewToolCallArgs({ api_key: "sk-12345678901234567890" }), '{"api_key":"[redacted]"}');
	assert.equal(previewToolCallArgs({ password: "hunter2" }), '{"password":"[redacted]"}');
	assert.equal(previewToolCallArgs({ private_key: "PRIVATE_SECRET" }), '{"private_key":"[redacted]"}');
	assert.equal(previewToolCallArgs({ "private-key": "PRIVATE_SECRET" }), '{"private-key":"[redacted]"}');
	assert.equal(previewToolCallArgs({ passphrase: "phrase" }), '{"passphrase":"[redacted]"}');
	assert.equal(previewToolCallArgs({ credential: "value" }), '{"credential":"[redacted]"}');
	assert.equal(previewToolCallArgs({ "client-secret": "value" }), '{"client-secret":"[redacted]"}');
	assert.equal(previewToolCallArgs({ client_secret: "value" }), '{"client_secret":"[redacted]"}');
	assert.equal(previewToolCallArgs({ refresh_token: "abc" }), '{"refresh_token":"[redacted]"}');
	assert.equal(previewToolCallArgs({ session: "sess-123" }), '{"session":"[redacted]"}');
});

test("FU-RV-001 reviewer probes use canonical credential names across argument shapes", () => {
	assert.equal(previewToolCallArgs({ client_secret: "structured" }), '{"client_secret":"[redacted]"}');
	assert.equal(previewToolCallArgs({ command: "SSH_PRIVATE_KEY=environment run" }), "command=SSH_PRIVATE_KEY=[redacted] run");
	assert.equal(previewToolCallArgs({ command: "run passphrase=assignment" }), "command=run passphrase=[redacted]");
	assert.equal(previewToolCallArgs({ command: "login --credential option" }), "command=login --credential [redacted]");
});

test("previewToolCallArgs scrubs credential value shapes", () => {
	assert.equal(
		previewToolCallArgs({ command: "curl -H 'Authorization: Bearer abcdef0123456789'" }),
		"command=curl -H 'Authorization: [redacted]'",
	);
	assert.equal(
		previewToolCallArgs({ command: "curl -H 'Authorization: Basic dXNlcjpwYXNz'" }),
		"command=curl -H 'Authorization: [redacted]'",
	);
});

test("previewToolCallArgs redacts common credential headers", () => {
	assert.equal(
		previewToolCallArgs({ command: "curl -H 'X-API-Key: hunter2'" }),
		"command=curl -H 'X-API-Key: [redacted]'",
	);
	assert.equal(
		previewToolCallArgs({ command: 'curl -H "Cookie: sid=hunter2; theme=dark"' }),
		'command=curl -H "Cookie: [redacted]"',
	);
	assert.equal(
		previewToolCallArgs({ command: "Authorization: custom-credential" }),
		"command=Authorization: [redacted]",
	);
});

test("previewToolCallArgs redacts credential URL query values", () => {
	assert.equal(
		previewToolCallArgs({ url: "https://example.test/run?access_token=hunter2&x=1" }),
		"url=https://example.test/run?access_token=[redacted]&…",
	);
	assert.equal(
		previewToolCallArgs({ url: "https://e.test/?access_token=h&x=1" }),
		"url=https://e.test/?access_token=[redacted]&x=1",
	);
	assert.equal(
		previewToolCallArgs({ query: "api_key=one&safe=yes" }),
		"query=api_key=[redacted]&safe=yes",
	);
	assert.equal(
		previewToolCallArgs({ query: "refresh-token=two" }),
		"query=refresh-token=[redacted]",
	);
});

test("previewToolCallArgs redacts explicit credential assignments only", () => {
	assert.equal(
		previewToolCallArgs({ command: "run refresh_token=one password='secret two'" }),
		"command=run refresh_token=[redacted] password='[redacted]'",
	);
	assert.equal(
		previewToolCallArgs({ command: "deploy --password=three --api-key four" }),
		"command=deploy --password=[redacted] --api-key [redacted]",
	);
	assert.equal(previewToolCallArgs({ command: "login --token value" }), "command=login --token [redacted]");
	assert.equal(previewToolCallArgs({ command: "login --password 'secret two'" }), "command=login --password '[redacted]'");
	for (const name of ["private-key", "private_key", "passphrase", "credential", "client-secret", "client_secret"]) {
		assert.equal(previewToolCallArgs({ command: `run ${name}=value` }), `command=run ${name}=[redacted]`);
		assert.equal(previewToolCallArgs({ command: `run --${name} value` }), `command=run --${name} [redacted]`);
	}
	for (const option of ["secret", "access-key", "access-token", "refresh-token"]) {
		assert.equal(previewToolCallArgs({ command: `run --${option} value` }), `command=run --${option} [redacted]`);
	}
});

test("RV-001 probe redacts common and suffix-based environment credentials", () => {
	for (const name of [
		"AWS_SECRET_ACCESS_KEY",
		"NPM_TOKEN",
		"GITHUB_TOKEN",
		"DEPLOY_SECRET",
		"DB_PASSWORD",
		"SERVICE_API_KEY",
		"STORAGE_ACCESS_KEY",
		"SSH_PRIVATE_KEY",
		"SSH_PASSPHRASE",
		"DEPLOY_CREDENTIAL",
		"OAUTH_CLIENT_SECRET",
	]) {
		assert.equal(previewToolCallArgs({ command: `${name}=credential run` }), `command=${name}=[redacted] run`);
	}
	assert.equal(
		previewToolCallArgs({ command: 'GITHUB_TOKEN="credential with spaces" run' }),
		'command=GITHUB_TOKEN="[redacted]" run',
	);
});

test("previewToolCallArgs preserves ordinary formatting and non-credential assignments", () => {
	assert.equal(
		previewToolCallArgs({ command: "KEY=value COLOR=auto FORMAT=json" }),
		"command=KEY=value COLOR=auto FORMAT=json",
	);
	assert.equal(previewToolCallArgs({ command: "git log --pretty format:%h" }), "command=git log --pretty format:%h");
	assert.equal(previewToolCallArgs({ command: "run --key value --format json" }), "command=run --key value --format json");
});

test("previewToolCallArgs redacts URL userinfo passwords", () => {
	assert.equal(
		previewToolCallArgs({ url: "https://alice:URL_PASSWORD@example.test/a" }),
		"url=https://alice:[redacted]@example.test/a",
	);
});

test("previewToolCallArgs removes real CSI and 8-bit CSI sequences", () => {
	assert.equal(
		previewToolCallArgs({ command: "printf \x1b[31mred\x1b[0m\nnext" }),
		"command=printf red next",
	);
	assert.equal(previewToolCallArgs({ command: "before\u009b2Jafter" }), "command=before after");
});

test("previewToolCallArgs removes OSC, DCS, SOS, PM, and APC payloads", () => {
	const command = [
		"start",
		"\x1b]0;osc-title\x07",
		"\x1bPdcs-payload\x1b\\",
		"\x1bXsos-payload\x1b\\",
		"\x1b^pm-payload\x1b\\",
		"\x1b_apc-payload\x1b\\",
		"end",
	].join("");
	assert.equal(previewToolCallArgs({ command }), "command=start end");
	assert.equal(
		previewToolCallArgs({ command: "left\u009dosc\u009cright\u0090dcs\u009cend" }),
		"command=left right end",
	);
});

test("previewToolCallArgs drops unterminated terminal sequences after bounding input", () => {
	for (const sequence of ["\x1b[31", "\u009b31", "\x1b]secret", "\x1bPsecret", "\x1bXsecret", "\x1b^secret", "\x1b_secret"]) {
		assert.equal(previewToolCallArgs({ command: `before${sequence}` }), "command=before");
	}
	const oversizedOsc = `before\x1b]${"secret".repeat(2_000)}`;
	assert.equal(previewToolCallArgs({ command: oversizedOsc }), "command=before");
});

test("previewToolCallArgs omits edit/write content with its original length", () => {
	assert.equal(
		previewToolCallArgs({ content: "hello world" }, "write"),
		'{"content":"[omitted 11 chars; use tool result diff]"}',
	);
	assert.equal(
		previewToolCallArgs({ oldText: "old", newText: "new text" }, "edit"),
		'{"oldText":"[omitted 3 chars; use tool result diff]","newText":"[omitted 8 chars; use tool result diff]"}',
	);
});

test("previewToolCallArgs does not generalize content omission to other tools", () => {
	assert.equal(previewToolCallArgs({ content: "visible" }, "read"), '{"content":"visible"}');
	assert.equal(previewToolCallArgs({ oldText: "visible" }), '{"oldText":"visible"}');
});

test("previewToolCallArgs never splits an astral code point", () => {
	const result = previewToolCallArgs({ command: `${'a'.repeat(48)}😀` });
	assert.ok(result);
	// Spread yields whole code points; a lone surrogate would surface as a raw
	// 0xD800-0xDFFF code unit and fail this check.
	const hasLoneSurrogate = [...result!].some((ch) => {
		const code = ch.codePointAt(0)!;
		return code >= 0xD800 && code <= 0xDFFF;
	});
	assert.equal(hasLoneSurrogate, false, "no lone surrogate may leak");
});

test("previewToolCallArgs bounds nesting, arrays, and object keys", () => {
	// No priority key: the fallback JSON path is what exercises the limits.
	const deep = previewToolCallArgs({ nested: { a: { b: { c: { d: "e" } } } } });
	assert.ok(deep);
	assert.match(deep!, /\[truncated\]/);
	assert.ok(!deep!.includes("\"d\":\"e\""), "deep value must be truncated");
	const many = previewToolCallArgs({ arr: Array.from({ length: 50 }, (_, i) => i) });
	assert.ok(!many!.includes("49"), "array must be bounded");
	const wide = previewToolCallArgs({ obj: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])) });
	assert.ok(wide);
	assert.ok(!wide!.includes("k49"), "object keys must be bounded");
});

test("previewToolCallArgs caps the final preview at the UTF-8 byte budget", () => {
	const result = previewToolCallArgs({
		a: "汉".repeat(3000),
		b: "汉".repeat(3000),
		c: "汉".repeat(3000),
		d: "汉".repeat(3000),
	});
	assert.ok(result);
	// The budget covers the preview body; the trailing ellipsis adds up to 3 UTF-8 bytes.
	assert.ok(Buffer.byteLength(result!, "utf8") <= 2048 + 3);
	assert.match(result!, /…$/);
});

test("previewToolCallArgs returns undefined for empty or uninformative args", () => {
	assert.equal(previewToolCallArgs(undefined), undefined);
	assert.equal(previewToolCallArgs(null), undefined);
	assert.equal(previewToolCallArgs({}), undefined);
	assert.equal(previewToolCallArgs(42), undefined);
});

test("previewToolCallArgs falls back to compact JSON for small object payloads", () => {
	const result = previewToolCallArgs({ extra: { b: 1 }, data: "x" });
	assert.ok(result);
	assert.equal(result, '{"extra":{"b":1},"data":"x"}');
});
