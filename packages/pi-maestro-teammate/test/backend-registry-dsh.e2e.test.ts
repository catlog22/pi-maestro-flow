import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import {
  normalizeTeammateParams,
  runSingleTeammate,
  sendRpcMessage,
  singleRunParamsOf,
  type RunSingleTeammateParams,
} from "../src/runs/execution.ts";
import {
  registerTeammateChildToolBroker,
  type TeammateChildToolBrokerRequest,
} from "../src/runs/child-extensions.ts";
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
function workspace(extraConfig: Record<string, unknown> = {}): string {
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
            ...extraConfig,
          },
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  forgetBackendRegistryConfigSync(root);
  return root;
}

/**
 * Turn a request into run params the way the extension does.
 *
 * The two cases below that carry todos go through this rather than naming
 * `todos` themselves. Handing `runSingleTeammate` a field the product's own
 * projection never set is what let `spec.todos` stay undefined on every real
 * dispatch while these very cases passed.
 */
function requested(task: { agent: string; prompt: string; todo?: string | string[] }): RunSingleTeammateParams {
  const normalization = normalizeTeammateParams({ tasks: [task] });
  assert.equal(normalization.error, undefined, "the request did not survive normalization");
  const single = normalization.tasks[0]!;
  return singleRunParamsOf(single, { task: single.prompt });
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

test("a real dsh run reaches the host todo broker through the product path", { skip }, async () => {
  // Nothing is injected here, and that is the whole point: the backends-side
  // e2e supplies its own `host.proxyToolCall` and therefore never walks
  // `runSingleTeammate` → `backendOptionsOf` → `getTeammateChildToolBroker`.
  // That closure is built by the host, and only this path builds it.
  //
  // Nothing tells the model what the tool is called, either. The follow-up
  // below names no tool, so the only place the model can learn the name is the
  // instruction the product generates for a task carrying todos — which is the
  // half that did not exist while both real cases on this seam passed by
  // spelling `mcp__maestro_todo__todo` out in their own follow-up text.
  const root = workspace({ todoBridge: true });
  const seen: TeammateChildToolBrokerRequest[] = [];
  const release = registerTeammateChildToolBroker("todo", async (request) => {
    seen.push(request);
    return { content: [{ type: "text", text: JSON.stringify([{ id: "probe-1", status: "pending" }]) }] };
  });
  try {
    const result = await runSingleTeammate(
      requested({
        agent: "prober",
        // The work is asked for on a follow-up because the runtime accepts its
        // opening prompt before the mcp-client's tools are published, so a
        // turn-one request would fail this on a startup race rather than on
        // anything under test. The instruction itself rides the opening prompt.
        prompt: "Reply with exactly the word READY and nothing else.",
        todo: "probe-1",
      }),
      {
        baseCwd: root,
        runtimeGeneration: 1,
        onChildSpawned: (stdin) => {
          sendRpcMessage(
            stdin,
            "Now work the queue you were assigned, then reply with how many items it holds.",
            "follow_up",
          );
        },
      },
    );

    assert.equal(result.terminalStatus, "completed", result.messages.at(-1)?.content ?? "");
    assert.ok(
      seen.length >= 1,
      "the runtime never reached the host broker: with no tool name in the follow-up, "
      + "the model had only the product's own todo instruction to go on",
    );
    assert.equal(seen[0]!.toolName, "todo");
    // Identity, not merely arrival: the broker must see this attempt, because
    // the host's edit check decides what a teammate may write from the actor.
    assert.equal(seen[0]!.actor.correlationId, result.correlationId);
  } finally {
    release();
  }
});

test("a real registration without todoBridge refuses a task carrying todos", { skip }, async () => {
  // The other half of the fail-loud promise, on the path that skipped it. The
  // registration above only differs by `todoBridge`, so the capability table
  // this one publishes says `todoBinding: "unsupported"` — and a single
  // dispatch used to run it anyway, dropping the field in silence and settling
  // as a clean success that had never touched the queue.
  const root = workspace();
  const seen: TeammateChildToolBrokerRequest[] = [];
  const release = registerTeammateChildToolBroker("todo", async (request) => {
    seen.push(request);
    return { content: [{ type: "text", text: "[]" }] };
  });
  try {
    const result = await runSingleTeammate(
      requested({
        agent: "prober",
        prompt: "Reply with exactly the word SEAM and nothing else.",
        todo: "probe-1",
      }),
      { baseCwd: root, runtimeGeneration: 1 },
    );

    assert.equal(result.terminalStatus, "failed", result.messages.at(-1)?.content ?? "");
    assert.match(result.messages[0]?.content ?? "", /todoBinding/);
    assert.match(result.messages[0]?.content ?? "", /dsh/);
    // Rejected before the runtime was ever spawned: this case costs no model
    // call, which is the practical difference between adjudicating up front
    // and reporting the gap after a turn has already been paid for.
    assert.deepEqual(seen, [], "the run reached the host broker despite declaring no binding");
    assert.equal(result.usage.turns, 0, "a turn was paid for before the capability gap surfaced");
  } finally {
    release();
  }
});
