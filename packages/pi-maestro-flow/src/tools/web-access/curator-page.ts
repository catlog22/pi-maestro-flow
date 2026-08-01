import { CSS } from "./curator-css.ts";
import { SCRIPT } from "./curator-script.ts";

function safeInlineJSON(data: unknown): string {
	return JSON.stringify(data)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function buildProviderButtons(
	available: { openai: boolean; brave: boolean; parallel: boolean; tavily: boolean; serpdive: boolean; searxng: boolean; perplexity: boolean; exa: boolean; gemini: boolean; anysearch: boolean },
	selected: string,
	hasInitialQueries: boolean,
): string {
	const providers = [
		{ value: "openai", label: "OpenAI", available: available.openai },
		{ value: "exa", label: "Exa", available: available.exa },
		{ value: "brave", label: "Brave", available: available.brave },
		{ value: "parallel", label: "Parallel", available: available.parallel },
		{ value: "tavily", label: "Tavily", available: available.tavily },
		{ value: "serpdive", label: "SERPdive", available: available.serpdive },
		{ value: "searxng", label: "SearXNG", available: available.searxng },
		{ value: "perplexity", label: "Perplexity", available: available.perplexity },
		{ value: "gemini", label: "Gemini", available: available.gemini },
		{ value: "anysearch", label: "AnySearch", available: available.anysearch },
	];

	return providers
		.filter(p => p.available)
		.map((p) => {
			const isDefault = p.value === selected;
			const state = isDefault && hasInitialQueries ? "loading" : "idle";
			const classes = ["provider-btn", state, isDefault ? "is-default" : ""].filter(Boolean).join(" ");
			const disabled = state === "loading" ? " disabled" : "";
			return `<button type="button" class="${classes}" data-provider="${p.value}" data-state="${state}"${disabled}>${p.label}</button>`;
		})
		.join("");
}

export function generateCuratorPage(
	queries: string[],
	sessionToken: string,
	timeout: number,
	availableProviders: { openai: boolean; brave: boolean; parallel: boolean; tavily: boolean; serpdive: boolean; searxng: boolean; perplexity: boolean; exa: boolean; gemini: boolean; anysearch: boolean },
	defaultProvider: string,
	searchProvider: string,
	summaryModels: Array<{ value: string; label: string }>,
	defaultSummaryModel: string | null,
): string {
	const providerButtonsHtml = buildProviderButtons(availableProviders, defaultProvider, queries.length > 0);
	const inlineData = safeInlineJSON({ queries, sessionToken, timeout, defaultProvider, searchProvider, summaryModels, defaultSummaryModel, availableProviders });

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Curate Search Results</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"><\/script>
<style>
${CSS}
</style>
</head>
<body>

<div class="timer-badge" id="timer" title="Click to adjust">--:--</div>
<div class="timer-adjust" id="timer-adjust">
<input type="text" id="timer-input" value="${timeout}">
<span class="timer-adjust-label">sec</span>
<button class="timer-adjust-btn" id="timer-set">Set</button>
</div>

<main>
<div class="hero" id="hero">
<div class="hero-kicker">Web Search</div>
<h1 class="hero-title">Searching\u2026</h1>
<p class="hero-desc">Results will appear below as they complete.</p>
<div class="hero-meta">
<span id="hero-status">Searching\u2026</span>
<span class="hero-meta-sep"></span>
<div class="provider-buttons" id="provider-buttons">${providerButtonsHtml}</div>
</div>
</div>
<div id="result-cards"></div>
<div class="send-raw-row hidden" id="send-raw-row">
<button class="btn btn-secondary" id="btn-send-raw" disabled>Send selected results without summary</button>
</div>
<div class="add-search" id="add-search">
<span class="add-search-icon">+</span>
<input type="text" placeholder="Add a search\u2026" id="add-search-input">
<button type="button" class="add-search-wand" id="add-search-wand" disabled title="Rewrite query with AI">\u2728</button>
</div>

<section class="summary-panel hidden" id="summary-panel" aria-label="Summary review">
<div class="summary-header">
<div class="summary-header-top">
<div>
<h2 class="summary-title">Review summary draft</h2>
<p class="summary-subtitle" id="summary-subtitle">Edit the summary before approving.</p>
</div>
<div class="summary-model-controls">
<select id="summary-provider-select" class="summary-model-dropdown" aria-label="Summary provider"></select>
<select id="summary-model-select" class="summary-model-dropdown" aria-label="Summary model"></select>
</div>
</div>
</div>
<div class="summary-generating hidden" id="summary-generating" aria-live="polite">
<div class="summary-generating-head">
<span class="summary-generating-orb" aria-hidden="true"></span>
<span id="summary-generating-copy">Generating summary draft…</span>
</div>
<div class="summary-generating-bars" aria-hidden="true">
<span class="summary-generating-bar b1"></span>
<span class="summary-generating-bar b2"></span>
<span class="summary-generating-bar b3"></span>
</div>
</div>
<textarea id="summary-input" class="summary-input" placeholder="Summary draft will appear here\u2026"></textarea>
<div class="summary-feedback-row">
<input type="text" id="summary-feedback" class="summary-feedback" placeholder="Optional feedback for regeneration\u2026" />
</div>
<div class="summary-actions">
<button class="btn btn-secondary" id="btn-summary-back">Back</button>
<button class="btn btn-secondary" id="btn-summary-regenerate">Regenerate</button>
<button class="btn btn-secondary" id="btn-summary-preview" title="Preview rendered summary">Preview</button>
<button class="btn btn-submit" id="btn-summary-approve">Approve</button>
</div>
</section>
</main>

<footer class="action-bar">
<div class="action-shortcuts">
<span class="shortcut"><kbd>A</kbd> <span>Toggle all</span></span>
<span class="shortcut"><kbd>Enter</kbd> <span>Generate</span></span>
<span class="shortcut"><kbd>Esc</kbd> <span>Cancel</span></span>
</div>
<div class="action-buttons">
<button class="btn btn-submit" id="btn-send" disabled>Waiting for results\u2026</button>
</div>
</footer>

<div id="success-overlay" class="success-overlay hidden" aria-live="polite">
<div class="success-icon">OK</div>
<p id="success-text">Results sent</p>
</div>

<div id="expired-overlay" class="expired-overlay hidden" aria-live="polite">
<div class="expired-content">
<div class="expired-icon">!</div>
<h2>Session Ended</h2>
<p id="expired-text">Time\u2019s up \u2014 sending all results to your agent.</p>
<div class="expired-countdown">Closing in <span id="close-countdown">5</span>s</div>
</div>
</div>

<div id="preview-modal" class="preview-modal hidden">
<div class="preview-modal-inner">
<div class="preview-modal-header">
<h2 class="preview-modal-title">Summary Preview</h2>
<button class="preview-modal-close" id="preview-modal-close" title="Close">\u00d7</button>
</div>
<div class="preview-modal-body" id="preview-modal-body"></div>
<div class="preview-popover hidden" id="preview-popover">
<div class="preview-popover-quote" id="preview-popover-quote"></div>
<textarea class="preview-popover-input" id="preview-popover-input" placeholder="Feedback\u2026" rows="3"></textarea>
<button class="btn btn-submit preview-popover-btn" id="preview-popover-regen">Regenerate</button>
</div>
<div class="preview-modal-footer">
<select id="preview-modal-model" class="preview-modal-model" aria-label="Summary model"></select>
<button class="btn btn-secondary" id="preview-modal-regenerate">Regenerate</button>
<button class="btn btn-submit" id="preview-modal-approve">Approve</button>
</div>
</div>
</div>

<div id="error-banner" class="error-banner" hidden></div>

<script>
${SCRIPT.replace("__INLINE_DATA__", () => inlineData)}
</script>
</body>
</html>`;
}
