import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getSessionModelRoutingPath,
  loadModelRoutingConfig,
} from "pi-maestro-teammate/v1/model-routing";
import { createTeammateSessionRoutingTool } from "../src/tools/teammate-session-routing.ts";

function mockCtx(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

test("teammate-session-routing writes session overrides and reflects them in the next read", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-routing-tool-"));
  const cwd = join(root, "project");
  const globalPath = join(root, "home", "teammate-models.json");
  // The tool uses the default global path resolution; point HOME so the global
  // config lands under our temp tree and stays isolated from the real machine.
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  const sessionId = "pi-session-tool-test-001";
  try {
    const tool = createTeammateSessionRoutingTool();
    const result = await tool.execute(
      "call-1",
      {
        mappings: { analysis: "maestro-openai/gpt-5.6-sol" },
        thinkingLevels: { analysis: "high" },
      },
      new AbortController().signal,
      undefined,
      mockCtx(cwd, sessionId),
    );

    assert.equal(result.isError, undefined);
    const details = result.details as { session_id: string; file: string; effective: Array<{ taskType: string; model: string | null; thinking: string }> };
    assert.equal(details.session_id, sessionId);
    assert.match(details.file, /teammate-models\.session\.pi-session-tool-test-001\.json/);
    assert.equal(existsSync(join(cwd, ".pi", "teammate-models.session.pi-session-tool-test-001.json")), true);

    const analysis = details.effective.find((entry) => entry.taskType === "analysis");
    assert.equal(analysis?.model, "maestro-openai/gpt-5.6-sol");
    assert.equal(analysis?.thinking, "high");

    // The library reader now sees the session override (proves the dispatch
    // path will route to it on the next teammate call).
    const cfg = loadModelRoutingConfig(cwd, globalPath, sessionId);
    assert.equal(cfg.mappings.analysis, "maestro-openai/gpt-5.6-sol");
    assert.equal(cfg.thinkingLevels.analysis, "high");

    // Without the session id the override is invisible (session isolation).
    const baseline = loadModelRoutingConfig(cwd, globalPath);
    assert.equal(baseline.mappings.analysis, undefined);
  } finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("teammate-session-routing clear drops all session overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-routing-clear-"));
  const cwd = join(root, "project");
  const sessionId = "pi-session-tool-test-002";
  try {
    const tool = createTeammateSessionRoutingTool();
    await tool.execute(
      "call-1",
      { mappings: { review: "maestro-qwen/qwen3.8-max" } },
      new AbortController().signal,
      undefined,
      mockCtx(cwd, sessionId),
    );
    assert.equal(existsSync(getSessionModelRoutingPath(cwd, sessionId)), true);

    const result = await tool.execute(
      "call-2",
      { clear: true },
      new AbortController().signal,
      undefined,
      mockCtx(cwd, sessionId),
    );
    const details = result.details as { cleared: boolean };
    assert.equal(details.cleared, true);

    // After clear, the session file holds empty rules, so the effective
    // config falls back to the global/project baseline (no session override).
    const cfg = loadModelRoutingConfig(cwd, undefined, sessionId);
    assert.ok(
      cfg.mappings.review === undefined || cfg.mappings.review === null,
      `review should not carry a session override after clear (got ${String(cfg.mappings.review)})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("teammate-session-routing rejects unknown taskTypes with a thrown error", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-routing-unknown-"));
  const cwd = join(root, "project");
  const sessionId = "pi-session-tool-test-003";
  try {
    const tool = createTeammateSessionRoutingTool();
    await assert.rejects(
      () => tool.execute(
        "call-1",
        { mappings: { bogus_type: "maestro-openai/gpt-5.6-sol" } },
        new AbortController().signal,
        undefined,
        mockCtx(cwd, sessionId),
      ),
      /No valid overrides after normalization/,
    );
    assert.equal(existsSync(getSessionModelRoutingPath(cwd, sessionId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
