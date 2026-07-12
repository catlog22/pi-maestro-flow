import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const THINKING_CYCLE_KEY = "shift+e";

export function ensureMaestroKeybindings(
  configPath = join(homedir(), ".pi", "agent", "keybindings.json"),
) {
  let config = {};

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root value must be a JSON object");
      }
      config = parsed;
    } catch (error) {
      return {
        status: "skipped",
        configPath,
        message: `Existing keybindings file is invalid; left unchanged: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (config["app.thinking.cycle"] === THINKING_CYCLE_KEY) {
    return { status: "unchanged", configPath };
  }

  config["app.thinking.cycle"] = THINKING_CYCLE_KEY;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { status: "updated", configPath };
}

function run() {
  try {
    const result = ensureMaestroKeybindings();
    if (result.status === "skipped") {
      console.warn(`[pi-maestro-flow] ${result.message}`);
      return;
    }
    if (result.status === "updated") {
      console.log(`[pi-maestro-flow] Configured Shift+E effort cycling in ${result.configPath}`);
    }
  } catch (error) {
    console.warn(`[pi-maestro-flow] Could not configure keybindings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
