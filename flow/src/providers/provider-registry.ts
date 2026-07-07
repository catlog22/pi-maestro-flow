/**
 * Dynamic LLM provider registration from cli-tools.json.
 *
 * At extension startup, reads cli-tools.json and registers each enabled
 * tool as a pi provider via pi.registerProvider(). Uses pi CredentialStore
 * for authentication ($API_KEY env var pattern).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadCliToolsConfig,
  getEnabledTools,
  type CliToolConfig,
} from "./cli-tools-loader.ts";

/**
 * Map a CLI tool type to its pi provider configuration.
 */
function mapToolToProviderConfig(
  name: string,
  config: CliToolConfig,
): {
  api: string;
  envVar: string;
  baseUrl?: string;
} {
  // Map tool names/types to API configurations
  switch (name) {
    case "claude":
      return {
        api: "anthropic-messages",
        envVar: "ANTHROPIC_API_KEY",
        baseUrl: "https://api.anthropic.com",
      };

    case "gemini":
      return {
        api: "google-genai",
        envVar: "GOOGLE_API_KEY",
        baseUrl: "https://generativelanguage.googleapis.com",
      };

    case "codex":
      return {
        api: "openai-completions",
        envVar: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      };

    case "opencode":
      return {
        api: "openai-compatible",
        envVar: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      };

    case "agy":
      return {
        api: "openai-compatible",
        envVar: "AGY_API_KEY",
        baseUrl: "https://api.openai.com/v1",
      };

    case "api-explore":
      return {
        api: "openai-compatible",
        envVar: "API_EXPLORE_KEY",
        baseUrl: "https://api.openai.com/v1",
      };

    default:
      return {
        api: "openai-compatible",
        envVar: `${name.toUpperCase()}_API_KEY`,
        baseUrl: "https://api.openai.com/v1",
      };
  }
}

/**
 * Register all enabled CLI tools as pi providers.
 *
 * Reads cli-tools.json, maps each enabled tool to a provider config,
 * and calls pi.registerProvider() for each.
 */
export function registerMaestroProviders(pi: ExtensionAPI): void {
  const cliConfig = loadCliToolsConfig();
  if (!cliConfig) {
    // No cli-tools.json — silently skip provider registration
    return;
  }

  const enabledTools = getEnabledTools(cliConfig);

  for (const { name, config: toolConfig } of enabledTools) {
    if (!toolConfig.primaryModel) {
      // Skip tools without a primary model (e.g., opencode with empty model)
      continue;
    }

    const providerMapping = mapToolToProviderConfig(name, toolConfig);

    try {
      // Register the provider with pi
      // Note: pi.registerProvider() is the ExtensionAPI method for adding
      // LLM providers dynamically. The exact signature depends on the
      // pi-agent-core version.
      if (typeof pi.registerProvider === "function") {
        pi.registerProvider(name, {
          api: providerMapping.api,
          apiKey: `$${providerMapping.envVar}`,
          ...(providerMapping.baseUrl
            ? { baseUrl: providerMapping.baseUrl }
            : {}),
          models: [
            {
              id: toolConfig.primaryModel,
              name: toolConfig.primaryModel,
              reasoning: false,
              input: ["text"],
            },
          ],
          ...(cliConfig.proxy?.enabled && cliConfig.proxy.httpProxy
            ? { proxy: cliConfig.proxy.httpProxy }
            : {}),
        });
      }
    } catch (error) {
      // Individual provider registration failures should not block others
      console.error(
        `[maestro] Failed to register provider "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
