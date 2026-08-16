import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpClientOperations, type AcpClientOperationsOptions } from "../src/remote/acp-client-operations.ts";
import type { RemoteAcpPolicy } from "../src/remote/types.ts";

/**
 * macOS resolves `os.tmpdir()` through the `/var` -> `/private/var` symlink, while the remote
 * surfaces reject non-canonical roots and compare a child's `process.cwd()` against the configured
 * root. Tests must hand them the canonical path production callers already receive.
 */
function canonicalTempRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function operations(
  root: string,
  policy: RemoteAcpPolicy,
  options: Partial<Pick<AcpClientOperationsOptions, "beforeFileOpen">> = {},
): AcpClientOperations {
  return new AcpClientOperations({
    targetRoot: root,
    policy,
    signal: new AbortController().signal,
    isCancelling: () => false,
    sessionId: () => "session",
    ...options,
  });
}

function terminalPolicy(executable: string, args: readonly string[], environment: readonly string[] = []): RemoteAcpPolicy {
  return {
    terminal: {
      commands: [{ executable, args, environment }],
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
      maxProcesses: 1,
    },
  };
}

function canonicalExecutable(command: string): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  const located = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (!located) return undefined;
  return fs.realpathSync(located);
}

function removeSwappedTree(root: string, link: string): void {
  try {
    const stat = fs.lstatSync(link);
    if (stat.isSymbolicLink()) {
      if (process.platform === "win32") fs.rmdirSync(link);
      else fs.unlinkSync(link);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test("ACP filesystem capabilities are advertised only with descriptor containment", () => {
  const root = canonicalTempRoot("pi-acp-auth-capabilities-");
  const instance = operations(root, { fs: { read: true, write: true } });
  try {
    const descriptorContainmentAvailable = process.platform === "linux" && fs.existsSync("/proc/self/fd");
    assert.deepEqual(instance.capabilities, descriptorContainmentAvailable
      ? { fs: { readTextFile: true, writeTextFile: true } }
      : {});
  } finally {
    instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP permissions are tool-specific and unknown tools default deny", () => {
  const root = canonicalTempRoot("pi-acp-auth-permission-");
  const instance = operations(root, {
    permissionMode: "allow-once",
    permissionTools: ["terminal/create"],
  });
  try {
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ];
    const allowed = instance.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "allowed", name: "terminal/create", title: "Display label" },
      options,
    }, new AbortController().signal);
    assert.deepEqual(allowed.outcome, { outcome: "selected", optionId: "allow" });

    const unknown = instance.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "unknown", name: "shell", title: "terminal/create" },
      options,
    }, new AbortController().signal);
    assert.deepEqual(unknown.outcome, { outcome: "selected", optionId: "reject" });

    const spoofedTitle = instance.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "spoofed-title", title: "terminal/create" },
      options,
    }, new AbortController().signal);
    assert.deepEqual(spoofedTitle.outcome, { outcome: "selected", optionId: "reject" });

    const unknownWithoutReject = instance.requestPermission({
      sessionId: "session",
      toolCall: { toolCallId: "unknown-only-allow", title: "unrecognized" },
      options: [options[0]],
    }, new AbortController().signal);
    assert.deepEqual(unknownWithoutReject.outcome, { outcome: "cancelled" });
  } finally {
    instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP terminal profiles reject code evaluation, git execution, and PATH replacement", async () => {
  const root = canonicalTempRoot("pi-acp-auth-terminal-");
  const script = path.join(root, "print-env.mjs");
  fs.writeFileSync(script, "process.stdout.write(process.env.SAFE_VALUE ?? 'missing')");

  assert.throws(
    () => operations(root, terminalPolicy(process.execPath, ["-e", "process.exit(0)"])),
    RequestError,
  );
  assert.throws(
    () => operations(root, terminalPolicy(process.execPath, [script], ["PATH"])),
    RequestError,
  );

  const git = canonicalExecutable("git");
  if (git) {
    assert.throws(
      () => operations(root, terminalPolicy(git, ["config", "alias.escape", "!node -e process.exit(0)"])),
      RequestError,
    );
  } else {
    assert.equal(git, undefined, "git-specific assertion requires no fallback executable");
  }

  const instance = operations(root, terminalPolicy(process.execPath, [script], ["SAFE_VALUE"]));
  try {
    await assert.rejects(instance.createTerminal({
      sessionId: "session",
      command: process.execPath,
      args: ["-e", "process.stdout.write('unsafe')"],
    }, new AbortController().signal), RequestError);

    await assert.rejects(instance.createTerminal({
      sessionId: "session",
      command: process.execPath,
      args: [script],
      env: [{ name: "PATH", value: root }],
    }, new AbortController().signal), RequestError);

    await assert.rejects(instance.createTerminal({
      sessionId: "session",
      command: process.execPath,
      args: [script, "extra"],
    }, new AbortController().signal), RequestError);

    const created = await instance.createTerminal({
      sessionId: "session",
      command: process.execPath,
      args: [script],
      env: [{ name: "SAFE_VALUE", value: "profile-ok" }],
    }, new AbortController().signal);
    await instance.waitForTerminalExit({ sessionId: "session", terminalId: created.terminalId }, new AbortController().signal);
    assert.equal(instance.terminalOutput({ sessionId: "session", terminalId: created.terminalId }).output, "profile-ok");
    instance.releaseTerminal({ sessionId: "session", terminalId: created.terminalId });
  } finally {
    instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP descriptor read remains contained across a parent symlink swap", async () => {
  const root = canonicalTempRoot("pi-acp-auth-read-root-");
  const outside = canonicalTempRoot("pi-acp-auth-read-outside-");
  const parent = path.join(root, "parent");
  const captured = path.join(root, "captured-parent");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "value.txt"), "inside");
  fs.writeFileSync(path.join(outside, "value.txt"), "outside");
  let hookCalled = false;
  const instance = operations(root, { fs: { read: true } }, {
    beforeFileOpen: async () => {
      hookCalled = true;
      fs.renameSync(parent, captured);
      fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
    },
  });
  try {
    if (process.platform !== "linux") {
      await assert.rejects(
        instance.readTextFile({ sessionId: "session", path: path.join(parent, "value.txt") }, new AbortController().signal),
        /descriptor-based containment/,
      );
      assert.equal(hookCalled, false);
    } else {
      const result = await instance.readTextFile(
        { sessionId: "session", path: path.join(parent, "value.txt") },
        new AbortController().signal,
      );
      assert.equal(result.content, "inside");
      assert.equal(fs.readFileSync(path.join(outside, "value.txt"), "utf8"), "outside");
    }
  } finally {
    instance.close();
    removeSwappedTree(root, parent);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("ACP descriptor write validates the opened handle before truncating after a parent swap", async () => {
  const root = canonicalTempRoot("pi-acp-auth-write-root-");
  const outside = canonicalTempRoot("pi-acp-auth-write-outside-");
  const parent = path.join(root, "parent");
  const captured = path.join(root, "captured-parent");
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, "value.txt"), "inside-before");
  fs.writeFileSync(path.join(outside, "value.txt"), "outside-before");
  let hookCalled = false;
  const instance = operations(root, { fs: { write: true } }, {
    beforeFileOpen: async () => {
      hookCalled = true;
      fs.renameSync(parent, captured);
      fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
    },
  });
  try {
    if (process.platform !== "linux") {
      await assert.rejects(instance.writeTextFile({
        sessionId: "session",
        path: path.join(parent, "value.txt"),
        content: "inside-after",
      }, new AbortController().signal), /descriptor-based containment/);
      assert.equal(hookCalled, false);
    } else {
      await instance.writeTextFile({
        sessionId: "session",
        path: path.join(parent, "value.txt"),
        content: "inside-after",
      }, new AbortController().signal);
      assert.equal(fs.readFileSync(path.join(captured, "value.txt"), "utf8"), "inside-after");
      assert.equal(fs.readFileSync(path.join(outside, "value.txt"), "utf8"), "outside-before");
    }
  } finally {
    instance.close();
    removeSwappedTree(root, parent);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
