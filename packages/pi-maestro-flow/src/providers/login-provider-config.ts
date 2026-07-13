import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface GenericProviderDefinition {
  id: string;
  name: string;
  api: "openai-responses" | "anthropic-messages";
  apiKey: string;
  baseUrl: string;
  model: {
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap?: { off: null };
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  };
}

const PROVIDERS: readonly GenericProviderDefinition[] = [
  {
    id: "maestro-openai",
    name: "Maestro OpenAI",
    api: "openai-responses",
    apiKey: "$OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: {
      id: "gpt-5",
      name: "GPT-5",
      reasoning: true,
      thinkingLevelMap: { off: null },
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    },
  },
  {
    id: "maestro-anthropic",
    name: "Maestro Anthropic",
    api: "anthropic-messages",
    apiKey: "$ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    model: {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  },
];

export function registerLoginProviderConfigs(pi: ExtensionAPI): void {
  if (typeof pi.registerProvider !== "function") return;

  for (const definition of PROVIDERS) {
    pi.registerProvider(definition.id, {
      name: definition.name,
      baseUrl: definition.baseUrl,
      api: definition.api,
      apiKey: definition.apiKey,
      models: [{ ...definition.model }],
    });
  }
}
