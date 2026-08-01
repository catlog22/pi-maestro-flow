export const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: #18181e;
  --bg-card: #1e1e24;
  --bg-elevated: #252530;
  --bg-hover: #2b2b37;
  --fg: #e0e0e0;
  --fg-muted: #909098;
  --fg-dim: #606068;
  --accent: #8abeb7;
  --accent-hover: #9dcec7;
  --accent-muted: rgba(138, 190, 183, 0.15);
  --accent-subtle: rgba(138, 190, 183, 0.08);
  --border: #2a2a34;
  --border-muted: #353540;
  --border-checked: #8abeb7;
  --check-bg: #8abeb7;
  --btn-primary: #8abeb7;
  --btn-primary-hover: #9dcec7;
  --btn-primary-fg: #18181e;
  --btn-secondary: #252530;
  --btn-secondary-hover: #2b2b37;
  --timer-bg: #252530;
  --timer-fg: #909098;
  --timer-warn-bg: rgba(240, 198, 116, 0.15);
  --timer-warn-fg: #f0c674;
  --timer-urgent-bg: rgba(204, 102, 102, 0.15);
  --timer-urgent-fg: #cc6666;
  --overlay-bg: rgba(24, 24, 30, 0.92);
  --success: #b5bd68;
  --warning: #f0c674;
  --font: 'Outfit', system-ui, -apple-system, sans-serif;
  --font-display: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  --font-mono: 'SF Mono', Consolas, monospace;
  --radius: 10px;
  --radius-sm: 6px;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f5f7;
    --bg-card: #ffffff;
    --bg-elevated: #eeeef0;
    --bg-hover: #e4e4e8;
    --fg: #1a1a1e;
    --fg-muted: #6c6c74;
    --fg-dim: #9a9aa2;
    --accent: #5f8787;
    --accent-hover: #4a7272;
    --accent-muted: rgba(95, 135, 135, 0.12);
    --accent-subtle: rgba(95, 135, 135, 0.06);
    --border: #dcdce0;
    --border-muted: #c8c8d0;
    --border-checked: #5f8787;
    --check-bg: #5f8787;
    --btn-primary: #5f8787;
    --btn-primary-hover: #4a7272;
    --btn-primary-fg: #ffffff;
    --btn-secondary: #e4e4e8;
    --btn-secondary-hover: #d4d4d8;
    --timer-bg: #e4e4e8;
    --timer-fg: #6c6c74;
    --timer-warn-bg: rgba(217, 119, 6, 0.10);
    --timer-warn-fg: #92400e;
    --timer-urgent-bg: rgba(175, 95, 95, 0.10);
    --timer-urgent-fg: #991b1b;
    --overlay-bg: rgba(255, 255, 255, 0.92);
    --success: #4d7c0f;
    --warning: #b45309;
  }
}

body {
  font-family: var(--font);
  background: var(--bg);
  background-image: radial-gradient(ellipse at 50% 0%, var(--accent-muted) 0%, transparent 60%);
  color: var(--fg);
  line-height: 1.5;
  min-height: 100dvh;
  padding-bottom: 72px;
}

.timer-badge {
  position: fixed;
  top: 20px;
  right: 24px;
  z-index: 50;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--timer-fg);
  border: 1px solid var(--border);
  transition: background 0.3s, color 0.3s, border-color 0.3s, opacity 0.3s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  cursor: pointer;
  user-select: none;
  opacity: 0.5;
}
.timer-badge:hover { opacity: 1; }
.timer-badge.active { opacity: 1; }
.timer-badge.warn {
  opacity: 1;
  background: var(--timer-warn-bg);
  color: var(--timer-warn-fg);
  border-color: color-mix(in srgb, var(--timer-warn-fg) 30%, transparent);
}
.timer-badge.urgent {
  opacity: 1;
  background: var(--timer-urgent-bg);
  color: var(--timer-urgent-fg);
  border-color: color-mix(in srgb, var(--timer-urgent-fg) 30%, transparent);
}
.timer-adjust {
  position: fixed;
  top: 20px;
  right: 24px;
  z-index: 51;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  border-radius: 999px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
}
.timer-adjust.visible { display: flex; }
.timer-adjust input {
  width: 48px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.timer-adjust-label { font-size: 11px; color: var(--fg-dim); }
.timer-adjust-btn {
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: none;
  background: var(--accent);
  color: var(--btn-primary-fg);
  cursor: pointer;
}
.timer-adjust-btn:hover { background: var(--accent-hover); }

main {
  max-width: 640px;
  margin: 0 auto;
  padding: 56px 24px 16px;
}

.hero { margin-bottom: 28px; }
.hero-kicker {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent);
  margin-bottom: 8px;
}
.hero-title {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.01em;
  line-height: 1.1;
  color: var(--fg);
  margin-bottom: 10px;
  text-wrap: balance;
}
.hero-desc {
  font-size: 14px;
  color: var(--fg-muted);
  line-height: 1.5;
  margin-bottom: 12px;
  max-width: 480px;
}
.hero-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--fg-dim);
}
.hero-meta-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--fg-dim);
  flex-shrink: 0;
}
#hero-status:empty + .hero-meta-sep { display: none; }
.provider-buttons {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.summary-model-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 0;
}
.summary-model-dropdown {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  max-width: 220px;
}
.summary-model-dropdown:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
}
.summary-model-dropdown:disabled {
  opacity: 0.65;
  cursor: default;
}
.provider-btn {
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s, opacity 0.12s;
}
.provider-btn.idle:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.provider-btn.loading {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border-muted));
  cursor: default;
  pointer-events: none;
  opacity: 0.85;
}
.provider-btn.loading::after {
  content: " …";
  animation: provider-pulse 1.2s ease-in-out infinite;
}
.provider-btn.searched {
  background: var(--btn-secondary);
  color: var(--fg);
  border-color: var(--border-muted);
}
.provider-btn.searched::after {
  content: " ✓";
  color: var(--success);
}
.provider-btn.is-default {
  box-shadow: inset 0 -2px 0 0 var(--accent);
  border-color: var(--accent);
}
.provider-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

@keyframes provider-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

#result-cards { display: flex; flex-direction: column; gap: 8px; }

.send-raw-row {
  display: flex;
  justify-content: flex-end;
  padding: 4px 0;
}
.send-raw-row.hidden { display: none; }

.result-loading {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-card) 86%, var(--accent-subtle));
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.result-loading-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border);
}
.result-loading-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
}
.result-loading-sub {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.result-loading-grid {
  display: grid;
  gap: 10px;
  padding: 12px 14px 14px;
}
.loading-card {
  border: 1px solid color-mix(in srgb, var(--border-muted) 80%, var(--accent-subtle));
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  overflow: hidden;
  position: relative;
}
.loading-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 10%, color-mix(in srgb, var(--accent) 18%, transparent) 45%, transparent 75%);
  transform: translateX(-130%);
  animation: loading-sweep 2s ease-in-out infinite;
  pointer-events: none;
}
.loading-card-row {
  height: 10px;
  border-radius: 999px;
  margin: 10px 12px;
  background: color-mix(in srgb, var(--fg-dim) 35%, transparent);
}
.loading-card-row.short { width: 35%; }
.loading-card-row.mid { width: 58%; }
.loading-card-row.long { width: 78%; }

.result-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.12s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}
.result-card.checked { border-color: var(--border-checked); }
.result-card.searching {
  opacity: 1;
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent-subtle) 70%, var(--bg-card)) 0%, var(--bg-card) 100%);
  position: relative;
}
.result-card.searching::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 20%, color-mix(in srgb, var(--accent) 14%, transparent) 50%, transparent 80%);
  transform: translateX(-130%);
  animation: loading-sweep 2.2s ease-in-out infinite;
  pointer-events: none;
}
.result-card.searching .result-card-header { cursor: default; }
.result-card.searching .result-card-header:hover { background: transparent; }
.result-card.error { border-color: var(--timer-urgent-fg); }

.result-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.result-card-header:hover { background: var(--bg-hover); }

.result-card-header input[type="checkbox"] {
  appearance: none;
  width: 16px;
  height: 16px;
  min-width: 16px;
  border: 1.5px solid var(--border-muted);
  border-radius: 4px;
  margin-top: 2px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  display: grid;
  place-content: center;
}
.result-card-header input[type="checkbox"]:checked {
  background: var(--check-bg);
  border-color: var(--check-bg);
}
.result-card-header input[type="checkbox"]:checked::after {
  content: "";
  width: 9px;
  height: 6px;
  border-left: 2px solid var(--btn-primary-fg);
  border-bottom: 2px solid var(--btn-primary-fg);
  transform: rotate(-45deg);
  margin-top: -1px;
}

.result-card-info { flex: 1; min-width: 0; }

.result-card-query-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.result-card-query {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.provider-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border: 1px solid transparent;
}
.provider-tag.provider-exa {
  color: #8dd3ff;
  background: rgba(141, 211, 255, 0.14);
  border-color: rgba(141, 211, 255, 0.3);
}
.provider-tag.provider-perplexity {
  color: #cba6f7;
  background: rgba(203, 166, 247, 0.14);
  border-color: rgba(203, 166, 247, 0.3);
}
.provider-tag.provider-gemini {
  color: #f5c27b;
  background: rgba(245, 194, 123, 0.14);
  border-color: rgba(245, 194, 123, 0.3);
}
.provider-tag.provider-anysearch {
  color: #f9c74f;
  background: rgba(249, 199, 79, 0.14);
  border-color: rgba(249, 199, 79, 0.3);
}
.provider-tag.provider-openai {
  color: #a6e3a1;
  background: rgba(166, 227, 161, 0.14);
  border-color: rgba(166, 227, 161, 0.3);
}
.provider-tag.provider-brave {
  color: #f38ba8;
  background: rgba(243, 139, 168, 0.14);
  border-color: rgba(243, 139, 168, 0.3);
}
.provider-tag.provider-parallel {
  color: #89dceb;
  background: rgba(137, 220, 235, 0.14);
  border-color: rgba(137, 220, 235, 0.3);
}
.provider-tag.provider-tavily {
  color: #a6e3a1;
  background: rgba(166, 227, 161, 0.14);
  border-color: rgba(166, 227, 161, 0.3);
}
.provider-tag.provider-serpdive {
  color: #94e2d5;
  background: rgba(148, 226, 213, 0.14);
  border-color: rgba(148, 226, 213, 0.3);
}
.provider-tag.provider-unknown {
  color: var(--fg-muted);
  background: var(--bg-elevated);
  border-color: var(--border-muted);
}
.result-card-meta {
  font-size: 12px;
  color: var(--fg-dim);
}
.result-card-preview {
  font-size: 12.5px;
  color: var(--fg-muted);
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}

.result-card-expand {
  color: var(--fg-dim);
  font-size: 11px;
  margin-top: 2px;
  flex-shrink: 0;
  padding-top: 3px;
  transition: color 0.12s;
}
.result-card-header:hover .result-card-expand { color: var(--fg-muted); }

.result-card-body {
  display: none;
  border-top: 1px solid var(--border);
}
.result-card-body.open { display: block; }

.result-card-answer {
  padding: 14px 16px;
  font-size: 13.5px;
  color: var(--fg-muted);
  line-height: 1.6;
  max-height: 400px;
  overflow-y: auto;
}
.result-card-answer h1,
.result-card-answer h2,
.result-card-answer h3,
.result-card-answer h4 {
  color: var(--fg);
  font-family: var(--font);
  font-weight: 600;
  margin: 16px 0 6px;
  line-height: 1.3;
}
.result-card-answer h1 { font-size: 16px; }
.result-card-answer h2 { font-size: 14.5px; }
.result-card-answer h3 { font-size: 13.5px; }
.result-card-answer h4 { font-size: 13px; color: var(--fg-muted); }
.result-card-answer p { margin: 0 0 10px; }
.result-card-answer p:last-child { margin-bottom: 0; }
.result-card-answer strong { color: var(--fg); font-weight: 600; }
.result-card-answer a { color: var(--accent); text-decoration: none; }
.result-card-answer a:hover { text-decoration: underline; }
.result-card-answer ul, .result-card-answer ol {
  margin: 6px 0 10px;
  padding-left: 20px;
}
.result-card-answer li { margin-bottom: 4px; }
.result-card-answer li::marker { color: var(--fg-dim); }
.result-card-answer code {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 1px 5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--fg);
}
.result-card-answer pre {
  margin: 8px 0 12px;
  padding: 12px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  line-height: 1.45;
}
.result-card-answer pre code {
  padding: 0;
  background: none;
  border: none;
  font-size: 12px;
  color: var(--fg-muted);
}
.result-card-answer blockquote {
  margin: 8px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--accent);
  color: var(--fg-dim);
  background: var(--accent-subtle);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.result-card-answer table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 12px;
  font-size: 12.5px;
}
.result-card-answer th, .result-card-answer td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  text-align: left;
}
.result-card-answer th {
  background: var(--bg-elevated);
  color: var(--fg);
  font-weight: 600;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.result-card-answer hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}

.result-card-sources {
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border);
}
.result-card-sources-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  margin-bottom: 6px;
}
.source-link {
  display: block;
  padding: 4px 0;
  font-size: 12.5px;
  color: var(--fg-muted);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.12s;
}
.source-link:hover { color: var(--accent); }
.source-domain {
  color: var(--fg-dim);
  margin-left: 6px;
}

.result-card-error-msg {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--timer-urgent-fg);
}

.card-alt-providers {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 16px 8px 42px;
  font-size: 11px;
  color: var(--fg-dim);
}
.card-alt-chip {
  font-family: var(--font);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.card-alt-chip:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.card-alt-chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.card-alt-chip.loading {
  opacity: 0.6;
  pointer-events: none;
}
.card-alt-chip.loading::after {
  content: " …";
}

.searching-dots::after {
  content: "";
  animation: dots 1.5s steps(4, end) infinite;
}
@keyframes dots {
  0% { content: ""; }
  25% { content: "."; }
  50% { content: ".."; }
  75% { content: "..."; }
}

@keyframes loading-sweep {
  0% { transform: translateX(-130%); }
  100% { transform: translateX(130%); }
}

@keyframes summary-pulse {
  0%, 100% {
    transform: scale(0.9);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent);
  }
  50% {
    transform: scale(1.15);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent);
  }
}

@keyframes summary-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(120%); }
}

@keyframes summary-panel-sweep {
  0% { transform: translateX(-115%); }
  100% { transform: translateX(115%); }
}

.add-search {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 11px 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  cursor: text;
  transition: border-color 0.15s, background 0.15s;
}
.add-search:hover {
  border-color: var(--border-muted);
  background: var(--accent-subtle);
}
.add-search:focus-within {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent-subtle);
}
.add-search-icon {
  color: var(--fg-dim);
  font-size: 16px;
  font-weight: 300;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.15s;
}
.add-search:focus-within .add-search-icon { color: var(--accent); }
.add-search input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 13.5px;
  font-weight: 500;
}
.add-search input::placeholder {
  color: var(--fg-dim);
  font-weight: 400;
}
.add-search-wand {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 14px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.add-search-wand:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.add-search-wand:disabled {
  opacity: 0.3;
  cursor: default;
}
.add-search-wand.rewriting {
  pointer-events: none;
  animation: wand-spin 0.8s linear infinite;
}
@keyframes wand-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.summary-panel {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary-panel.hidden { display: none; }
.summary-header { display: flex; flex-direction: column; gap: 2px; }
.summary-header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.summary-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.summary-subtitle {
  font-size: 12px;
  color: var(--fg-dim);
}
.summary-generating {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: var(--radius-sm);
  background: linear-gradient(130deg, color-mix(in srgb, var(--accent-subtle) 78%, transparent) 0%, var(--bg-elevated) 70%);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary-generating::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 0%, color-mix(in srgb, var(--accent) 16%, transparent) 50%, transparent 100%);
  transform: translateX(-115%);
  animation: summary-panel-sweep 2.4s ease-in-out infinite;
  pointer-events: none;
}
.summary-generating > * {
  position: relative;
  z-index: 1;
}
.summary-generating.hidden { display: none; }
.summary-generating-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-hover);
}
.summary-generating-orb {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent);
  animation: summary-pulse 1.1s ease-in-out infinite;
}
.summary-generating-bars {
  display: grid;
  gap: 6px;
}
.summary-generating-bar {
  position: relative;
  display: block;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 65%, var(--bg-elevated));
  overflow: hidden;
  transition: width 220ms ease;
}
.summary-generating-bar::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent) 45%, transparent) 50%, transparent 100%);
  animation: summary-sweep 1.6s ease-in-out infinite;
}
.summary-generating-bar.b1 { width: 86%; }
.summary-generating-bar.b2 { width: 68%; }
.summary-generating-bar.b3 { width: 74%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b1 { width: 72%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b2 { width: 82%; }
.summary-generating[data-phase="1"] .summary-generating-bar.b3 { width: 60%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b1 { width: 64%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b2 { width: 71%; }
.summary-generating[data-phase="2"] .summary-generating-bar.b3 { width: 90%; }
.summary-generating-bar.b2::after { animation-delay: 0.15s; }
.summary-generating-bar.b3::after { animation-delay: 0.3s; }
.summary-input {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg-elevated);
  outline: none;
}
.summary-input.hidden { display: none; }
.summary-input:focus {
  border-color: var(--accent);
}
.summary-feedback-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.summary-feedback {
  flex: 1;
  height: 32px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-family: var(--font);
  font-size: 12px;
  color: var(--fg);
  background: var(--bg-elevated);
  outline: none;
}
.summary-feedback:focus {
  border-color: var(--accent);
}
.summary-feedback::placeholder {
  color: var(--fg-muted);
}
.summary-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: color-mix(in srgb, var(--bg) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--border);
}
.action-shortcuts { display: flex; align-items: center; gap: 16px; }
.shortcut { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-dim); }
.shortcut kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  color: var(--fg-muted);
}
.action-buttons { display: flex; gap: 8px; }

.btn {
  font-family: var(--font);
  font-size: 13px;
  font-weight: 500;
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}
.btn:disabled { opacity: 0.35; cursor: default; }
.btn-submit { background: var(--btn-primary); color: var(--btn-primary-fg); }
.btn-submit:hover:not(:disabled) { background: var(--btn-primary-hover); }
.btn-secondary { background: var(--btn-secondary); color: var(--fg-muted); border: 1px solid var(--border); }
.btn-secondary:hover:not(:disabled) { background: var(--btn-secondary-hover); color: var(--fg); }

.success-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: var(--overlay-bg);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  transition: opacity 200ms;
}
.success-overlay.hidden { display: flex !important; opacity: 0; pointer-events: none; }
.success-icon {
  width: 56px; height: 56px; border-radius: 50%;
  border: 2px solid var(--success);
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 700; color: var(--success);
}
.success-overlay p { margin: 0; font-size: 13px; font-weight: 600; color: var(--success); letter-spacing: 0.06em; text-transform: uppercase; }

.expired-overlay {
  position: fixed; inset: 0;
  background: var(--overlay-bg);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 400ms; pointer-events: none; z-index: 200;
}
.expired-overlay.visible { opacity: 1; pointer-events: auto; }
.expired-overlay.hidden { display: flex !important; opacity: 0; pointer-events: none; }
.expired-content {
  text-align: center; max-width: 480px; padding: 48px 56px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
}
.expired-overlay.visible .expired-content { animation: slide-up 400ms ease-out; }
@keyframes slide-up { from { transform: translateY(20px); } to { transform: translateY(0); } }
.expired-icon {
  width: 72px; height: 72px; border-radius: 50%; border: 2px solid var(--warning);
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; font-weight: bold; color: var(--warning); margin: 0 auto 24px;
}
.expired-content h2 { color: var(--fg); margin: 0 0 16px; font-size: 22px; font-weight: 600; }
.expired-content p { color: var(--fg-muted); margin: 0 0 24px; font-size: 14px; line-height: 1.6; }
.expired-countdown { font-size: 13px; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.expired-countdown span { color: var(--warning); font-weight: 600; }

.preview-modal {
  position: fixed; inset: 0; z-index: 250;
  background: var(--overlay-bg);
  display: flex; align-items: center; justify-content: center;
  animation: fade-in 150ms ease-out;
}
.preview-modal.hidden { display: none; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.preview-modal-inner {
  width: min(720px, calc(100% - 48px));
  max-height: calc(100vh - 80px);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex; flex-direction: column;
  animation: slide-up 200ms ease-out;
}
.preview-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.preview-modal-title { font-size: 14px; font-weight: 600; color: var(--fg); margin: 0; }
.preview-modal-close {
  background: none; border: none; cursor: pointer;
  font-size: 22px; line-height: 1; color: var(--fg-muted); padding: 0 4px;
  transition: color 0.12s;
}
.preview-modal-close:hover { color: var(--fg); }
.preview-modal-body {
  position: relative;
  padding: 24px 28px;
  overflow-y: auto;
  font-size: 14px; line-height: 1.7; color: var(--fg);
}
.preview-modal-body h1 { font-size: 20px; font-weight: 600; margin: 1.2em 0 0.5em; color: var(--fg); }
.preview-modal-body h2 { font-size: 16px; font-weight: 600; margin: 1.2em 0 0.4em; color: var(--fg); }
.preview-modal-body h3 { font-size: 14px; font-weight: 600; margin: 1em 0 0.3em; color: var(--fg); }
.preview-modal-body p { margin: 0.6em 0; }
.preview-modal-body a { color: var(--accent); }
.preview-modal-body pre { background: var(--bg-elevated); padding: 14px; border-radius: var(--radius-sm); overflow-x: auto; }
.preview-modal-body code { font-size: 0.9em; }
.preview-modal-body blockquote { border-left: 3px solid var(--border); padding-left: 14px; color: var(--fg-muted); margin: 0.6em 0; }
.preview-modal-body hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.preview-modal-body ul, .preview-modal-body ol { padding-left: 1.4em; }
.preview-modal-body li + li { margin-top: 0.25em; }
.preview-modal-body strong { color: var(--fg); }
.preview-modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px;
  flex-shrink: 0;
}
.preview-modal-model {
  margin-right: auto;
  font-family: var(--font);
  font-size: 11px;
  color: var(--fg-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  max-width: 220px;
  outline: none;
}
.preview-modal-model:focus { border-color: var(--accent); }

.preview-popover {
  position: absolute;
  z-index: 260;
  width: min(340px, calc(100% - 40px));
  background: var(--bg-elevated);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  animation: fade-in 100ms ease-out;
}
.preview-popover.hidden { display: none; }
.preview-popover-quote {
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
  border-left: 2px solid var(--accent);
  padding-left: 8px;
  max-height: 48px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.preview-popover-input {
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.4;
  color: var(--fg);
  background: var(--bg-card);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  outline: none;
  width: 100%;
  resize: vertical;
}
.preview-popover-input:focus { border-color: var(--accent); }
.preview-popover-btn { align-self: flex-end; font-size: 12px; padding: 5px 14px; }

.error-banner {
  position: fixed; bottom: 64px; left: 50%; transform: translateX(-50%); z-index: 50;
  padding: 10px 20px; background: var(--timer-urgent-bg); color: var(--timer-urgent-fg);
  border-radius: var(--radius); font-size: 13px; font-weight: 500;
}

.summary-panel.updating {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  position: relative;
  overflow: hidden;
}
.summary-panel.updating::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 30%;
  height: 2px;
  border-radius: var(--radius) var(--radius) 0 0;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: updating-bar 1.8s ease-in-out infinite;
  pointer-events: none;
}
.summary-panel.updating .summary-input,
.summary-panel.updating .summary-feedback-row {
  opacity: 0.45;
  pointer-events: none;
}
.summary-panel.updating .summary-actions {
  opacity: 0.72;
}
@keyframes updating-bar {
  0% { transform: translateX(-50%); }
  100% { transform: translateX(430%); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-card::after,
  .result-card.searching::after,
  .provider-btn.loading::after,
  .searching-dots::after,
  .summary-generating::before,
  .summary-generating-orb,
  .summary-generating-bar::after,
  .summary-panel.updating::after {
    animation: none !important;
  }
}

@media (max-width: 500px) {
  main { padding: 32px 16px 16px; }
  .hero-title { font-size: 28px; }
  .hero-desc { font-size: 13px; }
  .summary-header-top { flex-direction: column; }
  .summary-model-controls { flex-wrap: wrap; }
  .summary-model-dropdown { max-width: 100%; }
  .action-bar { padding: 10px 14px; }
  .action-shortcuts { display: none; }
  .result-card-header { padding: 12px 14px; }
  .expired-content { padding: 32px 24px; }
  .timer-badge { top: 12px; right: 16px; }
}
`;
