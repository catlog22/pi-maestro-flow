import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureMaestroKeybindings,
  restorePiKeybindings,
} from "../scripts/configure-keybindings.mjs";

test("creates keybindings with Ctrl+Shift+E effort cycling", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, ".pi", "agent", "keybindings.json");

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "app.thinking.cycle": "ctrl+shift+e" });
});

test("merges the binding without removing existing shortcuts", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.tools.expand": "ctrl+o", "app.thinking.cycle": "shift+tab" }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.tools.expand": "ctrl+o",
    "app.thinking.cycle": "ctrl+shift+e",
  });
  assert.equal(ensureMaestroKeybindings(path).status, "unchanged");
});

test("preserves non-conflicting aliases when replacing Shift+Tab", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.thinking.cycle": ["shift+tab", "ctrl+e"] }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.thinking.cycle": ["ctrl+shift+e", "ctrl+e"],
  });
  assert.equal(ensureMaestroKeybindings(path).status, "unchanged");
});

test("preserves a custom scalar alias when applying the recommended key", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.thinking.cycle": "ctrl+e" }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.thinking.cycle": ["ctrl+shift+e", "ctrl+e"],
  });
});

test("migrates the legacy Shift+E binding without retaining it as an alias", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.thinking.cycle": "Shift+E" }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.thinking.cycle": "ctrl+shift+e",
  });
});

test("removes the legacy Shift+E alias while preserving custom aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.thinking.cycle": ["shift+e", "ctrl+e"] }));

  assert.equal(ensureMaestroKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "app.thinking.cycle": ["ctrl+shift+e", "ctrl+e"],
  });
});

test("treats mixed-case Ctrl+Shift+E as the same binding", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.thinking.cycle": "Ctrl+Shift+E" }));

  assert.equal(ensureMaestroKeybindings(path).status, "unchanged");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "app.thinking.cycle": "Ctrl+Shift+E" });
});

test("does not overwrite invalid existing JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, "{ invalid");

  assert.equal(ensureMaestroKeybindings(path).status, "skipped");
  assert.equal(readFileSync(path, "utf8"), "{ invalid");
});

test("restores the Pi default without removing unrelated shortcuts", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, JSON.stringify({ "app.tools.expand": "ctrl+o", "app.thinking.cycle": "ctrl+shift+e" }));

  assert.equal(restorePiKeybindings(path).status, "updated");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "app.tools.expand": "ctrl+o" });
  assert.equal(restorePiKeybindings(path).status, "unchanged");
});

test("restore does not overwrite invalid existing JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-maestro-keybindings-"));
  const path = join(root, "keybindings.json");
  writeFileSync(path, "{ invalid");

  assert.equal(restorePiKeybindings(path).status, "skipped");
  assert.equal(readFileSync(path, "utf8"), "{ invalid");
});
