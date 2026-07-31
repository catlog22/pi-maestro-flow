import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isRetryableProviderError,
  sharedModelCircuitBreaker,
  type AcquiredModelCandidate,
  type ModelCircuitBreaker,
} from "pi-maestro-teammate/v1/retry";

export interface ModelFailoverConfig {
  enabled: boolean;
  fallbackModels: Record<string, string[]>;
}

interface ActiveModelRun {
  chain: string[];
  index: number;
  model: string;
  acquisition: AcquiredModelCandidate;
  used: boolean;
  failureRecorded: boolean;
  lastError?: string;
  lastHttpStatus?: number;
}

export interface ModelFailoverOptions {
  breaker?: ModelCircuitBreaker;
  homeDir?: string;
}

const CONFIG_FILE = "model-failover.json";

function emptyConfig(): ModelFailoverConfig {
  return { enabled: false, fallbackModels: {} };
}

function readConfig(filePath: string): Partial<ModelFailoverConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ModelFailoverConfig>;
    const fallbackModels: Record<string, string[]> = {};
    if (parsed.fallbackModels && typeof parsed.fallbackModels === "object") {
      for (const [model, rawFallbacks] of Object.entries(parsed.fallbackModels)) {
        if (!model.includes("/") || !Array.isArray(rawFallbacks)) continue;
        const fallbacks = [...new Set(rawFallbacks
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.includes("/"))
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0 && candidate !== model))];
        fallbackModels[model] = fallbacks;
      }
    }
    return {
      ...(typeof parsed.enabled === "boolean" ? { enabled: parsed.enabled } : {}),
      fallbackModels,
    };
  } catch {
    return {};
  }
}

export function getGlobalModelFailoverPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", CONFIG_FILE);
}

export function getProjectModelFailoverPath(cwd: string): string {
  return path.join(cwd, ".pi", CONFIG_FILE);
}

export function loadModelFailoverConfig(cwd: string, homeDir = os.homedir()): ModelFailoverConfig {
  const globalConfig = readConfig(getGlobalModelFailoverPath(homeDir));
  const projectConfig = readConfig(getProjectModelFailoverPath(cwd));
  return {
    enabled: projectConfig.enabled ?? globalConfig.enabled ?? false,
    fallbackModels: {
      ...(globalConfig.fallbackModels ?? {}),
      ...(projectConfig.fallbackModels ?? {}),
    },
  };
}

export function saveProjectModelFailoverConfig(cwd: string, config: ModelFailoverConfig): void {
  const filePath = getProjectModelFailoverPath(cwd);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot save over invalid project model failover config: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Cannot save over invalid project model failover config: expected a JSON object");
    }
    existing = parsed as Record<string, unknown>;
  }

  const fallbackModels = Object.fromEntries(Object.entries(config.fallbackModels).map(([model, chain]) => [
    model,
    [...new Set(chain.filter((candidate) => candidate !== model))],
  ]));
  const next = {
    ...existing,
    enabled: config.enabled,
    fallbackModels,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function assistantFailure(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") continue;
    return message.stopReason === "error" ? message.errorMessage || "Provider returned error" : undefined;
  }
  return undefined;
}

function availableModels(ctx: ExtensionContext): Map<string, ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number]> {
  return new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
}

export function formatModelHealth(breaker: ModelCircuitBreaker): string {
  const snapshots = breaker.snapshot();
  if (snapshots.length === 0) return "No model health observations in this Pi process.";
  return snapshots.map((entry) => {
    const failures = `failures=${entry.consecutiveFailures}`;
    const retry = entry.retryAt === undefined ? "" : ` retryAt=${new Date(entry.retryAt).toISOString()}`;
    return `${entry.model}: ${entry.state} ${failures}${retry}`;
  }).join("\n");
}

export function registerModelFailover(pi: ExtensionAPI, options: ModelFailoverOptions = {}): void {
  const breaker = options.breaker ?? sharedModelCircuitBreaker;
  let active: ActiveModelRun | undefined;
  let config = emptyConfig();

  pi.registerCommand("model-failover", {
    description: "Configure main-agent model circuit breaking and ordered fallback chains",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Model failover settings require interactive TUI mode.", "warning");
        return;
      }
      const { showModelFailoverOverlay } = await import("../tui/model-failover-settings.ts");
      const saved = await showModelFailoverOverlay(ctx, breaker);
      if (saved) config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
    },
  });

  pi.registerCommand("model-health", {
    description: "Show model circuit-breaker health and automatic failover state",
    handler: async (_args, ctx) => {
      config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
      const status = config.enabled ? "automatic failover enabled" : "automatic failover disabled";
      ctx.ui.notify(`${status}\n${formatModelHealth(breaker)}`, "info");
    },
  });

  const selectCandidate = async (
    ctx: ExtensionContext,
    chain: string[],
    startIndex: number,
  ): Promise<ActiveModelRun | undefined> => {
    const models = availableModels(ctx);
    for (let index = startIndex; index < chain.length; index += 1) {
      const candidate = chain[index];
      const model = models.get(candidate);
      if (!model) continue;
      const acquisition = breaker.acquireCandidate(candidate);
      if (!acquisition.allowed) continue;
      try {
        const selected = await pi.setModel(model);
        if (!selected) {
          breaker.releaseCandidate(acquisition);
          continue;
        }
      } catch {
        breaker.releaseCandidate(acquisition);
        continue;
      }
      return {
        chain,
        index,
        model: candidate,
        acquisition,
        used: false,
        failureRecorded: false,
      };
    }
    return undefined;
  };

  pi.on("session_start", () => {
    // No config load here: nothing consumes `config` before the next
    // before_agent_start, which reloads unconditionally and remains the
    // external-edit visibility boundary. Loading at session start was always
    // overwritten before use.
    active = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    config = loadModelFailoverConfig(ctx.cwd, options.homeDir);
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;
    if (!config.enabled) return;

    const current = modelKey(ctx.model);
    if (!current) return;
    const chain = [...new Set([current, ...(config.fallbackModels[current] ?? [])])];
    const acquisition = breaker.acquireCandidate(current);
    if (acquisition.allowed) {
      active = {
        chain,
        index: 0,
        model: current,
        acquisition,
        used: false,
        failureRecorded: false,
      };
      return;
    }

    const fallback = await selectCandidate(ctx, chain, 1);
    if (fallback) {
      active = fallback;
      ctx.ui.notify(`Model circuit open for ${current}; switched to ${fallback.model}.`, "warning");
    } else {
      ctx.ui.notify(
        `Model circuit open for ${current} and no healthy fallback available. ` +
        `Continuing with the current model because no fallback can be selected.`,
        "warning",
      );
    }
  });

  pi.on("turn_start", () => {
    if (active) active.used = true;
  });

  pi.on("after_provider_response", (event) => {
    if (!active) return;
    active.lastHttpStatus = event.status;
    if (event.status >= 400) active.lastError = `Provider returned error: HTTP ${event.status}`;
  });

  pi.on("message_end", (event) => {
    if (!active || event.message.role !== "assistant") return;
    const message = event.message as unknown as { stopReason?: string; errorMessage?: string };
    active.lastError = message.stopReason === "error" ? message.errorMessage : undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!active || !config.enabled) return;
    const failure = assistantFailure(event.messages as AgentMessage[])
      ?? (active.lastHttpStatus && active.lastHttpStatus >= 400 ? active.lastError : undefined);
    if (!isRetryableProviderError(failure)) return;

    if (active.used && !active.failureRecorded) {
      breaker.recordRetryableFailure(active.acquisition);
      active.failureRecorded = true;
    }

    const failedModel = active.model;
    const previous = active;
    const fallback = await selectCandidate(ctx, active.chain, active.index + 1);
    // Release the old acquisition if it was never settled (e.g. used===false
    // skipped recordRetryableFailure above).  Without this, a HALF_OPEN trial
    // would leak and the circuit could stay stuck.
    if (!previous.failureRecorded) breaker.releaseCandidate(previous.acquisition);
    previous.failureRecorded = true;
    // Guard: agent_settled may have fired during the await and cleared active.
    if (active !== previous) {
      // Release the fallback acquisition that selectCandidate already took;
      // without this a HALF_OPEN trial on the fallback model would leak.
      if (fallback && !fallback.failureRecorded) breaker.releaseCandidate(fallback.acquisition);
      return;
    }
    if (!fallback) return;
    active = fallback;
    ctx.ui.notify(`Model ${failedModel} failed; retrying with ${fallback.model}.`, "warning");
  });

  pi.on("agent_settled", () => {
    if (active?.used && !active.failureRecorded && !active.lastError) {
      breaker.recordSuccess(active.acquisition);
    } else if (active && !active.failureRecorded) {
      breaker.releaseCandidate(active.acquisition);
    }
    active = undefined;
  });

  pi.on("session_shutdown", () => {
    if (active && !active.failureRecorded) breaker.releaseCandidate(active.acquisition);
    active = undefined;
  });
}
