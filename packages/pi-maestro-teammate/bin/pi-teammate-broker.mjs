#!/usr/bin/env node
import { createJiti } from "jiti";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function filteredRuntimeBrokerWarning(warning, ...args) {
  const message = warning instanceof Error ? warning.message : String(warning);
  const optionsOrType = args[0];
  const type = warning instanceof Error
    ? warning.name
    : typeof optionsOrType === "string"
      ? optionsOrType
      : optionsOrType && typeof optionsOrType === "object"
        ? optionsOrType.type
        : undefined;
  if (type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...args);
};

try {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { main } = await jiti.import("../src/runtime-broker/cli.ts");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`pi-teammate-broker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
