import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localMaestroRoot = process.env.MAESTRO_SOURCE_DIR
  ? resolve(process.env.MAESTRO_SOURCE_DIR)
  : resolve(packageRoot, "..", "..", "..", "maestro2");
const localTeammateRoot = resolve(packageRoot, "..", "pi-maestro-teammate");
const require = createRequire(import.meta.url);
const npmCommand = [process.execPath, process.env.npm_execpath ?? require.resolve("npm/bin/npm-cli.js")];
const piCli = resolve(
  packageRoot,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const piCommand = [process.execPath, piCli];

test("packed consumer completes Session/Run lifecycle and loads in a fresh Pi process", { timeout: 360_000 }, () => {
  const shortTempRoot = process.env.SystemDrive ? `${process.env.SystemDrive}\\tmp` : tmpdir();
  const root = join(shortTempRoot, `pme-${process.pid}-${Date.now()}`);
  const consumer = join(root, "consumer");
  const workflowRoot = join(root, "workflow");
  const maestroHome = join(root, "maestro-home");
  const installHome = join(root, "install-home");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(workflowRoot, { recursive: true });
  mkdirSync(maestroHome, { recursive: true });
  mkdirSync(installHome, { recursive: true });

  try {
    const localMaestroPackage = JSON.parse(readFileSync(join(localMaestroRoot, "package.json"), "utf8"));
    const localMaestroCli = join(localMaestroRoot, "bin", "maestro.js");
    assert.match(run([process.execPath, localMaestroCli], ["run", "create", "--help"], workflowRoot).stdout, /--workflow-root/);

    const packed = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      packageRoot,
    ).stdout);
    const tarball = join(root, packed[0].filename);
    assert.equal(existsSync(tarball), true);

    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    const installEnv = {
      ...process.env,
      HOME: installHome,
      USERPROFILE: installHome,
      MAESTRO_HOME: maestroHome,
    };
    run(
      npmCommand,
      ["link", localMaestroRoot, localTeammateRoot, "--save", "--no-audit", "--no-fund"],
      consumer,
      installEnv,
      120_000,
    );
    run(
      npmCommand,
      ["install", tarball, "--no-audit", "--no-fund"],
      consumer,
      installEnv,
      240_000,
    );

    const installed = join(consumer, "node_modules", "pi-maestro-flow");
    const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(
      installedPackage.dependencies["maestro-flow"],
      "https://codeload.github.com/catlog22/maestro-flow/tar.gz/84ae24f8ed9a12cac3b5c69ea3428840a0a58e1b",
    );
    const installedMaestro = join(consumer, "node_modules", "maestro-flow");
    const installedTeammate = join(consumer, "node_modules", "pi-maestro-teammate");
    assert.equal(lstatSync(installedMaestro).isSymbolicLink(), true);
    assert.equal(lstatSync(installedTeammate).isSymbolicLink(), true);
    assert.equal(
      JSON.parse(readFileSync(join(installedMaestro, "package.json"), "utf8")).version,
      localMaestroPackage.version,
    );
    assert.equal(existsSync(join(installed, ".pi", "skills", "workflow-skill-designer", "SKILL.md")), true);
    assert.equal(existsSync(join(installed, "src", "extension", "index.ts")), true);

    const prepareDir = join(maestroHome, "prepare");
    mkdirSync(prepareDir, { recursive: true });
    for (const stage of ["analyze", "plan", "execute", "verify"]) {
      writeFileSync(join(prepareDir, `${stage}.md`), prepareSource(stage));
    }

    const maestroCommand = [process.execPath, join(installedMaestro, "bin", "maestro.js")];
    const cliEnv = { ...process.env, MAESTRO_HOME: maestroHome };
    assert.match(run(maestroCommand, ["run", "create", "--help"], workflowRoot, cliEnv).stdout, /--workflow-root/);
    let sessionId = "";
    const createStage = (stage) => {
      const args = ["run", "create", stage, "--workflow-root", workflowRoot];
      if (sessionId) args.push("--session", sessionId);
      else args.push("--intent", "packed consumer lifecycle");
      const created = JSON.parse(run(maestroCommand, args, workflowRoot, cliEnv).stdout);
      sessionId ||= created.session_id;
      const runDir = resolve(workflowRoot, created.run_dir);
      mkdirSync(join(runDir, "outputs"), { recursive: true });
      writeFileSync(join(runDir, "outputs", `${stage}.json`), `${JSON.stringify({ stage, status: "passed" })}\n`);
      return created;
    };
    const completeStage = (stage, created) => {
      const completed = JSON.parse(run(
        maestroCommand,
        ["run", "complete", created.run_id, "--session", sessionId, "--workflow-root", workflowRoot],
        workflowRoot,
        cliEnv,
      ).stdout);
      assert.equal(completed.status, "sealed", stage);
      assert.equal(completed.sealed, true, stage);
    };
    for (const stage of ["analyze", "plan"]) {
      completeStage(stage, createStage(stage));
    }

    const executeRun = createStage("execute");
    const extensionPath = join(installed, "src", "extension", "index.ts");
    const runtimeEnv = {
      ...installEnv,
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
    const rpc = run(
      piCommand,
      [
        "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
        "--no-context-files", "--extension", extensionPath,
      ],
      workflowRoot,
      runtimeEnv,
      45_000,
      `${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "messages", type: "get_messages" })}\n`,
    );
    const messages = rpc.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(messages.some((message) => message.id === "state" && message.type === "response"), rpc.stdout);
    const messageResponse = messages.find((message) => message.id === "messages" && message.type === "response");
    assert.ok(messageResponse, rpc.stdout);
    const attachEvidence = JSON.stringify(messageResponse);
    assert.match(attachEvidence, /workflow-attach/);
    assert.match(attachEvidence, new RegExp(sessionId));
    assert.match(attachEvidence, new RegExp(executeRun.run_id));
    assert.match(attachEvidence, /"todoId":"[^"]+"/);
    assert.match(attachEvidence, /"nextAction":"[^"]+"/);

    completeStage("execute", executeRun);
    completeStage("verify", createStage("verify"));
    const sealed = JSON.parse(run(
      maestroCommand,
      ["run", "seal-session", sessionId, "--summary", "packed E2E", "--workflow-root", workflowRoot],
      workflowRoot,
      cliEnv,
    ).stdout);
    assert.equal(sealed.status, "sealed");
    const session = JSON.parse(readFileSync(join(workflowRoot, ".workflow", "sessions", sessionId, "session.json"), "utf8"));
    assert.equal(session.status, "sealed");
    assert.equal(session.latest_completed_run_id.endsWith("verify"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareSource(stage) {
  return `---\nname: ${stage}\nsession-mode: run\ncontract:\n  produces:\n    - { path: outputs/${stage}.json, kind: ${stage}, alias: current-${stage}, role: primary }\ngates: []\n---\n# ${stage}\n`;
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
