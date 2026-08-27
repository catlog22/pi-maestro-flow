#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { main } = await jiti.import("../src/completion-outbox/cli.ts");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`pi-teammate-outbox: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
