import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const THINKING_CYCLE_KEY = "ctrl+shift+e";
export const THINKING_CYCLE_ACTION = "app.thinking.cycle";
const LEGACY_THINKING_CYCLE_KEY = "shift+e";

function readKeybindings(configPath) {
  if (!existsSync(configPath)) return { config: {} };

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root value must be a JSON object");
    }
    return { config: parsed };
  } catch (error) {
    return {
      error: `Existing keybindings file is invalid; left unchanged: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function writeKeybindings(configPath, config) {
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporary, configPath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve the original write error */ }
    throw error;
  }
}

export function ensureMaestroKeybindings(
  configPath = join(homedir(), ".pi", "agent", "keybindings.json"),
) {
  const loaded = readKeybindings(configPath);
  if (loaded.error) return { status: "skipped", configPath, message: loaded.error };
  const config = loaded.config;

  const current = config[THINKING_CYCLE_ACTION];
  if (typeof current === "string" && current.toLowerCase() === THINKING_CYCLE_KEY) {
    return { status: "unchanged", configPath };
  }

  if (Array.isArray(current)) {
    const next = current.filter((key) => {
      if (typeof key !== "string") return true;
      const normalized = key.toLowerCase();
      return normalized !== "shift+tab" && normalized !== LEGACY_THINKING_CYCLE_KEY;
    });
    if (!next.some((key) => typeof key === "string" && key.toLowerCase() === THINKING_CYCLE_KEY)) {
      next.unshift(THINKING_CYCLE_KEY);
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { status: "unchanged", configPath };
    }
    config[THINKING_CYCLE_ACTION] = next;
  } else if (
    typeof current === "string"
    && current.toLowerCase() !== "shift+tab"
    && current.toLowerCase() !== LEGACY_THINKING_CYCLE_KEY
  ) {
    config[THINKING_CYCLE_ACTION] = [THINKING_CYCLE_KEY, current];
  } else {
    config[THINKING_CYCLE_ACTION] = THINKING_CYCLE_KEY;
  }
  writeKeybindings(configPath, config);
  return { status: "updated", configPath };
}

export function restorePiKeybindings(
  configPath = join(homedir(), ".pi", "agent", "keybindings.json"),
) {
  const loaded = readKeybindings(configPath);
  if (loaded.error) return { status: "skipped", configPath, message: loaded.error };
  const config = loaded.config;

  if (!(THINKING_CYCLE_ACTION in config)) {
    return { status: "unchanged", configPath };
  }

  delete config[THINKING_CYCLE_ACTION];
  writeKeybindings(configPath, config);
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
      console.log(`[pi-maestro-flow] Configured Ctrl+Shift+E effort cycling in ${result.configPath}`);
    }
  } catch (error) {
    console.warn(`[pi-maestro-flow] Could not configure keybindings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) run();
