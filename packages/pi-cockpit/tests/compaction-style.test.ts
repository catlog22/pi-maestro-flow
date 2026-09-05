import assert from "node:assert/strict";
import test from "node:test";
import {
	CompactionSummaryMessageComponent,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	attachCompactionStyle,
	compactionSummaryDetails,
} from "../src/compaction-style.ts";
import { resolveGlyphs } from "../src/icons.ts";

initTheme("dark", false);

const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function message(summary: string, tokensBefore = 197_231) {
	return {
		role: "compactionSummary" as const,
		summary,
		tokensBefore,
		timestamp: 0,
	};
}

const recoveryCapsule = `<recovery_capsule version="2">
- Capsule: Maestro New Context Recovery Capsule v2; no model summary was generated.

## Session
- Session ID: session-1
- Checkpoint ID: checkpoint-2
- Todo: stateVersion=8, revision=12, active=1, pending=2, blocked=0, completed=3

## Active Todo Tasks
- [#2] Verify the compact card (in_progress; assignee=root)
</recovery_capsule>`;

test("new-context compaction uses a Todo-style compact card with recovery details", () => {
	let enabled = true;
	const patch = attachCompactionStyle({
		isEnabled: () => enabled,
		getTheme: () => theme,
		getGlyphs: () => resolveGlyphs("nerd"),
	});
	assert.equal(patch.active, true);
	try {
		const component = new CompactionSummaryMessageComponent(message(recoveryCapsule));
		const compact = component.render(120).join("\n");
		assert.match(compact, /✓ new context · 197,231 tokens/);
		assert.match(compact, /✓ complete  deterministic recovery capsule/);
		assert.match(compact, /○ todo\s+stateVersion=8, revision=12, active=1, pending=2, blocked=0, completed=3/);
		assert.match(compact, /» next\s+#2 Verify the compact card/);
		assert.match(compact, /checkpoint checkpoint-2 · 11 lines ·/);
		assert.match(compact.toLowerCase(), /ctrl\+o expand/);

		enabled = false;
		const disabled = component.render(120).join("\n");
		assert.match(disabled, /\[compaction\]/);
		assert.match(disabled, /Compacted from 197,231 tokens/);
		assert.doesNotMatch(disabled, /deterministic recovery capsule/);

		component.setExpanded(true);
		const expanded = component.render(120).join("\n");
		assert.match(expanded, /\[compaction\]/);
		assert.match(expanded, /Compacted from 197,231 tokens/);
		assert.match(expanded, /Maestro New Context Recovery Capsule/);
	} finally {
		patch.detach();
	}
});

test("ordinary compaction shows model-summary size and detach restores Pi rendering", () => {
	const patch = attachCompactionStyle({
		isEnabled: () => true,
		getTheme: () => theme,
		getGlyphs: () => resolveGlyphs("ascii"),
	});
	try {
		const component = new CompactionSummaryMessageComponent(message("First line\nSecond line", 42_000));
		const compact = component.render(90).join("\n");
		assert.match(compact, /\+ \+ compaction · 42,000 tokens/);
		assert.match(compact, /\| \+ complete  model summary/);
		assert.match(compact, /summary · 2 lines · 22B · ctrl\+o expand/);
	} finally {
		patch.detach();
	}

	const native = new CompactionSummaryMessageComponent(message("Native summary", 12));
	const text = native.render(80).join("\n");
	assert.match(text, /\[compaction\]/);
	assert.match(text, /Compacted from 12 tokens/);
	assert.doesNotMatch(text, /model summary/);
});

test("recovery capsule metadata parser bounds the compact projection", () => {
	assert.deepEqual(compactionSummaryDetails(recoveryCapsule), {
		kind: "new-context",
		checkpoint: "checkpoint-2",
		todo: "stateVersion=8, revision=12, active=1, pending=2, blocked=0, completed=3",
		nextTask: "#2 Verify the compact card",
		lineCount: 11,
		byteCount: Buffer.byteLength(recoveryCapsule, "utf8"),
	});
});
