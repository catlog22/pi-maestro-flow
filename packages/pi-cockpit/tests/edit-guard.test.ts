import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareGuardedEditArguments,
	registerGuardedEditTool,
} from "../src/edit-guard.ts";
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
	assert.equal(edit.parameters.additionalProperties, false);
	assert.equal(edit.parameters.properties.edits.minItems, 1);
	assert.equal(edit.parameters.properties.edits.items.additionalProperties, false);
});

test("prepareArguments hoists one unambiguous nested path", () => {
	assert.deepEqual(
		prepareGuardedEditArguments({
			edits: [{ path: "a.ts", oldText: "before", newText: "after" }],
		}),
		{
			path: "a.ts",
			edits: [{ oldText: "before", newText: "after" }],
		},
	);
});

test("prepareArguments explains malformed mixed edit structures", () => {
	assert.throws(
		() => prepareGuardedEditArguments({
			oldText: "before",
			edits: [{ newText: "after" }, "occurrence"],
		}),
		(error: Error) => {
			assert.match(error.message, /path must be a top-level string property/);
			assert.match(error.message, /oldText is misplaced at the top level/);
			assert.match(error.message, /edits\[0\]\.oldText must be a string/);
			assert.match(error.message, /edits\[1\] must be an object, received string/);
			assert.match(error.message, /Expected shape/);
			return true;
		},
	);
});

test("prepareArguments explains a non-array edits value and the optional selector", () => {
	assert.throws(
		() => prepareGuardedEditArguments({ path: "a.ts", edits: "not-json" }),
		(error: Error) => {
			assert.match(error.message, /edits must be an array, received string/);
			assert.match(error.message, /occurrence is optional and must be a 1-based integer/);
			return true;
		},
	);
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

test("missing oldText reports when the requested change is already applied", async () => {
	const dir = tmpDir();
	const file = join(dir, "already.ts");
	const current = "import {\n  before,\n  added,\n  after,\n}\n";
	writeFileSync(file, current);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "already.ts",
				edits: [{
					oldText: "import {\n  before,\n  after,\n}",
					newText: "import {\n  before,\n  added,\n  after,\n}",
				}],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		/newText already exists at line 1.*already be applied/,
	);
	assert.equal(readFileSync(file, "utf8"), current);
});

test("missing oldText reports the closest current line block", async () => {
	const dir = tmpDir();
	const file = join(dir, "stale.ts");
	const current = [
		"const head = 1;",
		"function target() {",
		"  const shared = true;",
		"  const current = 2;",
		"  return current;",
		"}",
		"const tail = 3;",
		"",
	].join("\n");
	writeFileSync(file, current);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "stale.ts",
				edits: [{
					oldText: [
						"function target() {",
						"  const shared = true;",
						"  const stale = 2;",
						"  return stale;",
						"}",
					].join("\n"),
					newText: "function replacement() {}",
				}],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		(error: Error) => {
			assert.match(error.message, /Closest current block is lines 2-6 \(3\/5 matching nonblank lines\)/);
			assert.match(error.message, /2: function target\(\) \{/);
			return true;
		},
	);
	assert.equal(readFileSync(file, "utf8"), current);
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

test("overlapping exact matches require a larger unique oldText", async () => {
	const dir = tmpDir();
	const file = join(dir, "overlapping-exact.txt");
	const original = "aaa";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{ path: "overlapping-exact.txt", edits: [{ oldText: "aa", newText: "X" }] },
			undefined,
			undefined,
			{ cwd: dir },
		),
		/including overlapping exact matches/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("overlapping fuzzy candidates require exact surrounding context", async () => {
	const dir = tmpDir();
	const file = join(dir, "overlapping-fuzzy.txt");
	const original = "ﬀf";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{ path: "overlapping-fuzzy.txt", edits: [{ oldText: "ff", newText: "X" }] },
			undefined,
			undefined,
			{ cwd: dir },
		),
		/including overlapping fuzzy-normalized matches/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
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

test("occurrence preserves the selected overlapping substring", async () => {
	const dir = tmpDir();
	const file = join(dir, "overlap.txt");
	writeFileSync(file, "aaaa");
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await edit.execute(
		"t1",
		{ path: "overlap.txt", edits: [{ oldText: "aa", newText: "X", occurrence: 2 }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(readFileSync(file, "utf8"), "aaX");
});

test("occurrence widens until the selected range is unique after NFKC normalization", async () => {
	const dir = tmpDir();
	const file = join(dir, "nfkc-occurrence.txt");
	writeFileSync(file, "①aa1aa");
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await edit.execute(
		"t1",
		{ path: "nfkc-occurrence.txt", edits: [{ oldText: "aa", newText: "X", occurrence: 2 }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(readFileSync(file, "utf8"), "①aa1X");
});

test("an exact whitespace-only target is widened before delegation", async () => {
	const dir = tmpDir();
	const file = join(dir, "whitespace.txt");
	writeFileSync(file, "a \n");
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await edit.execute(
		"t1",
		{ path: "whitespace.txt", edits: [{ oldText: " ", newText: "_" }] },
		undefined,
		undefined,
		{ cwd: dir },
	);
	assert.equal(readFileSync(file, "utf8"), "a_\n");
});

test("occurrence refuses a pack containing a fuzzy-only edit", async () => {
	const dir = tmpDir();
	const file = join(dir, "mixed.txt");
	const original = "same\nquote “x”\nsame\n";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "mixed.txt",
				edits: [
					{ oldText: "same", newText: "changed", occurrence: 2 },
					{ oldText: "quote \"x\"", newText: "quote \"y\"" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		/Cannot combine selector-dependent edits\[0\] with fuzzy-only edits\[1\]/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("implicit whitespace selection refuses a pack containing a fuzzy-only edit", async () => {
	const dir = tmpDir();
	const file = join(dir, "implicit-mixed.txt");
	const original = "fﬀ \nquote“x”\n";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "implicit-mixed.txt",
				edits: [
					{ oldText: " ", newText: "_" },
					{ oldText: "quote\"x\"", newText: "quote\"y\"" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		/Cannot combine selector-dependent edits\[0\] with fuzzy-only edits\[1\]/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("NFKC cannot hide an exact duplicate beside a widened edit", async () => {
	const dir = tmpDir();
	const file = join(dir, "nfkc-range.txt");
	const original = "x \nA\u030A\nA\n";
	writeFileSync(file, original);
	const edit = install((pi) => registerGuardedEditTool(pi as never)).get("edit");
	await assert.rejects(
		edit.execute(
			"t1",
			{
				path: "nfkc-range.txt",
				edits: [
					{ oldText: " ", newText: "_" },
					{ oldText: "A", newText: "Z" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir },
		),
		/Found 2 occurrences of edits\[1\]/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
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
