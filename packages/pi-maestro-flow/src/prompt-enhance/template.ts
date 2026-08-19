/**
 * Prompt-enhance template.
 *
 * The system prompt fixes the model's role as a pure rewriter; the user
 * message assembles the gathered context (recent messages, project tree,
 * git log, referenced files, knowledge hits) plus the prompt to enhance.
 */
import type { EnhancerContext, KnowledgeHit } from "./context.ts";

export const ENHANCE_SYSTEM_PROMPT = `You are a prompt rewriter for a coding agent. You do not answer the user's request. You do not solve, implement, explain, or carry out the work described in the prompt. Your only job is to rewrite the user's rough request into a better request that a *different* coding agent will execute later.

Given a user's rough prompt and optional live context from their working directory (recent messages, project tree, git state, referenced file contents, retrieved knowledge/spec hits), rewrite the prompt to be precise, actionable, and codebase-aware.

Rules:
- Preserve the user's intent exactly. Do not invent new requirements.
- If the prompt references files or functions, anchor your rewrite to the actual paths and code present in the context.
- If relevant project knowledge or specs were retrieved, reference them to ground the request in established conventions.
- Be concise. Output only the rewritten prompt — no preamble, no commentary, no markdown headings, no quoting of the original.
- If the original is already precise, return it nearly verbatim with only minor clarifications.
- Do not address the agent in the second person ("please ...") unless the original did. Match the tone of the original.
- If you catch yourself answering the question, writing code, listing steps to do the work, or saying "here is the fix", stop. Output the rewritten *request* instead.

Return only the enhanced prompt as plain text.`;

export interface EnhancePromptContext extends EnhancerContext {
  prompt: string;
}

function block(items: string[] | undefined, label: string, formatter: (item: string) => string = (i) => `- ${i}`): string {
  const list = items && items.length > 0 ? items.map(formatter).join("\n") : "(none)";
  return `${label}:\n${list}`;
}

function knowledgeBlock(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return `KnowledgeHits:\n(none)`;
  const lines = hits.map((h) => `- [${h.category || "?"}] ${h.name || h.id}: ${h.summary}`.trim());
  return `KnowledgeHits:\n${lines.join("\n")}`;
}

export function renderEnhancePrompt(context: EnhancePromptContext): string {
  return `Rewrite the prompt below into a clearer, more actionable request for a coding agent. Output only the rewritten prompt.

${block(context.recentMessages, "RecentMessages")}

${block(context.projectTree?.split("\n"), "ProjectTree")}

${block(context.gitLog?.split("\n"), "GitLog")}

${block(context.mentionedFiles, "MentionedFiles", (f) => f)}

${knowledgeBlock(context.knowledgeHits)}

PromptToEnhance:
\`\`\`
${context.prompt}
\`\`\``;
}

/** Trim an enhanced result: strip fences, leading markdown headings, and surrounding quotes. */
export function cleanEnhancedText(value: string): string {
  let out = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  // Strip a single wrapping code fence if the whole body is fenced.
  const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) out = fenced[1].trim();
  // Drop leading markdown headings ("# ...") — a rewritten prompt is prose, not a doc.
  out = out.split("\n").filter((line) => !/^#{1,6}\s/.test(line.trimStart())).join("\n").trim();
  // Strip surrounding quotes only when the same quote char wraps both ends.
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length >= 2 && first === last && /["'“”『「]/.test(first)) {
    out = out.slice(1, -1).trim();
  }
  return out;
}
