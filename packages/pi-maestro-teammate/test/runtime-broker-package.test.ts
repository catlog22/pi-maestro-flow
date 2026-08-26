import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

interface PackageManifest {
  engines?: { node?: string };
  bin?: Record<string, string>;
  exports?: Record<string, string | { types?: string; default?: string }>;
}

interface PackDryRunResult {
  filename?: string;
  files?: Array<{ path?: string }>;
}

const packageRoot = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const brokerBin = path.join(packageRoot, "bin", "pi-teammate-broker.mjs");
const packTimeout = 360_000;
const installTimeout = 600_000;

function npmRun(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = packTimeout,
) {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${commandArgs.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${result.error ?? ""}`,
  );
  return result.stdout;
}

function parsePackResult(output: string): PackDryRunResult {
  const arrayStart = output.lastIndexOf("\n[");
  const [result] = JSON.parse(arrayStart >= 0 ? output.slice(arrayStart + 1) : output) as PackDryRunResult[];
  assert.ok(result, "npm pack did not return a package result");
  return result;
}

function assertCleanProbe(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.status, 0, `${result.stderr ?? ""}\n${result.error ?? ""}`);
  const lines = String(result.stdout).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { ok?: boolean }).ok, true);
  assert.doesNotMatch(String(result.stderr), /SQLite is an experimental feature|ExperimentalWarning/);
  assert.doesNotMatch(String(result.stderr), /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
}

function packFiles(): Set<string> {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const output = execFileSync(command, args, { cwd: packageRoot, encoding: "utf8" });
  const [result] = JSON.parse(output) as PackDryRunResult[];
  return new Set((result?.files ?? []).flatMap((file) => file.path ? [file.path] : []));
}

test("runtime broker package metadata exposes the supported Node, bin, and public subpath", () => {
  assert.equal(packageJson.engines?.node, ">=22.19.0");
  assert.equal(packageJson.bin?.["pi-teammate-broker"], "./bin/pi-teammate-broker.mjs");
  assert.deepEqual(packageJson.exports?.["./v2/runtime-broker"], {
    types: "./types/public/v2/runtime-broker.d.ts",
    default: "./src/public/v2/runtime-broker.ts",
  });
});

test("runtime broker package self-import exposes the stable client surface", async () => {
  const api = await import("pi-maestro-teammate/v2/runtime-broker");
  assert.equal(api.RUNTIME_BROKER_PROTOCOL, "pi.runtime-broker");
  assert.equal(typeof api.RuntimeBrokerClient.connect, "function");
  assert.equal(typeof api.createRuntimeActorHost, "function");
  assert.equal(typeof api.probeRuntimeBrokerCapability, "function");
  assert.equal(typeof api.createRuntimeTransport, "function");
});

test("runtime broker bin probe emits clean JSON without the SQLite ExperimentalWarning", () => {
  const result = spawnSync(process.execPath, [brokerBin, "probe", "--state-dir", packageRoot], {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assertCleanProbe(result);
});

test("packed install runs the runtime broker bin under supported Node without native TypeScript stripping", {
  timeout: packTimeout + installTimeout + 60_000,
}, () => {
  const tempBase = process.env.SystemDrive ? `${process.env.SystemDrive}\\tmp` : os.tmpdir();
  const root = path.join(tempBase, `pi-broker-pack-${process.pid}-${Date.now()}`);
  const consumer = path.join(root, "consumer");
  const stateDirectory = path.join(root, "state");
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  const cache = path.join(root, "npm-cache");
  for (const directory of [consumer, stateDirectory, home, prefix, cache]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  try {
    const packed = parsePackResult(npmRun(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
      packageRoot,
    ));
    assert.ok(packed.filename, "npm pack did not report a tarball filename");
    const tarball = path.join(root, packed.filename);
    assert.equal(fs.existsSync(tarball), true);

    fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    const installEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      npm_config_cache: cache,
      npm_config_prefix: prefix,
    };
    npmRun(
      ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
      consumer,
      installEnv,
      installTimeout,
    );

    const installedPackage = path.join(consumer, "node_modules", "pi-maestro-teammate");
    assert.equal(fs.lstatSync(installedPackage).isSymbolicLink(), false);
    const installedBin = path.join(
      consumer,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi-teammate-broker.cmd" : "pi-teammate-broker",
    );
    assert.equal(fs.existsSync(installedBin), true);

    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : installedBin;
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `${installedBin} probe --state-dir ${stateDirectory}`]
      : ["probe", "--state-dir", stateDirectory];
    assertCleanProbe(spawnSync(command, args, {
      cwd: consumer,
      env: installEnv,
      encoding: "utf8",
      windowsHide: true,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("npm pack includes the runtime broker bin, source facade, and declarations", () => {
  const files = packFiles();
  const required = [
    "bin/pi-teammate-broker.mjs",
    "src/public/v2/runtime-broker.ts",
    "types/public/v2/runtime-broker.d.ts",
    ...fs.readdirSync(path.join(packageRoot, "src", "runtime-broker"))
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [
        `src/runtime-broker/${file}`,
        `types/runtime-broker/${file.replace(/\.ts$/, ".d.ts")}`,
      ]),
  ];
  for (const file of required) assert.ok(files.has(file), `packed package is missing ${file}`);
});
