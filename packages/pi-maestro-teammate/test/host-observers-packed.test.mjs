import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

test("packed public host-observer API resolves in a fresh consumer process", { timeout: 90_000 }, () => {
  // Reuse installed dependencies, but resolve the subject package from its real tarball (no links).
  const cache = join(workspaceRoot, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "host-observers-packed-"));
  try {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "Run via npm run test:host-observers-packed to supply the current npm CLI.");
    const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", root], packageRoot));
    const installed = join(root, "node_modules", "pi-maestro-teammate");
    mkdirSync(installed, { recursive: true });
    run("tar", ["-xzf", packed[0].filename, "-C", "node_modules/pi-maestro-teammate", "--strip-components=1"], root);
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.exports["./v1/events"].types, "./types/public/v1/events.d.ts");
    assert.match(readFileSync(join(installed, "types/public/v1/events.d.ts"), "utf8"), /registerTeammateHostObserver/);
    assert.match(readFileSync(join(installed, "types/runs/host-observers.d.ts"), "utf8"), /TeammateHostBoundary/);
    const consumer = join(root, "consumer.mjs");
    writeFileSync(consumer, `import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const api = await jiti.import("pi-maestro-teammate/v1/events");
const producer = await jiti.import("./node_modules/pi-maestro-teammate/src/runs/host-observers.ts");
let count = 0;
const cleanup = api.registerTeammateHostObserver("packed-consumer", boundary => {
  assert.equal(boundary.correlationId, "host-owned-actor");
  assert.equal(boundary.steer("reflect"), true);
  count++;
});
const boundary = { correlationId: "host-owned-actor", incarnation: "packed-runtime", sequence: producer.nextTeammateHostSequence(), runtimeGeneration: 1, event: { type: "turn_end" }, steer(message) { return message === "reflect"; } };
producer.publishTeammateHostBoundary(boundary);
assert.equal(count, 1);
cleanup(); producer.publishTeammateHostBoundary(boundary); assert.equal(count, 1);
console.log("packed host-observer public API: PASS");
`);
    assert.match(run(process.execPath, [consumer], root), /public API: PASS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
