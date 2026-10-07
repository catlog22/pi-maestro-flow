import { readFileSync } from "node:fs";
import { join } from "node:path";

export function codexFastConfigPath(cwd: string): string {
  return join(cwd, ".pi", "codex-fast.json");
}

export function loadCodexFast(cwd: string): boolean {
  let text: string;
  try {
    text = readFileSync(codexFastConfigPath(cwd), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const config: unknown = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)
    || !("enabled" in config) || typeof config.enabled !== "boolean") {
    throw new Error("Codex Fast config must contain a boolean enabled field.");
  }
  return config.enabled;
}

export type RequestModel = { provider: string; api: string; id: string };

export function applyCodexFast(payload: unknown, model: RequestModel | undefined, enabled: boolean): unknown {
  if (!enabled || model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  // The hook exposes the session model, not the request model. Reject mismatched payloads.
  if (!("model" in payload) || payload.model !== model.id
    || !("input" in payload) || !Array.isArray(payload.input)) return undefined;
  return { ...payload, service_tier: "priority" };
}

/** A child override is authoritative, including false; otherwise use its project default. */
export function resolveChildCodexFast(cwd: string, override: string | undefined): boolean {
  if (override === "true") return true;
  if (override === "false") return false;
  return loadCodexFast(cwd);
}
