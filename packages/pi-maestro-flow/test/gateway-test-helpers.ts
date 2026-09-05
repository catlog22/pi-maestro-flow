import { join } from "node:path";
import { defaultGatewayConfig, type GatewayAuthConfig, type GatewayConfig } from "../src/gateway/config.ts";

export function createTestGatewayConfig(root: string, auth: GatewayAuthConfig = { mode: "open" }): GatewayConfig {
  const config = defaultGatewayConfig();
  config.auth = structuredClone(auth);
  config.server.host = "127.0.0.1";
  config.server.port = 9090;
  config.transport.http = { enabled: false, host: "127.0.0.1", port: 9090, path: "/mcp" };
  config.workspaces = [{ path: root, mode: "permanent" }];
  config.state = {
    rootDir: join(root, "state"),
    ownerPath: join(root, "state", "owner.json"),
    workspaceRegistryPath: join(root, "state", "workspaces.json"),
  };
  return config;
}
