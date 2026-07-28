import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createApplyPatchTool,
  executeApplyPatch,
  parseApplyPatch,
  registerApplyPatch,
} from "../src/tools/apply-patch.ts";
import { createSearchToolBm25 } from "../src/tools/search-tool-bm25.ts";

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "apply-patch-test-"));
}

test("apply_patch parses and applies add, update with move, and delete operations", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await writeFile(join(cwd, "source.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(cwd, "obsolete.txt"), "old\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: nested/moved.txt
@@
 one
-two
+three
*** Add File: added.txt
+new
+file
*** Delete File: obsolete.txt
*** End Patch`;

    const result = await executeApplyPatch(patch, cwd);

    assert.equal(await readFile(join(cwd, "nested", "moved.txt"), "utf8"), "one\nthree\n");
    assert.equal(await readFile(join(cwd, "added.txt"), "utf8"), "new\nfile\n");
    await assert.rejects(readFile(join(cwd, "source.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(cwd, "obsolete.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(result.details.files.length, 4);
    assert.match(result.details.diff, /\+\d+ three/);
    assert.match(result.details.diff, /-\d+ two/);
    assert.match(result.details.patch, /--- nested\/moved\.txt/);
    assert.equal(result.details.firstChangedLine, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("apply_patch validates every operation before changing files", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await writeFile(join(cwd, "stable.txt"), "before\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: stable.txt
@@
-before
+after
*** Delete File: missing.txt
*** End Patch`;

    await assert.rejects(executeApplyPatch(patch, cwd), /Cannot delete a missing file/);
    assert.equal(await readFile(join(cwd, "stable.txt"), "utf8"), "before\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("apply_patch rejects wrapped input and paths outside the workspace", async () => {
  assert.throws(
    () => parseApplyPatch('{"patch":"*** Begin Patch\\n*** End Patch"}'),
    /must begin with \*\*\* Begin Patch/,
  );

  const cwd = await temporaryWorkspace();
  try {
    const patch = `*** Begin Patch
*** Add File: ../outside.txt
+blocked
*** End Patch`;
    await assert.rejects(executeApplyPatch(patch, cwd), /outside the workspace/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("apply_patch exposes a raw grammar tool and Pi-compatible diff rendering", () => {
  const tool = createApplyPatchTool();
  assert.equal(tool.name, "apply_patch");
  assert.equal(tool.constrainedSampling && tool.constrainedSampling.type, "grammar");
  assert.match(
    tool.constrainedSampling && tool.constrainedSampling.type === "grammar"
      ? tool.constrainedSampling.variants.openai_lark ?? ""
      : "",
    /begin_patch/,
  );
  assert.match(
    tool.constrainedSampling && tool.constrainedSampling.type === "grammar"
      ? tool.constrainedSampling.variants.openai_lark ?? ""
      : "",
    /add_line:/,
  );
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ["patch"]);

  const render = tool.renderResult as NonNullable<typeof tool.renderResult>;
  const component = render(
    {
      content: [{ type: "text", text: "Applied patch to 1 file(s)." }],
      details: {
        diff: "--- file.txt\n+++ file.txt\n-1 old\n+1 new",
        patch: "patch",
        firstChangedLine: 1,
        files: [{ path: "file.txt", action: "update", diff: "-1 old\n+1 new", patch: "patch", firstChangedLine: 1 }],
      },
    },
    { expanded: true, isPartial: false },
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    { isError: false } as never,
  );
  assert.deepEqual(component.render(120).map((line) => line.trimEnd()), ["+1 / -1", "--- file.txt", "+++ file.txt", "-1 old", "+1 new"]);
});

test("apply_patch honors EOF hunks and rejects mixed line endings", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await writeFile(join(cwd, "duplicates.txt"), "dup\nkeep\ndup\n", "utf8");
    await executeApplyPatch(`*** Begin Patch
*** Update File: duplicates.txt
@@
-dup
+last
*** End of File
*** End Patch`, cwd);
    assert.equal(await readFile(join(cwd, "duplicates.txt"), "utf8"), "dup\nkeep\nlast\n");

    await writeFile(join(cwd, "mixed.txt"), "one\r\ntwo\n", "utf8");
    await assert.rejects(executeApplyPatch(`*** Begin Patch
*** Update File: mixed.txt
@@
-two
+changed
*** End Patch`, cwd), /mixed or bare-CR line endings/);
    assert.equal(await readFile(join(cwd, "mixed.txt"), "utf8"), "one\r\ntwo\n");

    await writeFile(join(cwd, "bare-cr.txt"), "one\rtwo\r", "utf8");
    await assert.rejects(executeApplyPatch(`*** Begin Patch
*** Update File: bare-cr.txt
@@
-two
+changed
*** End Patch`, cwd), /mixed or bare-CR line endings/);
    assert.equal(await readFile(join(cwd, "bare-cr.txt"), "utf8"), "one\rtwo\r");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("apply_patch preserves executable mode on POSIX", { skip: process.platform === "win32" }, async () => {
  const cwd = await temporaryWorkspace();
  try {
    const path = join(cwd, "script.sh");
    await writeFile(path, "echo old\n", { encoding: "utf8", mode: 0o755 });
    await executeApplyPatch(`*** Begin Patch
*** Update File: script.sh
@@
-echo old
+echo new
*** End Patch`, cwd);
    assert.equal((await stat(path)).mode & 0o777, 0o755);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("BM25 discovery does not bypass apply_patch activation gates", async () => {
  const active: string[] = [];
  const searchTool = createSearchToolBm25({
    getAllTools: () => [{
      name: "apply_patch",
      label: "apply_patch",
      description: "Apply a Codex patch",
      parameters: { type: "object", properties: { patch: { type: "string" } } },
      sourceInfo: { path: "test", type: "extension" },
    }],
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active.splice(0, active.length, ...names); },
  } as never);

  const result = await searchTool.execute("call", { query: "apply patch", limit: 5 }, undefined, undefined as never, undefined as never);
  assert.equal(result.details?.tools[0]?.name, "apply_patch");
  assert.deepEqual(result.details?.activated_tools, []);
  assert.deepEqual(active, []);
});

test("apply_patch stays inactive until enabled and supported by the selected model", async () => {
  const cwd = await temporaryWorkspace();
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const tools: ToolDefinition[] = [];
    const active: string[] = [];
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.push(tool);
        active.push(tool.name);
      },
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active.splice(0, active.length, ...names);
      },
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand(_name: string, definition: { handler: typeof command }) {
        command = definition.handler;
      },
    } as unknown as ExtensionAPI;
    registerApplyPatch(pi);
    assert.ok(tools.some((tool) => tool.name === "apply_patch"));
    assert.equal(active.includes("apply_patch"), true, "registration must not call runtime actions before session_start");

    const notifications: string[] = [];
    const capableModel = { compat: { supportsOpenAIGrammarTools: true } };
    const ctx = {
      cwd,
      model: capableModel,
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(active.includes("apply_patch"), false);

    assert.ok(command);
    await command!("on", ctx);
    assert.equal(active.includes("apply_patch"), true);
    assert.equal(
      JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")).platformTools.applyPatch.enabled,
      true,
    );

    await handlers.get("model_select")?.({ model: { compat: {} } }, { ...ctx, model: { compat: {} } });
    assert.equal(active.includes("apply_patch"), false);
    const applyPatch = tools.find((tool) => tool.name === "apply_patch");
    assert.ok(applyPatch);
    await assert.rejects(
      applyPatch!.execute("call", { patch: "*** Begin Patch\n*** End Patch" }, undefined, undefined as never, { ...ctx, model: { compat: {} } } as never),
      /unavailable for the current model/,
    );
    assert.match(notifications.at(-1) ?? "", /enabled.*active.*supported/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
