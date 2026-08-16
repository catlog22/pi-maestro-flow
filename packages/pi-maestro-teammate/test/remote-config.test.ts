import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  getGlobalRemoteConfigPath,
  getProjectRemoteConfigPath,
  loadRemoteConfigState,
  replaceRemoteConfigStores,
  resolveRemoteTarget,
  saveGlobalRemoteConfig,
  saveProjectRemoteConfig,
  validateRemoteHostDraft,
  validateRemoteTargetDraft,
  type GlobalRemoteConfigStore,
  type ProjectRemoteConfigStore,
  type RemoteDraftValidation,
} from "../src/remote/config.ts";
import { REMOTE_CONFIG_VERSION } from "../src/remote/types.ts";

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function errorOf(validation: RemoteDraftValidation): string {
  return validation.ok ? "" : validation.error;
}

function globalStore(): GlobalRemoteConfigStore {
  return {
    version: REMOTE_CONFIG_VERSION,
    hosts: {
      "linux-a": {
        host: "linux-a.example",
        user: "dev",
        port: 22,
        hostKeySha256: HOST_KEY,
      },
    },
    targets: {
      "linux-a/pi": {
        host: "linux-a",
        cwd: "/srv/project",
        driver: "pi-rpc",
        command: ["pi"],
      },
    },
  };
}

function emptyProject(): ProjectRemoteConfigStore {
  return { version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {} };
}

test("remote config paths use the approved global and project locations", () => {
  assert.equal(getGlobalRemoteConfigPath(), path.join(os.homedir(), ".pi", "agent", "teammate-remotes.json"));
  assert.equal(getProjectRemoteConfigPath("/work/project"), path.join("/work/project", ".pi", "teammate-remotes.json"));
});

test("project remote config overrides global targets and can hide entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-config-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "home", ".pi", "agent", "teammate-remotes.json");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const global = globalStore();
    global.targets["linux-a/hidden"] = {
      host: "linux-a",
      cwd: "/srv/legacy",
      driver: "pi-rpc",
      command: ["pi"],
    };
    saveGlobalRemoteConfig(global, globalPath);
    saveProjectRemoteConfig(cwd, {
      version: REMOTE_CONFIG_VERSION,
      hosts: {},
      targets: {
        "linux-a/pi": {
          host: "linux-a",
          cwd: "/srv/project-copy",
          driver: "pi-rpc",
          command: ["pi", "--mode", "rpc"],
        },
        "linux-a/hidden": null,
      },
    }, globalPath);

    const state = loadRemoteConfigState(cwd, globalPath);
    assert.equal(state.config.targets["linux-a/pi"].cwd, "/srv/project-copy");
    assert.deepEqual(state.config.targets["linux-a/pi"].command, ["pi", "--mode", "rpc"]);
    assert.equal(state.config.targets["linux-a/hidden"], undefined);
    const target = resolveRemoteTarget(state.config, "linux-a/pi");
    assert.equal(target.hostConfig.hostKeySha256, HOST_KEY);
    assert.equal(target.id, "linux-a/pi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote config rejects unsafe cwd, argv, fingerprints, and dangling hosts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-invalid-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "global.json");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    assert.throws(() => saveGlobalRemoteConfig({
      ...globalStore(),
      hosts: { "linux-a": { ...globalStore().hosts["linux-a"], hostKeySha256: "accept-new" } },
    }, globalPath), /fingerprint/);
    assert.throws(() => saveGlobalRemoteConfig({
      ...globalStore(),
      targets: { "linux-a/pi": { ...globalStore().targets["linux-a/pi"], cwd: "relative/path" } },
    }, globalPath), /must be absolute/);
    assert.throws(() => saveGlobalRemoteConfig({
      ...globalStore(),
      targets: { "linux-a/pi": { ...globalStore().targets["linux-a/pi"], command: ["pi", "bad\0arg"] } },
    }, globalPath), /command argv/);
    assert.throws(() => saveGlobalRemoteConfig({
      version: REMOTE_CONFIG_VERSION,
      hosts: {},
      targets: { "missing/pi": { host: "missing", cwd: "/srv/project", driver: "pi-rpc", command: ["pi"] } },
    }, globalPath), /references unknown host/);

    saveGlobalRemoteConfig(globalStore(), globalPath);
    assert.throws(() => saveProjectRemoteConfig(cwd, {
      version: REMOTE_CONFIG_VERSION,
      hosts: { "linux-a": null },
      targets: {},
    }, globalPath), /references unknown host/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP target policy requires exact canonical command profiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-acp-policy-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "global.json");
  fs.mkdirSync(cwd, { recursive: true });
  const expectRejectedStore = (store: unknown, pattern: RegExp) => {
    fs.writeFileSync(globalPath, JSON.stringify(store));
    assert.throws(() => loadRemoteConfigState(cwd, globalPath), pattern);
  };
  try {
    const valid = globalStore();
    valid.targets["linux-a/acp"] = {
      host: "linux-a",
      cwd: "/srv/project",
      driver: "acp",
      command: ["acp-agent"],
      acp: {
        permissionMode: "allow-once",
        permissionTools: ["Terminal"],
        fs: { read: true, maxReadBytes: 4096 },
        terminal: {
          commands: [
            { executable: "/usr/bin/git", args: ["status", "--short"], environment: ["CI"] },
            { executable: "/usr/bin/ls", args: [], environment: [] },
          ],
          maxOutputBytes: 8192,
          timeoutMs: 10_000,
          maxProcesses: 2,
        },
      },
    };
    const saved = saveGlobalRemoteConfig(valid, globalPath);
    assert.deepEqual(saved.targets["linux-a/acp"].acp, valid.targets["linux-a/acp"].acp);

    expectRejectedStore({
      ...valid,
      targets: { "linux-a/pi": { ...globalStore().targets["linux-a/pi"], acp: {} } },
    }, /requires the ACP driver/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { unknown: true } } },
    }, /Unknown remote ACP policy/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { fs: { read: true, maxReadBytes: 0 } } } },
    }, /maxReadBytes/);
    const duplicate = { executable: "/usr/bin/ls", args: [], environment: [] };
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [duplicate, duplicate] } } } },
    }, /Duplicate remote ACP terminal command profile/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "node", args: [], environment: [] },
      ] } } } },
    }, /canonical ACP terminal executable/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/node", args: ["-e", "process.exit()"], environment: [] },
      ] } } } },
    }, /code evaluation/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/git", args: ["config", "alias.run", "!sh"], environment: [] },
      ] } } } },
    }, /git alias\/config execution/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/git", args: ["-c", "alias.run=!sh", "run"], environment: [] },
      ] } } } },
    }, /git alias\/config execution/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/git", args: ["run"], environment: [] },
      ] } } } },
    }, /git alias\/config execution/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/ls", args: [] },
      ] } } } },
    }, /terminal environment/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: [
        { executable: "/usr/bin/ls", args: [], environment: ["PATH"] },
      ] } } } },
    }, /cannot set PATH/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { terminal: { commands: ["/usr/bin/ls"] } } } },
    }, /terminal command profile/);
    expectRejectedStore({
      ...valid,
      targets: { "linux-a/acp": { ...valid.targets["linux-a/acp"], acp: { permissionTools: ["Terminal"] } } },
    }, /require allow-once/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collect-validate-commit replaces global and project stores with CAS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-transaction-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "home", "teammate-remotes.json");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const initial = loadRemoteConfigState(cwd, globalPath);
    const nextGlobal = globalStore();
    const nextProject: ProjectRemoteConfigStore = {
      version: REMOTE_CONFIG_VERSION,
      hosts: {},
      targets: {
        "linux-a/claude": {
          host: "linux-a",
          cwd: "/srv/project",
          driver: "acp",
          command: ["claude-agent-acp"],
        },
      },
    };
    replaceRemoteConfigStores(cwd, {
      global: initial.global,
      project: initial.project,
    }, {
      global: nextGlobal,
      project: nextProject,
    }, globalPath);

    const committed = loadRemoteConfigState(cwd, globalPath);
    assert.deepEqual(Object.keys(committed.config.targets).sort(), ["linux-a/claude", "linux-a/pi"]);
    assert.equal(fs.existsSync(`${globalPath}.transaction.json`), false);
    assert.throws(() => replaceRemoteConfigStores(cwd, {
      global: initial.global,
      project: initial.project,
    }, {
      global: nextGlobal,
      project: emptyProject(),
    }, globalPath), /changed after collection/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project config rejects symlinked .pi containers and config files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-symlink-"));
  const projectRoot = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const globalPath = path.join(root, "teammate-remotes.json");
  try {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(projectRoot, ".pi"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => loadRemoteConfigState(projectRoot, globalPath), /config directory must be a real directory/);
    assert.throws(() => saveProjectRemoteConfig(projectRoot, emptyProject(), globalPath), /config directory must be a real directory/);
    fs.rmSync(path.join(projectRoot, ".pi"));

    fs.mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, JSON.stringify({ version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {} }));
    fs.symlinkSync(target, path.join(projectRoot, ".pi", "teammate-remotes.json"));
    assert.throws(() => loadRemoteConfigState(projectRoot, globalPath), /regular file, not a symlink/);
    assert.throws(() => saveProjectRemoteConfig(projectRoot, emptyProject(), globalPath), /regular file, not a symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("version 1 stores migrate to strict version 2 command profiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-migration-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "teammate-remotes.json");
  fs.mkdirSync(cwd, { recursive: true });
  const legacy = {
    version: 1,
    hosts: globalStore().hosts,
    targets: {
      "linux-a/acp": {
        host: "linux-a",
        cwd: "/srv/project",
        driver: "acp",
        command: ["acp-agent"],
        acp: {
          permissionMode: "allow-once",
          terminal: {
            commands: ["/usr/bin/ls"],
            environment: ["CI"],
            permissionTools: ["Terminal"],
            maxProcesses: 1,
          },
        },
      },
    },
  };
  try {
    fs.writeFileSync(globalPath, JSON.stringify(legacy));
    const state = loadRemoteConfigState(cwd, globalPath);
    assert.equal(state.global.version, REMOTE_CONFIG_VERSION);
    assert.deepEqual(state.global.targets["linux-a/acp"].acp?.permissionTools, ["Terminal"]);
    assert.deepEqual(state.global.targets["linux-a/acp"].acp?.terminal?.commands, [
      { executable: "/usr/bin/ls", args: [], environment: ["CI"] },
    ]);

    fs.writeFileSync(globalPath, JSON.stringify({
      ...legacy,
      targets: {
        "linux-a/acp": {
          ...legacy.targets["linux-a/acp"],
          acp: { terminal: { commands: ["node"] } },
        },
      },
    }));
    assert.throws(() => loadRemoteConfigState(cwd, globalPath), /canonical ACP terminal executable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and unknown-version remote stores fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-malformed-"));
  const cwd = path.join(root, "project");
  const globalPath = path.join(root, "teammate-remotes.json");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    fs.writeFileSync(globalPath, JSON.stringify({ version: REMOTE_CONFIG_VERSION, hosts: {}, targets: {}, unexpected: true }));
    assert.throws(() => loadRemoteConfigState(cwd, globalPath), /Unknown global teammate remote config field/);

    for (const version of [0, 3, "2", null]) {
      fs.writeFileSync(globalPath, JSON.stringify({ version, hosts: {}, targets: {} }));
      assert.throws(() => loadRemoteConfigState(cwd, globalPath), /Unsupported teammate remote config version/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Draft validation helpers used by the configuration TUI
// ---------------------------------------------------------------------------

const VALID_HOST_DRAFT = {
  host: "linux-b.example",
  user: "dev",
  port: 22,
  hostKeySha256: HOST_KEY,
};

const VALID_TARGET_DRAFT = {
  host: "linux-a",
  cwd: "/srv/project",
  driver: "pi-rpc" as const,
  command: ["pi", "--remote"],
};

test("validateRemoteHostDraft accepts a valid host and rejects field-level errors", () => {
  assert.deepEqual(validateRemoteHostDraft("linux-b", VALID_HOST_DRAFT), { ok: true });

  assert.equal(validateRemoteHostDraft("Bad ID", VALID_HOST_DRAFT).ok, false);
  assert.match(errorOf(validateRemoteHostDraft("Bad ID", VALID_HOST_DRAFT)), /Invalid remote host id/);

  assert.equal(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, port: 0 }).ok, false);
  assert.match(errorOf(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, port: 0 })), /Invalid remote host port/);
  assert.equal(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, port: 70_000 }).ok, false);

  assert.equal(
    validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, hostKeySha256: "MD5:abc" }).ok,
    false,
  );
  assert.match(
    errorOf(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, hostKeySha256: "MD5:abc" })),
    /Invalid remote host key fingerprint/,
  );

  assert.equal(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, host: "bad host" }).ok, false);
  assert.match(
    errorOf(validateRemoteHostDraft("linux-b", { ...VALID_HOST_DRAFT, host: "bad host" })),
    /Invalid remote host address/,
  );
});

test("validateRemoteTargetDraft accepts a valid target and rejects field-level errors", () => {
  assert.deepEqual(validateRemoteTargetDraft("linux-a/pi", VALID_TARGET_DRAFT), { ok: true });

  assert.equal(validateRemoteTargetDraft("bad target id", VALID_TARGET_DRAFT).ok, false);
  assert.match(errorOf(validateRemoteTargetDraft("bad target id", VALID_TARGET_DRAFT)), /Invalid remote target id/);

  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, cwd: "relative/path" }).ok, false);
  assert.match(
    errorOf(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, cwd: "relative/path" })),
    /must be absolute/,
  );

  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, driver: "unknown" }).ok, false);
  assert.match(
    errorOf(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, driver: "unknown" })),
    /Invalid remote target driver/,
  );

  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, command: [] }).ok, false);
  assert.match(
    errorOf(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, command: [] })),
    /Invalid remote target command argv/,
  );

  assert.equal(
    validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, command: ["pi", "bad\u0000arg"] }).ok,
    false,
  );
  assert.match(
    errorOf(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, command: ["pi", "bad\u0000arg"] })),
    /Invalid remote target command argv/,
  );
});

test("validateRemoteTargetDraft validates the forwarded env whitelist", () => {
  assert.deepEqual(validateRemoteTargetDraft("linux-a/pi", {
    ...VALID_TARGET_DRAFT,
    env: ["CODEX_API_KEY", "GEMINI_API_KEY"],
  }), { ok: true });

  // Launch-policy variables are always rejected.
  const pathEnv = validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: ["PATH"] });
  assert.equal(pathEnv.ok, false);
  assert.match(errorOf(pathEnv), /launch policy variable/);
  const ldEnv = validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: ["LD_PRELOAD"] });
  assert.equal(ldEnv.ok, false);

  // Malformed and duplicate names are rejected.
  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: ["bad-name"] }).ok, false);
  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: ["1NOPE"] }).ok, false);
  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: ["A", "A"] }).ok, false);
  assert.equal(validateRemoteTargetDraft("linux-a/pi", { ...VALID_TARGET_DRAFT, env: [42] }).ok, false);
});

test("validateRemoteTargetDraft enforces the ACP policy sub-rules", () => {
  assert.deepEqual(validateRemoteTargetDraft("linux-a/acp", {
    ...VALID_TARGET_DRAFT,
    driver: "acp",
    command: ["/opt/pi/bin/pi"],
    acp: { permissionMode: "deny", fs: { read: true, maxReadBytes: 1024 } },
  }), { ok: true });

  // permissionTools require allow-once mode.
  const toolsWithoutMode = validateRemoteTargetDraft("linux-a/acp", {
    ...VALID_TARGET_DRAFT,
    driver: "acp",
    command: ["/opt/pi/bin/pi"],
    acp: { permissionTools: ["Terminal"] },
  });
  assert.equal(toolsWithoutMode.ok, false);
  assert.match(errorOf(toolsWithoutMode), /permissionTools require allow-once/);

  // ACP terminal profile rejects code-evaluation executables.
  const evalProfile = validateRemoteTargetDraft("linux-a/acp", {
    ...VALID_TARGET_DRAFT,
    driver: "acp",
    command: ["/opt/pi/bin/pi"],
    acp: { terminal: { commands: [{ executable: "/usr/bin/node", args: ["-e"], environment: [] }] } },
  });
  assert.equal(evalProfile.ok, false);
  assert.match(errorOf(evalProfile), /code evaluation/);

  // ACP fs byte limits are bounded.
  const oversizedFs = validateRemoteTargetDraft("linux-a/acp", {
    ...VALID_TARGET_DRAFT,
    driver: "acp",
    command: ["/opt/pi/bin/pi"],
    acp: { fs: { maxReadBytes: 1024 * 1024 + 1 } },
  });
  assert.equal(oversizedFs.ok, false);
  assert.match(errorOf(oversizedFs), /maxReadBytes/);
});
