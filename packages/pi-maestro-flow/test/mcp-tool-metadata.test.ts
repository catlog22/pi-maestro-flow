import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { buildProxyDescription } from "../src/mcp/direct-tools.ts";
import { formatSchema } from "../src/mcp/tool-metadata.ts";
import { normalizeDirectToolInputSchema } from "../src/mcp/utils.ts";

test("MCP proxy description stays static and omits duplicated inventory counts", () => {
  const description = buildProxyDescription();
  assert.match(description, /MCP gateway/);
  assert.match(description, /mcp\(\{ search: "query" \}\)/);
  assert.doesNotMatch(description, /Direct tools available/);
  assert.doesNotMatch(description, /^Servers:/m);
});

test("direct MCP schema normalization preserves argument constraints and local refs", () => {
  const normalized = normalizeDirectToolInputSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { name: { type: "string", minLength: 1 } },
    properties: { name: { $ref: "#/$defs/name" } },
    required: ["name"],
    additionalProperties: false,
  });

  assert.equal("$schema" in normalized, false);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.$defs, { name: { type: "string", minLength: 1 } });

  const schema = Type.Unsafe(normalized);
  assert.equal(Check(schema, { name: "Ada" }), true);
  assert.equal(Check(schema, { name: "" }), false);
  assert.equal(Check(schema, { name: "Ada", extra: true }), false);
});

test("direct MCP schema normalization falls back only for non-object schemas", () => {
  assert.deepEqual(normalizeDirectToolInputSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(normalizeDirectToolInputSchema([]), { type: "object", properties: {} });
  assert.deepEqual(normalizeDirectToolInputSchema({}), {});
});

test("schema formatter includes root descriptions and required fields", () => {
  const text = formatSchema({
    type: "object",
    description: "Creates a deployment.",
    properties: {
      name: { type: "string", description: "Deployment name" },
      replicas: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["name"],
  });

  assert.match(text, /Creates a deployment/);
  assert.match(text, /name \(string\) \*required\* - Deployment name/);
  assert.match(text, /replicas \(integer\).*minimum: 1.*default: 1/);
});

test("schema formatter bounds deep nesting, large enums, and total output", () => {
  let nested: Record<string, unknown> = { type: "string" };
  for (let depth = 0; depth < 40; depth += 1) {
    nested = { type: "object", properties: { [`level${depth}`]: nested } };
  }
  const properties: Record<string, unknown> = {
    nested,
    choice: {
      type: "string",
      enum: Array.from({ length: 100 }, (_, index) => `option-${index}-${"x".repeat(300)}`),
    },
  };
  for (let index = 0; index < 500; index += 1) {
    properties[`field${index}`] = { type: "string", description: "y".repeat(500) };
  }

  const text = formatSchema({ type: "object", properties });
  assert.match(text, /nested schema omitted/);
  assert.match(text, /\+80 more/);
  assert.match(text, /schema output truncated/);
  assert.ok(text.length <= 16_000, `formatted schema exceeded limit: ${text.length}`);
  assert.ok(text.split("\n").length <= 201);
});
