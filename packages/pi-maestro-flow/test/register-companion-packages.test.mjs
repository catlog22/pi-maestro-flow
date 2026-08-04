import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  collectCompanionDirs,
  getAgentDir,
  getCompanionStatePath,
  registerCompanionPackages,
  resolvePackageDir,
} from "../scripts/register-companion-packages.mjs";

const flowRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flowPackage = JSON.parse(readFileSync(join(flowRoot, "package.json"), "utf8"));
const COMPANION_VERSIONS = {
  "pi-maestro-teammate": flowPackage.dependencies["pi-maestro-teammate"],
  "pi-cockpit": flowPackage.dependencies["pi-cockpit"],
};

function writePackage(directory, name, version = COMPANION_VERSIONS[name] ?? "1.0.0") {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }), "utf8");
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-register-companion-"));
  const agentDir = join(root, ".pi", "agent");
  const settingsFile = join(agentDir, "settings.json");
  const stateFile = getCompanionStatePath(agentDir);
  const teammate = join(root, "current", "pi-maestro-teammate");
  const cockpit = join(root, "current", "pi-cockpit");
  writePackage(teammate, "pi-maestro-teammate");
  writePackage(cockpit, "pi-cockpit");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    agentDir,
    settingsFile,
    stateFile,
    teammate,
    cockpit,
    packageDirs: [teammate, cockpit],
  };
}

function register(state, overrides = {}) {
  return registerCompanionPackages({
    settingsFile: state.settingsFile,
    stateFile: state.stateFile,
    packageDirs: state.packageDirs,
    expectedVersions: COMPANION_VERSIONS,
    ...overrides,
  });
}

function readState(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("adds companions and records their ownership on a fresh install", (t) => {
  const state = fixture(t);
  const result = register(state);

  assert.equal(result.changed, true);
  assert.deepEqual(result.added, state.packageDirs);
  assert.deepEqual(readState(state.settingsFile).packages, state.packageDirs);
  assert.deepEqual(
    Object.fromEntries(Object.entries(readState(state.stateFile).companions).map(([name, entry]) => [name, entry.source])),
    {
      "pi-maestro-teammate": state.teammate,
      "pi-cockpit": state.cockpit,
    },
  );
});

test("is idempotent after postinstall and extension-load registration", (t) => {
  const state = fixture(t);
  register(state);
  const second = register(state);

  assert.equal(second.changed, false);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.replaced, []);
  assert.deepEqual(second.adopted, []);
});

test("preserves unrelated settings keys and package entries", (t) => {
  const state = fixture(t);
  const unrelated = { source: join(state.root, "plugins", "unrelated"), skills: ["-legacy"], custom: true };
  const opaque = { futurePackageFormat: true, resources: ["custom"] };
  writeJson(state.settingsFile, { theme: "ocean", model: "x", packages: [unrelated, opaque, null] });

  register(state);

  const written = readState(state.settingsFile);
  assert.equal(written.theme, "ocean");
  assert.equal(written.model, "x");
  assert.deepEqual(written.packages, [unrelated, opaque, null, ...state.packageDirs]);
});

test("replaces a sidecar-owned companion source while preserving object resource configuration", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-maestro-teammate");
  writePackage(old, "pi-maestro-teammate");
  const entry = { source: old, skills: ["-legacy"], extensions: ["./custom.ts"], custom: true };
  writeJson(state.settingsFile, { packages: [entry] });
  writeJson(state.stateFile, {
    version: 1,
    companions: { "pi-maestro-teammate": { source: old } },
  });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-maestro-teammate", from: old, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [{ ...entry, source: state.teammate }]);
  assert.equal(readState(state.stateFile).companions["pi-maestro-teammate"].source, state.teammate);
});

test("migrates a legacy companion nested under an older Flow package root", (t) => {
  const state = fixture(t);
  const oldFlow = join(state.root, "old-flow");
  const old = join(oldFlow, "node_modules", "pi-maestro-teammate");
  writePackage(oldFlow, "pi-maestro-flow", "0.14.1");
  writePackage(old, "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [old] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-maestro-teammate", from: old, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
  assert.equal(readState(state.stateFile).companions["pi-maestro-teammate"].source, state.teammate);
});

test("migrates a symlinked legacy companion using its logical Flow ancestry", (t) => {
  const state = fixture(t);
  const oldFlow = join(state.root, "old-flow");
  const stored = join(state.root, "package-store", "pi-maestro-teammate");
  const linked = join(oldFlow, "node_modules", "pi-maestro-teammate");
  writePackage(oldFlow, "pi-maestro-flow", "0.14.1");
  writePackage(stored, "pi-maestro-teammate");
  mkdirSync(dirname(linked), { recursive: true });
  try {
    symlinkSync(stored, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  writeJson(state.settingsFile, { packages: [linked] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-maestro-teammate", from: linked, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
});

test("preserves a local checkout nested under a Flow repository root", (t) => {
  const state = fixture(t);
  const checkout = join(state.root, "checkout", "pi-maestro-flow");
  const localTeammate = join(checkout, "packages", "pi-maestro-teammate");
  writePackage(checkout, "pi-maestro-flow", "0.14.1");
  writePackage(localTeammate, "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [localTeammate] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.preservedUnowned, [{ name: "pi-maestro-teammate", source: localTeammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [localTeammate]);
});

test("preserves a same-name workspace override without adding a duplicate companion", (t) => {
  const state = fixture(t);
  const workspace = join(state.root, "workspace", "pi-maestro-teammate");
  writePackage(workspace, "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [workspace] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.preservedUnowned, [{ name: "pi-maestro-teammate", source: workspace }]);
  assert.deepEqual(readState(state.settingsFile).packages, [workspace]);
  assert.equal(existsSync(state.stateFile), false);
});

test("dedupes managed aliases while preferring an object entry over a preceding string", (t) => {
  const state = fixture(t);
  const entry = { source: join(state.teammate, "."), skills: ["-legacy"], custom: true };
  writeJson(state.settingsFile, { packages: [state.teammate, entry] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, true);
  assert.deepEqual(readState(state.settingsFile).packages, [entry]);
  assert.equal(readState(state.stateFile).companions["pi-maestro-teammate"].source, state.teammate);
});

test("fails closed when managed aliases carry conflicting object configuration", (t) => {
  const state = fixture(t);
  const first = { source: state.teammate, skills: ["-first"] };
  const second = { source: join(state.teammate, "."), extensions: ["./second.ts"] };
  writeJson(state.settingsFile, { packages: [first, second] });
  const before = readFileSync(state.settingsFile, "utf8");

  assert.throws(
    () => register(state, { packageDirs: [state.teammate] }),
    /Cannot safely dedupe companion aliases with conflicting resource configuration/,
  );
  assert.equal(readFileSync(state.settingsFile, "utf8"), before);
  assert.equal(existsSync(state.stateFile), false);
});

test("replaces a missing sidecar-owned source but preserves an unreadable unowned source", (t) => {
  const state = fixture(t);
  const ownedMissing = join(state.root, "old", "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [ownedMissing] });
  writeJson(state.stateFile, {
    version: 1,
    companions: { "pi-maestro-teammate": { source: ownedMissing } },
  });

  const replaced = register(state, { packageDirs: [state.teammate] });
  assert.deepEqual(replaced.replaced, [{ name: "pi-maestro-teammate", from: ownedMissing, to: state.teammate }]);

  const unownedMissing = join(state.root, "manual", "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [unownedMissing] });
  rmSync(state.stateFile, { force: true });
  const preserved = register(state, { packageDirs: [state.teammate] });
  assert.deepEqual(preserved.added, [state.teammate]);
  assert.deepEqual(readState(state.settingsFile).packages, [unownedMissing, state.teammate]);
});

test("fails closed for malformed settings or companion state", (t) => {
  const state = fixture(t);
  writeJson(state.stateFile, { version: 1, companions: {} });
  writeFileSync(state.settingsFile, "not json", "utf8");
  const settingsBefore = readFileSync(state.settingsFile, "utf8");
  const stateBefore = readFileSync(state.stateFile, "utf8");

  assert.throws(() => register(state), /Cannot read Pi settings/);
  assert.equal(readFileSync(state.settingsFile, "utf8"), settingsBefore);
  assert.equal(readFileSync(state.stateFile, "utf8"), stateBefore);

  writeJson(state.settingsFile, []);
  assert.throws(() => register(state), /root value must be an object/);
  writeJson(state.settingsFile, { packages: [] });
  writeJson(state.stateFile, { version: 2, companions: {} });
  assert.throws(() => register(state), /Invalid Maestro companion state/);
});

test("keeps both files unchanged when the settings write fails", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-maestro-teammate");
  writePackage(old, "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [old] });
  writeJson(state.stateFile, { version: 1, companions: { "pi-maestro-teammate": { source: old } } });
  const settingsBefore = readFileSync(state.settingsFile, "utf8");
  const stateBefore = readFileSync(state.stateFile, "utf8");

  assert.throws(() => register(state, {
    packageDirs: [state.teammate],
    writeFile(filePath, content) {
      if (filePath === state.settingsFile) throw new Error("injected settings write failure");
      writeFileSync(filePath, content, "utf8");
    },
  }), /injected settings write failure/);

  assert.equal(readFileSync(state.settingsFile, "utf8"), settingsBefore);
  assert.equal(readFileSync(state.stateFile, "utf8"), stateBefore);
});

test("recovers when the sidecar write fails after settings are updated", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-maestro-teammate");
  writePackage(old, "pi-maestro-teammate");
  writeJson(state.settingsFile, { packages: [old] });
  writeJson(state.stateFile, { version: 1, companions: { "pi-maestro-teammate": { source: old } } });

  assert.throws(() => register(state, {
    packageDirs: [state.teammate],
    writeFile(filePath, content) {
      if (filePath === state.stateFile) throw new Error("injected state write failure");
      writeFileSync(filePath, content, "utf8");
    },
  }), /injected state write failure/);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
  assert.equal(readState(state.stateFile).companions["pi-maestro-teammate"].source, old);

  const recovered = register(state, { packageDirs: [state.teammate] });
  assert.equal(recovered.changed, true);
  assert.equal(readState(state.stateFile).companions["pi-maestro-teammate"].source, state.teammate);
  assert.equal(register(state, { packageDirs: [state.teammate] }).changed, false);
});

test("uses the configured Pi agent directory for settings and companion state", (t) => {
  const state = fixture(t);
  assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: state.agentDir }), state.agentDir);

  const result = registerCompanionPackages({
    agentDir: state.agentDir,
    packageDirs: [state.teammate],
    expectedVersions: COMPANION_VERSIONS,
  });

  assert.equal(result.settingsFile, state.settingsFile);
  assert.equal(result.stateFile, state.stateFile);
  assert.equal(existsSync(state.settingsFile), true);
  assert.equal(existsSync(state.stateFile), true);
});

test("reports a resolved companion version that does not match Flow's exact dependency", (t) => {
  const state = fixture(t);
  const mismatched = join(state.root, "mismatched", "pi-maestro-teammate");
  writePackage(mismatched, "pi-maestro-teammate", "9.9.9");

  const result = register(state, { packageDirs: [mismatched] });

  assert.deepEqual(result.versionMismatch, [{
    name: "pi-maestro-teammate",
    expected: COMPANION_VERSIONS["pi-maestro-teammate"],
    actual: "9.9.9",
  }]);
});

test("resolvePackageDir locates the workspace teammate package", () => {
  const dir = resolvePackageDir("pi-maestro-teammate", import.meta.url);
  assert.ok(dir, "expected to resolve pi-maestro-teammate");
  assert.equal(readState(join(dir, "package.json")).name, "pi-maestro-teammate");
});

test("resolvePackageDir returns undefined for a missing package", () => {
  assert.equal(resolvePackageDir("pi-maestro-does-not-exist", import.meta.url), undefined);
});

test("collectCompanionDirs resolves the real companions from this workspace", () => {
  const dirs = collectCompanionDirs({ fromUrl: import.meta.url });
  assert.ok(dirs.length >= 1, "expected at least one companion to resolve");
  for (const dir of dirs) {
    assert.equal(existsSync(join(dir, "package.json")), true);
  }
});
