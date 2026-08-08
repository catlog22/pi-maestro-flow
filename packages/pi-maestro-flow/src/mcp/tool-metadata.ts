import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerEntry } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode } from "./utils.ts";

export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: "server" | "none" | "short"
): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];

  for (const tool of tools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
      continue;
    }
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: tool._meta });
    } catch {
      failedTools.push(tool.name);
    }
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri,
      uiStreamMode: extractToolUiStreamMode(tool._meta),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) {
        continue;
      }

      metadata.push({
        name: formatToolName(baseName, serverName, prefix),
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  return { metadata, failedTools };
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return state.toolMetadata.get(serverName)?.map(m => m.name) ?? [];
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.length;
  }
  return count;
}

export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find(m => m.name === toolName);
  if (exact) return exact;
  const normalized = toolName.replace(/-/g, "_");
  return metadata.find(m => m.name.replace(/-/g, "_") === normalized);
}

const SCHEMA_FORMAT_LIMITS = {
  maxDepth: 8,
  maxLines: 200,
  maxChars: 16_000,
  maxEnumItems: 20,
  maxValueChars: 240,
} as const;

export function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const s = schema as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof s.description === "string" && s.description.trim()) {
    lines.push(`${indent}${truncateInline(s.description.trim())}`);
  }

  if (s.type === "object" && s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.filter((name): name is string => typeof name === "string") : [];

    if (Object.keys(props).length === 0) {
      lines.push(`${indent}(no parameters)`);
      return boundFormattedSchema(lines, indent);
    }

    for (const [name, propSchema] of Object.entries(props)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent, 0));
    }
    return boundFormattedSchema(lines, indent);
  }

  lines.push(...formatNestedSchema(s, indent, 0));
  if (lines.length > 0) return boundFormattedSchema(lines, indent);

  const typeStr = formatType(s);
  if (typeStr) lines.push(`${indent}(${typeStr})`);
  else lines.push(`${indent}(complex schema)`);
  return boundFormattedSchema(lines, indent);
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string, depth: number): string[] {
  if (depth >= SCHEMA_FORMAT_LIMITS.maxDepth) {
    return [`${indent}${name}${required ? " *required*" : ""} ... [nested schema omitted]`];
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const s = schema as Record<string, unknown>;
  const parts = [`${indent}${name}`];
  const typeStr = formatType(s);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  appendSchemaAnnotations(parts, s);

  return [parts.join(" "), ...formatNestedSchema(s, `${indent}  `, depth + 1)];
}

function formatNestedSchema(schema: Record<string, unknown>, indent: string, depth: number): string[] {
  if (depth >= SCHEMA_FORMAT_LIMITS.maxDepth) {
    return hasNestedSchema(schema) ? [`${indent}... [nested schema omitted]`] : [];
  }
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent, depth + 1));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent, depth + 1));
  }
  if (schema.items !== undefined) {
    lines.push(...formatProperty("items", schema.items, false, indent, depth + 1));
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    for (const [name, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent, depth + 1));
    }
  }

  return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: unknown[], indent: string, depth: number): string[] {
  if (depth >= SCHEMA_FORMAT_LIMITS.maxDepth) return [`${indent}${keyword}: ... [nested schema omitted]`];
  const lines = [`${indent}${keyword}:`];

  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      lines.push(`${indent}  - ${formatSchemaValue(variant)}`);
      continue;
    }

    const s = variant as Record<string, unknown>;
    const typeStr = formatType(s) || "schema";
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, s);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(s, `${indent}    `, depth + 1));
  }

  return lines;
}

function formatType(schema: Record<string, unknown>): string {
  if (Object.hasOwn(schema, "const")) {
    return `const ${formatSchemaValue(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    const shown = schema.enum.slice(0, SCHEMA_FORMAT_LIMITS.maxEnumItems).map(formatSchemaValue);
    const omitted = schema.enum.length - shown.length;
    return `enum: ${shown.join(", ")}${omitted > 0 ? `, ... (+${omitted} more)` : ""}`;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map(type => String(type)).join(" | ");
  }

  if (schema.type) {
    return String(schema.type);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    return "object";
  }

  if (schema.items !== undefined) {
    return "array";
  }

  return "";
}

function appendSchemaAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (schema.description && typeof schema.description === "string") {
    parts.push(`- ${truncateInline(schema.description)}`);
  }

  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "pattern"] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${formatSchemaValue(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${formatSchemaValue(schema.default)}]`);
  }
}

function hasNestedSchema(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.anyOf)
    || Array.isArray(schema.oneOf)
    || schema.items !== undefined
    || (!!schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties));
}

function formatSchemaValue(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return truncateInline(rendered);
}

function truncateInline(value: string): string {
  if (value.length <= SCHEMA_FORMAT_LIMITS.maxValueChars) return value;
  return `${value.slice(0, SCHEMA_FORMAT_LIMITS.maxValueChars - 3)}...`;
}

function boundFormattedSchema(lines: string[], indent: string): string {
  let truncated = lines.length > SCHEMA_FORMAT_LIMITS.maxLines;
  let text = lines.slice(0, SCHEMA_FORMAT_LIMITS.maxLines).join("\n");
  const notice = `${indent}... [schema output truncated]`;
  const separator = text ? "\n" : "";
  if (text.length > SCHEMA_FORMAT_LIMITS.maxChars) truncated = true;
  if (!truncated) return text;
  const budget = Math.max(0, SCHEMA_FORMAT_LIMITS.maxChars - separator.length - notice.length);
  if (text.length > budget) text = text.slice(0, budget);
  return `${text}${separator}${notice}`;
}
