import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, statSync } from "node:fs";
import test from "node:test";
import { Check } from "typebox/value";
import { OcrReviewParams } from "../src/extension/schemas.ts";
import {
  encodeExtraHeaders,
  executeOcrReview,
  resolveOpenCodeReviewLlmEnv,
  scopeArgs,
} from "../src/tools/ocr-review.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function ocrOnPath(): boolean {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).some((dir) =>
    exts.some((ext) => {
      const candidate = join(dir.trim().replace(/^"|"$/g, ""), `ocr${ext.toLowerCase()}`);
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }),
  );
}

test("ocr-review params schema validates actions and scope flags", () => {
  assert.ok(Check(OcrReviewParams, { action: "preview" }));
  assert.ok(Check(OcrReviewParams, { action: "rules", paths: ["a.ts", "b.ts"] }));
  assert.ok(Check(OcrReviewParams, { action: "review", commit: "abc123", background: "ctx" }));
  assert.ok(Check(OcrReviewParams, { action: "health" }));
  assert.ok(!Check(OcrReviewParams, { action: "bogus" }));
  assert.ok(!Check(OcrReviewParams, { action: "review", extra: 1 }));
  assert.ok(Check(OcrReviewParams, { action: "preview", overallTimeoutMinutes: 5 }));
  assert.ok(!Check(OcrReviewParams, { action: "preview", overallTimeoutMinutes: 0 }));
  assert.ok(!Check(OcrReviewParams, { action: "preview", overallTimeoutMinutes: 35792 }));
});

test("ocr-review scopeArgs maps flags and rejects conflicts", () => {
  assert.deepEqual(scopeArgs({}), []);
  assert.deepEqual(scopeArgs({ commit: "abc" }), ["--commit", "abc"]);
  assert.deepEqual(
    scopeArgs({ from: "main", to: "feat" }),
    ["--from", "main", "--to", "feat"],
  );
  assert.deepEqual(scopeArgs({ exclude: "a,b" }), ["--exclude", "a,b"]);
  assert.throws(() => scopeArgs({ from: "main" }), /from.*to/);
  assert.throws(() => scopeArgs({ commit: "x", from: "a", to: "b" }), /either/i);
  assert.throws(() => scopeArgs({ resume: "s1", commit: "x" }), /resume/i);
});

test("open-code-review encodeExtraHeaders quotes comma values", () => {
  assert.equal(encodeExtraHeaders({}), "");
  assert.equal(encodeExtraHeaders({ "X-A": "1", "X-B": "v2" }), "X-A=1,X-B=v2");
  assert.equal(encodeExtraHeaders({ "X-C": "a,b" }), 'X-C="a,b"');
  assert.equal(encodeExtraHeaders({ "X-Keep": "yes", "X-Removed": null }), "X-Keep=yes");
});

test("open-code-review inherits runtime-resolved API manager gateway auth", async () => {
  const model = {
    provider: "managed-gateway",
    id: "review-model",
    api: "openai-responses",
    baseUrl: "https://stale.example/v1",
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(received: unknown) {
        assert.equal(received, model);
        return {
          ok: true as const,
          apiKey: "runtime-token",
          baseUrl: "https://gateway.example/v1",
          headers: { "X-Gateway": "active", "X-Route": "review" },
        };
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(await resolveOpenCodeReviewLlmEnv(ctx, "session"), {
    OCR_LLM_URL: "https://gateway.example/v1",
    OCR_LLM_TOKEN: "runtime-token",
    OCR_LLM_MODEL: "review-model",
    OCR_LLM_PROTOCOL: "openai-responses",
    OCR_LLM_EXTRA_HEADERS: "X-Gateway=active,X-Route=review",
  });
});

test("open-code-review adapts inherited OpenAI Codex Responses auth", async () => {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  })).toString("base64url");
  const token = `header.${payload}.signature`;
  const model = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
  const ctx = {
    cwd: process.cwd(),
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(received: unknown) {
        assert.equal(received, model);
        return { ok: true as const, apiKey: token, headers: { "X-Route": "review" } };
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(await resolveOpenCodeReviewLlmEnv(ctx, "session"), {
    OCR_LLM_URL: "https://chatgpt.com/backend-api/codex",
    OCR_LLM_TOKEN: token,
    OCR_LLM_MODEL: "gpt-5.6-sol",
    OCR_LLM_PROTOCOL: "openai-responses",
    OCR_LLM_EXTRA_HEADERS: "X-Route=review,chatgpt-account-id=account-123,originator=pi,OpenAI-Beta=responses=experimental",
  });
});

test("open-code-review deterministic actions honor explicit deadlines without resolving model auth", async () => {
  const ctx = { cwd: process.cwd(), model: undefined } as unknown as ExtensionContext;
  const calls: { args: string[]; timeoutMs?: number }[] = [];
  const runner: Parameters<typeof executeOcrReview>[3] = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return { stdout: "{}", stderr: "", exitCode: 0 };
  };
  assert.notEqual((await executeOcrReview({ action: "preview", overallTimeoutMinutes: 5 }, undefined, ctx, runner)).isError, true);
  assert.equal(calls.at(-1)?.timeoutMs, 300_000);
  assert.notEqual((await executeOcrReview({ action: "rules", paths: ["a.ts"], overallTimeoutMinutes: 3 }, undefined, ctx, runner)).isError, true);
  assert.equal(calls.at(-1)?.timeoutMs, 180_000);
  await executeOcrReview({ action: "preview" }, undefined, ctx, runner);
  assert.equal(calls.at(-1)?.timeoutMs, 120_000);
  for (const overallTimeoutMinutes of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const count = calls.length;
    assert.equal((await executeOcrReview({ action: "preview", overallTimeoutMinutes }, undefined, ctx, runner)).isError, true);
    assert.equal(calls.length, count);
  }
});

test("open-code-review health applies explicit deadlines to both processes and keeps defaults", async () => {
  const model = { provider: "test", id: "review", api: "openai-responses", baseUrl: "https://example.invalid" };
  const ctx = {
    cwd: process.cwd(), model,
    modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; } },
  } as unknown as ExtensionContext;
  const calls: { args: string[]; timeoutMs?: number }[] = [];
  const runner: Parameters<typeof executeOcrReview>[3] = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  };
  await executeOcrReview({ action: "health", model: "session", overallTimeoutMinutes: 5 }, undefined, ctx, runner);
  assert.deepEqual(calls.map((call) => call.timeoutMs), [300_000, 300_000]);
  calls.length = 0;
  await executeOcrReview({ action: "health", model: "session" }, undefined, ctx, runner);
  assert.deepEqual(calls.map((call) => call.timeoutMs), [30_000, 90_000]);
  calls.length = 0;
  await executeOcrReview({ action: "review", model: "session", overallTimeoutMinutes: 7 }, undefined, ctx, runner);
  assert.equal(calls[0]?.timeoutMs, 420_000);
});

test("open-code-review preview returns JSON file selection (requires ocr)", { skip: !ocrOnPath(), timeout: 120_000 }, async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "ocr-preview "));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, "source file.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  execFileSync("git", ["-c", "user.name=OCR Test", "-c", "user.email=ocr@example.invalid", "commit", "-qm", "fixture"], { cwd: repo, windowsHide: true });
  await writeFile(join(repo, "source file.ts"), "export const value = 2;\n");
  await writeFile(join(repo, "new.ts"), "export const added = true;\n");
  const ctx = { cwd: repo, model: undefined } as unknown as ExtensionContext;
  const result = await executeOcrReview({ action: "preview" }, undefined, ctx);
  assert.notEqual(result.isError, true);
  const text = result.content.find((item) => item.type === "text");
  const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
    schema_version?: string;
    mode?: string;
    reviewable_files?: unknown[];
  };
  assert.equal(parsed.schema_version, "1");
  assert.ok(["workspace", "range", "commit"].includes(parsed.mode ?? ""));
  assert.ok(Array.isArray(parsed.reviewable_files));
  const files = parsed.reviewable_files as { path: string; status: string }[];
  assert.ok(files.some((file) => file.path === "source file.ts"));
  assert.ok(files.some((file) => file.path === "new.ts" && file.status === "added"));
});
