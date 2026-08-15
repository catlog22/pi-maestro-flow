import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { runSingleTeammate, sendRpcMessage } from "../src/runs/execution.ts";
import { forgetBackendRegistryConfigSync } from "../src/backends/registry-host.ts";

/**
 * The whole product path, with nothing injected.
 *
 * Every other test on this seam substitutes something: a fake driver, an
 * injected registry, a probe backend. This one substitutes nothing — a real
 * registration document selects `backend-registry`, the registry loads the dsh
 * module by specifier, that module drives a real runtime, and the host
 * addresses the running agent through the channel it is handed.
 *
 * That combination is where the seam's defects have actually lived: each piece
 * passed its own tests while the path between them was never walked.
 *
 * Self-skips unless a runtime is configured:
 *
 *   DSH_E2E_CORDIS=~/.dsh/smoke/cordis.yml \
 *   DSH_E2E_COMMAND=~/.dsh/smoke/node_modules/.bin/dsh-jsonrpc-agent \
 *   node --experimental-transform-types --import ./test/setup.ts \
 *     --test test/backend-registry-dsh.e2e.test.ts
 */

/** Expand a leading `~` so the documented invocation works from a shell. */
function expand(path: string): string {
  return path.startsWith("~/") ? resolve(process.env.HOME ?? "", path.slice(2)) : resolve(path);
}

const cordisConfig = process.env.DSH_E2E_CORDIS === undefined
  ? undefined
  : expand(process.env.DSH_E2E_CORDIS);
const command = process.env.DSH_E2E_COMMAND === undefined
  ? "dsh-jsonrpc-agent"
  : expand(process.env.DSH_E2E_COMMAND);

const skip = cordisConfig === undefined
  ? "DSH_E2E_CORDIS is unset"
  : existsSync(cordisConfig) ? undefined : `no runtime config at ${cordisConfig}`;

/**
 * A workspace that routes every task to dsh through the registry.
 *
 * The module specifier is the published subpath, not an in-process object, so
 * this exercises the loader and the module's default export — the two things
 * that made dsh unregisterable while every unit test passed.
 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-registry-e2e-"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", "prober.md"),
    "---\nname: prober\ndescription: \"backend seam probe\"\ntools:\n  - Read\n---\n\n# Prober\n",
    "utf-8",
  );
  writeFileSync(
    join(root, ".pi", "teammate-backends.json"),
    `${JSON.stringify({
      mode: "backend-registry",
      default: "dsh",
      backends: {
        dsh: {
          module: "pi-maestro-backends/dsh",
          config: {
            command,
            cordisConfig,
            cwd: resolve(cordisConfig!, ".."),
            requestTimeoutMs: 120_000,
          },
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  forgetBackendRegistryConfigSync(root);
  return root;
}

test("a registration document routes a real task to a real dsh runtime", { skip }, async () => {
  const root = workspace();
  const result = await runSingleTeammate(
    { agent: "prober", task: "Reply with exactly the word SEAM and nothing else." },
    { baseCwd: root, runtimeGeneration: 1 },
  );

  assert.equal(result.terminalStatus, "completed", result.messages[0]?.content);
  // Populated by the dispatch, so a result carries which backend served it.
  assert.equal(result.backend, "dsh");
  assert.match(result.messages[0]?.content ?? "", /SEAM/);
});

test("the host is handed a control channel it can address mid-run", { skip }, async () => {
  const root = workspace();
  let channel: Writable | undefined;
  let channelGeneration: number | undefined;
  let sent: boolean | undefined;

  const result = await runSingleTeammate(
    { agent: "prober", task: "Remember the number 41. Reply with just: OK" },
    {
      baseCwd: root,
      // The extension fences this callback on the agent's generation, so a
      // mismatch here means the channel is dropped and teammate-send reports
      // "no restorable runtime" for a runtime that is running.
      runtimeGeneration: 1,
      onChildSpawned: (stdin, _sendControl, _sessionDir, _childId, generation) => {
        channel = stdin;
        channelGeneration = generation;
        // Exactly what the extension's teammate-send does with agent.stdin.
        sent = sendRpcMessage(
          stdin,
          "Add one to the number you were asked to remember. Reply with the digits only.",
          "follow_up",
        );
      },
    },
  );

  assert.notEqual(channel, undefined, "no control channel reached the host");
  assert.equal(channelGeneration, 1, "the channel arrived under a generation the extension would reject");
  assert.equal(sent, true, "the host could not deliver a follow-up to a running backend agent");

  assert.equal(result.terminalStatus, "completed", result.messages[0]?.content);
  assert.equal(result.messages.length, 2, "the follow-up produced no second turn");
  // 42 is only derivable from the first turn's context, so this also proves the
  // follow-up continued the same session rather than starting a new one.
  assert.match(result.messages[1]?.content ?? "", /42/);
});
