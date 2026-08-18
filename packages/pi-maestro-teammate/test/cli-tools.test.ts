import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  cliToolArgv,
  cliToolCommand,
  getEnabledTools,
  getGlobalCliToolsConfigPath,
  getProjectCliToolsConfigPath,
  loadMaestroDelegateConfig,
  loadCliToolsConfig,
  probeCliToolCommand,
  sshHostConfigOf,
  toCliToolModelEntries,
  type CliToolConfig,
  type CliToolsConfig,
} from "../src/cli-tools/cli-tools-config.ts";
import {
  cliToolNameFromModel,
  isCliToolModel,
} from "../src/cli-tools/local-acp.ts";

const baseConfig: CliToolsConfig = {
  version: "1",
  tools: {
    codex: {
      enabled: true,
      command: "codex",
      env: ["OPENAI_API_KEY"],
    },
    "no-exec": {
      enabled: true,
    },
    "with-args": {
      enabled: true,
      command: "node",
      args: ["--version"],
      env: ["OPENAI_API_KEY"],
    },
    disabled: {
      enabled: false,
    },
  },
};

test("getEnabledTools filters disabled tools", () => {
  const tools = getEnabledTools(baseConfig).map(({ name }) => name);
  assert.deepEqual(tools, ["codex", "no-exec", "with-args"]);
});

test("cliToolCommand falls back to the tool name; cliToolArgv appends args", () => {
  assert.equal(cliToolCommand("codex", baseConfig.tools["codex"]!), "codex");
  assert.deepEqual(cliToolArgv("codex", baseConfig.tools["codex"]!), ["codex"]);
  assert.equal(cliToolCommand("with-args", baseConfig.tools["with-args"]!), "node");
  assert.deepEqual(cliToolArgv("with-args", baseConfig.tools["with-args"]!), ["node", "--version"]);
});

test("sshHostConfigOf lifts complete ssh fields and rejects incomplete ones", () => {
  const complete: CliToolConfig = {
    enabled: true,
    mode: "ssh",
    host: "devbox",
    user: "dyw",
    port: 22,
    hostKeySha256: "SHA256:abc",
    identityFile: "~/.ssh/id_ed25519",
  };
  const host = sshHostConfigOf(complete);
  assert.ok(host);
  assert.deepEqual(host, {
    host: "devbox",
    user: "dyw",
    port: 22,
    hostKeySha256: "SHA256:abc",
    identityFile: "~/.ssh/id_ed25519",
  });
  assert.equal(sshHostConfigOf({ enabled: true, mode: "ssh", host: "devbox" }), null);
  assert.equal(sshHostConfigOf({ enabled: true, mode: "ssh", host: "devbox", user: "u", port: 99999, hostKeySha256: "SHA256:abc" }), null);
  // local tools never need ssh fields
  assert.equal(sshHostConfigOf({ enabled: true }), null);
});

test("probeCliToolCommand reports reachable and missing local executables", () => {
  const reachable = probeCliToolCommand("reachable-probe", {
    enabled: true,
    command: "node",
  });
  assert.equal(reachable.ok, true);
  assert.equal(reachable.command, "node");

  const missing = probeCliToolCommand("missing-probe", {
    enabled: true,
    command: "definitely-not-a-real-executable-xyz",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /not found|unreachable/);
});

test("probeCliToolCommand caches by the resolved command, not by the tool name", () => {
  // Two registrations may serve the same `cli/<tool>` route with different
  // executables, so a verdict cached under the route name would validate the
  // second registration against the first one's binary for the whole TTL.
  const first = probeCliToolCommand("shared-route", { enabled: true, command: "node" });
  assert.equal(first.ok, true);

  const second = probeCliToolCommand("shared-route", {
    enabled: true,
    command: "definitely-not-a-real-executable-xyz",
  });
  assert.equal(second.command, "definitely-not-a-real-executable-xyz");
  assert.equal(second.ok, false);
});

test("ssh probe fails closed on incomplete config; optimistic pass on complete config", () => {
  const incomplete = probeCliToolCommand("ssh-incomplete", {
    enabled: true,
    mode: "ssh",
    host: "devbox",
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error ?? "", /host, user and hostKeySha256/);

  // Complete config optimistically passes while the async probe runs.
  const complete = probeCliToolCommand("ssh-optimistic", {
    enabled: true,
    mode: "ssh",
    host: "127.0.0.1",
    user: "u",
    port: 22,
    hostKeySha256: "SHA256:abc",
    command: "codex",
  });
  assert.equal(complete.ok, true);
});

test("toCliToolModelEntries exposes reachable tools as cli/<tool> and skips missing", () => {
  const entries = toCliToolModelEntries({
    version: "1",
    tools: {
      reachable: {
        enabled: true,
        command: "node",
      },
      unreachable: {
        enabled: true,
        command: "definitely-not-a-real-executable-xyz",
      },
      "ssh-incomplete": {
        enabled: true,
        mode: "ssh",
        host: "devbox",
      },
    },
  });
  assert.deepEqual(entries.map((entry) => `${entry.provider}/${entry.id}`), ["cli/reachable"]);
  assert.equal(entries[0]?.reasoning, false);
});

test("cli tool model specifier helpers", () => {
  assert.equal(isCliToolModel("cli/codex"), true);
  assert.equal(isCliToolModel("cli/"), false);
  assert.equal(isCliToolModel("codex"), false);
  assert.equal(isCliToolModel("cli/a/b"), false);
  assert.equal(cliToolNameFromModel("cli/codex"), "codex");
});

test("loadCliToolsConfig merges project over global and returns null without files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tools-config-"));
  const globalFile = path.join(dir, "global.json");
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  const projectFile = getProjectCliToolsConfigPath(projectDir);

  fs.writeFileSync(globalFile, JSON.stringify({
    version: "1",
    tools: {
      globalOnly: { enabled: true, command: "node" },
      shared: { enabled: true, command: "node" },
      hidden: { enabled: true, command: "node" },
    },
  }));
  fs.writeFileSync(projectFile, JSON.stringify({
    version: "2",
    tools: {
      shared: { enabled: true, command: "node", args: ["--version"] },
      hidden: { enabled: false },
      projectOnly: { enabled: true, mode: "ssh", host: "devbox", user: "u", port: 22, hostKeySha256: "SHA256:abc" },
    },
  }));

  const merged = loadCliToolsConfig(projectDir, globalFile);
  assert.ok(merged);
  assert.deepEqual(Object.keys(merged.tools).sort(), ["globalOnly", "hidden", "projectOnly", "shared"]);
  assert.deepEqual(merged.tools["shared"]!.args, ["--version"]);
  assert.equal(merged.tools["hidden"]!.enabled, false);
  assert.equal(merged.version, "2");

  const emptyDir = path.join(dir, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.equal(loadCliToolsConfig(emptyDir, path.join(dir, "missing.json")), null);
  assert.equal(getGlobalCliToolsConfigPath(), path.join(os.homedir(), ".pi", "agent", "teammate-cli-tools.json"));
});

test("loadMaestroDelegateConfig parses the legacy cli-tools.json shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tools-legacy-"));
  const legacyFile = path.join(dir, "cli-tools.json");
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: "1.1.0",
    tools: {
      claude: { enabled: true, primaryModel: "claude-opus-4-6", tags: ["fullstack"], type: "builtin" },
      codex: { enabled: true, primaryModel: "gpt-5.5", tags: [], type: "builtin", acp: { command: "codex" } },
    },
    roles: {},
  }));
  const config = loadMaestroDelegateConfig(legacyFile);
  assert.ok(config);
  assert.equal(config.tools["claude"]!.primaryModel, "claude-opus-4-6");
  assert.equal(config.tools["codex"]!.acp!.command, "codex");
  assert.equal(loadMaestroDelegateConfig(path.join(dir, "missing.json")), null);
});