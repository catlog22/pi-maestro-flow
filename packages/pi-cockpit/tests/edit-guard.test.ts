import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGuardedEditTool } from "../src/edit-guard.ts";
import { registerQuietTools } from "../src/quiet-tools.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

function install(register: (pi: any) => void): Map<string, any> {
	const tools = new Map<string, any>();
	register({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	});
	return tools;
}

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-cockpit-edit-guard-"));
}

// `const s = "中文变量";\nconst keep = 1;\n` with 中文变量 encoded as GBK bytes.
const GBK_FILE = Buffer.from(
	"636f6e73742073203d2022d6d0cec4b1e4c1bf223b0a636f6e7374206b656570203d20313b0a",
	"hex",
);

test("guarded edit registers under the built-in name with the stricter description", () => {
	const tools = install((pi) => registerGuardedEditTool(pi as never));
	const edit = tools.get("edit");
	assert.ok(edit, "edit tool must be registered");
	assert.match(edit.description, /verbatim/i);
	assert.match(edit.description, /merge them into one edit/);
	assert.match(edit.description, /not valid UTF-8/);
});

test("guarded edit edits a valid UTF-8 file through the built-in implementation", async () => {
	const dir = tmpDir();
	const file = join(dir, "a.ts");
	writeFileSync(file, "const a = 1;\nconst b = 2;\n");
	const tools = install((pi) => registerGuardedEditTool(pi as never));
	const edit = tools.get("edit");
	const result = await edit.execute(
		"t1",
		{ path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.match(result.content[0].text, /Successfully replaced/);
	assert.equal(readFileSync(file, "utf8"), "const a = 10;\nconst b = 2;\n");
});

test("duplicate oldText reports candidate lines and keeps the whole edit pack atomic", async () => {
	const dir = tmpDir();
	const file = join(dir, "duplicate.ts");
	const original = "const target = 0;\nconst keep = 1;\nconst target = 0;\n";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "duplicate.ts",
				edits: [
					{ oldText: "const keep = 1;", newText: "const keep = 10;" },
					{ oldText: "const target = 0;", newText: "const target = 20;" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		(error: Error) => {
			assert.match(error.message, /Found 2 occurrences of edits\[1\]/);
			assert.match(error.message, /at lines 1, 3/);
			assert.match(error.message, /occurrence.*1-2/);
			assert.match(error.message, /1\. line 1: const target = 0;/);
			return true;
		},
	);
	assert.equal(readFileSync(file, "utf8"), original, "a later duplicate must prevent every write in the pack");
});

test("occurrence selects one exact duplicate from the frozen original", async () => {
	const dir = tmpDir();
	const file = join(dir, "duplicate.ts");
	writeFileSync(file, "const target = 0;\nconst keep = 1;\nconst target = 0;\n");
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await edit.execute(
		"t1",
		{
			path: "duplicate.ts",
			edits: [{ oldText: "const target = 0;", newText: "const target = 20;", occurrence: 2 }],
		},
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(readFileSync(file, "utf8"), "const target = 0;\nconst keep = 1;\nconst target = 20;\n");
});

test("occurrence composes atomically with another disjoint edit", async () => {
	const dir = tmpDir();
	const file = join(dir, "multiple.ts");
	writeFileSync(file, "const target = 0;\nconst keep = 1;\nconst target = 0;\nconst tail = 2;\n");
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await edit.execute(
		"t1",
		{
			path: "multiple.ts",
			edits: [
				{ oldText: "const keep = 1;", newText: "const keep = 10;" },
				{ oldText: "const target = 0;", newText: "const target = 20;", occurrence: 2 },
			],
		},
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(
		readFileSync(file, "utf8"),
		"const target = 0;\nconst keep = 10;\nconst target = 20;\nconst tail = 2;\n",
	);
});

test("an out-of-range occurrence fails without modifying the file", async () => {
	const dir = tmpDir();
	const file = join(dir, "duplicate.ts");
	const original = "same\nother\nsame\n";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{ path: "duplicate.ts", edits: [{ oldText: "same", newText: "changed", occurrence: 3 }] },
			undefined,
			undefined,
			{ cwd: dir },
		),
		/occurrence is 3.*only 2 exact match/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("quiet mode exposes and executes occurrence selection", async () => {
	const dir = tmpDir();
	const file = join(dir, "duplicate.ts");
	writeFileSync(file, "same\nother\nsame\n");
	const tools = install((pi) =>
		registerQuietTools(pi as never, () => ({ ...DEFAULT_CONFIG, quietMode: true })),
	);
	const edit = tools.get("edit");
	assert.match(edit.description, /occurrence/);
	assert.ok(edit.parameters.properties.edits.items.properties.occurrence, "quiet schema must expose occurrence");
	await edit.execute(
		"t1",
		{ path: "duplicate.ts", edits: [{ oldText: "same", newText: "changed", occurrence: 2 }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(readFileSync(file, "utf8"), "same\nother\nchanged\n");
});

test("guarded edit refuses a non-UTF-8 file without touching it", async () => {
	const dir = tmpDir();
	const file = join(dir, "gbk.ts");
	writeFileSync(file, GBK_FILE);
	const tools = install((pi) => registerGuardedEditTool(pi as never));
	const edit = tools.get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{ path: "gbk.ts", edits: [{ oldText: "const keep = 1;", newText: "const keep = 2;" }] },
			undefined,
			undefined,
			{ cwd: dir },
		),
		/not valid UTF-8/,
	);
	assert.deepEqual(readFileSync(file), GBK_FILE, "file bytes must be untouched");
});

test("quiet mode edit keeps the UTF-8 gate", async () => {
	const dir = tmpDir();
	const file = join(dir, "gbk.ts");
	writeFileSync(file, GBK_FILE);
	const tools = install((pi) =>
		registerQuietTools(pi as never, () => ({ ...DEFAULT_CONFIG, quietMode: true })),
	);
	const edit = tools.get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{ path: "gbk.ts", edits: [{ oldText: "const keep = 1;", newText: "const keep = 2;" }] },
			undefined,
			undefined,
			{ cwd: dir },
		),
		/not valid UTF-8/,
	);
	assert.deepEqual(readFileSync(file), GBK_FILE, "file bytes must be untouched");
});
