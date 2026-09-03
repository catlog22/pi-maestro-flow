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
const piCorePackageVersions = {
  "@earendil-works/pi-agent-core": "0.84.4",
  "@earendil-works/pi-ai": "0.84.4",
  "@earendil-works/pi-coding-agent": "0.84.4",
  "@earendil-works/pi-tui": "0.84.4",
  typebox: "1.3.7",
};
const piCorePackageNames = Object.keys(piCorePackageVersions);
const extensionRoots = [
  packageRoot,
  resolve(packageRoot, "..", "pi-maestro-teammate"),
  resolve(packageRoot, "..", "pi-cockpit"),
];

test("installed and locked Pi core packages have supported versions without extraneous entries", () => {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const lockedCoreEntries = Object.entries(lock.packages)
    .flatMap(([path, entry]) => {
      const name = piCorePackageNames.find((packageName) => path.endsWith(`node_modules/${packageName}`));
      return name ? [{
        name,
        path,
        version: entry.version,
        extraneous: entry.extraneous === true,
      }] : [];
    });

  assert.ok(lockedCoreEntries.length >= piCorePackageNames.length, "package-lock must contain the Pi core development graph");
  assert.equal(
    lockedCoreEntries.some(({ name, version }) => version !== piCorePackageVersions[name]),
    false,
    `unsupported locked Pi core versions:\n${JSON.stringify(lockedCoreEntries, null, 2)}`,
  );
  assert.equal(
    lockedCoreEntries.some(({ extraneous }) => extraneous),
    false,
    `extraneous locked Pi core entries:\n${JSON.stringify(lockedCoreEntries, null, 2)}`,
  );

  const listed = runNpm([
    "ls",
    ...piCorePackageNames,
    "--all",
    "--json",
  ], repoRoot);
  assert.equal(
    listed.status,
    0,
    `npm ls reported Pi core package problems\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
  );
  const physicalCoreRoots = collectCorePackageNodes(JSON.parse(listed.stdout));
  assert.ok(physicalCoreRoots.length >= piCorePackageNames.length, "npm ls must expose the physical Pi core package roots");
  assert.equal(
    physicalCoreRoots.some(({ name, version }) => version !== piCorePackageVersions[name]),
    false,
    `unsupported installed Pi core versions:\n${JSON.stringify(physicalCoreRoots, null, 2)}`,
  );
  assert.equal(
    physicalCoreRoots.some(({ extraneous }) => extraneous),
    false,
    `extraneous installed Pi core packages:\n${JSON.stringify(physicalCoreRoots, null, 2)}`,
  );
});

test("published extension packages do not bundle Pi core packages", { timeout: 180_000 }, () => {
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
      bundled.some((name) => piCorePackageNames.includes(name)),
      false,
      `${pkg.name} must not declare bundled Pi core packages`,
    );
    assert.equal(
      packResult.files.some(({ path }) =>
        piCorePackageNames.some((packageName) => path.includes(`node_modules/${packageName}/`))
      ),
      false,
      `${pkg.name} tarball must not contain Pi core package files`,
    );
  }
});

function collectCorePackageNodes(node, parentPath = "") {
  const nodes = [];
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    const path = parentPath ? `${parentPath} > ${name}` : name;
    if (piCorePackageNames.includes(name)) {
      nodes.push({
        name,
        path,
        version: dependency.version,
        extraneous: dependency.extraneous === true
          || dependency.problems?.some((problem) => problem.startsWith("extraneous:")) === true,
      });
    }
    nodes.push(...collectCorePackageNodes(dependency, path));
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
