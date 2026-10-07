import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createOcrRunner, OcrError, resolveOcrCommand } from "../src/ocr-review/runner.ts";

const nodeRunner = createOcrRunner(() => ({ command: process.execPath, args: [] }));

async function installation() {
  const root = await mkdtemp(join(tmpdir(), "ocr installation "));
  const pkg = join(root, "node_modules", "@alibaba-group", "open-code-review");
  const launcher = join(pkg, "bin", "ocr.js");
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(launcher, "// npm OCR launcher\n");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@alibaba-group/open-code-review" }));
  if (process.platform === "win32") {
    await writeFile(join(root, "ocr.cmd"), 'node "%~dp0%\\node_modules\\@alibaba-group\\open-code-review\\bin\\ocr.js" %*');
  } else {
    await symlink(launcher, join(root, "ocr"));
  }
  return { root, pkg, launcher };
}

test("OCR resolves the PATH-selected npm platform binary without launching cmd or node", async () => {
  const { root, pkg } = await installation();
  try {
    const nativePkg = join(pkg, "node_modules", "@alibaba-group", `ocr-${process.platform}-${process.arch}`);
    await mkdir(join(nativePkg, "bin"), { recursive: true });
    await writeFile(join(nativePkg, "package.json"), JSON.stringify({ name: `@alibaba-group/ocr-${process.platform}-${process.arch}` }));
    const binary = join(nativePkg, "bin", process.platform === "win32" ? "opencodereview.exe" : "opencodereview");
    await writeFile(binary, "native fixture");
    assert.deepEqual(resolveOcrCommand(root), { command: binary, args: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR preserves custom PATH priority and supports legacy and launcher-only npm installs", async () => {
  const { root, pkg, launcher } = await installation();
  const custom = await mkdtemp(join(tmpdir(), "ocr custom "));
  try {
    assert.deepEqual(resolveOcrCommand(root), { command: process.execPath, args: [launcher] });
    const legacy = join(pkg, "bin", process.platform === "win32" ? "opencodereview.exe" : "opencodereview");
    await writeFile(legacy, "legacy fixture");
    assert.deepEqual(resolveOcrCommand(root), { command: legacy, args: [] });
    const customCommand = join(custom, process.platform === "win32" ? "ocr.cmd" : "ocr");
    await writeFile(customCommand, "custom CLI");
    assert.deepEqual(resolveOcrCommand(`${custom}${delimiter}${root}`), { command: customCommand, args: [] });
    assert.equal(resolveOcrCommand(join(root, "missing")), undefined);
    const late = join(root, "missing");
    await mkdir(late);
    const installed = join(late, process.platform === "win32" ? "ocr.cmd" : "ocr");
    await writeFile(installed, "installed after missing probe");
    assert.deepEqual(resolveOcrCommand(late), { command: installed, args: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(custom, { recursive: true, force: true });
  }
});

test("OCR pre-abort and invalid timeout do not resolve or spawn a command", async () => {
  const runner = createOcrRunner(() => { throw new Error("must not resolve"); });
  await assert.rejects(runner([], { cwd: process.cwd(), signal: AbortSignal.abort() }), /aborted/);
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(runner([], { cwd: process.cwd(), timeoutMs }), /timeout must/i);
  }
});

test("OCR runner preserves argument boundaries, injects env and disables background updates", async () => {
  const args = ['space path', 'quote"value', 'x&y', '%PATH%', '中文'];
  const result = await nodeRunner([
    "-e", 'console.log(JSON.stringify({args:process.argv.slice(1),update:process.env.OCR_NO_UPDATE,model:process.env.OCR_LLM_MODEL}));',
    ...args,
  ], { cwd: process.cwd(), env: { OCR_LLM_MODEL: "test-model", OCR_NO_UPDATE: "" } });
  assert.deepEqual(JSON.parse(result.stdout), { args, update: "1", model: "test-model" });
  assert.equal(result.exitCode, 0);
});

test("OCR executes custom cmd shims with space paths and metacharacter arguments", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr cmd shim "));
  try {
    const echo = join(root, "echo args.mjs");
    const command = join(root, "ocr.cmd");
    await writeFile(echo, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
    const args = ["space path", 'quote"value', "x&y", "a|b", "中文"];
    const runner = createOcrRunner(() => resolveOcrCommand(root));
    const result = await runner(args, { cwd: root });
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OCR reports nonzero exits and spawn failures", async () => {
  await assert.rejects(nodeRunner(["-e", 'console.error("git diagnostic");process.exit(3);'], { cwd: process.cwd() }), (error: unknown) => {
    assert.ok(error instanceof OcrError);
    assert.equal(error.exitCode, 3);
    assert.equal(error.stderr, "git diagnostic");
    return true;
  });
  const missing = createOcrRunner(() => ({ command: join(tmpdir(), "ocr-does-not-exist"), args: [] }));
  await assert.rejects(missing([], { cwd: process.cwd() }), /Failed to (start|run) ocr/);
  await assert.rejects(createOcrRunner(() => undefined)([], { cwd: process.cwd() }), /not found on PATH/);
});

function processIsAlive(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0);
    return result.stdout.includes(`"${pid}"`);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("OCR timeout keeps bounded stderr and waits for process-tree reclamation", async () => {
  // The descendant keeps inherited pipes open and ignores graceful termination.
  const script = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"inherit"}); console.error("x".repeat(5000));console.error("descendant="+child.pid);setInterval(()=>{},1000);`;
  await assert.rejects(nodeRunner(["-e", script], { cwd: process.cwd(), timeoutMs: 1000 }), (error: unknown) => {
    assert.ok(error instanceof OcrError);
    assert.match(error.message, /timed out.*overallTimeoutMinutes/s);
    assert.ok(error.stderr.length <= 4096);
    const pid = Number(/descendant=(\d+)/.exec(error.stderr)?.[1]);
    assert.ok(pid > 0, error.message);
    assert.equal(processIsAlive(pid), false);
    return true;
  });
});

test("OCR caller abort and output overflow reclaim the child before rejecting", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(nodeRunner(["-e", "setInterval(()=>{},1000)"], { cwd: process.cwd(), signal: controller.signal }), /aborted/);
  } finally { clearTimeout(timer); }
  await assert.rejects(nodeRunner(["-e", 'process.stdout.write("x".repeat(11*1024*1024));setInterval(()=>{},1000);'], { cwd: process.cwd() }), /output exceeded/);
});
