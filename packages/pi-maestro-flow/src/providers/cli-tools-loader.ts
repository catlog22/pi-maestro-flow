/**
 * Load and parse ~/.maestro/cli-tools.json configuration.
 *
 * Maps each enabled CLI tool to its provider configuration for
 * dynamic pi provider registration.
 *
 * Implementation moved to the shared pi-maestro-teammate cli-tools module so
 * the teammate layer (catalog injection + ACP execution backend) consumes the
 * same config; this path stays as a compatibility re-export.
 */

export * from "pi-maestro-teammate/v1/cli-tools";
