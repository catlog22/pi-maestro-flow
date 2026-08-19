import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  advertisedModels,
  findSelectOption,
  flattenSelectOptions,
  resolveModelSelection,
  resolveSelectValue,
} from "../src/remote/acp-config-options.ts";

/**
 * Resolution of an operator's model request against what an ACP agent
 * advertises.
 *
 * The load-bearing cases are the two the specification forces: `category` is
 * UX-only, so an agent that omits it must still be selectable; and a value the
 * agent never advertised must be refused rather than silently left on the
 * agent's current model, because selecting nothing is indistinguishable from
 * success once the run completes.
 *
 * The advertised values below are the shapes a real Cursor session returns —
 * bracketed variants whose bare names repeat across entries.
 */

/** A model selector carrying both `id` and `category`, as Cursor sends it. */
function modelOption(
  overrides: Partial<SessionConfigOption & { type: "select" }> = {},
): SessionConfigOption & { type: "select" } {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "default[]",
    options: [
      { value: "default[]", name: "Auto" },
      { value: "composer-2.5[fast=true]", name: "composer-2.5" },
      { value: "claude-opus-5[thinking=true,context=300k]", name: "claude-opus-5" },
    ],
    ...overrides,
  } as SessionConfigOption & { type: "select" };
}

test("flattenSelectOptions reads grouped and flat advertisements alike", () => {
  const flat = flattenSelectOptions([
    { value: "a", name: "A" },
    { value: "b", name: "B" },
  ]);
  assert.deepEqual(flat.map((option) => option.value), ["a", "b"]);

  const grouped = flattenSelectOptions([
    { name: "Fast", options: [{ value: "a", name: "A" }] },
    { name: "Deep", options: [{ value: "b", name: "B" }, { value: "c", name: "C" }] },
  ] as never);
  assert.deepEqual(grouped.map((option) => option.value), ["a", "b", "c"]);
});

test("findSelectOption locates a selector without its category, which is UX-only", () => {
  // Preferred when present.
  assert.equal(findSelectOption([modelOption()], "model")?.id, "model");

  // The specification forbids requiring `category` for correctness, so an agent
  // that omits it is still selectable by option id.
  const uncategorized = modelOption({ category: null });
  assert.equal(findSelectOption([uncategorized], "model")?.id, "model");

  // A category on a differently-named option still wins, so an agent free to
  // name its ids is served too.
  const renamed = modelOption({ id: "llm", category: "model" });
  assert.equal(findSelectOption([renamed], "model")?.id, "llm");

  assert.equal(findSelectOption([], "model"), undefined);
  assert.equal(findSelectOption(undefined, "model"), undefined);
});

test("resolveSelectValue accepts an advertised value and a bare name that is unambiguous", () => {
  const option = modelOption();
  assert.equal(
    resolveSelectValue(option, "claude-opus-5[thinking=true,context=300k]"),
    "claude-opus-5[thinking=true,context=300k]",
  );
  // A bare name reaches its single bracketed variant, so an operator need not
  // memorize the parameter suffix when only one exists.
  assert.equal(resolveSelectValue(option, "composer-2.5"), "composer-2.5[fast=true]");
});

test("resolveSelectValue refuses an ambiguous bare name instead of picking a variant", () => {
  const option = modelOption({
    options: [
      { value: "opus[effort=high]", name: "claude-opus-5" },
      { value: "opus[effort=low]", name: "claude-opus-5" },
    ],
  });
  assert.throws(
    () => resolveSelectValue(option, "claude-opus-5"),
    (error: Error) => error.message.includes("2 variants")
      && error.message.includes("opus[effort=high]")
      && error.message.includes("opus[effort=low]"),
  );
});

test("resolveSelectValue names every advertised value when it rejects one", () => {
  assert.throws(
    () => resolveSelectValue(modelOption(), "no-such-model[x=1]"),
    (error: Error) => error.message.includes("does not advertise")
      && error.message.includes("default[]")
      && error.message.includes("composer-2.5[fast=true]")
      && error.message.includes("claude-opus-5[thinking=true,context=300k]"),
  );
});

test("resolveModelSelection reports the config id to set alongside the value", () => {
  const selection = resolveModelSelection([modelOption()], "composer-2.5");
  assert.deepEqual(selection, { configId: "model", value: "composer-2.5[fast=true]" });
});

test("resolveModelSelection refuses when the agent advertises no model selector", () => {
  const modeOnly: SessionConfigOption[] = [{
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "agent",
    options: [{ value: "agent", name: "Agent" }],
  } as SessionConfigOption];
  assert.throws(
    () => resolveModelSelection(modeOnly, "composer-2.5"),
    // Names what the agent did advertise, so the operator can see the agent was
    // reached and simply cannot serve the request.
    (error: Error) => error.message.includes("no model selector")
      && error.message.includes("mode"),
  );
});

test("advertisedModels projects the selector for a configuration surface", () => {
  assert.deepEqual(advertisedModels([modelOption()]), [
    { value: "default[]", label: "Auto" },
    { value: "composer-2.5[fast=true]", label: "composer-2.5" },
    { value: "claude-opus-5[thinking=true,context=300k]", label: "claude-opus-5" },
  ]);
  // An agent with no model selector yields nothing rather than throwing: a
  // configuration surface renders an empty list, it does not fail.
  assert.deepEqual(advertisedModels([]), []);
});
