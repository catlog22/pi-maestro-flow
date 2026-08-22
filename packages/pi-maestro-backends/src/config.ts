/**
 * Backend configuration resolution: validate a registration's values against
 * the declaring backend's own fields, apply defaults, and record what an `auto`
 * value resolved to.
 *
 * Resolution runs once at registration rather than per dispatch. A typo in a
 * mode name must fail while the operator is still looking at the file, not
 * three tasks into a graph.
 */

import type {
  BackendConfigField,
  ConfigValue,
  ResolvedBackendConfig,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";

/**
 * Check one value against its declared field.
 *
 * @param field - the declaring field.
 * @param value - the configured value.
 * @returns an error message, or undefined when the value is acceptable.
 */
function validateField(field: BackendConfigField, value: ConfigValue): string | undefined {
  switch (field.kind) {
    case "text":
    case "path":
    case "credential-ref":
    // A dynamic field's valid set lives in the executing system and costs a
    // probe to read, so registration checks the type and leaves membership to
    // the backend that can actually answer it. Validating harder here would
    // make a hand-written registration depend on reaching that system, and
    // would reject a value the system added since the last probe.
    case "dynamic-enum":
      return typeof value === "string" ? undefined : `expected a string, got ${typeof value}`;
    case "integer":
      if (typeof value !== "number") return `expected a number, got ${typeof value}`;
      return Number.isInteger(value) ? undefined : `expected an integer, got ${value}`;
    case "number":
      return typeof value === "number" ? undefined : `expected a number, got ${typeof value}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `expected a boolean, got ${typeof value}`;
    case "string-list":
      if (!Array.isArray(value)) return `expected an array of strings, got ${typeof value}`;
      return value.every((item) => typeof item === "string")
        ? undefined
        : "expected every item to be a string";
    case "enum": {
      if (typeof value !== "string") return `expected a string, got ${typeof value}`;
      const allowed = (field.options ?? []).map((option) => option.value);
      if (allowed.length === 0) return "declares kind \"enum\" but no options";
      return allowed.includes(value)
        ? undefined
        : `expected one of ${allowed.join(" | ")}, got "${value}"`;
    }
  }
}

/**
 * Validate and default a backend registration's configuration.
 *
 * Unknown keys are errors rather than ignored values: a misspelled key that is
 * silently dropped produces a run configured differently from what the file
 * says, which is the failure this whole step exists to prevent.
 *
 * @param backend - the backend whose fields govern this configuration.
 * @param config - raw values from the registration document.
 * @returns the resolved values plus every rejection found.
 */
export function resolveBackendConfig(
  backend: TeammateBackend,
  config: Record<string, ConfigValue> = {},
): ResolvedBackendConfig {
  const fields = backend.configFields ?? [];
  const errors: string[] = [];

  if (fields.length === 0) {
    for (const key of Object.keys(config)) {
      errors.push(`backend "${backend.name}" accepts no configuration, but "${key}" was set`);
    }
    return { values: {}, errors };
  }

  if (backend.resolveConfig === undefined) {
    return {
      values: {},
      errors: [
        `backend "${backend.name}" declares ${fields.length} configuration field(s) `
        + "but implements no resolveConfig, so its values cannot be validated",
      ],
    };
  }

  // A dynamic field's values come from the executing system, so the declaration
  // alone cannot describe it. Declaring one without the lister leaves a
  // configuration surface with a choice it can never populate — a field that
  // renders as empty rather than as broken, which is the failure the pairing
  // check exists to prevent.
  const dynamic = fields.filter((field) => field.kind === "dynamic-enum");
  if (dynamic.length > 0 && backend.listConfigOptions === undefined) {
    return {
      values: {},
      errors: [
        `backend "${backend.name}" declares dynamic-enum field(s) `
        + `${dynamic.map((field) => `"${field.key}"`).join(", ")} `
        + "but implements no listConfigOptions, so their values can never be listed",
      ],
    };
  }

  const declared = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(config)) {
    if (declared.has(key)) continue;
    const known = [...declared.keys()].join(", ");
    errors.push(`backend "${backend.name}" has no setting "${key}" (known: ${known})`);
  }

  const values: Record<string, ConfigValue> = {};
  for (const field of fields) {
    const raw = config[field.key];
    if (raw === undefined) {
      if (field.default !== undefined) values[field.key] = field.default;
      else if (field.required === true) {
        errors.push(`backend "${backend.name}" requires setting "${field.key}"`);
      }
      continue;
    }
    const failure = validateField(field, raw);
    if (failure !== undefined) errors.push(`backend "${backend.name}" setting "${field.key}": ${failure}`);
    else values[field.key] = raw;
  }

  if (errors.length > 0) return { values, errors };

  // Only a configuration that survives generic validation reaches the backend's
  // own resolution, so a backend never has to defend against shapes the
  // declaration already rejects.
  const resolved = backend.resolveConfig(values);
  // Advisory warnings survive resolution: a backend that flags a workable but
  // risky configuration is speaking to the operator, and dropping the message
  // here would silence it before anyone read it.
  return resolved.warnings === undefined
    ? { values: resolved.values, errors: resolved.errors }
    : { values: resolved.values, errors: resolved.errors, warnings: resolved.warnings };
}
