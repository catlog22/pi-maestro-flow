/**
 * Dynamically loaded in teammate child processes when outputSchema is set.
 * The terminating tool validates arguments against the caller-provided schema
 * and persists the structured value for the parent execution process.
 */

import * as fs from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function readSchema(schemaPath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PI_TEAMMATE_STRUCTURED_SCHEMA_PATH must contain a JSON Schema object");
  }
  return parsed as Record<string, unknown>;
}

export default function registerStructuredOutput(pi: ExtensionAPI): void {
  const schemaPath = process.env.PI_TEAMMATE_STRUCTURED_SCHEMA_PATH;
  const outputPath = process.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH;
  if (!schemaPath || !outputPath) return;

  const schema = readSchema(schemaPath);
  const structuredOutputTool = defineTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return the final answer in the required structured shape. This must be the final action for the task.",
    promptSnippet: "Submit the final answer through structured_output",
    promptGuidelines: [
      "When structured_output is available, call it exactly once as the final action.",
      "Populate every required field from the task result and do not emit a prose answer afterward.",
    ],
    parameters: Type.Unsafe(schema),

    async execute(_toolCallId, params) {
      fs.writeFileSync(outputPath, JSON.stringify(params), "utf-8");
      return {
        content: [{ type: "text", text: "Structured output saved." }],
        details: params,
        terminate: true,
      };
    },
  });

  pi.registerTool(structuredOutputTool);
}
