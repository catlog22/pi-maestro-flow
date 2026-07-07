/**
 * Load and parse ~/.maestro/cli-tools.json configuration.
 *
 * Maps each enabled CLI tool to its provider configuration for
 * dynamic pi provider registration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliToolConfig {
  enabled: boolean;
  primaryModel: string;
  tags: string[];
  type: string;
  settingsFile?: string;
  reasoningEffort?: string;
}

export interface CliToolsConfig {
  version: string;
  tools: Record<string, CliToolConfig>;
  roles: Record<string, unknown>;
  proxy?: {
    enabled: boolean;
    httpProxy?: string;
    noProxy?: string;
  };
}

const CLI_TOOLS_PATH = path.join(os.homedir(), ".maestro", "cli-tools.json");

/**
 * Load cli-tools.json from the default location.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadCliToolsConfig(
  configPath?: string,
): CliToolsConfig | null {
  const filePath = configPath ?? CLI_TOOLS_PATH;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const config = parsed as Record<string, unknown>;

    // Validate basic structure
    if (!config.tools || typeof config.tools !== "object") {
      return null;
    }

    return parsed as CliToolsConfig;
  } catch {
    // File missing or invalid — not an error, providers are optional
    return null;
  }
}

/**
 * Get all enabled tools from the config.
 */
export function getEnabledTools(
  config: CliToolsConfig,
): Array<{ name: string; config: CliToolConfig }> {
  return Object.entries(config.tools)
    .filter(([_, toolConfig]) => toolConfig.enabled)
    .map(([name, toolConfig]) => ({ name, config: toolConfig }));
}
