import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolvePackageRoot();

function resolvePackageRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

test("computer-use package publishes contracts and excludes model/cache artifacts", () => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.ok(packageJson.files.includes("optional/"), "package files must include optional contracts");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, encoding: "utf8", shell: true });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  for (const required of [
    "optional/computer-use-manifest.json",
    "optional/COMPUTER-USE-NOTICES.md",
    "schemas/computer-use-manifest.schema.json",
    "optional/COMPUTER-USE-SETUP.md",
    "optional/computer-use-windows-bridge.py",
    "optional/INIT-SETUP.md",
    "optional/TEAMMATE-MODELS-SETUP.md",
    "optional/SMART-SEARCH-SETUP.md",
    "optional/MCP-SETUP.md",
    "optional/COMPUTER-USE-WEIGHTS-SETUP.md",
    "optional/BROWSER-BRIDGE-SETUP.md",
    "optional/browser-bridge/manifest.json",
    "optional/browser-bridge/background.js",
  ]) assert.ok(files.includes(required), `${required} must be published`);
  const forbidden = files.filter((path) => /\.(onnx|pt|bin|safetensors|traineddata)$/i.test(path) || /(^|\/)(cache|models|\.part)(\/|$)/i.test(path));
  assert.deepEqual(forbidden, [], "model weights and runtime caches must not be published");
});
