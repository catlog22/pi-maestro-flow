/**
 * Public, version-gated OpenAI Secure MCP Tunnel CLI contract.
 *
 * This describes only the documented customer-run CLI/config surface. It does
 * not model, implement, or make claims about the tunnel wire protocol.
 */
export const OPENAI_TUNNEL_PROVIDER = "openai" as const;
export const OPENAI_TUNNEL_CLIENT_EXECUTABLE = "tunnel-client" as const;
export const OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION = "0.0.14" as const;
export const OPENAI_TUNNEL_CONFIG_VERSION = 1 as const;
export const OPENAI_TUNNEL_RUNTIME_KEY_ENV = "PI_MAESTRO_OPENAI_TUNNEL_RUNTIME_KEY" as const;
export const OPENAI_TUNNEL_ID_PATTERN = /^tunnel_[a-f0-9]{32}$/u;

export interface OpenAiTunnelClientContract {
  readonly maturity: "experimental";
  readonly executable: typeof OPENAI_TUNNEL_CLIENT_EXECUTABLE;
  readonly minimumVersion: string;
  readonly versionArgs: readonly string[];
  doctorArgs(configPath: string): readonly string[];
  runArgs(configPath: string): readonly string[];
}

/**
 * v0.0.14 is the first contract pinned by this integration. Later 0.0.x
 * releases are accepted; a minor/major change must be reviewed explicitly.
 */
export const OPENAI_TUNNEL_CLIENT_CONTRACT: OpenAiTunnelClientContract = Object.freeze({
  maturity: "experimental",
  executable: OPENAI_TUNNEL_CLIENT_EXECUTABLE,
  minimumVersion: OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION,
  versionArgs: Object.freeze(["--version"]),
  doctorArgs: (configPath: string) => ["doctor", "--config", configPath],
  runArgs: (configPath: string) => ["run", "--config", configPath],
});

export function parseOpenAiTunnelClientVersion(output: string): string | undefined {
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/u);
  return match?.[1];
}

export function isSupportedOpenAiTunnelClientVersion(version: string, minimumVersion: string = OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION): boolean {
  const value = parseTriplet(version);
  const minimum = parseTriplet(minimumVersion);
  if (!value || !minimum || value[0] !== minimum[0] || value[1] !== minimum[1]) return false;
  return value[2] >= minimum[2];
}

export function assertOpenAiTunnelId(value: string): string {
  if (!OPENAI_TUNNEL_ID_PATTERN.test(value)) throw contractError("invalid_arguments", "OpenAI tunnel id must match tunnel_<32 lowercase hex characters>");
  return value;
}

export function renderOpenAiTunnelClientConfig(input: {
  tunnelId: string;
  mcpUrl: string;
  authorizationFile: string;
  healthUrlFile: string;
  logFile: string;
}): string {
  const tunnelId = assertOpenAiTunnelId(input.tunnelId);
  const mcp = new URL(input.mcpUrl);
  if (mcp.protocol !== "http:" || (mcp.hostname !== "127.0.0.1" && mcp.hostname !== "localhost" && mcp.hostname !== "::1")) {
    throw contractError("invalid_arguments", "OpenAI tunnel MCP target must be a loopback HTTP URL");
  }
  if (mcp.username || mcp.password || mcp.search || mcp.hash) throw contractError("invalid_arguments", "OpenAI tunnel MCP target must not contain credentials, query, or fragment");
  const scalar = (value: string): string => JSON.stringify(value);
  return [
    `config_version: ${OPENAI_TUNNEL_CONFIG_VERSION}`,
    "control_plane:",
    `  tunnel_id: ${scalar(tunnelId)}`,
    `  api_key: ${scalar(`env:${OPENAI_TUNNEL_RUNTIME_KEY_ENV}`)}`,
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: ${scalar(mcp.toString())}`,
    "  extra_headers:",
    `    Authorization: ${scalar(`file:${input.authorizationFile}`)}`,
    "health:",
    "  listen_addr: 127.0.0.1:0",
    `  url_file: ${scalar(input.healthUrlFile)}`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  format: json",
    `  file: ${scalar(input.logFile)}`,
    "",
  ].join("\n");
}

function parseTriplet(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contractError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
