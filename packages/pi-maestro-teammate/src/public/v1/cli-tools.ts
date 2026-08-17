/**
 * Version 1 public cli-tools contract.
 *
 * Standalone teammate CLI tool configuration (teammate-cli-tools.json, global
 * + project) driving `cli/<tool>` catalog injection and the local/SSH ACP
 * execution backends. Also exposes the legacy Maestro delegate loader
 * (loadMaestroDelegateConfig) for pi-maestro-flow's provider registration.
 */
export * from "../../cli-tools/cli-tools-config.ts";
