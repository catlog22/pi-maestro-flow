import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelList,
  renderLegacyUpgradeSkeleton,
  renderModelList,
  runLegacyPreviewFlow,
  type ModelCliRow,
} from "../src/models/cli-list.ts";
import {
  createModelsCliTranslator,
  MODELS_CLI_CATALOGS,
  parseModelsCliLocale,
} from "../src/models/cli-i18n.ts";
import { main } from "../src/models/cli.ts";
import { TUI_TRANSLATION_CATALOGS, checkTuiCatalogCompleteness } from "../src/tui/locale.ts";
import {
  createReadlineEditIO,
  EditAborted,
  EditCancelled,
  parseConfigFieldInput,
  runEditFlow,
  EDIT_EXIT_CODES,
  type EditFlowIO,
} from "../src/models/cli-edit.ts";
import { runAddFlow } from "../src/models/cli-add.ts";
import { parseModelRegistryManifest } from "../src/models/model-registry.ts";
import {
  publishModelRegistryDocument,
  type WriteConfirmIO,
} from "../src/models/cli-write.ts";
import { looksLikeSecret } from "../src/models/cli-redact.ts";
import type { BackendConfigField } from "pi-maestro-backend-core/v1/backend";

const FIXTURE_MANIFEST = JSON.stringify({
  version: 2,
  mode: "model-registry",
  default: "pi-local",
  defaultModel: "pi/default",
  backends: {
    "pi-local": { module: "pi-subprocess" },
    "dsh-local": { module: "pi-maestro-backends/dsh", config: { model: "flash" } },
    "acp-local": { module: "pi-maestro-teammate/v1/acp-cli", config: { command: "agent" } },
    "acp-ssh": {
      module: "pi-maestro-teammate/v1/acp-cli",
      config: { command: "agent", mode: "ssh" },
    },
    "remote-beta": { module: "remote-workers", config: { targetId: "beta", driver: "pi-rpc" } },
    // A module no loader could ever resolve: if `list` attempted any backend
    // module import it would fail; the static descriptor must not.
    "ghost-adapter": { module: "vendor/never-shipped-adapter" },
  },
  models: {
    "pi/default": {
      modelId: "openai/gpt-default",
      deployment: "pi-local",
      selector: { kind: "adapter-model", value: "openai/gpt-default" },
      deploymentDefault: true,
      displayName: "Pi default",
    },
    "dsh/flash": {
      modelId: "zai/glm-flash",
      deployment: "dsh-local",
      selector: { kind: "deployment-default" },
      deploymentDefault: true,
    },
    "acp/cursor": {
      modelId: "cli/cursor",
      deployment: "acp-local",
      selector: { kind: "deployment-default" },
      deploymentDefault: true,
    },
    "acp/tunnel": {
      modelId: "cli/tunnel",
      deployment: "acp-ssh",
      selector: { kind: "deployment-default" },
      deploymentDefault: true,
    },
    "remote/beta": {
      modelId: "pi/beta",
      deployment: "remote-beta",
      selector: { kind: "fixed" },
      deploymentDefault: true,
    },
    "ghost/model": {
      modelId: "vendor/model",
      deployment: "ghost-adapter",
      // A fixed selector would be rejected for an unverified backend; the
      // deployment default is the only legal shape here.
      selector: { kind: "deployment-default" },
    },
  },
});

function row(overrides: Partial<ModelCliRow> & Pick<ModelCliRow, "registrationId">): ModelCliRow {
  return {
    modelId: overrides.registrationId,
    deploymentId: overrides.registrationId,
    deploymentDefault: false,
    harness: "pi",
    transportKind: "local-process",
    protocol: "pi-rpc",
    modelSelection: "native",
    registered: true,
    resolvable: true,
    healthyStatic: true,
    sessionAvailable: "n/a",
    ...overrides,
  };
}

test("list builds exact static rows from the manifest compiler", () => {
  const result = buildModelList(FIXTURE_MANIFEST, "fixture.json");
  assert.equal(result.kind, "registry");
  if (result.kind !== "registry") return;
  assert.deepEqual(result.rows, [
    row({
      registrationId: "acp/cursor",
      modelId: "cli/cursor",
      deploymentId: "acp-local",
      deploymentDefault: true,
      harness: "acp",
      protocol: "acp",
    }),
    row({
      registrationId: "acp/tunnel",
      modelId: "cli/tunnel",
      deploymentId: "acp-ssh",
      deploymentDefault: true,
      harness: "acp",
      transportKind: "acp-direct-ssh",
      protocol: "acp",
    }),
    row({
      registrationId: "dsh/flash",
      modelId: "zai/glm-flash",
      deploymentId: "dsh-local",
      deploymentDefault: true,
      harness: "dsh",
      protocol: "json-rpc-stdio",
    }),
    row({
      registrationId: "ghost/model",
      modelId: "vendor/model",
      deploymentId: "ghost-adapter",
      harness: "adapter-owned",
      transportKind: "adapter-owned",
      protocol: "-",
      modelSelection: "unknown",
      resolvable: false,
      healthyStatic: false,
    }),
    row({
      registrationId: "pi/default",
      modelId: "openai/gpt-default",
      deploymentId: "pi-local",
      deploymentDefault: true,
    }),
    row({
      registrationId: "remote/beta",
      modelId: "pi/beta",
      deploymentId: "remote-beta",
      deploymentDefault: true,
      harness: "pi",
      transportKind: "remote-worker",
      protocol: "remote/2",
      modelSelection: "unsupported",
    }),
  ].sort((left, right) => left.registrationId.localeCompare(right.registrationId)));
  // The unresolvable ghost deployment carries its static diagnostic reason and
  // never triggered a module load.
  const ghost = result.rows.find((entry) => entry.registrationId === "ghost/model")!;
  assert.equal(ghost.resolvable, false);
  assert.equal(ghost.sessionAvailable, "n/a");
});

// P3 landed the dsh-direct-ssh transport descriptor, so a dsh deployment with
// ssh config fields now projects dsh-direct-ssh instead of local-process.
test("dsh direct-ssh topology row", () => {
  const manifest = JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "dsh-ssh",
    defaultModel: "dsh/ssh",
    backends: {
      "dsh-ssh": { module: "pi-maestro-backends/dsh", config: { mode: "ssh", host: "build-box", user: "ci" } },
    },
    models: {
      "dsh/ssh": {
        modelId: "zai/glm-flash",
        deployment: "dsh-ssh",
        selector: { kind: "deployment-default" },
        deploymentDefault: true,
      },
    },
  });
  const result = buildModelList(manifest, "fixture.json");
  assert.equal(result.kind, "registry");
  if (result.kind !== "registry") return;
  assert.equal(result.rows[0]!.transportKind, "dsh-direct-ssh");
});

test("legacy documents return early through the preview hook", () => {
  for (const document of [
    JSON.stringify({ default: "pi-subprocess", backends: {} }),
    JSON.stringify({ version: 1, mode: "legacy", default: "pi-subprocess", backends: {} }),
    JSON.stringify({ version: 2, mode: "backend-registry", default: "pi-subprocess", backends: {} }),
  ]) {
    let hookPath: string | undefined;
    let hookParsed: unknown;
    const result = buildModelList(document, "old.json", {
      legacyPreviewHook: (path, parsed) => {
        hookPath = path;
        hookParsed = parsed;
      },
    });
    assert.equal(result.kind, "legacy");
    if (result.kind !== "legacy") return;
    assert.equal(hookPath, "old.json");
    // The parsed document travels with the result so the interactive preview
    // flow can compute the upgraded copy without re-reading the file.
    assert.deepEqual(result.parsed, JSON.parse(document));
    assert.deepEqual(hookParsed, result.parsed);
  }
});

test("zh-CN rendering toggle translates headers and status words", () => {
  const en = renderModelList(buildModelList(FIXTURE_MANIFEST), createModelsCliTranslator("en"));
  const zh = renderModelList(buildModelList(FIXTURE_MANIFEST), createModelsCliTranslator("zh-CN"));
  assert.match(en, /Registration/);
  assert.match(zh, /注册/);
  assert.match(zh, /不适用（CLI）/);
  assert.doesNotMatch(zh, /Registration/);

  const legacy = renderModelList(
    { kind: "legacy", documentPath: ".pi/teammate-backends.json", parsed: {} },
    createModelsCliTranslator("zh-CN"),
  );
  assert.match(legacy, /legacy 或 backend-registry 文档/);
  assert.match(legacy, /\[E\].*\[A\]|显式写出升级/u);
});

test("models CLI catalogs are complete inside the central TUI catalogs", () => {
  assert.deepEqual(checkTuiCatalogCompleteness(), {
    complete: true,
    referenceLocale: "en",
    issues: [],
  });
  // Every CLI key is reachable through the merged central surface.
  for (const key of Object.keys(MODELS_CLI_CATALOGS.en!)) {
    assert.ok(key in TUI_TRANSLATION_CATALOGS.en!, key);
    assert.ok(key in TUI_TRANSLATION_CATALOGS["zh-CN"]!, key);
  }
  assert.equal(parseModelsCliLocale("zh-CN"), "zh-CN");
  assert.equal(parseModelsCliLocale("fr"), undefined);
});

test("listing never dynamically imports a backend module", async (t) => {
  // Guard every dynamic-loading seam the process could reach: an ESM import of
  // a missing module must never even be attempted on the list path. The
  // fixture's "vendor/never-shipped-adapter" deployment would throw
  // ERR_MODULE_NOT_FOUND if list resolved modules; instead the static
  // descriptor marks the route adapter-owned/unresolvable.
  const loaded: string[] = [];
  // Node resolves dynamic imports through its host loader, not this property;
  // the behavioral assertion below therefore carries the guarantee, with the
  // spy acting as a tripwire for future refactors onto indirection.
  Object.defineProperty(globalThis, "import", {
    value: (specifier: string) => { loaded.push(specifier); },
    configurable: true,
  });
  t.after(() => { delete (globalThis as { import?: unknown }).import; });

  const root = mkdtempSync(join(tmpdir(), "teammate-models-cli-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const file = join(root, ".pi", "teammate-backends.json");
  writeFileSync(file, FIXTURE_MANIFEST, "utf8");

  const exit = await main(["list", "--file", file]);
  assert.equal(exit, 0);
  assert.equal(loaded.length, 0);
});

test("main prints the path subcommand output and rejects bad locales", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["path", "--file", ".pi/teammate-backends.json"]), 0);
    assert.match(writes.at(-1)!, /[\\/.]pi[\\/]?teammate-backends\.json/);
    await assert.rejects(() => main(["list", "--locale", "fr"]), /--locale must be one of en \| zh-CN/);
    assert.equal(await main([]), 2);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("P6 acceptance block", async (t) => {
  const fields: readonly BackendConfigField[] = [
    { key: "alpha", kind: "text", labelKey: "p6.alpha" },
    { key: "count", kind: "integer", labelKey: "p6.count" },
    { key: "secretRef", kind: "credential-ref", labelKey: "p6.secretRef" },
  ];

  function manifest(config: Record<string, unknown>): string {
    return `${JSON.stringify({
      version: 2,
      mode: "model-registry",
      default: "deploy",
      defaultModel: "model/default",
      backends: {
        deploy: {
          module: "p6-fields",
          config,
        },
      },
      models: {
        "model/default": {
          modelId: "provider/model",
          deployment: "deploy",
          selector: { kind: "deployment-default" },
          deploymentDefault: true,
        },
      },
    }, null, 2)}\n`;
  }

  function rootFile(raw = manifest({ alpha: "old", count: 7, secretRef: "OLD_KEY" })): {
    root: string;
    file: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "teammate-models-p6-"));
    const file = join(root, "registry.json");
    writeFileSync(file, raw, "utf8");
    return { root, file };
  }

  class ScriptedEditIO implements EditFlowIO {
    readonly output: string[] = [];
    readonly prompts: string[] = [];
    private readonly actions: Array<string | "ctrl-c" | "eof">;
    private readonly interruptHandlers: Array<() => void> = [];
    onPrompt?: (index: number, prompt: string) => void;

    constructor(actions: Array<string | "ctrl-c" | "eof">) {
      this.actions = [...actions];
    }

    write(text: string): void {
      this.output.push(text);
    }

    prompt(promptText: string, registerCancel: (cancel: () => void) => void): Promise<string> {
      const index = this.prompts.push(promptText) - 1;
      this.onPrompt?.(index, promptText);
      const action = this.actions.shift();
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const cancel = (): void => {
          if (!settled) {
            settled = true;
            reject(new EditCancelled());
          }
        };
        const finish = (value: string): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        registerCancel(cancel);
        if (action === "ctrl-c") {
          queueMicrotask(() => this.interruptHandlers.forEach((handler) => handler()));
        } else if (action === "eof" || action === undefined) {
          queueMicrotask(() => {
            if (!settled) {
              settled = true;
              reject(new EditAborted());
            }
          });
        } else {
          queueMicrotask(() => finish(action));
        }
      });
    }

    onInterrupt(handler: () => void): void {
      this.interruptHandlers.push(handler);
    }

    close(): void {}
  }

  function writeIO(output: string[] = []): WriteConfirmIO {
    return {
      write: (text) => output.push(text),
      confirm: async () => true,
    };
  }

  async function edit(
    file: string,
    actions: Array<string | "ctrl-c" | "eof">,
    options: { yes?: boolean; io?: ScriptedEditIO } = {},
  ): Promise<{ exit: number; io: ScriptedEditIO }> {
    const io = options.io ?? new ScriptedEditIO(actions);
    const exit = await runEditFlow({
      file,
      io,
      yes: options.yes,
      importModule: async () => ({ configFields: fields }),
    });
    return { exit, io };
  }

  await t.test("round-trips changed fields while preserving untouched values and enumeration order", async () => {
      const original = JSON.stringify({
      version: 2,
      mode: "model-registry",
      default: "deploy",
      defaultModel: "model/default",
      backends: {
        deploy: {
          module: "p6-fields",
          config: {
            untouchedFirst: "keep",
            alpha: "old",
            untouchedLast: ["a", "b"],
            count: 7,
            secretRef: "OLD_KEY",
          },
        },
      },
      models: {
        "model/default": {
          modelId: "provider/model",
          deployment: "deploy",
          selector: { kind: "deployment-default" },
          deploymentDefault: true,
        },
      },
    }, null, 0);
    const { root, file } = rootFile(original);
    try {
      const result = await edit(file, ["deploy", "new", "", ""]);
      assert.equal(result.exit, 0);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
      const registration = parsed.backends.deploy;
      assert.deepEqual(registration.config, {
        untouchedFirst: "keep",
        alpha: "new",
        untouchedLast: ["a", "b"],
        count: 7,
        secretRef: "OLD_KEY",
      });
      assert.deepEqual(Object.keys(registration.config), [
        "untouchedFirst",
        "alpha",
        "untouchedLast",
        "count",
        "secretRef",
      ]);
      assert.equal(registration.config.secretRef, "OLD_KEY");
      assert.deepEqual(parsed.models["model/default"], {
        modelId: "provider/model",
        deployment: "deploy",
        selector: { kind: "deployment-default" },
        deploymentDefault: true,
      });
      // The writer deliberately canonicalizes JSON whitespace; semantic and
      // enumeration order preservation are the acceptance contract.
      assert.notEqual(readFileSync(file, "utf8"), original);
      assert.deepEqual(Object.keys(parsed), [
        "version",
        "mode",
        "default",
        "defaultModel",
        "backends",
        "models",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("rejects integer garbage, empty required text, and secret-looking credential input", () => {
    const table: Array<{ field: BackendConfigField; input: string; warning?: boolean }> = [
      { field: { key: "count", kind: "integer", labelKey: "p6.count" }, input: "12.5" },
      { field: { key: "required", kind: "text", labelKey: "p6.required", required: true }, input: "" },
      {
        field: { key: "secretRef", kind: "credential-ref", labelKey: "p6.secretRef" },
        input: "sk-live_1234567890",
        warning: true,
      },
    ];
    for (const entry of table) {
      const result = parseConfigFieldInput(entry.field, entry.input);
      assert.equal(result.ok, false, entry.field.key);
      if (!result.ok && entry.warning !== undefined) assert.equal(result.secretWarning, entry.warning);
    }
    assert.equal(looksLikeSecret("sk-live_1234567890"), true);
  });

  await t.test("credential-ref prompts accept a NAME and never expose the rejected value", async () => {
    const { root, file } = rootFile(manifest({ secretRef: "OLD_KEY" }));
    try {
      const result = await edit(file, ["deploy", "", "", "sk-live_1234567890", "DEEPSEEK_API_KEY"]);
      const captured = result.io.output.join("");
      assert.equal(result.exit, 0);
      assert.match(captured, /secret VALUE/i);
      assert.doesNotMatch(captured, /sk-live_1234567890/);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).backends.deploy.config.secretRef, "DEEPSEEK_API_KEY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("rotates .bak then .bak.1 across consecutive writes", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    try {
      const initial = readFileSync(file, "utf8");
      const first = manifest({ alpha: "first" });
      const second = manifest({ alpha: "second" });
      assert.deepEqual(
        await publishModelRegistryDocument({ file, candidateRaw: first, baselineRaw: initial, io: writeIO() }),
        { kind: "written", backupPath: `${file}.bak` },
      );
      assert.equal(readFileSync(`${file}.bak`, "utf8"), initial);
      assert.deepEqual(
        await publishModelRegistryDocument({ file, candidateRaw: second, baselineRaw: first, io: writeIO() }),
        { kind: "written", backupPath: `${file}.bak` },
      );
      assert.equal(readFileSync(`${file}.bak`, "utf8"), first);
      assert.equal(readFileSync(`${file}.bak.1`, "utf8"), initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("fails rotation before publishing", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const baseline = readFileSync(file, "utf8");
    try {
      writeFileSync(`${file}.bak`, "old backup", "utf8");
      mkdirSync(`${file}.bak.1`);
      writeFileSync(`${file}.bak.1/guard`, "keep", "utf8");
      await assert.rejects(
        () => publishModelRegistryDocument({
          file,
          candidateRaw: manifest({ alpha: "new" }),
          baselineRaw: baseline,
          io: writeIO(),
        }),
        /Backup rotation.*failed/i,
      );
      assert.equal(readFileSync(file, "utf8"), baseline);
      assert.equal(readFileSync(`${file}.bak`, "utf8"), "old backup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("warns and aborts on declined external changes", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const baseline = readFileSync(file, "utf8");
    const io = new ScriptedEditIO(["deploy", "local", "", "", "n"]);
    io.onPrompt = (index) => {
      if (index === 1) writeFileSync(file, manifest({ alpha: "external" }), "utf8");
    };
    try {
      const result = await edit(file, [], { io });
      assert.equal(result.exit, 1);
      assert.equal(readFileSync(file, "utf8"), manifest({ alpha: "external" }));
      assert.match(io.output.join(""), /changed since this edit started/i);
      assert.ok(!statSync(`${file}.bak`, { throwIfNoEntry: false }));
      assert.notEqual(readFileSync(file, "utf8"), baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("accepts external changes with --yes using documented last-writer-wins", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const io = new ScriptedEditIO(["deploy", "local", "", ""]);
    io.onPrompt = (index) => {
      if (index === 1) writeFileSync(file, manifest({ alpha: "sk-live_1234567890" }), "utf8");
    };
    try {
      const result = await edit(file, [], { yes: true, io });
      assert.equal(result.exit, 0);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).backends.deploy.config.alpha, "local");
      assert.match(io.output.join(""), /last writer wins/i);
      assert.doesNotMatch(io.output.join(""), /sk-live_1234567890/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("publish gate rejects parse-valid documents the runtime compiler would refuse", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const baseline = readFileSync(file, "utf8");
    // Parse-valid but topology-invalid: a fixed selector on a native-modelSelection module.
    const topologyInvalid = `${JSON.stringify({
      version: 2,
      mode: "model-registry",
      default: "deploy",
      defaultModel: "model/default",
      backends: { deploy: { module: "pi-subprocess" } },
      models: {
        "model/default": {
          modelId: "x",
          deployment: "deploy",
          selector: { kind: "fixed" },
          deploymentDefault: true,
        },
      },
    }, null, 2)}\n`;
    try {
      await assert.rejects(
        () => publishModelRegistryDocument({ file, candidateRaw: topologyInvalid, baselineRaw: baseline, io: writeIO() }),
        /fixed selector/,
      );
      assert.equal(readFileSync(file, "utf8"), baseline);
      assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("edit refuses an ssh candidate without host/user and writes nothing", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const io = new ScriptedEditIO(["deploy", "", "ssh", "", ""]);
    try {
      const exit = await runEditFlow({
        file,
        io,
        importModule: async () => ({
          configFields: [
            { key: "alpha", kind: "text", labelKey: "f.alpha" },
            { key: "mode", kind: "text", labelKey: "f.mode" },
            { key: "host", kind: "text", labelKey: "f.host" },
            { key: "user", kind: "text", labelKey: "f.user" },
          ] as never,
        }),
      });
      assert.equal(exit, EDIT_EXIT_CODES.invalidArguments);
      assert.match(io.output.join(""), /host.*required|user.*required|is required/s);
      assert.equal(readFileSync(file, "utf8"), manifest({ alpha: "initial" }));
      assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("invalid compiled manifests write nothing", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const baseline = readFileSync(file, "utf8");
    try {
      await assert.rejects(
        () => publishModelRegistryDocument({ file, candidateRaw: "{}\n", baselineRaw: baseline, io: writeIO() }),
      );
      assert.equal(readFileSync(file, "utf8"), baseline);
      assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("EOF mid-flow exits non-zero without writing", async () => {
    const { root, file } = rootFile();
    const baseline = readFileSync(file, "utf8");
    try {
      const result = await edit(file, ["deploy", "eof"]);
      assert.equal(result.exit, 2);
      assert.equal(readFileSync(file, "utf8"), baseline);
      assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("Ctrl-C cancels the prompt without writing", async () => {
    const { root, file } = rootFile();
    const baseline = readFileSync(file, "utf8");
    try {
      const result = await edit(file, ["deploy", "ctrl-c"]);
      assert.equal(result.exit, 2);
      assert.match(result.io.output.join(""), /NOT modified/i);
      assert.equal(readFileSync(file, "utf8"), baseline);
      assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("piped non-TTY input drives the full edit flow", async () => {
    const { root, file } = rootFile(manifest({ alpha: "initial" }));
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const io = createReadlineEditIO({ input, output });
    try {
      const pending = runEditFlow({
        file,
        io,
        importModule: async () => ({ configFields: [fields[0]!] }),
      });
      input.end("deploy\nfrom-pipe\n");
      assert.equal(await pending, 0);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).backends.deploy.config.alpha, "from-pipe");
      assert.match(Buffer.concat(chunks).toString("utf8"), /Wrote|previous document saved/i);
    } finally {
      io.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("P7 acceptance block", async (t) => {
  /**
   * Scripted IO for the add/preview flows: one action per prompt, "ctrl-c"
   * fires the interrupt handlers, and anything else — including running dry —
   * ends input (EOF).
   */
  class ScriptedAddIO implements EditFlowIO {
    readonly output: string[] = [];
    private readonly actions: Array<string | "ctrl-c" | "eof">;
    private readonly interruptHandlers: Array<() => void> = [];

    constructor(actions: Array<string | "ctrl-c" | "eof">) {
      this.actions = [...actions];
    }

    write(text: string): void {
      this.output.push(text);
    }

    prompt(promptText: string, registerCancel: (cancel: () => void) => void): Promise<string> {
      this.output.push(promptText);
      const action = this.actions.shift();
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const cancel = (): void => {
          if (!settled) {
            settled = true;
            reject(new EditCancelled());
          }
        };
        const finish = (value: string): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        registerCancel(cancel);
        if (action === "ctrl-c") {
          queueMicrotask(() => this.interruptHandlers.forEach((handler) => handler()));
        } else if (action === "eof" || action === undefined) {
          queueMicrotask(() => {
            if (!settled) {
              settled = true;
              reject(new EditAborted());
            }
          });
        } else {
          queueMicrotask(() => finish(action));
        }
      });
    }

    onInterrupt(handler: () => void): void {
      this.interruptHandlers.push(handler);
    }

    close(): void {}
  }

  function baseManifest(): string {
    return `${JSON.stringify({
      version: 2,
      mode: "model-registry",
      default: "pi-local",
      defaultModel: "pi/default",
      backends: { "pi-local": { module: "pi-subprocess" } },
      models: {
        "pi/default": {
          modelId: "openai/gpt-default",
          deployment: "pi-local",
          selector: { kind: "adapter-model", value: "openai/gpt-default" },
          deploymentDefault: true,
        },
      },
    }, null, 2)}\n`;
  }

  await t.test("help documents backup retention (.bak/.bak.1) and undo", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await main(["--help"]), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    const help = writes.join("");
    assert.match(help, /\.bak\.1/);
    assert.match(help, /[Uu]ndo/);
    assert.match(help, /\badd\b/);
  });

  await t.test("scripted end-to-end add through --file yields a compiler-valid manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-"));
    const file = join(root, "registry.json");
    writeFileSync(file, baseManifest(), "utf8");
    try {
      // dsh family → local transport → new deployment → the declared fields
      // (only cordisConfig is required; empty keeps each declared default) →
      // registration on the new deployment.
      const io = new ScriptedAddIO([
        "dsh",               // family
        "",                  // transport variant: local (default)
        "dsh-local",         // deployment id
        "",                  // command → default
        "cordis.yml",        // cordisConfig (required)
        "", "",              // cwd, provider
        "",                  // model → default
        "",                  // apiKeyEnv → default NAME
        "",                  // envPassthrough
        "",                  // mode → default local
        "", "", "", "",      // host, user, port, hostKeySha256
        "", "", "",          // identityFile, todoBridge, maxTokens
        "",                  // requestTimeoutMs → default
        "",                  // registration target deployment (new)
        "dsh/flash",         // registration id
        "deepseek-v4-flash", // modelId
        "2",                 // selector: deployment-default
        "",                  // not the deployment default (pi/default stays)
      ]);
      const exit = await main(["add", "--file", file], io);
      assert.equal(exit, 0);

      // The written document survives the exact parser the runtime loads with.
      const raw = readFileSync(file, "utf8");
      const manifest = parseModelRegistryManifest(raw, file);
      const dshConfig = manifest.backends["dsh-local"]!.config!;
      assert.equal(dshConfig.cordisConfig, "cordis.yml");
      // Declared defaults were shown and applied on empty input.
      assert.equal(dshConfig.provider, "deepseek-official");
      assert.equal(dshConfig.port, 22);
      assert.equal(dshConfig.requestTimeoutMs, 300_000);
      // Credential fields hold a NAME default, never a value.
      assert.equal(dshConfig.apiKeyEnv, "DEEPSEEK_API_KEY");
      assert.equal(manifest.models["dsh/flash"]!.deployment, "dsh-local");
      assert.equal(manifest.models["dsh/flash"]!.deploymentDefault, undefined);
      assert.deepEqual(Object.keys(manifest.backends), ["pi-local", "dsh-local"]);
      // The previous document was rotated into the backup path.
      assert.match(io.output.join(""), /previous document saved/i);
      assert.equal(readFileSync(`${file}.bak`, "utf8"), baseManifest());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("duplicate-selector attempt surfaces numbered compiler errors and re-prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-dup-"));
    const file = join(root, "registry.json");
    writeFileSync(file, `${JSON.stringify({
      version: 2,
      mode: "model-registry",
      default: "acp-local",
      defaultModel: "acp/one",
      backends: {
        "acp-local": { module: "pi-maestro-teammate/v1/acp-cli", config: { command: "agent" } },
      },
      models: {
        "acp/one": {
          modelId: "cli/agent",
          deployment: "acp-local",
          selector: { kind: "adapter-model", value: "cli/agent" },
          deploymentDefault: true,
        },
      },
    }, null, 2)}\n`, "utf8");
    try {
      const io = new ScriptedAddIO([
        "acp",          // family
        "",             // transport: local
        "acp-extra",    // new deployment id
        "", "", "",     // acpAgent, acpInstall, installTimeoutMs (new acp-cli fields)
        "agent",        // command (required)
        "", "", "",     // args, cwd, env
        "",             // mode
        "", "", "", "", // host, user, port, hostKeySha256
        "", "", "", "", "", "", // identityFile, modelId, acpModel, acpMode, acpThoughtLevel, runTimeoutMs
        "",             // startupTimeoutMs
        // First registration attempt targets the EXISTING deployment and
        // duplicates its adapter-model selector.
        "acp-local",
        "acp/two",
        "dup/model",
        "1",            // adapter-model
        "cli/agent",    // …same value as acp/one
        "",             // first pass: not the deployment default
        // Numbered compiler errors; the block re-prompts.
        "",             // target now the fresh deployment
        "acp/two",
        "dup/model",
        "2",            // deployment-default is free there
        "",
      ]);
      const exit = await runAddFlow({ file, io, locale: "en" });
      assert.equal(exit, 0);
      const output = io.output.join("");
      assert.match(output, /failed validation; re-enter/i);
      assert.match(output, /1\. model registrations "acp\/one" and "acp\/two" duplicate the same deployment selector/);
      const raw = readFileSync(file, "utf8");
      const manifest = parseModelRegistryManifest(raw, file);
      assert.equal(manifest.models["acp/two"]!.deployment, "acp-extra");
      assert.deepEqual(Object.keys(manifest.backends).sort(), ["acp-extra", "acp-local"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("legacy fixture yields preview and refuses writes; [E] writes an explicit upgraded copy", async (t) => {
    const legacyDoc = JSON.stringify({
      version: 2,
      mode: "backend-registry",
      default: "gemini",
      backends: { gemini: { module: "pi-maestro-teammate/v1/acp-cli", config: { command: "gemini" } } },
    });

    await t.test("[A]bort (default) leaves every file untouched", async () => {
      const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-legacy-"));
      const file = join(root, "teammate-backends.json");
      writeFileSync(file, legacyDoc, "utf8");
      try {
        const io = new ScriptedAddIO(["A"]);
        const exit = await main(["list", "--file", file], io);
        assert.equal(exit, 1);
        const output = io.output.join("");
        assert.match(output, /computed v2 skeleton/);
        assert.match(output, /refused/i);
        // The legacy document itself was never written…
        assert.equal(readFileSync(file, "utf8"), legacyDoc);
        // …and neither was anything else.
        assert.equal(statSync(`${file}.bak`, { throwIfNoEntry: false }), undefined);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    await t.test("end of input aborts with nothing written", async () => {
      const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-legacy-eof-"));
      const file = join(root, "teammate-backends.json");
      writeFileSync(file, legacyDoc, "utf8");
      try {
        const exit = await main(["list", "--file", file], new ScriptedAddIO(["eof"]));
        assert.equal(exit, 1);
        assert.equal(readFileSync(file, "utf8"), legacyDoc);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    await t.test("[E]xplicitly writes the upgraded skeleton to a sibling copy only", async () => {
      const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-legacy-e-"));
      const file = join(root, "teammate-backends.json");
      writeFileSync(file, legacyDoc, "utf8");
      try {
        const io = new ScriptedAddIO(["E"]);
        const exit = await main(["list", "--file", file, "--locale", "en"], io);
        assert.equal(exit, 0);
        assert.equal(readFileSync(file, "utf8"), legacyDoc); // refusal holds
        const copyPath = `${file}.upgraded.json`;
        const copy = JSON.parse(readFileSync(copyPath, "utf8")) as Record<string, any>;
        assert.equal(copy.version, 2);
        assert.equal(copy.mode, "model-registry");
        assert.equal(copy.default, "gemini"); // carried over verbatim
        assert.deepEqual(copy.backends.gemini.config, { command: "gemini" });
        // Deliberately NOT dispatchable until models are completed.
        assert.deepEqual(copy.models, {});
        assert.throws(() => parseModelRegistryManifest(readFileSync(copyPath, "utf8"), copyPath));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  await t.test("upgrade skeleton carries backends verbatim and placeholders for models", () => {
    const parsed = JSON.parse('{"default":"gemini","backends":{"gemini":{"module":"x"}}}');
    const text = renderLegacyUpgradeSkeleton(parsed, "old.json");
    assert.match(text, /computed v2 skeleton/);
    assert.match(text, /"default": "gemini"/);
    assert.match(text, /<registration-id-of-default-model>/);
    assert.match(text, /nothing has been written/i);
  });

  await t.test("runLegacyPreviewFlow refuses to clobber an existing upgraded copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "teammate-models-p7-legacy-x-"));
    const file = join(root, "teammate-backends.json");
    try {
      const first = await runLegacyPreviewFlow({
        file,
        parsed: { default: "gemini", backends: {} },
        locale: "en",
        io: new ScriptedAddIO(["E"]),
      });
      assert.equal(first, 0); // writes the sibling copy
      // A second explicit write refuses to clobber the existing copy.
      const second = await runLegacyPreviewFlow({
        file,
        parsed: { default: "gemini", backends: {} },
        locale: "en",
        io: new ScriptedAddIO(["E"]),
      });
      assert.equal(second, 1);
      assert.match(
        readFileSync(`${file}.upgraded.json`, "utf8"),
        /registration-id-of-default-model/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
