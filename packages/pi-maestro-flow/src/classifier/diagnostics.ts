import { open, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, classifierConfig, classifierStatus, listClassifyDomains } from "pi-maestro-teammate/v1/classify";
import { loadDecisionPolicy, type PolicyDomain } from "../decision-policy/config.ts";
import { POLICY_CLASSIFY_NAMES, policyClassifyDomain } from "../decision-policy/domains.ts";
import { evaluateDecisionPolicy } from "../decision-policy/service.ts";
import { envOverrideForSelfEvolve, normalizeSelfEvolveConfig, selfEvolveConfigPath } from "../self-evolve/runtime.ts";
import { loadEnhanceConfig } from "../prompt-enhance/config.ts";
import { buildDomainTestInput } from "./domains.ts";

export const DIAGNOSTIC_INPUT_LIMIT = 3000;
export function diagnosticText(value: unknown, limit = 500): string {
  return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, limit);
}
export function boundedDiagnosticInput(text: string): string {
  if (!text.trim()) throw new Error("Diagnostic text is required.");
  if (text.length > DIAGNOSTIC_INPUT_LIMIT) throw new Error(`Diagnostic text exceeds ${DIAGNOSTIC_INPUT_LIMIT} characters.`);
  const clean = diagnosticText(text, DIAGNOSTIC_INPUT_LIMIT).trim();
  if (!clean) throw new Error("Diagnostic text is required.");
  return clean;
}
export const policyDiagnosticDomain = (name: string): PolicyDomain | undefined =>
  (Object.keys(POLICY_CLASSIFY_NAMES) as PolicyDomain[]).find(domain => POLICY_CLASSIFY_NAMES[domain] === name);

/** Cancellation fences the consumer. The shared classify API has no transport AbortSignal. */
export async function diagnosticWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw new Error("Classifier diagnostic cancelled."); }
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Classifier diagnostic cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function freshPolicy(cwd: string) {
  try {
    const policy = await loadDecisionPolicy(cwd);
    if (!policy) throw new Error("Missing .pi/decision-policy.json; run /skill:decision-policy.");
    return policy;
  } catch (error) { throw new Error(`Current project policy unavailable: ${diagnosticText(error)}`); }
}
/** Fresh object/questions every call: never classify a policy domain by registry history. */
export async function rawClassifierDiagnostic(ctx: ExtensionContext, name: string, text: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const input = boundedDiagnosticInput(text);
  const cwd = ctx.cwd;
  const session = ctx.sessionManager?.getSessionId();
  const policyDomain = policyDiagnosticDomain(name);
  const domain = policyDomain ? policyClassifyDomain(policyDomain, await freshPolicy(cwd)) : name;
  signal.throwIfAborted();
  if (ctx.cwd !== cwd || ctx.sessionManager?.getSessionId() !== session) throw new Error("Diagnostic session/project changed.");
  if (!listClassifyDomains().includes(name) && !policyDomain) throw new Error(`Unknown domain: ${diagnosticText(name)}`);
  const requested = classifierStatus().enabled ? classifierConfig().domains?.[name] ?? "off" : "off";
  const modes = typeof domain === "string" ? classifierStatus().domains[name]?.supportedModes : domain.modes;
  const mode = modes?.includes(requested) ? requested : "off";
  const result = await diagnosticWait(classify(domain, buildDomainTestInput(name, input)), signal);
  signal.throwIfAborted();
  if (ctx.cwd !== cwd || ctx.sessionManager?.getSessionId() !== session) throw new Error("Diagnostic session/project changed.");
  return [`Raw domain ${name} · mode=${mode} · backend=${result.layer} · layer=${result.layer}`, `label=${diagnosticText(result.label, 2000)} · confidence=${result.confidence.toFixed(2)} · model=${diagnosticText(result.model) || "none"}`,
    `fallback/degraded=${diagnosticText(result.degradedReason) || "none"}`, "Raw off/shadow/JEV rules; not business advice or authorization. Shadow may finish in background."];
}
export async function businessPolicyDiagnostic(ctx: ExtensionContext, domain: PolicyDomain, text: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const input = boundedDiagnosticInput(text);
  const cwd = ctx.cwd;
  const session = ctx.sessionManager.getSessionId();
  await freshPolicy(cwd);
  signal.throwIfAborted();
  if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== session) throw new Error("Diagnostic session/project changed.");
  // Existing singleton owns classification/advice budgets; never reset/force-enable.
  const result = await diagnosticWait(evaluateDecisionPolicy(domain, input, ctx, { signal, advice: false }), signal);
  signal.throwIfAborted();
  if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== session) throw new Error("Diagnostic session/project changed.");
  return [`Business policy ${domain} · mode=${result.mode} · backend=${result.backend}`, `owner=${result.owner} · candidate=${result.candidateType} · confidence=${result.confidence.toFixed(2)}`,
    `ruleIds=${result.matchedRuleIds.join(", ") || "none"} · model=${diagnosticText(result.model) || "none"}`,
    `fallback=${diagnosticText(result.fallbackReason) || "none"} · degraded=${diagnosticText(result.degradedReason) || "none"}`,
    "advice:false · read-only classification; no recommendation, stage, promotion, approval or feature activation."];
}
const BUSINESS = new Map<string, { purpose: string; prerequisite: string; entry: string }>([
  ["retry-error", { purpose: "Retry error observation", prerequisite: "shadow-only; sync retry rules remain authoritative", entry: "/api-manager retry" }],
  ["file-value", { purpose: "Unknown handoff file annotations", prerequisite: "owned Todo + explicit next step + human host confirmation", entry: "/classifier handoff" }],
  ["signal-type", { purpose: "Reusable signal type", prerequisite: "separate /self-evolve switch; never stages knowledge here", entry: "/self-evolve" }],
  ["evolve-capture", { purpose: "Policy knowledge capture classification", prerequisite: "self-evolve + confirmed policy rules/mode", entry: "/self-evolve ; /skill:decision-policy" }],
  ["evolve-review", { purpose: "Policy candidate review classification", prerequisite: "self-evolve + confirmed policy rules/mode", entry: "/self-evolve ; /skill:decision-policy" }],
  ["prompt-route", { purpose: "Prompt enhancement route only", prerequisite: "prompt-enhance + independent generation LLM", entry: "/enhance ; /api-manager prompt-enhance" }],
  ["decision-owner", { purpose: "Policy ask ownership classification", prerequisite: "confirmed rules + ask mode + classification/advice model availability", entry: "/skill:decision-policy" }],
]);
export async function classifierBusinessStatus(ctx: ExtensionContext): Promise<string[]> {
  const status = classifierStatus();
  const lines = ["Business prerequisites (read-only; saved configuration, not drafts)", "new_context is always deterministic; no model injection or automatic handoff edits."];
  let evolve = "unknown";
  try {
    let raw;
    try { raw = JSON.parse(await readFile(selfEvolveConfigPath(ctx.cwd), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const config = normalizeSelfEvolveConfig(raw);
    evolve = `${envOverrideForSelfEvolve(process.env.PI_SELF_EVOLVE) ?? config.enabled ? "enabled" : "disabled"} (mode=${config.mode}, env=${process.env.PI_SELF_EVOLVE === undefined ? "none" : "PI_SELF_EVOLVE"})`;
  } catch (error) { evolve = `unavailable: ${diagnosticText(error)}`; }
  lines.push(`Self-evolve: ${evolve}`);
  try {
    const enhance = await loadEnhanceConfig(join(getAgentDir(), "api-manager.json"));
    const models = ctx.modelRegistry.getAvailable();
    const ref = enhance.modelRef === "session" ? `${ctx.model?.provider}/${ctx.model?.id}` : enhance.modelRef;
    lines.push(`Prompt-enhance: ${enhance.enabled ? "enabled" : "disabled"} · generation model=${diagnosticText(enhance.modelRef)} · ${models.some(model => `${model.provider}/${model.id}` === ref) ? "authenticated" : "unavailable"}`);
  } catch (error) { lines.push(`Prompt-enhance: unavailable: ${diagnosticText(error)}`); }
  try {
    const policy = await freshPolicy(ctx.cwd);
    const models = ctx.modelRegistry.getAvailable();
    const available = (ref: string) => models.some(model => `${model.provider}/${model.id}` === (["inherit", "session", "auto"].includes(ref) ? `${ctx.model?.provider}/${ctx.model?.id}` : ref));
    lines.push(`Policy: ask=${policy.ask.mode}, evolve=${policy.selfEvolve.mode}, backend=${policy.backend}, confirmed rules=${policy.rules.map(rule => rule.id).join(",") || "none"}`);
    lines.push(`Classification LLM ${diagnosticText(policy.classification.model)}: ${available(policy.classification.model) ? "authenticated" : "unavailable"}; advice LLM ${diagnosticText(policy.advice.model)}: ${available(policy.advice.model) ? "authenticated" : "unavailable"}`);
  } catch (error) { lines.push(diagnosticText(error)); }
  lines.push(`Classifier runtime=${status.runtimeStatus ?? "unknown"} · model=${diagnosticText(status.effectiveModel) || "none"} · reason=${diagnosticText(status.runtimeReason) || "none"}`);
  for (const [name, info] of BUSINESS) {
    const domain = status.domains[name];
    lines.push(`${name}: ${info.purpose} · mode=${domain?.mode ?? "not registered"} · supports=${domain?.supportedModes.join("|") ?? "unknown"}`, `  Requires: ${info.prerequisite}`, `  Entry: ${info.entry}`);
  }
  return lines.map(line => diagnosticText(line, 2000));
}

function shadowLabel(value: unknown): string {
  if (value === undefined) return "none";
  const text = diagnosticText(value, 500);
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(text)) return text;
  try {
    const label = JSON.parse(text);
    return `owner=${["internal", "external", "uncertain"].includes(label.owner) ? label.owner : "unknown"}, candidate=${["knowhow", "spec", "unknown"].includes(label.candidateType) ? label.candidateType : "unknown"}`;
  } catch { return "non-enum label withheld"; }
}
export interface ShadowSummary { lines: string[]; records: number; malformed: number; bytesRead: number }
/** Read only bounded tails of at most 3 daily logs; never expose state/input bytes. */
export async function readClassifierShadow(root = join(homedir(), ".maestro", "classifier", "shadow")): Promise<ShadowSummary> {
  const result: ShadowSummary = { lines: [], records: 0, malformed: 0, bytesRead: 0 };
  let files: string[];
  try {
    files = [];
    const dir = await opendir(root);
    for await (const entry of dir) {
      if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) files = [...files, entry.name].sort().reverse().slice(0, 3);
    }
  } catch (error) {
    result.lines.push((error as NodeJS.ErrnoException).code === "ENOENT" ? "Shadow logs missing (no observations yet)." : `Shadow logs unavailable: ${diagnosticText(error)}`);
    return result;
  }
  if (!files.length) result.lines.push("Shadow logs missing (no observations yet).");
  const aggregate = new Map<string, { count: number; agree: number; errors: number }>();
  const records: string[] = [];
  for (const file of files) {
    let handle;
    try {
      handle = await open(join(root, file), "r");
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - 32768);
      const buffer = Buffer.alloc(Math.min(size, 32768));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      result.bytesRead += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start) {
        result.lines.push(`${file}: bounded tail; leading partial record omitted.`);
        text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
      }
      for (const line of text.split("\n").filter(Boolean).slice(-40).reverse()) {
        try {
          const row = JSON.parse(line);
          if (!row || typeof row.domain !== "string" || typeof row.at !== "string" || (row.rule !== null && (!row.rule || typeof row.rule.label !== "string")) || (row.jev !== undefined && (typeof row.jev?.label !== "string" || typeof row.jev?.confidence !== "number"))) throw new Error("Malformed record");
          result.records++;
          const domain = diagnosticText(row.domain, 80);
          const stats = aggregate.get(domain) ?? { count: 0, agree: 0, errors: 0 };
          stats.count++; if (row.agree === true) stats.agree++; if (row.error) stats.errors++;
          aggregate.set(domain, stats);
          records.push(`${diagnosticText(row.at, 40)} ${domain}: rule=${shadowLabel(row.rule?.label)} · JEV=${shadowLabel(row.jev?.label)} · agree=${row.agree === true ? "yes" : row.agree === false ? "no" : "unknown"} · confidence=${Number.isFinite(row.jev?.confidence) ? row.jev.confidence.toFixed(2) : "none"} · error=${row.error ? "present (details withheld)" : "none"}`);
        } catch { result.malformed++; }
      }
    } catch (error) { result.lines.push(`${file}: unavailable: ${diagnosticText(error)}`); }
    finally { await handle?.close(); }
  }
  result.lines.unshift(`Shadow sample: ${result.records} records · malformed=${result.malformed} · bytes=${result.bytesRead} (3 files × 32KiB × 40 lines max)`);
  for (const [domain, stats] of aggregate) result.lines.push(`${domain}: n=${stats.count} · agree=${stats.agree} · errors=${stats.errors}`);
  result.lines.push(...records.slice(0, 40), "Input/state and error details withheld. No polling; bounded sample, not lifetime totals.");
  return result;
}
