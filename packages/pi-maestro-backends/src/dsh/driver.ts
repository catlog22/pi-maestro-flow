/**
 * The real SDK driver behind the dsh backend.
 *
 * Kept apart from the backend so the capability declarations, configuration
 * rules, and outcome mapping stay testable without spawning a runtime.
 */

import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { ConfigValue } from "pi-maestro-backend-core/v1/backend";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import type { DshHarnessDriver } from "./backend.ts";

/** Read a string setting, or undefined when unset. */
function text(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a number setting, or undefined when unset. */
function count(config: Record<string, ConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Build a driver that spawns a real dsh runtime.
 *
 * The child's environment is deliberately left inherited. The runtime resolves
 * its own credential from its own configuration — in the reference deployment,
 * an `.env` beside its `cordis.yml` — so this process neither reads the key nor
 * checks whether it is set. A presence check here would be worse than useless:
 * the key is legitimately absent from this process, and failing on that would
 * reject a correctly configured deployment.
 *
 * @param config - the backend's resolved configuration.
 * @param options - the run options, for cancellation and correlation.
 * @returns a driver owning one runtime subprocess.
 */
export async function createDshDriver(
  config: Record<string, ConfigValue>,
  options: BackendRunOptions,
): Promise<DshHarnessDriver> {
  const cordisConfig = text(config, "cordisConfig");
  if (cordisConfig === undefined) {
    throw new Error('dsh backend requires "cordisConfig"; the runtime has no built-in fallback');
  }
  const command = text(config, "command") ?? "dsh-jsonrpc-agent";
  const cwd = text(config, "cwd") ?? options.baseCwd;
  const requestTimeoutMs = count(config, "requestTimeoutMs");
  const maxTokens = count(config, "maxTokens");

  const harness = new DeepSeekHarness({
    launch: {
      command,
      args: [cordisConfig],
      cwd,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    },
    cwd,
    ...(text(config, "provider") === undefined ? {} : { provider: text(config, "provider")! }),
    ...(text(config, "model") === undefined ? {} : { model: text(config, "model")! }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });

  return {
    async run(input, runOptions) {
      const result = await harness.run(input, {
        sessionId: runOptions.sessionId,
        ...(runOptions.onNotification === undefined ? {} : { onNotification: runOptions.onNotification }),
      });
      return {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        events: result.events as unknown as readonly Record<string, unknown>[],
      };
    },
    close: () => harness.close(),
  };
}
