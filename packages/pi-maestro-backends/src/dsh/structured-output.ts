/**
 * Host-side structured output for a runtime with no schema parameter.
 *
 * The SDK's run result is text, so a schema request cannot be handed to the
 * runtime. This is the compensation the contract calls `emulated`: instruct the
 * model, extract the value from what came back, and validate it against the
 * schema the orchestrator supplied.
 *
 * Validation is not optional here. The host reads `structuredOutput` to
 * interpolate `{name.field}` into a downstream task's prompt and validates
 * nothing itself, so an unvalidated value would flow into another agent's
 * instructions as if a schema had guaranteed it.
 */

import { Check, Errors } from "typebox/value";

/** Fenced block a model commonly wraps JSON in. */
const FENCED = /```(?:json)?\s*\n([\s\S]*?)\n?```/i;

/**
 * Tell the model exactly what to return.
 *
 * Appended rather than replacing the task: the run still has to do the work,
 * and only its final message is constrained.
 *
 * @param schema - the orchestrator's JSON Schema.
 * @returns the instruction to append to the prompt.
 */
export function structuredOutputInstruction(schema: Record<string, unknown>): string {
  return [
    "",
    "When you have finished, your final message must be exactly one JSON value",
    "matching this JSON Schema, with no prose before or after it:",
    "",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Ask again after a value failed to validate.
 *
 * The failure is quoted back because a model that produced the wrong shape once
 * will usually repeat it unless told which part was wrong.
 *
 * @param schema - the orchestrator's JSON Schema.
 * @param failure - what validation rejected.
 * @returns the follow-up prompt.
 */
export function structuredOutputRecovery(
  schema: Record<string, unknown>,
  failure: string,
): string {
  return [
    `Your last message did not satisfy the required JSON Schema: ${failure}`,
    "",
    "Reply with exactly one JSON value matching this schema, and nothing else:",
    "",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Pull the JSON value out of a final message.
 *
 * Tries the whole text first, then a fenced block, then the widest balanced
 * object or array. Prose around the value is common enough that refusing it
 * would fail runs whose answer was correct.
 *
 * @param text - the model's final message.
 * @returns the parsed value, or undefined when none was found.
 */
export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];
  const fenced = FENCED.exec(trimmed);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1].trim());
  const spans = [
    [trimmed.indexOf("{"), trimmed.lastIndexOf("}")],
    [trimmed.indexOf("["), trimmed.lastIndexOf("]")],
  ] as const;
  for (const [start, end] of spans) {
    if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  }
  for (const attempt of attempts) {
    if (attempt === "") continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next shape; a failure here only means this span was not the
      // value, not that the run produced none.
    }
  }
  return undefined;
}

/**
 * Describe why a value does not satisfy a schema.
 *
 * @param value - the extracted value.
 * @param schema - the orchestrator's JSON Schema.
 * @returns the failure, or undefined when the value is valid.
 */
export function describeSchemaFailure(
  value: unknown,
  schema: Record<string, unknown>,
): string | undefined {
  try {
    if (Check(schema, value)) return undefined;
    const issue = [...Errors(schema, value)][0] as {
      instancePath?: string;
      message?: string;
    } | undefined;
    const at = issue?.instancePath || "/";
    return `value does not match the schema at ${at}: ${issue?.message ?? "no further detail"}`;
  } catch (cause) {
    // A schema the validator cannot run is the orchestrator's error, and
    // reporting it as a validation failure keeps it visible instead of
    // silently accepting whatever came back.
    return `the schema could not be evaluated (${cause instanceof Error ? cause.message : String(cause)})`;
  }
}

/** A final message resolved against the requested schema. */
export type StructuredOutcome =
  | { status: "valid"; value: unknown }
  | { status: "invalid"; failure: string };

/**
 * Resolve a final message against the requested schema.
 *
 * @param text - the model's final message.
 * @param schema - the orchestrator's JSON Schema.
 * @returns the validated value, or why it was rejected.
 */
export function resolveStructuredOutput(
  text: string,
  schema: Record<string, unknown>,
): StructuredOutcome {
  const value = extractJsonValue(text);
  if (value === undefined) {
    return { status: "invalid", failure: "the final message contained no JSON value" };
  }
  const failure = describeSchemaFailure(value, schema);
  return failure === undefined ? { status: "valid", value } : { status: "invalid", failure };
}
