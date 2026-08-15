import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every settings provider reaches the shell.
 *
 * A provider is complete, compiles, and passes its own tests while nothing
 * emits it — the teammate-backends provider shipped that way and its execution
 * mode toggle existed only in tests. The defect has no symptom: the settings
 * page simply lacks a section nobody is looking for.
 *
 * The check is textual because the wiring is textual: a factory in
 * `src/settings/` must be constructed and announced from the extension entry
 * point, which is the only place that owns the session lifecycle.
 */

const settingsDir = fileURLToPath(new URL("../src/settings/", import.meta.url));
const extensionSource = fs.readFileSync(
  new URL("../src/extension/index.ts", import.meta.url),
  "utf-8",
);

/** Provider factories declared under `src/settings/`. */
function providerFactories(): { file: string; factory: string }[] {
  const found: { file: string; factory: string }[] = [];
  for (const file of fs.readdirSync(settingsDir)) {
    if (!file.endsWith("-provider.ts")) continue;
    const source = fs.readFileSync(`${settingsDir}${file}`, "utf-8");
    for (const match of source.matchAll(/^export function (create\w*SettingsProvider)/gm)) {
      found.push({ file, factory: match[1]! });
    }
  }
  return found;
}

test("every settings provider factory is constructed by the extension", () => {
  const factories = providerFactories();
  assert.ok(factories.length > 0, "no provider factories found — has the naming changed?");
  const missing = factories.filter(({ factory }) => !extensionSource.includes(`${factory}(`));
  assert.deepEqual(
    missing.map((entry) => `${entry.file}:${entry.factory}`),
    [],
    "these providers are built but never constructed, so the shell never shows them",
  );
});

test("every settings provider is announced on session start and disposed on shutdown", () => {
  // Constructing without announcing is the same defect one step later: the
  // object exists and the shell still never discovers it.
  // The calls are assignments (`disposer = registerXSettingsProvider(...)`), so
  // this deliberately does not anchor to the start of a line.
  const registrars = [...new Set(
    [...extensionSource.matchAll(/\bregister(\w+)SettingsProvider\(/g)].map((match) => match[1]!),
  )];
  assert.ok(registrars.length > 0, "no provider registrations found in the extension entry point");

  // The entry point installs several handlers per lifecycle event, so every
  // block of each kind is searched rather than the first one found.
  const blocks = (event: string): string =>
    [...extensionSource.matchAll(new RegExp(`pi\\.on\\("${event}"[\\s\\S]*?\\n {2}\\}\\);`, "g"))]
      .map((match) => match[0])
      .join("\n");
  const startBlock = blocks("session_start");
  const shutdownBlock = blocks("session_shutdown");
  assert.ok(startBlock.length > 0 && shutdownBlock.length > 0, "session lifecycle blocks not found");

  for (const name of registrars) {
    assert.match(
      startBlock,
      new RegExp(`register${name}Settings\\(\\)`),
      `${name} settings are registered but never announced on session start`,
    );
    assert.match(
      shutdownBlock,
      new RegExp(`dispose${name}Settings\\(\\)`),
      `${name} settings are announced but never disposed on session shutdown`,
    );
  }
});
