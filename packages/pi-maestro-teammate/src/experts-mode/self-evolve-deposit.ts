import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { KnowledgeHarvestSuggestion } from "./types.ts";

/**
 * P7b: deposit experts harvest suggestions into the self-evolve *pending*
 * suggestions pool (`~/.maestro/self-evolve/suggestions/YYYY-MM-DD.jsonl`).
 *
 * Compatible with SelfEvolveSignal schema (schemaVersion 1, kind candidate)
 * so `/self-evolve review` and auto-deposit can see them later.
 *
 * Never promotes. Never runs `maestro knowledge stage` here — that stays on
 * self-evolve auto-deposit after human/LLM review, or Leader manual stage.
 */

export interface SelfEvolvePoolDepositResult {
  written: number;
  skipped: number;
  filePath?: string;
  ids: string[];
  errors: string[];
}

export interface DepositToSelfEvolvePoolOptions {
  /** Override output root (default ~/.maestro/self-evolve or SELF_EVOLVE_OUTPUT_DIR). */
  outputRoot?: string;
  cwd?: string;
  sessionId?: string;
  runId?: string;
  project?: string;
  /** Skip ids already present in today's file (default true). */
  dedupe?: boolean;
}

export function selfEvolveOutputRoot(envValue?: string): string {
  const fromEnv = (envValue ?? process.env.SELF_EVOLVE_OUTPUT_DIR)?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".maestro", "self-evolve");
}

export function suggestionsDirPath(outputRoot: string): string {
  return path.join(outputRoot, "suggestions");
}

export function dailySuggestionFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}.jsonl`;
}

/** Map harvest suggestion → SelfEvolveSignal-compatible record. */
export function harvestToSelfEvolveSignal(
  suggestion: KnowledgeHarvestSuggestion,
  opts: {
    sessionId?: string;
    runId?: string;
    project?: string;
  } = {},
): Record<string, unknown> {
  const sessionId = suggestion.sessionId || opts.sessionId || "experts-session";
  const runId = suggestion.runId || opts.runId;
  const traceHash = suggestion.fingerprint;
  const id = `se-${traceHash.slice(0, 12)}`;
  const candidateType = suggestion.target === "spec" ? "spec" : "knowhow";
  const evidence: Array<{ type: string; ref: string; role?: string }> =
    (suggestion.evidence || []).map((ref) => ({
      type: "file",
      ref,
    }));
  if (suggestion.agentId) {
    evidence.push({ type: "tool", ref: `experts:${suggestion.agentId}` });
  }
  const title = suggestion.title.slice(0, 120);
  const summary = suggestion.content.slice(0, 2000);
  const stageHint = [
    "maestro knowledge stage",
    candidateType,
    JSON.stringify(title),
    "--content-file -",
    sessionId ? `--session ${sessionId}` : "",
    runId ? `--run ${runId}` : "",
    "--category",
    suggestion.kind,
  ].filter(Boolean).join(" ");

  return {
    schemaVersion: 1,
    id,
    kind: "candidate",
    source: "agent_end",
    dryRun: true,
    createdAt: suggestion.at || new Date().toISOString(),
    sessionId,
    ...(opts.project ? { project: opts.project } : {}),
    skill: "experts-harvest",
    ...(runId ? { runId } : {}),
    traceHash,
    candidateType,
    title,
    summary,
    evidence: evidence.length
      ? evidence
      : [{ type: "tool", ref: "experts-settle-harvest" }],
    suggestion: stageHint,
    trigger: {
      reason: `experts-harvest:${suggestion.kind}`,
    },
    // Non-schema extension fields (ignored by strict readers, useful for audit)
    expertsHarvestId: suggestion.id,
    expertsKind: suggestion.kind,
    expertsScore: suggestion.score,
  };
}

/**
 * Append harvest suggestions to today's self-evolve suggestions jsonl.
 */
export function depositHarvestToSelfEvolvePool(
  suggestions: readonly KnowledgeHarvestSuggestion[],
  opts: DepositToSelfEvolvePoolOptions = {},
): SelfEvolvePoolDepositResult {
  if (!suggestions.length) {
    return { written: 0, skipped: 0, ids: [], errors: [] };
  }
  const root = opts.outputRoot
    ? path.resolve(opts.outputRoot)
    : selfEvolveOutputRoot();
  const dir = suggestionsDirPath(root);
  const filePath = path.join(dir, dailySuggestionFileName());
  const errors: string[] = [];
  const ids: string[] = [];
  let written = 0;
  let skipped = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return {
      written: 0,
      skipped: suggestions.length,
      errors: [error instanceof Error ? error.message : String(error)],
      ids: [],
    };
  }

  const existing = new Set<string>();
  if (opts.dedupe !== false && fs.existsSync(filePath)) {
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { id?: string; traceHash?: string };
          if (row.id) existing.add(row.id);
          if (row.traceHash) existing.add(`th:${row.traceHash}`);
        } catch {
          /* skip bad line */
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const project = opts.project
    || (opts.cwd ? path.basename(opts.cwd) : undefined);

  const chunks: string[] = [];
  for (const suggestion of suggestions) {
    const signal = harvestToSelfEvolveSignal(suggestion, {
      sessionId: opts.sessionId,
      runId: opts.runId,
      project,
    });
    const id = String(signal.id);
    const th = `th:${String(signal.traceHash)}`;
    if (existing.has(id) || existing.has(th)) {
      skipped++;
      continue;
    }
    existing.add(id);
    existing.add(th);
    chunks.push(`${JSON.stringify(signal)}\n`);
    // Also write evidence markdown so stage template can use --content-file
    try {
      const evidenceDir = path.join(root, "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      const evidencePath = path.join(evidenceDir, `${id}.md`);
      if (!fs.existsSync(evidencePath)) {
        const body = [
          `# ${suggestion.title}`,
          "",
          suggestion.content,
          "",
          `source: experts-settle · kind: ${suggestion.kind} · score: ${suggestion.score}`,
          suggestion.agentId ? `agent: ${suggestion.agentId}` : "",
          suggestion.taskType ? `taskType: ${suggestion.taskType}` : "",
          suggestion.stage ? `stage: ${suggestion.stage}` : "",
        ].filter(Boolean).join("\n");
        fs.writeFileSync(evidencePath, `${body}\n`, "utf8");
      }
      // Upgrade suggestion command to real evidence file path
      signal.suggestion = [
        "maestro knowledge stage",
        signal.candidateType === "spec" ? "spec" : "knowhow",
        JSON.stringify(suggestion.title),
        "--content-file",
        evidencePath,
        opts.sessionId || suggestion.sessionId
          ? `--session ${opts.sessionId || suggestion.sessionId}`
          : "",
        opts.runId || suggestion.runId
          ? `--run ${opts.runId || suggestion.runId}`
          : "",
        "--category",
        suggestion.kind,
      ].filter(Boolean).join(" ");
      // rewrite last chunk with updated suggestion
      chunks[chunks.length - 1] = `${JSON.stringify(signal)}\n`;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    ids.push(id);
    written++;
  }

  if (chunks.length) {
    try {
      fs.appendFileSync(filePath, chunks.join(""), "utf8");
    } catch (error) {
      return {
        written: 0,
        skipped: suggestions.length,
        filePath,
        ids: [],
        errors: [...errors, error instanceof Error ? error.message : String(error)],
      };
    }
  }

  return { written, skipped, filePath, ids, errors };
}
