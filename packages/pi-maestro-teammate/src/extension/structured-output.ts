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
  const fd = openStructuredOutputFile(outputPath);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Structured output path is not a regular file: ${outputPath}`);
    }
    if (process.platform !== "win32") fs.fchmodSync(fd, STRUCTURED_OUTPUT_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
}

function openStructuredOutputFile(outputPath: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const existingFlags = fs.constants.O_WRONLY | noFollow;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(outputPath, existingFlags, STRUCTURED_OUTPUT_FILE_MODE);
    } catch (error) {
      const code = fileErrorCode(error);
      if (code === "ELOOP" || code === "EISDIR") {
        throw new Error(`Structured output path is not a regular file: ${outputPath}`);
      }
      if (code !== "ENOENT") throw error;
      try {
        fd = fs.openSync(
          outputPath,
          existingFlags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          STRUCTURED_OUTPUT_FILE_MODE,
        );
      } catch (createError) {
        if (fileErrorCode(createError) === "EEXIST" && attempt === 0) continue;
        throw createError;
      }
    }
    if (fs.fstatSync(fd).isFile()) return fd;
    fs.closeSync(fd);
    throw new Error(`Structured output path is not a regular file: ${outputPath}`);
  }
  throw new Error(`Structured output path changed while opening: ${outputPath}`);
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function readSchema(schemaPath: string): Record<string, unknown> {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(schemaPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "ELOOP" || code === "EISDIR") {
      throw new Error(`Structured output schema path is not a regular file: ${schemaPath}`);
    }
    throw error;
  }
  let schemaText: string;
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Structured output schema path is not a regular file: ${schemaPath}`);
    }
    schemaText = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const parsed = JSON.parse(schemaText) as unknown;
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
