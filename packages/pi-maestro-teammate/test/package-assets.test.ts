import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

interface PackDryRunResult {
  files?: Array<{ path?: string }>;
}

test("npm package includes the experts-mode JSON rules", () => {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const output = execFileSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [result] = JSON.parse(output) as PackDryRunResult[];
  const files = new Set((result?.files ?? []).map((file) => file.path));

  assert.ok(files.has("src/experts-mode/config/default-rules.json"));
  assert.ok(files.has("src/experts-mode/config/experts-rules.example.json"));
});
