import fs from "node:fs";
import path from "node:path";
import type { ExpertsMode } from "./types.ts";

export function resolveStatePath(cwd = process.cwd(), explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.EXPERTS_MODE_STATE) return path.resolve(process.env.EXPERTS_MODE_STATE);
  return path.resolve(cwd, ".experts-mode.json");
}

export function getMode(cwd = process.cwd(), statePath?: string): ExpertsMode {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) return "normal";
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { mode?: string };
    return raw?.mode === "experts" ? "experts" : "normal";
  } catch {
    return "normal";
  }
}

export function setMode(mode: ExpertsMode, cwd = process.cwd(), statePath?: string): Record<string, unknown> {
  if (mode !== "normal" && mode !== "experts") {
    throw new Error(`Invalid mode: ${mode}. Expected normal|experts`);
  }
  const file = resolveStatePath(cwd, statePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prev: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    prev = {};
  }
  const next = {
    ...prev,
    mode,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function readState(cwd = process.cwd(), statePath?: string): {
  mode: ExpertsMode;
  path: string;
  updatedAt?: string | null;
  lastDispatch?: unknown;
} {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) {
      return { mode: "normal", path: file, lastDispatch: null };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      mode?: string;
      updatedAt?: string;
      lastDispatch?: unknown;
    };
    return {
      mode: raw?.mode === "experts" ? "experts" : "normal",
      path: file,
      updatedAt: raw?.updatedAt ?? null,
      lastDispatch: raw?.lastDispatch ?? null,
    };
  } catch {
    return { mode: "normal", path: file, lastDispatch: null };
  }
}
