import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRemoteCommand } from "../src/ssh-manager/executor.ts";

const windows = process.platform === "win32";
const psQuote = (value: string): string => `'${value.replace(/'/gu, "''")}'`;

function bootstrap(command: string, cwd?: string): string {
  const remote = buildRemoteCommand("powershell", command, cwd);
  const match = remote.match(/-Command "([^"]+)"$/u);
  assert.ok(match, "outer bootstrap is one static quoted argument");
  return match[1]!;
}

function run(command: string, cwd?: string) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap(command, cwd)], {
    windowsHide: true, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.error, undefined, `PowerShell launch failed: ${result.error?.message}`);
  return result;
}

test("Windows PowerShell bootstrap preserves Unicode and final/explicit exit semantics", { skip: !windows }, () => {
  const success = run("Write-Output '中文🙂'\n# trailing comment");
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), "中文🙂");
  assert.equal(success.stdout.charCodeAt(0) === 0xfeff, false, "no UTF-8 BOM");
  assert.equal(run("exit 23").status, 23);
  assert.equal(run("& $env:ComSpec /d /c 'exit 17'").status, 17);
  assert.equal(run("& $env:ComSpec /d /c 'exit 17'\nWrite-Output recovered").status, 0);
  const failure = run("throw 'expected failure'\nWrite-Output 'MUST_NOT_RUN'");
  assert.equal(failure.status, 1);
  assert.doesNotMatch(failure.stdout, /MUST_NOT_RUN/);
});

test("Windows cmd parsing, delayed expansion, multiline text, and literal cwd remain safe", { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-ps-bootstrap-"));
  const cwd = join(root, "中文🙂 %PATH% !X! & 'quoted");
  await mkdir(cwd);
  try {
    const value = `中文🙂 %PATH% !X! & | < > \"double\" 'single'`;
    const command = `Write-Output ${psQuote(value)}\nWrite-Output (Get-Location).Path\nexit 23\n# tail`;
    const remote = buildRemoteCommand("powershell", command, cwd);
    for (const delayedExpansion of ["/v:off", "/v:on"]) {
      const result = spawnSync("cmd.exe", ["/d", delayedExpansion, "/s", "/c", remote], {
        windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 23, result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [value, cwd]);
    }
    const missing = run("Write-Output 'MUST_NOT_RUN'", join(root, "does-not-exist"));
    assert.equal(missing.status, 1);
    assert.doesNotMatch(missing.stdout, /MUST_NOT_RUN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows PowerShell bootstrap leaves stdin open for multiple stdio protocol exchanges", { skip: !windows, timeout: 25_000 }, async () => {
  const program = [
    'process.stdout.write("READY\\n");',
    'let buffer="", count=0;',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { buffer += chunk;',
    'let end; while ((end=buffer.indexOf("\\n")) >= 0) {',
    'const line=buffer.slice(0,end); buffer=buffer.slice(end+1);',
    'process.stdout.write("PONG:"+line+"\\n");',
    'if (++count === 2) process.exit(0); } });',
  ].join(" ");
  // Windows PowerShell 5.1 has its own native -e quoting rules. A temporary
  // fixture avoids conflating those rules with bootstrap/stdin transport.
  const root = await mkdtemp(join(tmpdir(), "ssh-ps-stdio-"));
  const programPath = join(root, "stdio.cjs");
  await writeFile(programPath, program, "utf8");
  const command = `& ${psQuote(process.execPath)} ${psQuote(programPath)}`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap(command)], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "", firstSent = false, secondSent = false;
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio exchange timed out: ${output}; ${errors}`)), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!firstSent && output.includes("READY")) {
        firstSent = true;
        child.stdin.write("first\n");
      }
      if (!secondSent && output.includes("PONG:first")) {
        secondSent = true;
        assert.equal(child.stdin.writableEnded, false);
        child.stdin.write("second\n");
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !secondSent) reject(new Error(`stdio process exit=${code}: ${output}; ${errors}`));
      else resolve();
    });
  });
  try {
    await completed;
    assert.equal(child.stdin.writableEnded, false, "protocol completes without EOF from caller");
    assert.deepEqual(output.trim().split(/\r?\n/u), ["READY", "PONG:first", "PONG:second"]);
  } finally {
    if (child.exitCode === null && child.pid !== undefined) {
      // Only this test's known process tree, never unrelated PowerShell/Fluent.
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
      child.kill();
    }
    child.stdin.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
