import { test } from "node:test";
import assert from "node:assert/strict";
import {
	collectExtensionStatuses,
	sanitizeExtensionStatusText,
} from "../src/extension-status.ts";

test("sanitizeExtensionStatusText strips terminal controls and flattens whitespace", () => {
	assert.equal(
		sanitizeExtensionStatusText("\x1b[31mred\x1b[0m\nnext\tline"),
		"red next line",
	);
	assert.equal(
		sanitizeExtensionStatusText("\x1b]133;A\x07prompt\x1b]133;B\x07"),
		"prompt",
	);
});

test("collectExtensionStatuses sorts keys and drops empty values", () => {
	assert.deepEqual(
		collectExtensionStatuses(new Map([
			["zeta", "last"],
			["empty", "\x1b[31m\x1b[0m\n"],
			["alpha", " first "],
		])),
		[
			{ key: "alpha", text: "first" },
			{ key: "zeta", text: "last" },
		],
	);
});
