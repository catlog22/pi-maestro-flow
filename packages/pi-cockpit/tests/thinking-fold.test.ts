import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ensureThinkingFolded, findThinkingToggle, readHideThinkingBlock } from "../src/thinking-fold.ts";

// pi resolves the global settings dir through this env var on every
// getAgentDir() call, so pointing it at a scratch dir isolates the read tests
// from the user's real ~/.pi/agent/settings.json.
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let tmpRoot: string;
let agentDir: string;
let projectDir: string;
let savedEnv: string | undefined;

const fakeComponent = (): { render: (w: number) => string[]; invalidate: () => void } => ({
	render: () => [],
	invalidate: (): void => {},
});

const fakeEditor = (toggle?: () => void): Record<string, unknown> => {
	const editor = fakeComponent() as Record<string, unknown>;
	editor.getText = () => "";
	editor.setText = (): void => {};
	editor.handleInput = (): void => {};
	if (toggle) editor.actionHandlers = new Map([["app.thinking.toggle", toggle]]);
	return editor;
};

const fakeTui = (...children: unknown[]): TUI =>
	({ children }) as unknown as TUI;

before(() => {
	savedEnv = process.env[AGENT_DIR_ENV];
	tmpRoot = mkdtempSync(join(tmpdir(), "cockpit-thinking-fold-"));
	agentDir = join(tmpRoot, "agent");
	projectDir = join(tmpRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	process.env[AGENT_DIR_ENV] = agentDir;
});

after(() => {
	if (savedEnv === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = savedEnv;
	rmSync(tmpRoot, { recursive: true, force: true });
});

test("findThinkingToggle walks containers and returns the wired handler", () => {
	let calls = 0;
	const toggle = (): void => {
		calls++;
	};
	const editor = fakeEditor(toggle);
	const editorContainer = { children: [editor] };
	const tui = fakeTui({ children: [fakeComponent()] }, editorContainer, fakeComponent());
	const found = findThinkingToggle(tui);
	assert.equal(found !== undefined, true);
	found?.();
	assert.equal(calls, 1);
});

test("findThinkingToggle returns undefined when no handler is wired", () => {
	assert.equal(findThinkingToggle(fakeTui()), undefined);
	assert.equal(findThinkingToggle(fakeTui({ children: [fakeComponent()] })), undefined);
	// An editor without the action map (custom editors that do not extend
	// CustomEditor) must not crash the walk.
	assert.equal(findThinkingToggle(fakeTui({ children: [fakeEditor()] })), undefined);
	// A map that lacks the thinking action is not a match.
	const other = fakeComponent() as Record<string, unknown>;
	other.actionHandlers = new Map([["app.clear", () => {}]]);
	assert.equal(findThinkingToggle(fakeTui({ children: [other] })), undefined);
});

test("findThinkingToggle survives cycles and non-container nodes", () => {
	const a: Record<string, unknown> = fakeComponent();
	const b: Record<string, unknown> = { children: [a] };
	a.children = [b];
	assert.equal(findThinkingToggle(fakeTui(a)), undefined);
});

test("readHideThinkingBlock defaults to false when no settings exist", () => {
	assert.equal(readHideThinkingBlock(projectDir), false);
});

test("readHideThinkingBlock reads the global flag and lets project override it", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
	assert.equal(readHideThinkingBlock(projectDir), true);
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(projectDir, CONFIG_DIR_NAME, "settings.json"),
		JSON.stringify({ hideThinkingBlock: false }),
	);
	assert.equal(readHideThinkingBlock(projectDir), false);
});

test("readHideThinkingBlock treats corrupt files as absent", () => {
	writeFileSync(join(agentDir, "settings.json"), "{not json");
	writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ other: 1 }));
	assert.equal(readHideThinkingBlock(projectDir), false);
});

test("ensureThinkingFolded dispatches only when the state differs", () => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: false }));
	rmSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true, force: true });
	let calls = 0;
	const tui = fakeTui({ children: [fakeEditor(() => {
		calls++;
	})] });
	assert.equal(ensureThinkingFolded(tui, projectDir, false), true);
	assert.equal(calls, 0, "already in the wanted state — no dispatch");
	assert.equal(ensureThinkingFolded(tui, projectDir, true), true);
	assert.equal(calls, 1, "state differs — exactly one dispatch");
});

test("ensureThinkingFolded reports unreachable editors instead of guessing", () => {
	assert.equal(ensureThinkingFolded(undefined, projectDir, true), false);
	assert.equal(ensureThinkingFolded(fakeTui(fakeComponent()), projectDir, true), false);
});
