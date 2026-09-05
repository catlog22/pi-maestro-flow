#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
const command = args[0];

try {
  if (command === "version" || command === "--version" || command === "-v") {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (args.includes("--json")) console.log(JSON.stringify({ name: "pi-maestro-gateway", version: manifest.version, protocolVersion: 1 }));
    else console.log(`pi-maestro-gateway ${manifest.version}`);
  } else {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    if (command === "connect") {
      if (args.length !== 2 || args[1] !== "--stdio") throw new Error("Usage: pi-maestro-gateway connect --stdio");
      const { relayGatewayStdio } = await jiti.import("../src/gateway/stdio-relay.ts");
      await relayGatewayStdio();
    } else {
      const { main } = await jiti.import("../src/gateway/cli.ts");
      process.exitCode = await main(args);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
