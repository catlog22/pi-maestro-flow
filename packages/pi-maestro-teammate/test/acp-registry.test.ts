import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRegistryTarget,
  findRegistryAgent,
  registryAgentChoices,
  resolveRegistryLaunch,
} from "../src/backends/acp-registry.ts";
import { ACP_REGISTRY_AGENTS } from "../src/backends/acp-registry-snapshot.ts";

/**
 * Resolving a registry agent id into a launch.
 *
 * The load-bearing case is the local preference: it decides which program runs,
 * so it must come from the package's own manifest and must fall back rather
 * than fail when nothing is installed.
 */

const runner = () => {
  const agent = ACP_REGISTRY_AGENTS.find((a) => a.launch.kind === "npx" && a.launch.bins.length > 0);
  assert.ok(agent, "snapshot must list an npx agent that declares a bin");
  return agent;
};

test("an installed copy wins over the package runner, and its arguments come with it", () => {
  const agent = runner();
  assert.equal(agent.launch.kind, "npx");
  const bin = agent.launch.kind === "npx" ? agent.launch.bins[0]! : "";

  const local = resolveRegistryLaunch(agent, { isExecutable: (command) => command === bin });
  assert.equal(local.source, "local");
  assert.equal(local.command, bin);
  // The package specifier is the runner's business; a local copy takes only the
  // arguments that follow the executable.
  assert.ok(!local.args.some((argument) => argument.includes("@")), local.args.join(" "));
  assert.ok(!local.args.includes("-y"));
});

test("nothing installed falls back to the runner rather than failing", () => {
  const agent = runner();
  const viaRunner = resolveRegistryLaunch(agent, { isExecutable: () => false });
  assert.equal(viaRunner.source, "runner");
  assert.equal(viaRunner.command, "npx");
  assert.equal(viaRunner.args[0], "-y");
});

test("only the manifest's own bin names are probed", () => {
  const agent = runner();
  const probed: string[] = [];
  resolveRegistryLaunch(agent, { isExecutable: (command) => (probed.push(command), false) });
  // Never the package name: `@google/gemini-cli` installs `gemini`, so deriving
  // a candidate from the specifier would probe — and could find — the wrong one.
  assert.deepEqual(probed, agent.launch.kind === "npx" ? [...agent.launch.bins] : []);
});

test("a binary agent contributes arguments for this machine and leaves the executable to the operator", () => {
  const cursor = findRegistryAgent("cursor");
  assert.ok(cursor, "snapshot must list cursor");
  const resolved = resolveRegistryLaunch(cursor, { target: "darwin-aarch64" });
  assert.equal(resolved.source, "operator");
  assert.equal(resolved.command, undefined);
  assert.deepEqual([...resolved.args], ["acp"]);

  // Kept per target because they genuinely differ: this one passes `--uid=` on
  // Linux only, so collapsing them would state the wrong arguments somewhere.
  const antigravity = findRegistryAgent("antigravity-acp");
  if (antigravity && antigravity.launch.kind === "binary") {
    assert.notDeepEqual(
      antigravity.launch.argsByTarget["linux-x86_64"],
      antigravity.launch.argsByTarget["darwin-aarch64"],
    );
  }
});

test("a machine the registry names no binary for is refused, naming what it does list", () => {
  const cursor = findRegistryAgent("cursor")!;
  assert.throws(
    () => resolveRegistryLaunch(cursor, { target: "solaris-sparc" }),
    (error: Error) => error.message.includes("solaris-sparc") && error.message.includes("darwin-aarch64"),
  );
});

test("platform targets are named the way upstream names them", () => {
  assert.equal(currentRegistryTarget("darwin", "arm64"), "darwin-aarch64");
  assert.equal(currentRegistryTarget("linux", "x64"), "linux-x86_64");
  assert.equal(currentRegistryTarget("win32", "x64"), "windows-x86_64");
  // Unknown rather than guessed: a wrong target would silently pick another
  // platform's arguments.
  assert.equal(currentRegistryTarget("aix", "ppc64"), undefined);
});

test("the snapshot offers every listed agent, saying how each is distributed", () => {
  const choices = registryAgentChoices();
  assert.equal(choices.length, ACP_REGISTRY_AGENTS.length);
  assert.ok(choices.length > 20, `snapshot looks truncated: ${choices.length}`);
  const cursor = choices.find((choice) => choice.value === "cursor");
  assert.match(cursor?.description ?? "", /platform binary/);
  const gemini = choices.find((choice) => choice.value === "gemini");
  assert.match(gemini?.description ?? "", /npx/);
});
