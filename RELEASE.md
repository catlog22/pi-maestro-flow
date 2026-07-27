# v0.7.0 — Native Web-Access Engine, Smart Search Native Mode & Ask TUI Overhaul

## Overview

A feature release with three major additions. **A complete native TypeScript web-access engine** (`src/tools/web-access/`, ~42 modules, ~14k lines) brings first-class web search and page fetching directly into the extension — supporting Perplexity, OpenAI, Brave, Parallel, SERPdive, SearXNG, Gemini, Exa, Tavily, Firecrawl, GitHub, YouTube, and PDF extraction, with SSRF protection and a curator pipeline. **Smart Search gains a `native` mode** that routes queries through these TS providers instead of the Python CLI, with automatic fallback on configuration errors. **The `ask-user-question` TUI wizard is overhauled** with a two-column layout for wide terminals, Chinese localization, and preview scrolling.

Additionally, todo rendering in both `pi-cockpit` and the flow extension widget is simplified to creation-order display, and several bugs are fixed (TUI expanded rendering, companion re-registration, compaction budget overflow, Pi Skill platform injection).

`pi-maestro-teammate` is unchanged at `0.6.0` and is not republished.

## Package Versions

| Package | Version | npm |
|---------|---------|-----|
| `pi-maestro-flow` | 0.7.0 | `npm i pi-maestro-flow@0.7.0` |
| `pi-maestro-teammate` | 0.6.0 (unchanged) | `npm i pi-maestro-teammate@0.6.0` |
| `pi-cockpit` | 0.1.2 | `npm i pi-cockpit@0.1.2` |

`pi-maestro-flow@0.7.0` depends on `pi-cockpit@0.1.2`, `pi-maestro-teammate@0.6.0`, and `maestro-flow@0.5.57`.

## Detailed Changes

### 🌐 Native Web-Access Engine (flow, NEW)

A complete native TypeScript web search and content extraction engine, eliminating the Python CLI dependency for common web operations:

- **`src/tools/web-access/`** (~42 modules, ~14,000 lines) — provider adapters for Perplexity, OpenAI Search, Brave, Parallel AI, SERPdive, SearXNG, Gemini (web search + URL context), Exa, Tavily, Firecrawl, GitHub API, YouTube transcript extraction, and PDF extraction (`unpdf`).
- **`search-router.ts` / `fetch-router.ts`** — unified routing across providers with credential-based auto-selection and concurrency control (`p-limit`).
- **`ssrf-protection.ts`** — SSRF guard with configurable allow/deny domain policies and IP range validation.
- **`curator.ts` / `curator-server.ts`** — AI-powered result curation and summarization pipeline.
- **`extract.ts` / `rsc-extract.ts`** — HTML-to-Markdown extraction via `@mozilla/readability` + `turndown` + `linkedom`.
- **`source-check.ts` / `source-check-tool.ts`** — claim verification against web sources with source quality classification.

### 🔍 Smart Search Native Mode (flow)

- **`native` parameter** on the `smart_search` tool — routes `search` and `fetch` modes through native TS providers instead of the Python CLI (`src/tools/smart-search.ts`, +180).
- **Automatic fallback** — when the Python CLI fails with a configuration error, the tool transparently retries via native providers.
- **Enhanced `renderResult`** — richer collapsed/expanded rendering with source attribution and result parsing.

### ⚙️ Smart Search Config Expansion (flow)

- **`WEB_ACCESS_CONFIG_GROUPS`** — 10+ new configuration groups for native web-access providers (Perplexity, OpenAI, Brave, Parallel, SERPdive, SearXNG, Gemini, SSRF, Curator, Video) (`src/tools/smart-search-config.ts`, +162).
- **Web Access config sync** — bidirectional sync bridge between `~/.pi/web-search.json` and the Smart Search config store, with conflict detection and status indicators (`src/tui/smart-search-config.ts`, +200).

### 🎨 Ask TUI Wizard Overhaul (flow)

- **Two-column layout** — when the terminal is ≥84 columns and ≥16 rows, the wizard renders options and a live preview side by side (`src/tools/ask.ts`, +359).
- **Chinese localization** — all wizard prompts, labels, and option text localized to Chinese.
- **Preview scrolling** — the detail preview pane supports scroll navigation for long descriptions.
- **Review cursor** — improved navigation in the review/confirmation step.

### 📋 Todo Rendering Simplification (cockpit 0.1.2 + flow)

- **Creation-order display** — tasks are now sorted by their numeric creation ID instead of a priority-based rank (`todoDisplayRank` removed). Non-numeric IDs (workflow mirrors) sort after numeric ones.
- **Removed next-task preview** from the collapsed cockpit todo bar — the bar now shows only the progress bar, percentage, and blocked count.
- **Visible task limit raised** from 5 to 8 in the flow extension widget.
- Removed `findNextTodo`, `todoNextLabel`, and `RECENT_COMPLETED_MS` from both `pi-cockpit` and the flow widget.

### 🐛 Bug Fixes (flow)

- **TUI expanded rendering** — `options.expanded` is now honored in `renderResult` across 11 tool sites (`9d26c1f7`).
- **Companion re-registration** — companion packages are re-registered at extension load, not just postinstall (`5bb4a15b`).
- **Compaction budget overflow** — fixed request budget overflow when compacting with no history (`54a62c0f`).
- **Pi Skill platform injection** — generated Pi Skills now include the runtime platform (`945c7a13`).

### 📝 Documentation

- Root README simplified to a quick overview (Chinese + English).
- All three plugin READMEs updated for v0.6.0/v0.6.1 with cross-references.
- Release workflow knowhow captured with pitfall documentation.

### 📦 New Dependencies (flow)

`@mozilla/readability`, `turndown`, `linkedom`, `p-limit`, `promise.try`, `unpdf`, `@types/turndown` — supporting the native web-access engine's HTML extraction, PDF parsing, and concurrency control.

## Statistics

- **7 commits** since `v0.6.1` + uncommitted web-access engine
- **~60 files changed**, +17,000 / −600 lines (including ~14k new web-access modules)
- `pi-maestro-flow`: ~55 files, +16,500 / −500
- `pi-cockpit`: 3 files, +97 / −93

## Installation & Upgrade

```bash
# Fresh install
npm i pi-maestro-flow@0.7.0

# Upgrade from 0.6.x
npm i pi-maestro-flow@0.7.0
```

**Upgrade notes:**
- The native web-access engine is opt-in via the `native: true` parameter on `smart_search`. The Python CLI path remains the default.
- Configure native providers via `Alt+S` → Smart Search Config, or set API keys in `~/.pi/web-search.json`.
- Todo rendering now uses creation order — no configuration change needed.
