// Heuristic session-title generation — the rule-based equivalent of Claude
// Code's Haiku title generator (utils/sessionTitle.ts). Pi's extension API has
// no LLM query surface, so instead of asking a model for a 3-7 word sentence,
// we extract a short concrete topic from the user's first real message.
// Same constraints: concise, concrete, no preamble, no scaffolding.

// Claude Code asks Haiku for 3-7 words; users want short titles, so we cap at
// 20 chars (~3-5 words in English, ~6-7 CJK chars) — a tab has no room for more.
const MAX_TITLE_LENGTH = 20;

// Leading personal pronouns / polite prompts produce subjective, sentence-like
// titles ("We analyze the code", "帮我分析终端"). Titles must be objective noun
// phrases, so strip these before anything else; model-generated titles get the
// same treatment via cleanTitle().
const FIRST_PERSON_LEADS = [
	/^我(?:们|的)?\s*/,
	/^帮我\s*/,
	/^请(?:你)?(?:帮)?我\s*/,
	/^(?:I|We|You|My|Our|Your)\s+(?:need to |want to |should |can |will |am |are )?/i,
];

/**
 * Normalize a title into an objective noun phrase: strip leading personal
 * pronouns / polite prompts and surrounding quotes.
 */
export function cleanTitle(title: string): string {
	let t = title.trim();
	for (const lead of FIRST_PERSON_LEADS) t = t.replace(lead, "");
	t = t.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "").trim();
	return t;
}

/**
 * Suggest a short title for the session from the first real user message.
 * Returns undefined when the text is empty, pure punctuation, or collapses to
 * nothing after stripping scaffolding (code fences, URLs).
 */
export function suggestTitle(text: string): string | undefined {
	const cleaned = cleanText(text);
	if (!cleaned) return undefined;
	const titled = cleanTitle(cleaned);
	if (!titled) return undefined;
	return titled.length > MAX_TITLE_LENGTH
		? `${titled.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
		: titled;
}

function cleanText(text: string): string | undefined {
	let t = text.trim();
	if (!t) return undefined;
	// Fenced and inline code blocks are scaffolding, not the topic.
	t = t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
	// URLs are noise in a tab title.
	t = t.replace(/https?:\/\/\S+/g, " ");
	t = t.replace(/\s+/g, " ").trim();
	if (t.length < 3) return undefined;
	// Pure punctuation/symbols (or a message that was only code) is not a topic.
	if (/^[\p{P}\p{S}\s]+$/u.test(t)) return undefined;
	return t;
}
