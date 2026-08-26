import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teammateRoot = resolve(packageRoot, "..", "pi-maestro-teammate");
const cockpitRoot = resolve(packageRoot, "..", "pi-cockpit");
const flowPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const piSdkVersion = flowPackage.devDependencies["@earendil-works/pi-coding-agent"];
const require = createRequire(import.meta.url);
const npmCommand = [process.execPath, process.env.npm_execpath ?? require.resolve("npm/bin/npm-cli.js")];
const ffiPackage = JSON.parse(readFileSync(require.resolve("ffi-rs/package.json"), "utf8"));
const nativeRuntimePackages = currentNativeRuntimePackages();

const packTimeout = 360_000;
const installTimeout = 600_000;
const testTimeout = packTimeout * 3 + installTimeout + 180_000;

test("packed Flow worker loads Todo projection capability through the public Teammate subpath", { timeout: testTimeout }, () => {
  const base = process.env.SystemDrive ? `${process.env.SystemDrive}\\tmp` : tmpdir();
  const root = join(base, `pmf-${process.pid}-${Date.now()}`);
  const consumer = join(root, "consumer");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  for (const path of [consumer, workspace, home, prefix]) mkdirSync(path, { recursive: true });

  try {
    const teammatePack = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      teammateRoot,
      process.env,
      packTimeout,
    ).stdout);
    const cockpitPack = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      cockpitRoot,
      process.env,
      packTimeout,
    ).stdout);
    const flowPack = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      packageRoot,
      process.env,
      packTimeout,
    ).stdout);
    const teammateTarball = join(root, teammatePack[0].filename);
    const cockpitTarball = join(root, cockpitPack[0].filename);
    const flowTarball = join(root, flowPack[0].filename);
    assert.equal(existsSync(teammateTarball), true);
    assert.equal(existsSync(cockpitTarball), true);
    assert.equal(existsSync(flowTarball), true);
    assert.ok(teammatePack[0].files.some(({ path }) => path === "src/public/v1/workspace-projections.ts"));
    assert.ok(teammatePack[0].files.some(({ path }) => path === "types/public/v1/workspace-projections.d.ts"));

    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      npm_config_prefix: prefix,
    };
    run(npmCommand, [
      "install",
      teammateTarball,
      cockpitTarball,
      flowTarball,
      `@earendil-works/pi-agent-core@${piSdkVersion}`,
      `@earendil-works/pi-ai@${piSdkVersion}`,
      `@earendil-works/pi-coding-agent@${piSdkVersion}`,
      `@earendil-works/pi-tui@${piSdkVersion}`,
      ...nativeRuntimePackages,
      "--omit=optional",
      "--no-audit",
      "--no-fund",
    ], consumer, env, installTimeout);

    const installedFlow = join(consumer, "node_modules", "pi-maestro-flow");
    const installedTeammate = join(consumer, "node_modules", "pi-maestro-teammate");
    assert.equal(existsSync(join(installedFlow, "src", "extension", "index.ts")), true);
    assert.equal(existsSync(join(installedTeammate, "src", "public", "v1", "workspace-projections.ts")), true);
    assert.equal(existsSync(join(installedTeammate, "types", "public", "v1", "workspace-projections.d.ts")), true);

    const evidencePath = join(consumer, "flow-todo-probe.json");
    const verifierPath = join(consumer, "verify-flow-todo.mjs");
    writeFileSync(verifierPath, `import { writeFileSync } from "node:fs";
import { getWorkspaceProjectionProvider } from "pi-maestro-teammate/v1/workspace-projections";
export default function register(pi) {
  pi.on("session_start", () => {
    writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({
      tools: pi.getAllTools().map((tool) => tool.name),
      todoProvider: getWorkspaceProjectionProvider("todo") !== undefined,
    }));
  });
}
`);
    const piCommand = [
      process.execPath,
      join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    ];
    const runtimeEnv = {
      ...env,
      PI_TEAMMATE_MANAGED_WINDOW: "1",
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
    delete runtimeEnv.PI_TEAMMATE_CHILD;
    run(piCommand, [
      "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
      "--no-context-files",
      "--extension", join(installedFlow, "src", "extension", "index.ts"),
      "--extension", verifierPath,
    ], workspace, runtimeEnv, 90_000, `${JSON.stringify({ id: "state", type: "get_state" })}\n`);

    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.ok(evidence.tools.includes("todo"), evidence.tools.join(","));
    assert.ok(evidence.tools.includes("flow-schedule"), evidence.tools.join(","));
    assert.equal(evidence.todoProvider, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function currentNativeRuntimePackages() {
  const fffVersion = flowPackage.dependencies["@ff-labs/fff-node"];
  const arch = process.arch;
  let ffiSuffix;
  let fffSuffix;
  if (process.platform === "win32" && ["x64", "arm64"].includes(arch)) {
    ffiSuffix = `win32-${arch}-msvc`;
    fffSuffix = `win32-${arch}`;
  } else if (process.platform === "darwin" && ["x64", "arm64"].includes(arch)) {
    ffiSuffix = `darwin-${arch}`;
    fffSuffix = `darwin-${arch}`;
  } else if (process.platform === "linux" && ["x64", "arm64"].includes(arch)) {
    const libc = process.report?.getReport().header.glibcVersionRuntime ? "gnu" : "musl";
    ffiSuffix = `linux-${arch}-${libc}`;
    fffSuffix = `linux-${arch}-${libc}`;
  } else if (process.platform === "android" && arch === "arm64") {
    ffiSuffix = "android-arm64";
    fffSuffix = "android-arm64";
  } else {
    throw new Error(`packed Flow test does not support ${process.platform}/${arch}`);
  }
  return [
    `@yuuang/ffi-rs-${ffiSuffix}@${ffiPackage.version}`,
    `@ff-labs/fff-bin-${fffSuffix}@${fffVersion}`,
  ];
}

function parseTrailingJson(stdout) {
  const arrayStart = stdout.lastIndexOf("\n[");
  return JSON.parse(arrayStart >= 0 ? stdout.slice(arrayStart + 1) : stdout);
}

function run(command, args, cwd, env = process.env, timeout = 60_000, input) {
  const [file, ...prefix] = Array.isArray(command) ? command : [command];
  const argv = [...prefix, ...args];
  const result = spawnSync(file, argv, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    shell: false,
  });
  assert.equal(
    result.status,
    0,
    `${file} ${argv.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${result.error ?? ""}`,
  );
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
