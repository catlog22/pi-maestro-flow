/**
 * Dynamically loaded in teammate child processes when outputSchema is set.
 * The terminating tool validates arguments against the caller-provided schema
 * and persists the structured value for the parent execution process.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare const STRUCTURED_OUTPUT_FILE_MODE = 384;
export declare function writeStructuredOutputFile(outputPath: string, content: string): void;
export default function registerStructuredOutput(pi: ExtensionAPI): void;
