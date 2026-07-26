import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const npmCliPath = process.env.npm_execpath
  ?? resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCommand = [process.execPath, npmCliPath];
const piCoreSdkNames = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const supportedSdkVersion = "0.82.1";
const extensionRoots = [
  packageRoot,
  resolve(packageRoot, "..", "pi-maestro-teammate"),
  resolve(packageRoot, "..", "pi-cockpit"),
];

test("installed and locked Pi SDKs have supported versions without extraneous entries", () => {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const lockedSdkEntries = Object.entries(lock.packages)
    .filter(([path]) => piCoreSdkNames.some((sdkName) => path.endsWith(`node_modules/${sdkName}`)))
    .map(([path, entry]) => ({
      path,
      version: entry.version,
      extraneous: entry.extraneous === true,
    }));

  assert.ok(lockedSdkEntries.length >= piCoreSdkNames.length, "package-lock must contain the Pi SDK development graph");
  assert.deepEqual(
    [...new Set(lockedSdkEntries.map(({ version }) => version))],
    [supportedSdkVersion],
    `unsupported locked Pi SDK versions:\n${JSON.stringify(lockedSdkEntries, null, 2)}`,
  );
  assert.equal(
    lockedSdkEntries.some(({ extraneous }) => extraneous),
    false,
    `extraneous locked Pi SDK entries:\n${JSON.stringify(lockedSdkEntries, null, 2)}`,
  );

  const listed = runNpm([
    "ls",
    ...piCoreSdkNames,
    "--all",
    "--json",
  ], repoRoot);
  assert.equal(
    listed.status,
    0,
    `npm ls reported Pi SDK problems\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
  );
  const physicalSdkRoots = collectSdkNodes(JSON.parse(listed.stdout));
  assert.ok(physicalSdkRoots.length >= piCoreSdkNames.length, "npm ls must expose the physical Pi SDK roots");
  assert.equal(
    physicalSdkRoots.some(({ version }) => version !== supportedSdkVersion),
    false,
    `unsupported installed Pi SDK versions:\n${JSON.stringify(physicalSdkRoots, null, 2)}`,
  );
  assert.equal(
    physicalSdkRoots.some(({ extraneous }) => extraneous),
    false,
    `extraneous installed Pi SDKs:\n${JSON.stringify(physicalSdkRoots, null, 2)}`,
  );
});

test("published extension packages do not bundle Pi core SDKs", { timeout: 180_000 }, () => {
  for (const extensionRoot of extensionRoots) {
    const pkg = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
    const packed = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], extensionRoot);
    assert.equal(
      packed.status,
      0,
      `${pkg.name} pack dry-run failed\nstdout:\n${packed.stdout}\nstderr:\n${packed.stderr}`,
    );
    const packResult = JSON.parse(packed.stdout)[0];
    const bundled = [
      ...(pkg.bundleDependencies ?? []),
      ...(pkg.bundledDependencies ?? []),
    ];
    assert.equal(
      bundled.some((name) => piCoreSdkNames.includes(name)),
      false,
      `${pkg.name} must not declare bundled Pi core SDKs`,
    );
    assert.equal(
      packResult.files.some(({ path }) =>
        piCoreSdkNames.some((sdkName) => path.includes(`node_modules/${sdkName}/`))
      ),
      false,
      `${pkg.name} tarball must not contain Pi core SDK files`,
    );
  }
});

function collectSdkNodes(node, parentPath = "") {
  const nodes = [];
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    const path = parentPath ? `${parentPath} > ${name}` : name;
    if (piCoreSdkNames.includes(name)) {
      nodes.push({
        path,
        version: dependency.version,
        extraneous: dependency.extraneous === true
          || dependency.problems?.some((problem) => problem.startsWith("extraneous:")) === true,
      });
    }
    nodes.push(...collectSdkNodes(dependency, path));
  }
  return nodes;
}

function runNpm(args, cwd) {
  const [command, ...prefix] = npmCommand;
  return spawnSync(command, [...prefix, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
}
