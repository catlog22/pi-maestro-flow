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
const localTeammateRoot = resolve(packageRoot, "..", "pi-maestro-teammate");
const localSettingsCoreRoot = resolve(packageRoot, "..", "pi-maestro-settings-core");
const localCockpitRoot = resolve(packageRoot, "..", "pi-cockpit");
const localFlowPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const localTeammatePackage = JSON.parse(readFileSync(join(localTeammateRoot, "package.json"), "utf8"));
const localSettingsCorePackage = JSON.parse(readFileSync(join(localSettingsCoreRoot, "package.json"), "utf8"));
const localCockpitPackage = JSON.parse(readFileSync(join(localCockpitRoot, "package.json"), "utf8"));
const piSdkVersion = localFlowPackage.devDependencies["@earendil-works/pi-coding-agent"];
const piCodingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCodingAgentPackage = JSON.parse(readFileSync(
  resolve(dirname(piCodingAgentEntry), "..", "package.json"),
  "utf8",
));
const teammatePublicSpecifiers = [
  "pi-maestro-teammate",
  "pi-maestro-teammate/v1",
  "pi-maestro-teammate/v1/agents",
  "pi-maestro-teammate/v1/child-extensions",
  "pi-maestro-teammate/v1/events",
  "pi-maestro-teammate/v1/workspace-projections",
  "pi-maestro-teammate/v1/execution",
  "pi-maestro-teammate/v1/extension",
  "pi-maestro-teammate/v1/model-routing",
  "pi-maestro-teammate/v1/progress-tree",
  "pi-maestro-teammate/v1/retry",
  "pi-maestro-teammate/v1/types",
];
const require = createRequire(import.meta.url);
const npmCommand = [process.execPath, process.env.npm_execpath ?? require.resolve("npm/bin/npm-cli.js")];
const packTimeout = 360_000;
const installTimeout = 600_000;
const testTimeout = packTimeout * 4 + installTimeout + 600_000;

test("packed consumer installs real tarballs and loads in a fresh Pi process", { timeout: testTimeout }, () => {
  const shortTempRoot = process.env.SystemDrive ? `${process.env.SystemDrive}\\tmp` : tmpdir();
  const root = join(shortTempRoot, `pme-${process.pid}-${Date.now()}`);
  const consumer = join(root, "consumer");
  const workflowRoot = join(root, "workflow");
  const maestroHome = join(root, "maestro-home");
  const installHome = join(root, "install-home");
  const npmPrefix = join(root, "npm-prefix");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(workflowRoot, { recursive: true });
  mkdirSync(maestroHome, { recursive: true });
  mkdirSync(installHome, { recursive: true });
  mkdirSync(npmPrefix, { recursive: true });

  try {
    const settingsCorePacked = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      localSettingsCoreRoot,
      process.env,
      packTimeout,
    ).stdout);
    const cockpitPacked = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      localCockpitRoot,
      process.env,
      packTimeout,
    ).stdout);
    const teammatePacked = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      localTeammateRoot,
      process.env,
      packTimeout,
    ).stdout);
    const flowPacked = parseTrailingJson(run(
      npmCommand,
      ["pack", "--json", "--pack-destination", root],
      packageRoot,
      process.env,
      packTimeout,
    ).stdout);
    const settingsCoreTarball = join(root, settingsCorePacked[0].filename);
    const cockpitTarball = join(root, cockpitPacked[0].filename);
    const teammateTarball = join(root, teammatePacked[0].filename);
    const flowTarball = join(root, flowPacked[0].filename);
    assert.equal(existsSync(settingsCoreTarball), true);
    assert.equal(existsSync(cockpitTarball), true);
    assert.equal(existsSync(teammateTarball), true);
    assert.equal(existsSync(flowTarball), true);
    assert.equal(settingsCorePacked[0].version, localSettingsCorePackage.version);
    assert.equal(cockpitPacked[0].version, localCockpitPackage.version);
    assert.equal(teammatePacked[0].version, localTeammatePackage.version);
    assert.equal(flowPacked[0].version, localFlowPackage.version);
    assert.ok(settingsCorePacked[0].files.some(({ path }) => path === "src/public/v1/index.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "src/index.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "src/public/v1/execution.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "src/public/v1/workspace-projections.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "types/index.d.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "types/public/v1/execution.d.ts"));
    assert.ok(teammatePacked[0].files.some(({ path }) => path === "types/public/v1/workspace-projections.d.ts"));

    // pi loads packages with separate module roots, so the shared settings-core
    // protocol must be bundled inside each plugin tarball (packages.md). npm
    // pack stores bundled deps under package/node_modules/...
    for (const [label, tarball] of [
      ["flow", flowTarball],
      ["cockpit", cockpitTarball],
      ["teammate", teammateTarball],
    ]) {
      const entries = tarList(tarball);
      assert.ok(
        entries.some((entry) => entry.startsWith("package/node_modules/pi-maestro-settings-core/")),
        `${label} tarball must bundle node_modules/pi-maestro-settings-core`,
      );
    }

    verifyStandaloneCockpit({
      consumer: join(root, "cockpit-standalone"),
      workflowRoot: join(root, "cockpit-workflow"),
      installHome: join(root, "cockpit-home"),
      npmPrefix: join(root, "cockpit-npm-prefix"),
      settingsCoreTarball,
      cockpitTarball,
      piSdkVersion,
      npmCommand,
    });

    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
    const installEnv = {
      ...process.env,
      HOME: installHome,
      USERPROFILE: installHome,
      MAESTRO_HOME: maestroHome,
      npm_config_prefix: npmPrefix,
    };
    run(
      npmCommand,
      [
        "install",
        settingsCoreTarball,
        cockpitTarball,
        teammateTarball,
        flowTarball,
        `@earendil-works/pi-agent-core@${piSdkVersion}`,
        `@earendil-works/pi-ai@${piSdkVersion}`,
        `@earendil-works/pi-coding-agent@${piSdkVersion}`,
        `@earendil-works/pi-tui@${piSdkVersion}`,
        `@types/cross-spawn@${localFlowPackage.devDependencies["@types/cross-spawn"]}`,
        `@types/node@${piCodingAgentPackage.devDependencies["@types/node"]}`,
        `typescript@${piCodingAgentPackage.devDependencies.typescript}`,
        "--no-audit",
        "--no-fund",
      ],
      consumer,
      installEnv,
      installTimeout,
    );

    const installed = join(consumer, "node_modules", "pi-maestro-flow");
    const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(installedPackage.version, localFlowPackage.version);
    assert.equal(
      installedPackage.dependencies["maestro-flow"],
      localFlowPackage.dependencies["maestro-flow"],
    );
    assert.equal(installedPackage.dependencies["pi-maestro-settings-core"], localSettingsCorePackage.version);
    assert.equal(installedPackage.dependencies["pi-maestro-teammate"], localTeammatePackage.version);
    const installedMaestro = join(consumer, "node_modules", "maestro-flow");
    const installedSettingsCore = join(consumer, "node_modules", "pi-maestro-settings-core");
    const installedCockpit = join(consumer, "node_modules", "pi-cockpit");
    const installedTeammate = join(consumer, "node_modules", "pi-maestro-teammate");
    const installedSmartSearch = join(consumer, "node_modules", "@konbakuyomu", "smart-search");
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    assert.equal(lstatSync(installedMaestro).isSymbolicLink(), false);
    assert.equal(lstatSync(installedSettingsCore).isSymbolicLink(), false);
    assert.equal(JSON.parse(readFileSync(join(installedSettingsCore, "package.json"), "utf8")).version, localSettingsCorePackage.version);
    assert.equal(lstatSync(installedCockpit).isSymbolicLink(), false);
    const installedCockpitPackage = JSON.parse(readFileSync(join(installedCockpit, "package.json"), "utf8"));
    assert.equal(installedCockpitPackage.version, localCockpitPackage.version);
    assert.equal(installedCockpitPackage.dependencies["pi-maestro-settings-core"], localSettingsCorePackage.version);
    assert.equal(lstatSync(installedTeammate).isSymbolicLink(), false);
    const installedTeammatePackage = JSON.parse(readFileSync(join(installedTeammate, "package.json"), "utf8"));
    assert.equal(installedTeammatePackage.version, localTeammatePackage.version);
    assert.equal(installedTeammatePackage.dependencies["cross-spawn"], "7.0.6");
    assert.equal(installedTeammatePackage.dependencies["pi-maestro-settings-core"], localSettingsCorePackage.version);
    assert.equal(installedTeammatePackage.types, "./types/index.d.ts");
    assert.equal(existsSync(installedSmartSearch), true, "the source-pinned Smart Search optional dependency must install");
    assert.match(
      readFileSync(join(installedSmartSearch, "src", "smart_search", "config.py"), "utf8"),
      /SMART_SEARCH_INTENT_ROUTER/,
    );
    const smartSearchRegressionOutput = run(
      [process.execPath, join(installedSmartSearch, "npm", "bin", "smart-search.js")],
      ["regression"],
      consumer,
      installEnv,
      180_000,
    ).stdout;
    const smartSearchRegression = JSON.parse(smartSearchRegressionOutput.slice(smartSearchRegressionOutput.indexOf("{")));
    assert.equal(smartSearchRegression.ok, true);
    assert.equal(smartSearchRegression.mode, "mock");
    assert.equal(existsSync(join(installed, ".pi", "skills", "workflow-skill-designer", "SKILL.md")), true);
    assert.equal(existsSync(join(installed, "src", "extension", "index.ts")), true);
    const extensionPath = join(installed, "src", "extension", "index.ts");
    const piCommand = [
      process.execPath,
      join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    ];
    const runtimeEnv = {
      ...installEnv,
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
    const runtimeProbePath = join(consumer, "teammate-runtime-probe.json");
    const runtimeVerifierPath = join(consumer, "verify-teammate-runtime.ts");
    writeFileSync(
      runtimeVerifierPath,
      `${teammatePublicSpecifiers
        .map((specifier, index) => `import * as publicApi${index} from ${JSON.stringify(specifier)};`)
        .join("\n")}
import { writeFileSync } from "node:fs";
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
const specifiers = ${JSON.stringify(teammatePublicSpecifiers)};
const loaded = [${teammatePublicSpecifiers.map((_, index) => `publicApi${index}`).join(", ")}]
  .map((publicApi) => Object.keys(publicApi).length);
const refreshProbe = {
  runtime: { refreshed: 0 },
  async refresh() {
    this.runtime.refreshed++;
  },
};
export default function register(pi) {
  pi.on("session_start", async () => {
    await refreshModelRegistry({ modelRegistry: refreshProbe });
    writeFileSync(${JSON.stringify(runtimeProbePath)}, JSON.stringify({
      specifiers,
      loaded,
      refreshModelRegistry: typeof refreshModelRegistry,
      refreshCalls: refreshProbe.runtime.refreshed,
    }));
  });
}
`,
    );
    run(
      piCommand,
      [
        "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
        "--no-context-files", "--extension", runtimeVerifierPath,
      ],
      workflowRoot,
      runtimeEnv,
      45_000,
      `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
    );
    const runtimeProbe = JSON.parse(readFileSync(runtimeProbePath, "utf8"));
    assert.deepEqual(runtimeProbe.specifiers, teammatePublicSpecifiers);
    assert.equal(runtimeProbe.loaded.length, teammatePublicSpecifiers.length);
    assert.equal(runtimeProbe.refreshModelRegistry, "function");
    assert.equal(runtimeProbe.refreshCalls, 1);
    assert.match(
      run(
        [process.execPath],
        [
          "--input-type=module",
          "--eval",
          "console.log(import.meta.resolve('pi-maestro-teammate/v1/execution'))",
        ],
        consumer,
        installEnv,
      ).stdout,
      /pi-maestro-teammate[\\/]src[\\/]public[\\/]v1[\\/]execution\.ts$/,
    );

    const typeFixture = join(consumer, "teammate-public-api.mts");
    writeFileSync(
      typeFixture,
      `${teammatePublicSpecifiers
        .map((specifier, index) => `import * as publicApi${index} from ${JSON.stringify(specifier)};`)
        .join("\n")}
import { refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
void [${teammatePublicSpecifiers.map((_, index) => `publicApi${index}`).join(", ")}, refreshModelRegistry];
`,
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          resolveJsonModule: true,
          types: ["node"],
        },
        files: ["teammate-public-api.mts"],
      }, null, 2)}\n`,
    );
    const typeResolution = run(
      [process.execPath],
      [
        join(consumer, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.json",
        "--noEmit",
        "--traceResolution",
        "--listFilesOnly",
        "--pretty",
        "false",
      ],
      consumer,
      installEnv,
    );
    const normalizedTypeResolution = typeResolution.stdout.replaceAll("\\", "/").toLowerCase();
    assert.match(normalizedTypeResolution, /pi-maestro-teammate\/types\/public\/v1\/execution\.d\.ts/);
    assert.match(normalizedTypeResolution, /pi-maestro-teammate\/types\/public\/v1\/workspace-projections\.d\.ts/);
    assert.doesNotMatch(normalizedTypeResolution, /pi-maestro-teammate\/src\/.*\.ts/);

    const childToolsPath = join(consumer, "child-tools.json");
    const childVerifierPath = join(consumer, "verify-child-tools.mjs");
    writeFileSync(childVerifierPath, `import { writeFileSync } from "node:fs";
export default function register(pi) {
  pi.on("session_start", () => {
    writeFileSync(${JSON.stringify(childToolsPath)}, JSON.stringify(pi.getAllTools().map((tool) => tool.name)));
  });
}
`);
    run(
      piCommand,
      [
        "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
        "--no-context-files", "--extension", extensionPath, "--extension", childVerifierPath,
      ],
      workflowRoot,
      { ...runtimeEnv, PI_TEAMMATE_CHILD: "1" },
      45_000,
      `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
    );
    const childTools = JSON.parse(readFileSync(childToolsPath, "utf8"));
    assert.ok(childTools.includes("ask-user-question"), childTools.join(","));
    assert.ok(childTools.includes("todo"), childTools.join(","));
    assert.ok(childTools.includes("flow-schedule"), childTools.join(","));
    assert.equal(childTools.includes("goal"), false, childTools.join(","));
    assert.equal(childTools.includes("run-control"), false, childTools.join(","));
    const smoke = run(
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
    const smokeMessages = smoke.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(smokeMessages.some((message) => message.id === "state" && message.type === "response"), smoke.stdout);
    assert.ok(smokeMessages.some((message) => message.id === "messages" && message.type === "response"), smoke.stdout);

    const maestroRuntimeEntry = join(installedMaestro, "dist", "src", "utils", "wasm-relaunch.js");
    assert.equal(
      existsSync(maestroRuntimeEntry),
      true,
      "the exact Maestro registry dependency must include dist/src/utils/wasm-relaunch.js before consumer installation",
    );

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
    assert.doesNotMatch(
      JSON.stringify(messageResponse),
      /workflow-attach/,
      "a fresh packed Pi session must not implicitly opt into an active Workflow",
    );

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

function verifyStandaloneCockpit({
  consumer,
  workflowRoot,
  installHome,
  npmPrefix,
  settingsCoreTarball,
  cockpitTarball,
  piSdkVersion,
  npmCommand,
}) {
  for (const directory of [consumer, workflowRoot, installHome, npmPrefix]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
  const env = {
    ...process.env,
    HOME: installHome,
    USERPROFILE: installHome,
    npm_config_prefix: npmPrefix,
  };
  run(
    npmCommand,
    [
      "install",
      settingsCoreTarball,
      cockpitTarball,
      `@earendil-works/pi-agent-core@${piSdkVersion}`,
      `@earendil-works/pi-ai@${piSdkVersion}`,
      `@earendil-works/pi-coding-agent@${piSdkVersion}`,
      `@earendil-works/pi-tui@${piSdkVersion}`,
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
    env,
    installTimeout,
  );

  const installedCockpit = join(consumer, "node_modules", "pi-cockpit");
  assert.equal(existsSync(installedCockpit), true);
  assert.equal(
    existsSync(join(consumer, "node_modules", "pi-maestro-teammate")),
    false,
    "standalone Cockpit must load without installing its optional Teammate peer",
  );
  const piCommand = [
    process.execPath,
    join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ];
  const smoke = run(
    piCommand,
    [
      "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
      "--no-context-files", "--extension", join(installedCockpit, "src", "extension", "index.ts"),
    ],
    workflowRoot,
    {
      ...env,
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
    45_000,
    `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
  );
  const messages = smoke.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(messages.some((message) => message.id === "state" && message.type === "response"), smoke.stdout);
}

function prepareSource(stage) {
  return `---\nname: ${stage}\nsession-mode: run\ncontract:\n  produces:\n    - { path: outputs/${stage}.json, kind: ${stage}, alias: current-${stage}, role: primary }\ngates: []\n---\n# ${stage}\n`;
}

function parseTrailingJson(stdout) {
  const arrayStart = stdout.lastIndexOf("\n[");
  return JSON.parse(arrayStart >= 0 ? stdout.slice(arrayStart + 1) : stdout);
}

function tarList(tarball) {
  const args = process.platform === "win32"
    ? ["--force-local", "-tzf", tarball]
    : ["-tzf", tarball];
  const result = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(result.status, 0, `tar ${args.slice(0, -1).join(" ")} failed for ${tarball}: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
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
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${file} ${argv.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${result.error ?? ""}`,
  );
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
