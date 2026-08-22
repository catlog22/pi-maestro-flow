import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfigField } from "pi-maestro-backend-core/v1/backend";
import {
  promptConfigFields,
  promptNumberedErrorRetry,
  type ConnectionFormUi,
} from "../src/tui/connection-forms.ts";

/** Scripted UI: prompts are recorded; answers pop off a response queue. */
class ScriptedUi implements ConnectionFormUi {
  readonly inputPrompts: string[] = [];
  readonly confirmPrompts: string[] = [];
  readonly selectPrompts: string[] = [];
  private readonly queue: Array<
    { kind: "input"; answer?: string } | { kind: "confirm"; answer: boolean }
  > = [];

  /** Queue one scripted response, consumed in call order. */
  respondInput(answer?: string): void {
    this.queue.push({ kind: "input", answer });
  }

  respondConfirm(answer: boolean): void {
    this.queue.push({ kind: "confirm", answer });
  }

  async input(prompt: string): Promise<string | undefined> {
    this.inputPrompts.push(prompt);
    const next = this.queue.shift();
    assert.ok(next !== undefined && next.kind === "input", "unexpected input prompt");
    return next.answer;
  }

  async confirm(prompt: string): Promise<boolean> {
    this.confirmPrompts.push(prompt);
    const next = this.queue.shift();
    assert.ok(next !== undefined && next.kind === "confirm", "unexpected confirm prompt");
    return next.answer;
  }

  async select(prompt: string): Promise<string | undefined> {
    this.selectPrompts.push(prompt);
    const next = this.queue.shift();
    assert.ok(next !== undefined && next.kind === "input", "unexpected select prompt");
    return next.answer;
  }

  assertDrained(): void {
    assert.deepEqual(this.queue, [], "not every queued response was consumed");
  }
}

function textField(key: string, extra: Partial<BackendConfigField> = {}): BackendConfigField {
  return { key, kind: "text", labelKey: `test.${key}`, ...extra };
}

test("happy path collects a validated value per field in declaration order", async () => {
  const ui = new ScriptedUi();
  ui.respondInput("https://api.example.com");
  ui.respondInput("4");
  ui.respondInput("true");
  const result = await promptConfigFields(ui, [
    textField("endpoint"),
    { key: "workers", kind: "integer", labelKey: "test.workers" },
    { key: "verbose", kind: "boolean", labelKey: "test.verbose" },
  ]);
  ui.assertDrained();
  assert.deepEqual(result, {
    ok: true,
    values: { endpoint: "https://api.example.com", workers: 4, verbose: true },
  });
  // Prompts carry the kind label and current/default context.
  assert.match(ui.inputPrompts[0]!, /endpoint \[/);
  assert.match(ui.inputPrompts[0]!, /current: unset/);
});

test("validation failure re-prompts the same field in place with the error first", async () => {
  const ui = new ScriptedUi();
  ui.respondInput("not-a-number");
  ui.respondInput("7");
  ui.respondInput("team-a");
  const result = await promptConfigFields(ui, [
    { key: "workers", kind: "integer", labelKey: "test.workers" },
    textField("name"),
  ]);
  ui.assertDrained();
  assert.deepEqual(result, { ok: true, values: { workers: 7, name: "team-a" } });
  // Two prompts for the integer field, none for the untouched second field yet.
  assert.equal(ui.inputPrompts.length, 3);
  const retryPrompt = ui.inputPrompts[1]!;
  assert.ok(retryPrompt.startsWith("expected an integer\n"), "error must lead the re-prompt");
  assert.match(retryPrompt, /workers \[/);
  // Two prompts for the integer field; neither mentions the second field.
  assert.ok(
    !ui.inputPrompts.slice(0, 2).some((p) => p.includes("name [")),
    "second field not prompted before the first is accepted",
  );
  assert.match(ui.inputPrompts[2]!, /^name \[/);
});

test("empty input resolves the field default without further validation", async () => {
  const ui = new ScriptedUi();
  ui.respondInput("");
  ui.respondInput("");
  const result = await promptConfigFields(ui, [
    {
      key: "mode",
      kind: "enum",
      options: [{ value: "auto", labelKey: "x" }, { value: "manual", labelKey: "y" }],
      default: "auto",
      labelKey: "test.mode",
    },
    { key: "absent", kind: "text", labelKey: "test.absent" },
  ]);
  ui.assertDrained();
  assert.deepEqual(result, { ok: true, values: { mode: "auto" } });
  // The default was surfaced in the prompt before the operator pressed enter.
  assert.match(ui.inputPrompts[0]!, /default: auto/);
});

test("cancel mid-form stops further prompts and reports the cancelled variant", async () => {
  const ui = new ScriptedUi();
  ui.respondInput("first");
  ui.respondInput(undefined);
  ui.respondInput("never-consumed");
  const result = await promptConfigFields(ui, [textField("a"), textField("b"), textField("c")]);
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(ui.inputPrompts.length, 2);
});

test("credential-ref prompts never echo stored values back", async () => {
  const ui = new ScriptedUi();
  ui.respondInput("DEEPSEEK_KEY");
  await promptConfigFields(
    ui,
    [{ key: "apiKey", kind: "credential-ref", credentialLocation: "env-var", labelKey: "t" }],
    { apiKey: "DEEPSEEK_KEY" },
  );
  ui.assertDrained();
  const prompt = ui.inputPrompts[0]!;
  assert.ok(!prompt.includes("DEEPSEEK_KEY"), "stored credential reference leaked into prompt");
  assert.match(prompt, /variable name/);
});

test("numbered error retry renders errors and succeeds on the first retry", async () => {
  const ui = new ScriptedUi();
  ui.respondConfirm(true);
  let attempts = 0;
  const proceeded = await promptNumberedErrorRetry(ui, ["alpha failed", "beta failed"], async () => {
    attempts += 1;
    return { success: true };
  });
  ui.assertDrained();
  assert.equal(proceeded, true);
  assert.equal(attempts, 1);
  assert.equal(ui.confirmPrompts.length, 1);
  const prompt = ui.confirmPrompts[0]!;
  assert.match(prompt, /1\. alpha failed/);
  assert.match(prompt, /2\. beta failed/);
});

test("numbered error retry declines by declining the confirm and never retries", async () => {
  const ui = new ScriptedUi();
  ui.respondConfirm(false);
  let attempts = 0;
  const proceeded = await promptNumberedErrorRetry(ui, ["boom"], async () => {
    attempts += 1;
    return { success: true };
  });
  ui.assertDrained();
  assert.equal(proceeded, false);
  assert.equal(attempts, 0);
});

test("numbered error retry loops with refreshed errors until success", async () => {
  const ui = new ScriptedUi();
  ui.respondConfirm(true);
  ui.respondConfirm(true);
  let attempts = 0;
  const proceeded = await promptNumberedErrorRetry(ui, ["first failure"], async () => {
    attempts += 1;
    if (attempts === 1) {
      return { success: false, errors: ["still failing"] };
    }
    return { success: true };
  });
  ui.assertDrained();
  assert.equal(proceeded, true);
  assert.equal(attempts, 2);
  // Second render shows only the refreshed error list.
  assert.match(ui.confirmPrompts[1]!, /1\. still failing/);
  assert.ok(!ui.confirmPrompts[1]!.includes("first failure"));
});
