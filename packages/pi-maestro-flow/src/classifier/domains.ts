/**
 * Flow-owned classifier domains — registered by the classifier extension so
 * flow's own keyword classifiers can be shadowed/adjudicated by JEV.
 *
 * - `signal-type`: self-evolve candidate classification (knowhow/spec/unknown).
 *   The L0 rules delegate to `classifyCandidateType`: its `knowhow`/`spec`
 *   results are terminal (strong-signal hits and score wins stay authoritative),
 *   `unknown` is provisional — exactly the population the semantic layer exists
 *   to rescue or confirm.
 */

import type { ClassifyDomain } from "pi-maestro-teammate/v1/classify";
import { classifyCandidateType } from "../self-evolve/runtime.ts";
import type { CandidateType } from "../self-evolve/runtime.ts";

export interface SignalTypeInput {
  /** Signal text: title + summary + optional tool/episode hints. */
  text: string;
}

const SIGNAL_TYPE_CRITERIA: Record<CandidateType, string> = {
  knowhow:
    "A pitfall, failure lesson, workaround, or debugging insight: what failed, the root cause, and what to do differently. Includes Chinese markers like 陷阱/踩坑/教训/根因.",
  spec:
    "A design decision, architectural constraint, contract, or rule future work must follow. Includes Chinese markers like 决策/架构决定/约束/规范/约定.",
  unknown:
    "Process narration, progress reports, or content with no reusable knowledge signal — not worth staging.",
};

export const signalTypeDomain: ClassifyDomain<CandidateType, SignalTypeInput> = {
  name: "signal-type",
  modes: ["off", "shadow", "jev"],
  rules(input) {
    const label = classifyCandidateType(input.text);
    return { label, terminal: label !== "unknown" };
  },
  state(input) {
    return input.text.slice(0, 3_000);
  },
  questions: () => ({
    type: {
      type: "choice",
      instructions:
        "Classify this agent-session signal for a knowledge pipeline. knowhow = reusable failure/pitfall lesson; spec = a decision/constraint/rule; unknown = process narration with no reusable signal.",
      criteria: SIGNAL_TYPE_CRITERIA,
    },
    worthCapturing: {
      type: "noul",
      instructions: "This signal contains reusable engineering knowledge worth staging for future sessions.",
    },
  }),
  decide(answers) {
    const answer = answers.type;
    if (answer?.type !== "choice") return undefined;
    const label = answer.choice as CandidateType;
    if (!Object.hasOwn(SIGNAL_TYPE_CRITERIA, label)) return undefined;
    return {
      label,
      confidence: answer.confidence ?? answer.probabilities?.[answer.choice] ?? 0.5,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
    };
  },
  fallback: () => ({ label: "unknown", confidence: 0 }),
};

/** Build a domain-specific test input from free text (used by `/classifier test`). */
export function buildDomainTestInput(domain: string, text: string): unknown {
  if (domain === "retry-error") {
    const statusMatch = /\b([1-5]\d\d)\b/.exec(text);
    return {
      message: text,
      ...(statusMatch ? { status: Number(statusMatch[1]) } : {}),
    };
  }
  if (domain === "file-value") {
    const [path, ...rest] = text.split(/\s+/);
    return { path: path ?? text, nextAction: rest.join(" ") || undefined };
  }
  return { text };
}
