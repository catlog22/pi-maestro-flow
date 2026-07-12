import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureMaestroKeybindings } from "../scripts/configure-keybindings.mjs";

test("creates keybindings with Shift+E effort cycling", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, ".pi", "agent", "keybindings.json");

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "app.thinking.cycle": "shift+e" });
});

test("merges the binding without removing existing shortcuts", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.tools.expand": "ctrl+o", "app.thinking.cycle": "shift+tab" }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.tools.expand": "ctrl+o",
    "app.thinking.cycle": "shift+e",
  });
  assert.equal(ensureMaestroKeybindings(path).status, "unchanged");
});

test("does not overwrite invalid existing JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, "{ invalid");

  assert.equal(ensureMaestroKeybindings(path).status, "skipped");
  assert.equal(readFileSync(path, "utf8"), "{ invalid");
});
