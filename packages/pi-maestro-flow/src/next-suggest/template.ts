/**
 * Prompt template for next-step suggestion generation.
 *
 * Distilled from @guwidoe/pi-prompt-suggester (MIT, .references/pi-prompt-suggester)
 * keeping the core signals — recent user messages, tool activity, touched
 * files, unresolved questions, latest assistant message — without the heavy
 * project-intent seeding pipeline.
 */

export interface SuggestionPromptContext {
  turnStatus: string;
  recentUserPrompts: string[];
  toolSignals: string[];
  touchedFiles: string[];
  unresolvedQuestions: string[];
  latestAssistantText: string;
  maxSuggestionChars: number;
  noSuggestionToken: string;
}

function list(items: string[], label: string): string {
  return items.length > 0 ? `${label}:\n${items.map((item) => `- ${item}`).join("\n")}` : `${label}:\n(none)`;
}

export function renderSuggestionPrompt(context: SuggestionPromptContext): string {
  return `Write the next message the user would most likely send in this pi session.

Return only the user's message text.
Do not explain.
Do not describe the instructions you were given.
If no plausible next user message is clear, return exactly ${context.noSuggestionToken}.

TurnStatus:
${context.turnStatus}

${list(context.recentUserPrompts, "RecentUserMessages")}

${list(context.toolSignals, "ToolSignals")}

${list(context.touchedFiles, "TouchedFiles")}

${list(context.unresolvedQuestions, "UnresolvedQuestions")}

LatestAssistantMessage:
\`\`\`
${context.latestAssistantText || "(empty)"}
\`\`\`

Guidance:
- Stay close to the user's recent style and current trajectory.
- Treat RecentUserMessages as the strongest signal.
- If the latest assistant message proposed a next step and it fits, a short reply like "Yes.", "Go ahead.", or "Proceed." is often best.
- Only add more text when it adds new information such as a constraint, correction, or emphasis.
- Do not restate, summarize, or paraphrase the assistant's proposal unless repeating a small part is necessary.
- If the assistant's direction clearly conflicts with the user's recent behavior, write a natural pivot instead.
- Keep the result under ${context.maxSuggestionChars} characters. Prefer fewer when possible.`;
}
