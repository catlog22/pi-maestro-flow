import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type GenericProviderFormat = "openai" | "anthropic";

interface StoredProviderSettings {
  version: 1;
  format: GenericProviderFormat;
  baseUrl: string;
  modelId: string;
}

interface GenericProviderDefinition {
  id: string;
  name: string;
  format: GenericProviderFormat;
  api: "openai-completions" | "anthropic-messages";
  defaultBaseUrl: string;
  defaultModelId: string;
}

const PROVIDERS: readonly GenericProviderDefinition[] = [
  {
    id: "maestro-openai",
    name: "Maestro Custom OpenAI",
    format: "openai",
    api: "openai-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModelId: "gpt-5",
  },
  {
    id: "maestro-anthropic",
    name: "Maestro Custom Anthropic",
    format: "anthropic",
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModelId: "claude-sonnet-4-5",
  },
];

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

export function normalizeBaseUrl(value: string, fallback: string): string {
  const normalized = (value.trim() || fallback).replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  return normalized;
}

export function encodeProviderSettings(settings: StoredProviderSettings): string {
  return JSON.stringify(settings);
}

export function decodeProviderSettings(
  credentials: Pick<OAuthCredentials, "refresh">,
): StoredProviderSettings {
  const parsed = JSON.parse(credentials.refresh) as Partial<StoredProviderSettings>;
  if (parsed.version !== 1 || (parsed.format !== "openai" && parsed.format !== "anthropic")) {
    throw new Error("Unsupported Maestro provider credential format");
  }
  return {
    version: 1,
    format: parsed.format,
    baseUrl: required(parsed.baseUrl ?? "", "Base URL"),
    modelId: required(parsed.modelId ?? "", "Model ID"),
  };
}

async function loginGenericProvider(
  callbacks: OAuthLoginCallbacks,
  definition: GenericProviderDefinition,
): Promise<OAuthCredentials> {
  const baseUrl = normalizeBaseUrl(
    await callbacks.onPrompt({
      message: `${definition.name} base URL:`,
      placeholder: definition.defaultBaseUrl,
    }),
    definition.defaultBaseUrl,
  );
  const modelId = required(
    (await callbacks.onPrompt({
      message: `${definition.name} model ID:`,
      placeholder: definition.defaultModelId,
    })).trim() || definition.defaultModelId,
    "Model ID",
  );
  const apiKey = required(
    await callbacks.onPrompt({ message: `${definition.name} API key:` }),
    "API key",
  );

  return {
    access: apiKey,
    refresh: encodeProviderSettings({
      version: 1,
      format: definition.format,
      baseUrl,
      modelId,
    }),
    expires: Number.MAX_SAFE_INTEGER,
  };
}

export function registerLoginProviderConfigs(pi: ExtensionAPI): void {
  if (typeof pi.registerProvider !== "function") return;

  for (const definition of PROVIDERS) {
    pi.registerProvider(definition.id, {
      name: definition.name,
      baseUrl: definition.defaultBaseUrl,
      api: definition.api,
      models: [{
        id: definition.defaultModelId,
        name: definition.defaultModelId,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      }],
      oauth: {
        name: `${definition.name} (URL + API key)`,
        login: (callbacks) => loginGenericProvider(callbacks, definition),
        async refreshToken(credentials) {
          return credentials;
        },
        getApiKey(credentials) {
          return credentials.access;
        },
        modifyModels(models, credentials) {
          const settings = decodeProviderSettings(credentials);
          return models.map((model) => ({
            ...model,
            id: settings.modelId,
            name: settings.modelId,
            baseUrl: settings.baseUrl,
          }));
        },
      },
    });
  }
}

