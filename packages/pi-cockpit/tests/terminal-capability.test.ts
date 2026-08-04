import assert from "node:assert/strict";
import test from "node:test";
import { detectTerminalCompatibility } from "../src/terminal-capability.ts";

test("dumb or unset TERM is known-incompatible", () => {
	assert.equal(detectTerminalCompatibility({ TERM: "dumb" }).compatible, false);
	assert.equal(detectTerminalCompatibility({ TERM: "" }).compatible, false);
	assert.equal(detectTerminalCompatibility({ TERM: "unknown" }).compatible, false);
	assert.ok(detectTerminalCompatibility({ TERM: "dumb" }).reason, "reports a reason");
});

test("common modern TERMs are best-effort compatible", () => {
	for (const term of ["xterm-256color", "screen-256color", "xterm-kitty", "wezterm", "alacritty"]) {
		assert.equal(detectTerminalCompatibility({ TERM: term }).compatible, true, term);
	}
});
