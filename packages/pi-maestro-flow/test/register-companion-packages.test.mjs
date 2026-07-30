import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectCompanionDirs,
  registerCompanionPackages,
  resolvePackageDir,
} from "../scripts/register-companion-packages.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-register-companion-"));
  const settingsFile = join(root, ".pi", "agent", "settings.json");
  const dirA = join(root, "pkgs", "pi-maestro-teammate");
  const dirB = join(root, "pkgs", "pi-cockpit");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  return { settingsFile, dirA, dirB, packageDirs: [dirA, dirB] };
}

test("adds companion packages to a fresh settings file", () => {
  const { settingsFile, dirA, dirB } = fixture();
  const result = registerCompanionPackages({ settingsFile, packageDirs: [dirA, dirB] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, [dirA, dirB]);
  const written = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.deepEqual(written.packages, [dirA, dirB]);
});

test("creates the settings file when it does not exist", () => {
  const { settingsFile, dirA } = fixture();
  assert.equal(existsSync(settingsFile), false);
  registerCompanionPackages({ settingsFile, packageDirs: [dirA] });
  assert.equal(existsSync(settingsFile), true);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [dirA]);
});

test("is idempotent across repeated runs", () => {
  const { settingsFile, packageDirs } = fixture();
  registerCompanionPackages({ settingsFile, packageDirs });
  const second = registerCompanionPackages({ settingsFile, packageDirs });
  assert.equal(second.changed, false);
  assert.deepEqual(second.added, []);
  const written = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(written.packages.length, packageDirs.length);
});

test("preserves unrelated settings keys", () => {
  const { settingsFile, dirA } = fixture();
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ theme: "ocean", model: "x", packages: [] }), "utf8");
  registerCompanionPackages({ settingsFile, packageDirs: [dirA] });
  const written = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(written.theme, "ocean");
  assert.equal(written.model, "x");
  assert.deepEqual(written.packages, [dirA]);
});

test("dedupes against an existing non-canonical path entry", () => {
  const { settingsFile, dirA } = fixture();
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  // Same directory expressed non-canonically; realpath/resolve must collapse it.
  writeFileSync(settingsFile, JSON.stringify({ packages: [join(dirA, ".")] }), "utf8");
  const result = registerCompanionPackages({ settingsFile, packageDirs: [dirA] });
  assert.equal(result.changed, false);
  const written = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(written.packages.length, 1);
});

test("prunes duplicate package names while preserving the first configured source", () => {
  const { settingsFile } = fixture();
  const root = join(settingsFile, "..", "..", "..");
  const workspace = join(root, "workspace", "pi-maestro-teammate");
  const nested = join(root, "flow", "node_modules", "pi-maestro-teammate");
  for (const dir of [workspace, nested]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-maestro-teammate" }), "utf8");
  }
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ packages: [workspace, nested] }), "utf8");

  const result = registerCompanionPackages({ settingsFile, packageDirs: [nested] });

  assert.equal(result.changed, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [workspace]);
});

test("does not add a nested companion when a workspace source is already configured", () => {
  const { settingsFile } = fixture();
  const root = join(settingsFile, "..", "..", "..");
  const workspace = join(root, "workspace", "pi-maestro-teammate");
  const nested = join(root, "flow", "node_modules", "pi-maestro-teammate");
  for (const dir of [workspace, nested]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-maestro-teammate" }), "utf8");
  }
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ packages: [workspace] }), "utf8");

  const result = registerCompanionPackages({ settingsFile, packageDirs: [nested] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.packages, [workspace]);
});

test("does not prune duplicate names for packages outside the companion set", () => {
  const { settingsFile, dirA } = fixture();
  const root = join(settingsFile, "..", "..", "..");
  const sourceA = join(root, "plugins", "source-a");
  const sourceB = join(root, "plugins", "source-b");
  for (const dir of [sourceA, sourceB]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "unrelated-plugin" }), "utf8");
  }
  mkdirSync(join(settingsFile, ".."), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ packages: [sourceA, sourceB] }), "utf8");

  const result = registerCompanionPackages({ settingsFile, packageDirs: [dirA] });

  assert.equal(result.changed, true);
  assert.deepEqual(result.packages, [sourceA, sourceB, dirA]);
});

test("resolvePackageDir locates the workspace teammate package", () => {
  const dir = resolvePackageDir("pi-maestro-teammate", import.meta.url);
  assert.ok(dir, "expected to resolve pi-maestro-teammate");
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-maestro-teammate");
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
