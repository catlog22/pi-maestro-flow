import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teammateRoot = resolve(packageRoot, "..", "pi-maestro-teammate");
const require = createRequire(import.meta.url);
const npmCommand = [process.execPath, process.env.npm_execpath ?? require.resolve("npm/bin/npm-cli.js")];
const packTimeout = 360_000;
const installTimeout = 600_000;
const testTimeout = packTimeout * 2 + installTimeout + 120_000;

test("packed child Pi discovers shared Todo without root-only lifecycle tools", { timeout: testTimeout }, () => {
  const base = process.env.SystemDrive ? `${process.env.SystemDrive}\\tmp` : tmpdir();
  const root = join(base, `pmt-${process.pid}-${Date.now()}`);
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
    const flowPack = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      packageRoot,
      process.env,
      packTimeout,
    ).stdout);
    const teammateTarball = join(root, teammatePack[0].filename);
    const flowTarball = join(root, flowPack[0].filename);
    assert.equal(existsSync(teammateTarball), true);
    assert.equal(existsSync(flowTarball), true);

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
      flowTarball,
      "@earendil-works/pi-coding-agent@0.74.0",
      "--no-audit",
      "--no-fund",
    ], consumer, env, installTimeout);

    const installedFlow = join(consumer, "node_modules", "pi-maestro-flow");
    const installedTeammate = join(consumer, "node_modules", "pi-maestro-teammate");
    assert.equal(lstatSync(installedFlow).isSymbolicLink(), false);
    assert.equal(lstatSync(installedTeammate).isSymbolicLink(), false);

    const evidencePath = join(consumer, "child-tools.json");
    const verifierPath = join(consumer, "verify-child-tools.mjs");
    writeFileSync(verifierPath, `import { writeFileSync } from "node:fs";
export default function register(pi) {
  pi.on("session_start", () => {
    writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify(pi.getAllTools().map((tool) => tool.name)));
  });
}
`);
    const piCommand = [
      process.execPath,
      join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    ];
    const runtimeEnv = {
      ...env,
      PI_TEAMMATE_CHILD: "1",
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
    run(piCommand, [
      "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
      "--no-context-files",
      "--extension", join(installedFlow, "src", "extension", "index.ts"),
      "--extension", verifierPath,
    ], workspace, runtimeEnv, 45_000, `${JSON.stringify({ id: "state", type: "get_state" })}\n`);

    const tools = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.ok(tools.includes("ask-user-question"), tools.join(","));
    assert.ok(tools.includes("todo"), tools.join(","));
    assert.equal(tools.includes("goal"), false, tools.join(","));
    assert.equal(tools.includes("run-control"), false, tools.join(","));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
