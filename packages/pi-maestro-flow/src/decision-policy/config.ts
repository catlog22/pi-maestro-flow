import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as { lock(path: string, options: { realpath: boolean; stale: number; update: number }): Promise<() => Promise<void>> };
export const PolicyDomainSchema = z.enum(["ask", "evolve-capture", "evolve-review"]);
export type PolicyDomain = z.infer<typeof PolicyDomainSchema>;
const stage = z.object({ model: z.string().trim().min(1).default("inherit"), timeoutMs: z.number().int().min(100).max(120_000).default(15_000), maxCallsPerSession: z.number().int().min(1).max(1000).default(30) }).strict();
export const DecisionPolicySchema = z.object({
  version: z.literal(1).default(1),
  revision: z.number().int().nonnegative().default(0),
  description: z.string().trim().max(12_000).default(""),
  rules: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), domain: PolicyDomainSchema, instruction: z.string().trim().min(1).max(4000) }).strict()).max(100).default([]),
  specIds: z.array(z.string().regex(/^spec:[a-zA-Z0-9:_-]+$/)).max(20).default([]),
  ask: z.object({ mode: z.enum(["off", "shadow", "enforce"]).default("off") }).strict().default({}),
  selfEvolve: z.object({ mode: z.enum(["off", "shadow", "enforce"]).default("off") }).strict().default({}),
  backend: z.enum(["auto", "classifier", "llm"]).default("auto"),
  minConfidence: z.number().min(0.5).max(1).default(0.8),
  classification: stage.default({}),
  advice: stage.default({}),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.rules.map((rule) => rule.id)).size !== policy.rules.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Rule IDs must be unique", path: ["rules"] });
  for (const [key, domains] of [["ask", ["ask"]], ["selfEvolve", ["evolve-capture", "evolve-review"]]] as const) {
    if (policy[key].mode !== "off" && !domains.some((domain) => policy.rules.some((rule) => rule.domain === domain))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Enabled ${key} requires confirmed rules`, path: [key] });
  }
});
export type DecisionPolicy = z.infer<typeof DecisionPolicySchema>;
export function defaultDecisionPolicy(): DecisionPolicy { return DecisionPolicySchema.parse({}); }
export function decisionPolicyPath(cwd: string): string { return resolve(cwd, ".pi", "decision-policy.json"); }
export function policyFingerprint(policy: DecisionPolicy): string { return createHash("sha256").update(JSON.stringify(policy)).digest("hex"); }
export async function loadDecisionPolicy(cwd: string): Promise<DecisionPolicy | undefined> {
  let text: string;
  try { text = await readFile(decisionPolicyPath(cwd), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return DecisionPolicySchema.parse(JSON.parse(text));
}
export async function saveDecisionPolicy(cwd: string, draft: unknown, expectedRevision: number, validateOwner: () => void = () => {}): Promise<DecisionPolicy> {
  const policy = DecisionPolicySchema.parse(draft);
  const path = decisionPolicyPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, { realpath: false, stale: 10_000, update: 2000 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await loadDecisionPolicy(cwd);
    validateOwner();
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error("Decision policy revision conflict; reload and confirm the new draft.");
    const next = { ...policy, revision: expectedRevision + 1 };
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    validateOwner();
    // Ownership check and atomic publication share one synchronous commit point.
    renameSync(temporary, path);
    return next;
  } finally {
    try { await rm(temporary, { force: true }); } finally { await release(); }
  }
}
