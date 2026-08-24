import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  INSTALL_ITEMS,
  STATUS_GLYPH,
  resolveInstallItems,
  probeInstallStatus,
  readInstallDoc,
  type InstallStatus,
} from "../src/install/install-items.ts";
import { composeInstallMessageForTest } from "../src/install/install-command.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("install registry declares seven items with stable ids", () => {
  const ids = INSTALL_ITEMS.map((item) => item.id);
  assert.deepEqual(ids, ["init", "teammate-models", "computer-use", "computer-use-weights", "self-evolve", "smart-search", "mcp"]);
  for (const item of INSTALL_ITEMS) {
    assert.ok(item.title.length > 0 && item.description.length > 0, `${item.id} needs title+description`);
    assert.ok(item.promptIntro.length > 0, `${item.id} needs promptIntro`);
    assert.ok(["core", "optional", "external"].includes(item.category), `${item.id} bad category`);
  }
});

test("categories are ordered core → optional → external", () => {
  const order = { core: 0, optional: 1, external: 2 };
  for (let i = 1; i < INSTALL_ITEMS.length; i++) {
    assert.ok(order[INSTALL_ITEMS[i - 1].category] <= order[INSTALL_ITEMS[i].category], "categories must not regress");
  }
});

test("every install doc ships in the package optional/ dir", () => {
  for (const item of INSTALL_ITEMS) {
    const path = join(packageRoot, "optional", item.docFile);
    assert.ok(existsSync(path), `${item.docFile} must be published in optional/`);
  }
});

test("probeInstallStatus returns a known status for each item and never throws", () => {
  for (const item of INSTALL_ITEMS) {
    const status = probeInstallStatus(item.id);
    assert.ok(["not-installed", "installed", "partial", "unknown"].includes(status), `${item.id} bad status ${status}`);
  }
  // unknown id does not throw
  assert.equal(probeInstallStatus("nonexistent"), "unknown");
});

test("resolveInstallItems attaches status, glyph, and docPath to every item", () => {
  const resolved = resolveInstallItems();
  assert.equal(resolved.length, INSTALL_ITEMS.length);
  for (const item of resolved) {
    assert.ok(Object.prototype.hasOwnProperty.call(STATUS_GLYPH, item.status), `${item.id} status has glyph`);
    assert.ok(typeof item.docPath === "string" || item.docPath === undefined, `${item.id} docPath type`);
  }
});

test("readInstallDoc returns the doc content for a shipped file and undefined for a missing one", () => {
  const init = readInstallDoc("INIT-SETUP.md");
  assert.ok(typeof init === "string" && init.includes("## PURPOSE"), "INIT-SETUP.md must load with PURPOSE section");
  assert.equal(readInstallDoc("NONEXISTENT.md"), undefined);
});

test("composeInstallMessage prepends promptIntro, the execution instruction, and the full doc", () => {
  const item = INSTALL_ITEMS.find((i) => i.id === "init")!;
  const doc = readInstallDoc(item.docFile)!;
  const message = composeInstallMessageForTest(item, doc);
  assert.ok(message.startsWith(item.promptIntro), "message must start with promptIntro");
  assert.ok(message.includes("自主执行全部步骤"), "message must instruct autonomous execution");
  assert.ok(message.includes("INTERACTIVE INPUTS"), "message must reference interactive inputs");
  assert.ok(message.includes("## 安装文档"), "message must embed the doc header");
  assert.ok(message.includes(doc), "message must embed the full doc body");
});

test("STATUS_GLYPH covers every InstallStatus", () => {
  const statuses: InstallStatus[] = ["not-installed", "installed", "partial", "unknown"];
  for (const s of statuses) assert.ok(typeof STATUS_GLYPH[s] === "string", `glyph for ${s}`);
});
