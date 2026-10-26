import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
function resolveNpmCommand() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return [process.execPath, process.env.npm_execpath];
  }
  const candidateLib = resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(candidateLib)) return [process.execPath, candidateLib];
  const candidateDirect = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(candidateDirect)) return [process.execPath, candidateDirect];
  return [process.platform === "win32" ? "npm.cmd" : "npm"];
}
const npmCommand = resolveNpmCommand();
const piSdkPackageNames = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const piCorePackageNames = [...piSdkPackageNames, "typebox"];
const extensionRoots = [
  packageRoot,
  resolve(packageRoot, "..", "pi-maestro-teammate"),
  resolve(packageRoot, "..", "pi-cockpit"),
];
const extensionManifests = extensionRoots.map((root) =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
);
const piCorePackageVersions = Object.fromEntries(piCorePackageNames.map((name) =>
  [name, extensionManifests[0].devDependencies[name]]
));

test("Pi development baselines stay pinned and aligned while runtime packages remain host-provided", () => {
  assert.equal(new Set(piSdkPackageNames.map((name) => piCorePackageVersions[name])).size, 1,
    "Pi SDK packages must be upgraded together");
  for (const pkg of extensionManifests) {
    for (const name of piCorePackageNames) {
      assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, `${pkg.name}: ${name} must have an exact stable development pin`);
      assert.equal(pkg.devDependencies[name], piCorePackageVersions[name], `${pkg.name}: ${name} development baseline differs`);
      assert.equal(pkg.peerDependencies[name], "*", `${pkg.name}: ${name} must be supplied by the Pi host`);
      assert.equal(pkg.peerDependenciesMeta[name].optional, true, `${pkg.name}: ${name} must not be auto-installed as a peer`);
      assert.equal(pkg.dependencies?.[name], undefined, `${pkg.name}: ${name} must not be a runtime dependency`);
    }
  }
});

test("SDK update automation groups only host SDK dependencies and keeps validation read-only", () => {
  const config = parse(readFileSync(join(repoRoot, ".github", "dependabot.yml"), "utf8"));
  assert.equal(config.version, 2);
  assert.equal(config.updates.length, 1);
  const update = config.updates[0];
  assert.equal(update["package-ecosystem"], "npm");
  assert.equal(update.directory, "/", "npm workspaces share the root lockfile");
  assert.equal(update.schedule.interval, "weekly");
  assert.equal(update["open-pull-requests-limit"], 1);
  assert.equal(update["versioning-strategy"], "increase");
  assert.deepEqual(update.allow.map((entry) => entry["dependency-name"]).sort(), [...piCorePackageNames].sort());
  for (const name of piSdkPackageNames) {
    assert.equal(update.allow.find((entry) => entry["dependency-name"] === name)["dependency-type"], "development");
  }
  assert.deepEqual(Object.keys(update.groups), ["pi-sdk"]);
  assert.deepEqual([...update.groups["pi-sdk"].patterns].sort(), [...piCorePackageNames].sort());

  const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "pi-sdk.yml"), "utf8"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  for (const path of ["package-lock.json", ".github/dependabot.yml", ".github/workflows/pi-sdk.yml"]) {
    assert.ok(workflow.on.pull_request.paths.includes(path));
  }
  const commands = workflow.jobs.compatibility.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /npm ci --ignore-scripts/);
  assert.match(commands, /node --test packages\/pi-maestro-flow\/test\/sdk-resolution-contract\.test\.mjs/);
  for (const pkg of extensionManifests) {
    assert.match(commands, new RegExp(`npm --prefix packages/${pkg.name} run typecheck`));
  }
  assert.doesNotMatch(commands, /npm (?:update|publish)|gh pr merge|test:release/);
});

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
