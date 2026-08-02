import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, suggestTitle } from "../src/title-gen.ts";

test("plain prose passes through as the session topic", () => {
	assert.equal(suggestTitle("Fix login"), "Fix login");
	assert.equal(suggestTitle("分析终端标题"), "分析终端标题");
});

test("code fences and inline code are scaffolding, not the topic", () => {
	assert.equal(
		suggestTitle("Help me ```const x = 1``` fix typo"),
		"Help me fix typo",
	);
	assert.equal(suggestTitle("what does `setTitle` do"), "what does do");
});

test("URLs are noise in a tab title", () => {
	assert.equal(
		suggestTitle("check https://example.com/x then diff"),
		"check then diff",
	);
});

test("whitespace collapses to a single space", () => {
	assert.equal(suggestTitle("  deep\n\tsession   topic   "), "deep session topic");
});

test("overlong titles are clipped with an ellipsis", () => {
	const long = "Investigate and fix the issue where the login button does not respond on mobile devices";
	const t = suggestTitle(long)!;
	assert.ok(t.endsWith("…"));
	assert.ok(t.length <= 21, `length ${t.length}`);
	assert.ok(!t.includes("does not respond"));
});

test("empty, too-short, or punctuation-only text yields no title", () => {
	assert.equal(suggestTitle(""), undefined);
	assert.equal(suggestTitle("   "), undefined);
	assert.equal(suggestTitle("ab"), undefined);
	assert.equal(suggestTitle("!!!"), undefined);
	assert.equal(suggestTitle("```code only```"), undefined);
});

test("cleanTitle strips first-person leads and spoken prompts", () => {
	assert.equal(cleanTitle("我们分析终端标题"), "分析终端标题");
	assert.equal(cleanTitle("帮我分析终端标题"), "分析终端标题");
	assert.equal(cleanTitle("请帮我分析终端标题"), "分析终端标题");
	assert.equal(cleanTitle("We analyze the login flow"), "analyze the login flow");
	assert.equal(cleanTitle("I need to fix login"), "fix login");
	assert.equal(cleanTitle("You can debug CI tests"), "debug CI tests");
});

test("cleanTitle strips surrounding quotes and keeps objective phrases", () => {
	assert.equal(cleanTitle('"Fix login button"'), "Fix login button");
	assert.equal(cleanTitle("“终端标题实现分析”"), "终端标题实现分析");
	assert.equal(cleanTitle("Fix login button"), "Fix login button");
	assert.equal(cleanTitle("终端标题实现分析"), "终端标题实现分析");
});

test("suggestTitle outputs an objective noun phrase", () => {
	assert.equal(suggestTitle("帮我分析 claude-code-sourcemap 项目里终端标题"), "分析 claude-code-sourc…");
	assert.equal(suggestTitle("我们看看这个项目的实现"), "看看这个项目的实现");
});
