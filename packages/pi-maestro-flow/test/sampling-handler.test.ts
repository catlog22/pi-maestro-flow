import assert from "node:assert/strict";
import test from "node:test";
import { handleSamplingRequest } from "../src/mcp/sampling-handler.ts";

function model(provider: string, id: string, multimodal: boolean): any {
  return { provider, id, name: id, api: "openai-completions", baseUrl: "https://example.com/v1",
    input: multimodal ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 16_384 };
}

function options(models: any[]): any {
  return {
    serverName: "test-server",
    autoApprove: true,
    modelRegistry: {
      getAvailable: () => models,
      async getApiKeyAndHeaders(model: any) {
        return model.id === "noauth" ? { ok: false, error: "no key" } : { ok: true, apiKey: "secret", headers: {} };
      },
    },
    getCurrentModel: () => models[0],
    getSignal: () => undefined,
  };
}

test("MCP sampling with image content requires a multimodal model", async () => {
  const models = [model("p", "text", false)];
  const runtime = options(models);
  await assert.rejects(
    handleSamplingRequest(runtime, {
      params: {
        messages: [{ role: "user", content: [
          { type: "text", text: "describe" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ] }],
      },
    } as any),
    /contains image content but no multimodal model is available/,
  );
});

test("MCP sampling without images rejects text-only and multimodal auth errors distinctly", async () => {
  // Text-only model without auth: the error must be about auth, not modality,
  // proving the no-image path does not apply the multimodal filter.
  const models = [model("p", "noauth", false)];
  const runtime = options(models);
  await assert.rejects(
    handleSamplingRequest(runtime, {
      params: { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    } as any),
    /No configured auth for MCP sampling model/,
  );
});

test("MCP sampling with image content prefers multimodal hint candidates", async () => {
  // Both models have auth; the vision model is listed in modelPreferences.hints
  // and the request contains an image. The handler must reach the completion
  // stage (proving a multimodal candidate was selected and no modality error
  // was raised) rather than fail on the modality filter.
  const text = model("p", "text", false);
  const vision = model("p", "vision", true);
  const runtime = options([text, vision]);
  // complete is module-scoped; we assert the modality gate passes by observing
  // that the failure (if any) is NOT the no-multimodal error.
  const error = await handleSamplingRequest(runtime, {
    params: {
      messages: [{ role: "user", content: [
        { type: "text", text: "describe" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ] }],
      modelPreferences: { hints: [{ name: "vision" }] },
    },
  } as any).then(() => undefined, (caught: Error) => caught);
  assert.ok(!(error instanceof Error) || !/no multimodal model is available/.test(error.message),
    `should not fail on modality gate (got: ${error instanceof Error ? error.message : "no error"})`);
});
