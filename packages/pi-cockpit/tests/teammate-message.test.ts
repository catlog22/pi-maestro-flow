import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	TEAMMATE_MESSAGE_CUSTOM_TYPE,
	parseTeammateMessageEnvelope,
	registerTeammateMessageRenderer,
	renderIncomingTeammateMessage,
} from "../src/teammate-message.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const canonical = [
	"[teammate:coordination] from @flow-trace",
	"Coordination only: preserve the active user objective.",
	"Reply with teammate-send to \"flow-trace#bef74c57\" when a response is needed.",
	"---",
	"Avoid editing the same file while I trace the flow.",
].join("\n");

test("teammate-message parser identifies an incoming canonical envelope", () => {
	assert.deepEqual(parseTeammateMessageEnvelope(canonical), {
		sender: "@flow-trace",
		kind: "coordination",
		guidance: [
			"Coordination only: preserve the active user objective.",
			"Reply with teammate-send to \"flow-trace#bef74c57\" when a response is needed.",
		].join("\n"),
		body: "Avoid editing the same file while I trace the flow.",
	});
});

test("teammate-message renderer presents receipt direction and keeps protocol guidance expandable", () => {
	const message = { content: canonical };
	const collapsed = renderIncomingTeammateMessage(
		message,
		{ expanded: false, outputPad: 0 },
		theme,
	).render(100).join("\n");
	assert.match(collapsed, /← (?:Received from @flow-trace|收到来自 @flow-trace 的消息) · (?:coordination|协调)/);
	assert.match(collapsed, /Avoid editing the same file/);
	assert.doesNotMatch(collapsed, /\[teammate-message\]|\[teammate:coordination\]|Coordination only/);

	const expanded = renderIncomingTeammateMessage(
		message,
		{ expanded: true, outputPad: 0 },
		theme,
	).render(100).join("\n");
	assert.match(expanded, /Coordination only/);
	assert.match(expanded, /Reply with teammate-send/);
	assert.match(expanded, /Avoid editing the same file/);
});

test("teammate-message renderer falls back to verified provenance and strips terminal controls", () => {
	const parsed = parseTeammateMessageEnvelope("\u001b[31mreview complete\u001b[0m", {
		provenance: {
			messageKind: "status",
			sender: { label: "monitor" },
		},
	});
	assert.deepEqual(parsed, {
		sender: "monitor",
		kind: "status",
		guidance: "",
		body: "review complete",
	});
});

test("Cockpit registers the incoming renderer and yields while disabled", () => {
	let customType: string | undefined;
	let renderer: ((
		message: { content: string },
		options: { expanded: boolean; outputPad: number },
		theme: Theme,
	) => unknown) | undefined;
	const pi = {
		registerMessageRenderer(type: string, callback: unknown) {
			customType = type;
			renderer = callback as typeof renderer;
		},
	} as unknown as Pick<ExtensionAPI, "registerMessageRenderer">;
	registerTeammateMessageRenderer(pi, () => false);
	assert.equal(customType, TEAMMATE_MESSAGE_CUSTOM_TYPE);
	assert.equal(renderer?.({ content: canonical }, { expanded: false, outputPad: 0 }, theme), undefined);
});
