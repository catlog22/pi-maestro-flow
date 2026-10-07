import { registerClassifyDomain, type ClassifyDomain } from "pi-maestro-teammate/v1/classify";
import { defaultDecisionPolicy, type DecisionPolicy, type PolicyDomain } from "./config.ts";

export interface PolicyClassification {
  owner: "internal" | "external" | "uncertain";
  candidateType: "knowhow" | "spec" | "unknown";
  worthCapturing: boolean;
  confidence: number;
  matchedRuleIds: string[];
  rationale: string;
}
export const POLICY_CLASSIFY_NAMES = { ask: "decision-owner", "evolve-capture": "evolve-capture", "evolve-review": "evolve-review" } as const;
export function registerDecisionPolicyDomains(): void {
  const policy = defaultDecisionPolicy();
  for (const domain of ["ask", "evolve-capture", "evolve-review"] as const) registerClassifyDomain(policyClassifyDomain(domain, policy));
}
export function policyClassifyDomain(domain: PolicyDomain, policy: DecisionPolicy): ClassifyDomain<string, { text: string }> {
  const rules = policy.rules.filter((rule) => rule.domain === domain);
  const criteria: Record<string, string> = domain === "evolve-capture"
    ? { knowhow: "Reusable failure/pitfall lesson", spec: "Prescriptive rule/trade-off", unknown: "No reusable knowledge" }
    : { internal: "Policy permits an agent recommendation", external: "Human preference/authorization needed", uncertain: "Insufficient policy/evidence" };
  return {
    name: POLICY_CLASSIFY_NAMES[domain], modes: ["off", "shadow", "jev"],
    rules: () => undefined,
    state: (input) => input.text,
    questions: () => ({
      verdict: { type: "choice", instructions: domain === "evolve-capture" ? "Classify reusable knowledge; process narration is unknown." : "Who owns this decision under the confirmed policy? Internal is advisory only, never approval.", criteria },
      rule: { type: "choice", instructions: "Choose the confirmed rule supporting the verdict, or none.", criteria: Object.fromEntries([["none", "No applicable rule"], ...rules.map((rule) => [rule.id, rule.instruction])]) },
      worth: { type: "noul", instructions: "This input contains reusable knowledge worth extracting, rather than narration." },
    }),
    decide(answers) {
      if (answers.verdict?.type !== "choice" || answers.rule?.type !== "choice" || answers.worth?.type !== "noul") return undefined;
      const verdict = answers.verdict;
      const value: PolicyClassification = {
        owner: domain === "evolve-capture" ? "uncertain" : verdict.choice as PolicyClassification["owner"],
        candidateType: domain === "evolve-capture" ? verdict.choice as PolicyClassification["candidateType"] : "unknown",
        worthCapturing: answers.worth.noul >= policy.minConfidence,
        confidence: Math.min(verdict.confidence ?? verdict.probabilities?.[verdict.choice] ?? 0, answers.rule.confidence ?? answers.rule.probabilities?.[answers.rule.choice] ?? 0),
        matchedRuleIds: answers.rule.choice === "none" ? [] : [answers.rule.choice],
        rationale: "Classifier verdict under the confirmed project rules.",
      };
      return { label: JSON.stringify(value), confidence: value.confidence };
    },
    fallback: () => ({ label: "", confidence: 0 }),
  };
}
