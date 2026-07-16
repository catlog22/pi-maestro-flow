/**
 * Dynamically loaded in teammate child processes when outputSchema is set.
 * The terminating tool validates arguments against the caller-provided schema
 * and persists the structured value for the parent execution process.
 */

import * as fs from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const STRUCTURED_OUTPUT_FILE_MODE = 0o600;

export function writeStructuredOutputFile(outputPath: string, content: string): void {
  try {
    const existing = fs.lstatSync(outputPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Structured output path is not a regular file: ${outputPath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const fd = fs.openSync(outputPath, "w", STRUCTURED_OUTPUT_FILE_MODE);
  try {
    if (process.platform !== "win32") fs.fchmodSync(fd, STRUCTURED_OUTPUT_FILE_MODE);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
}

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
      writeStructuredOutputFile(outputPath, JSON.stringify(params));
      return {
        content: [{ type: "text", text: "Structured output saved." }],
        details: params,
        terminate: true,
      };
    },
  });

  pi.registerTool(structuredOutputTool);
}
