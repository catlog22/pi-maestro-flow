import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTitleRequestBody, filterNullHeaders, parseTitleResponse } from "../src/title-llm.ts";

test("buildTitleRequestBody carries the short-title prompt and the clipped user text", () => {
	const body = JSON.parse(buildTitleRequestBody("qwen3.8-max", "analyze this project")) as {
		model: string;
		messages: { role: string; content: string }[];
		max_tokens: number;
		thinking: { type: string };
	};
	assert.equal(body.model, "qwen3.8-max");
	assert.equal(body.messages[0]?.role, "system");
	assert.match(body.messages[0]!.content, /at most 20 characters/);
	assert.equal(body.messages[1]?.content, "analyze this project");
	assert.equal(body.max_tokens, 512);
	assert.deepEqual(body.thinking, { type: "disabled" });
});

test("parseTitleResponse extracts from a standard chat-completions payload", () => {
	const body = {
		choices: [{ message: { content: '{"title": "Fix login button"}' } }],
	};
	assert.equal(parseTitleResponse(body), "Fix login button");
});

test("parseTitleResponse tolerates code fences and trailing prose", () => {
	assert.equal(parseTitleResponse({ choices: [{ message: { content: '```json\n{"title": "Add OAuth"}\n```' } }] }), "Add OAuth");
	assert.equal(parseTitleResponse({ choices: [{ message: { content: 'Sure! {"title": "Debug CI tests"}' } }] }), "Debug CI tests");
});

test("parseTitleResponse falls back to a substring scan for bare titles", () => {
	assert.equal(parseTitleResponse({ choices: [{ message: { content: 'Returning: "title": "Refactor API client"' } }] }), "Refactor API client");
});

test("parseTitleResponse returns null for malformed or empty responses", () => {
	assert.equal(parseTitleResponse(undefined), null);
	assert.equal(parseTitleResponse({ choices: [] }), null);
	assert.equal(parseTitleResponse({ choices: [{ message: { content: "{}" } }] }), null);
	assert.equal(parseTitleResponse({ choices: [{ message: { content: '{"title": ""}' } }] }), null);
});

test("filterNullHeaders drops ProviderHeaders deletion markers", () => {
	assert.deepEqual(
		filterNullHeaders({ authorization: "Bearer abc", "x-delete": null }),
		{ authorization: "Bearer abc" },
	);
	assert.equal(filterNullHeaders(undefined), undefined);
	assert.equal(filterNullHeaders({ "x-delete": null }), undefined);
});
