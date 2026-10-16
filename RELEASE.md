# v0.34.1 — Pi Host Compaction Loading Fix

> Fast patch release: the user explicitly authorized skipping verification for
> this version. Tests, typechecks, documentation builds, packaging dry-runs and
> registry install/startup smoke were not run. No runtime acceptance is claimed.

## Changes

- Resolve compaction internals through the Pi host's `getPackageDir()` instead
  of requiring SDK package resolution inside the managed npm tree. This supports
  host aliases and virtual modules without installing a private Pi SDK copy.
- Include both new regression cases in `test:compaction`: managed installation
  without a local SDK and host-provided virtual modules. These cases are not
  claimed executed for this release.
- Source: `packages/pi-maestro-flow/src/compaction/pi-internals.ts` and
  `packages/pi-maestro-flow/test/pi-internals.test.mjs`.
- Publish **pi-maestro-flow 0.34.1** only. Teammate **2.10.0**, Cockpit **0.24.4**,
  all other packages, engine range and optional host peers remain unchanged.
- Includes all pending working-tree changes since **v0.34.0**, plus synchronized
  version, lockfile, installation commands and bilingual release banners.

## Install / upgrade

```bash
pi install npm:pi-maestro-flow@0.34.1
```

Close Pi before upgrading and restart afterward. This patch does not establish
passing video, fresh-install or startup acceptance for v0.34.0 or v0.34.1.

---

## Historical v0.34.0 notes (not v0.34.1 acceptance)

# v0.34.0 — Browser Recording, Compaction & Runtime Stability

> Scoped Windows x64 / Node 22.22.0 verification. **The user explicitly accepted
> the unverified real-video encoding case for this release**: FFmpeg is absent,
> temporary installation stalled, and a bounded binary download timed out.
> This is not a passing recording/decoding test. **The user separately accepted
> incomplete registry install/startup acceptance for v0.34.0**, authorizing its
> tag and GitHub Release after the 600-second install timeout. Neither waiver
> is inferred from v0.33.0; neither failure is labelled a passing smoke.

## Overview

Flow **0.34.0**, Teammate **2.10.0**, and Cockpit **0.24.4** include all pending
working-tree changes and the fixes committed since **v0.33.0**. The ten other
publishable workspace packages are unchanged and match their registry SHA-1s.

## Highlights

- **Browser recording and presentation:** `start_video` / `stop_video` capture
  persistent, non-overwriting VP8/WebM artifacts for admitted pages; chapter
  cards, action labels and pointers support guided demos. Managed/profile/CDP
  recording requires FFmpeg; extension mode rejects unsupported video actions
  rather than silently switching channels. Artifacts survive tab cleanup.
  Implementation: `src/tools/browser/video*.ts`, `manager.ts`, `browser-tool.ts`.
- **Compaction summaries:** configurable summary thinking (default `off`) and
  timeout (default 240000 ms), fitted input windows, bounded retries, progress
  and usage/attempt metrics. Explicit `new_context` still makes no model-summary
  call; command-origin resets require bounded history recovery.
  Implementation: `src/compaction/` and `src/tui/compaction-settings.ts`.
- **Teammate lifecycle and routing:** exact-owner Monitor lifecycle subscriptions,
  one-time workspace objective/root delivery, and clearer separation of queued,
  consumed, settled, business success and physical process closure. Interactive
  task completion does not implicitly close its window. Model precedence remains
  owned by the tool contract; task-type guidance does not override it.
  Implementation: Teammate `src/extension/`, `src/sessions/`, `src/models/`.
- **Cockpit stability:** viewport ownership/layout checks, fullscreen rebuild and
  terminal cleanup improve redraw stability without hiding required native
  redraws. Agent-store/footer/tick handling follows the current viewport.
  Implementation: Cockpit `src/viewport-stability.ts`, `src/terminal-cleanup.ts`,
  `src/fullscreen-controller.ts`, `src/agents-store.ts`, `src/footer.ts`.
- **Runtime hardening:** bounded observation/RPC/search/error output, HTTP/2 and
  upstream stream-read retry classification, callback/transport error containment,
  verifier permission routing, native tool discovery and custom-turn failover
  compatibility. Cancellation/authentication boundaries remain intact.
- **Repository and docs:** instruction modules are split into on-demand references;
  install commands, bilingual banners, changelogs and affected guides are synced.

## Source scope

The pre-release snapshot spans **137 files**, approximately **9.2k inserted /
1.1k removed lines**, relative to **v0.33.0**. Runtime source accounts for
**3230 inserted / 762 removed lines** across the paths above. It includes
**12 existing commits**, followed by the release snapshot and publication-record
commits; test-only fixture repairs and release documentation are included.

## Package versions

| Package | Version | Publication |
|---|---|---|
| pi-maestro-teammate | 2.10.0 | before Flow |
| pi-cockpit | 0.24.4 | before Flow |
| pi-maestro-flow | 0.34.0 | after exact companions |
| pi-maestro-settings-core | 0.2.3 | unchanged |
| pi-maestro-backend-core / pi-maestro-backends | 0.1.5 / 0.1.7 | unchanged |
| pi-maestro-fabric / pi-maestro-fabric-core | 0.1.0 | unchanged |
| pi-fluent-tui | 0.1.2 | unchanged |
| @dyw1234/active-win | 9.0.1 | unchanged |
| @dyw1234/nut-js / nut-shared / nut-provider-interfaces | 4.2.7 | unchanged |

Flow's exact companion dependencies and lockfile are synchronized. Engine range
**`maestro-flow >=0.5.91`** is retained; npm latest and local upstream both report
**0.5.92**. Pi validation baseline remains **0.99.0**, optional host peers remain
`*`, and the Node minimum remains **22.19.0**. Minimum Node, macOS/Linux, model
inference and credential-dependent features are not claimed verified.

## Verification

- **1519 unique selected tests passed**, **9 selected skips** (7 POSIX cases
  and 2 Teammate cases),
  and **one real-video integration case failed for missing FFmpeg**, explicitly
  accepted by the user. No test was disabled to obtain a pass.
- Flow: **905 passed**, **7 POSIX skips**, **1 unaccepted-by-test-runner video
  failure**. The missing-FFmpeg case was not rerun after bootstrap/download
  failures. A stale extension test mock lacked `getAllTools`; that mock was
  corrected and only its failed case reran successfully.
- Teammate: **395 passed**, **2 skips**. Initial delegated execution inherited a
  disabled child nesting budget; root/child fixtures now isolate and restore
  their intended environment. All 37 affected cases passed after correction.
  Schema-description assertions now use runtime type narrowing instead of
  reading annotation fields absent from TypeBox's inferred types; the edited
  metadata case and typecheck passed. No production workaround was added.
- Cockpit: **219 passed**, no skips. All three changed package typechecks,
  Teammate declaration consistency, and all workspace manifest/lock/exact
  dependency-closure assertions passed.
- Documentation `tsc && vite build` passed. Existing >500 kB Mermaid/Cynefin
  chunk advisories remain; no visual browser validation is claimed.
- Verification selected changed test files and directly affected boundaries,
  not the unrelated root `test:release` matrix. Passing evidence was reused;
  only invalidated/failed cases were rerun.
- Initial tarball inventory parsing encountered lifecycle stdout; trailing JSON
  parsing corrected the harness and remaining packages were inspected. All ten
  unchanged workspace tarballs match npm; changed packages receive new versions.

### Locked artifacts and publication

The release snapshot is commit **`2b021bf9`**. Each immutable tarball passed
`npm publish --dry-run`, bundles settings-core but no private Pi host SDK/typebox
copy, and was published in dependency order: Teammate → Cockpit → Flow. Flow's
four on-demand instruction references are present. Registry SHA-1s match below.
Teammate initially returned HTTP **202**, followed by temporary metadata 404s;
publication was observed after processing, without republishing the version.

| Package | Files | Packed / unpacked bytes | Registry-matched SHA-1 |
|---|---:|---:|---|
| pi-maestro-teammate@2.10.0 | 492 | 1259610 / 5625114 | `37a25bd94adc8fe23664758ec99add5810872201` |
| pi-cockpit@0.24.4 | 115 | 332933 / 1249701 | `06a4edf363c1eeb201136145dd1137bbb9897a05` |
| pi-maestro-flow@0.34.0 | 1177 | 3861994 / 14858045 | `d5b20a950698558899cce1349abf995272446967` |

### Incomplete registry installation/startup acceptance

- A fresh consumer at `D:/tmp/pi-registry034-vb7Vgw`, with isolated `HOME` and
  `USERPROFILE`, attempted registry installation of Flow **0.34.0** and explicit
  Pi **0.99.0** host packages. It used `--legacy-peer-deps --omit=optional
  --ignore-scripts`, with no workspace links and a **600-second** install bound.
- The install timed out with **ETIMEDOUT**. Manifests for Flow **0.34.0**,
  Teammate **2.10.0**, Cockpit **0.24.4** and Pi **0.99.0** were present, but this
  does not prove installation completed. npm logs showed cache misses and some
  tarball downloads taking **45–110 seconds**; the complete timeout cause has
  not been localized. A runtime defect has not been excluded.
- Because install did not pass, **Flow postinstall and the offline RPC suite
  startup/tool-registration probe were not executed**. No model inference was
  attempted. The `pi install` managed wrapper and optional/native installations
  are also not claimed verified.
- The cumulative install/startup failure history was inspected and no further
  retry or timeout extension was made. The user then **explicitly accepted this
  incomplete acceptance scope for v0.34.0** and authorized its tag/GitHub Release.
  npm publication and matching hashes establish artifact identity, not readiness.

## Install / upgrade

```bash
pi install npm:pi-maestro-flow@0.34.0
pi list
```

Close Pi before upgrading and restart afterward. Update preserved local
companion overrides to Teammate **2.10.0** / Cockpit **0.24.4**; ordinary managed
registrations migrate automatically. Install FFmpeg separately for recording.

---

## Historical v0.33.0 notes (not v0.34.0 acceptance)

# v0.33.0 — Session-Scoped Browser & Human Auto Controls

> **Limited verification, explicitly accepted by the user:** 643 targeted tests
> passed, but fresh Pi install-wrapper/startup checks timed out. Runtime startup
> acceptance is incomplete. The user authorized tagging and GitHub publication
> without a passing startup smoke for this release; the timeouts are not passes.

## Overview

Flow **0.33.0** and Teammate **2.9.0** add session-scoped browser ownership,
human-controlled Ask timeout recommendations, persistent session Plan-auto
preauthorization, and paginated session-history search. Cockpit **0.24.3** and
all other workspace packages remain unchanged.

## Highlights

- **Browser ownership follows the trusted host session**, not the tool instance
  or turn. Named tabs persist across turns; status and close-all target only the
  caller's session. Missing host identity permits guide only. This isolates
  operation ownership, not shared cookies or login state.
- **One managed/profile/CDP run deadline** covers setup, execution and
  postprocessing. Passive failures retain bounded output, operation names,
  screenshot metadata and unresolved-dialog hints without probing a stalled
  renderer. Cleanup can add latency; borrowed profile/CDP pages may continue
  executing after disconnect. Extension interruptions retain draining ownership
  until terminals settle and explicit open revalidates the same tab/generation.
  Interrupted actions are never replayed automatically.
- **Human `/auto ask on [seconds]`** can adopt explicitly recommended safe
  choices after a timeout (default 60 seconds). Results are machine
  `recommendations`, never user answers or approval. Human answers/cancellation
  win; ambiguous choices, policy refusals, sensitive approvals and financial
  decisions remain human. Teammate relay preserves timeout provenance.
- **Plan-auto persists across Plan cycles and same-session context resets**,
  while each cycle receives fresh task authorization. Manual exit invalidates
  task authority without disabling the human session grant. Session/cwd changes,
  history navigation, reload and shutdown revoke the grant; no disk or child
  message can restore it. Automatic execution remains standalone/current.
- **Session history search** adds `mode:terms`, `sort:relevance` and `offset`.
  Terms require every normalized whitespace-separated query term in one visible
  entry; exact phrases and tighter spans rank first. Pagination rescans live
  transcripts, not a snapshot. FFF candidates do not exclude fresh inventory.
- **Classifier settings and diagnostics** gain Chinese/English catalogs,
  themed narrow-terminal rendering and clearer configured/effective values.
  Published SOP hints can be loaded from canonical content while outer lifecycle
  and title stay authoritative.
- **Teammate RPC telemetry** omits repeated image bytes from wire-only event
  projections while preserving original model/session data, text, errors and
  structured output. Malformed or oversized JSONL fails immediately and retires
  the child; a previously published answer is not rewritten by a later corrupt
  stream. The preload is included in the package and does not intercept ordinary
  tool subprocess stdout.
- **SDK maintenance** adds a grouped dependency-update configuration and a
  read-only compatibility CI workflow. The included HTML example and existing
  knowledge/SOP snapshots are repository-only changes, not new runtime features.

## Package versions

| Package | Version | Scope |
|---|---|---|
| pi-maestro-flow | 0.33.0 | publish |
| pi-maestro-teammate | 2.9.0 | publish before Flow |
| pi-cockpit | 0.24.3 | unchanged |
| pi-maestro-settings-core | 0.2.3 | unchanged |
| pi-maestro-backend-core | 0.1.5 | unchanged |
| pi-maestro-backends | 0.1.7 | unchanged |
| pi-maestro-fabric / pi-maestro-fabric-core | 0.1.0 | unchanged |
| pi-fluent-tui | 0.1.2 | unchanged |
| @dyw1234/active-win | 9.0.1 | unchanged |
| @dyw1234/nut-js / nut-shared / nut-provider-interfaces | 4.2.7 | unchanged |

The engine requirement remains **`maestro-flow >=0.5.91`**; registry latest and
local upstream both reported **0.5.91** at preflight. Pi validation baseline is
**0.99.0**, with optional host SDK peers; Node minimum is **22.19.0**.

## Source scope

Relative to **v0.32.1**, this release has **two release commits** (the feature
snapshot and this limited-verification publication record),
covering **82 files**, approximately **5.8k inserted / 0.9k removed lines**.
The scope includes the user-approved working-tree changes and release metadata.

## Verification

- **469 selected tests passed**, with no selected skips: Flow changed-boundary
  tests **343**, Teammate history/relay **42**, browser compiler/deadline/SDK
  contracts **18**, extension drain/revalidation **13**, Plan lifecycle **53**.
- Flow and Teammate typechecks, Teammate declaration consistency, and
  workspace manifest/lock dependency equality passed.
- All **11 unchanged publishable workspace tarballs** match their registry
  SHA-1s. Flow and Teammate are bumped rather than republishing changed content
  under an existing version.
- The first extension test invocation lacked the TypeScript transform flag;
  it passed with the correct runner. Two stale browser-message assertions were
  updated to the new ownership/deadline contract and only those cases reran.
- Verification is scoped to Windows x64 / Node **22.22.0**. The broad root
  `test:release` was not run; focused changed-boundary evidence is used instead.
  Minimum Node, macOS/Linux, credential-dependent integration and model
  inference are not claimed verified by this release.
- Documentation `tsc && vite build` passed; Vite reported its existing >500 kB
  chunk-size advisory. No browser visual check was performed for this copy-only
  documentation update.
- RPC/stdout work was explicitly added after the original checks. All **174**
  targeted projection, decoder, spawning and structured-output cases passed
  (**643 selected tests total**). Two legacy stdout-diagnostic expectations were
  updated for immediate protocol failure and rerun individually; the other 172
  passing cases were reused. Teammate typecheck and declaration consistency
  passed again after the RPC changes. No selected tests were skipped.
- Immutable package tarballs passed `npm publish --dry-run`; neither bundles
  private Pi host SDK/typebox copies. The Teammate preload is present in its
  tarball. Both npm versions are published and their registry SHA-1s match the
  locked artifacts below. Flow initially returned HTTP 202 (asynchronous
  processing); registry metadata later exposed the matching version without
  republishing.

### Locked artifacts

| Package | Files | Packed / unpacked bytes | SHA-1 |
|---|---:|---:|---|
| pi-maestro-teammate@2.9.0 | 488 | 1,244,176 / 5,571,343 | `11f316509f2f9495dfeb3ed6aed35a23677b82bf` |
| pi-maestro-flow@0.33.0 | 1,167 | 3,835,500 / 14,766,288 | `5cbb2c59fe0beadeb75d955cd2e6dc4d4468fef7` |

### Incomplete runtime acceptance

- The fresh-home `pi install npm:pi-maestro-flow@0.33.0` wrapper timed out at
  **600 seconds**. Its original npm child subsequently recorded **exit 0**;
  Flow **0.33.0**, Teammate **2.9.0**, and Cockpit **0.24.3** manifests exist in
  the isolated `HOME` / `USERPROFILE` installation directory. Companion
  registration exists, but the wrapper did not finish registering Flow itself.
- The previously unexecuted offline RPC startup check then timed out at
  **60 seconds**, without a successful state/messages response or tool-registration
  probe. There is no evidence that this installed suite completed startup.
  The cause has not been localized; cold loading, harness behavior and a runtime
  defect have not been distinguished. No timeout was extended and no failing
  command was relabelled as a passing startup test.
- After the failure history was reviewed, the user explicitly accepted this
  limited validation scope and waived the passing-startup prerequisite for this
  version's tag/GitHub Release. No further smoke retries were performed.

## Install / upgrade

```bash
pi install npm:pi-maestro-flow@0.33.0
pi list
```

Close Pi before upgrading and restart afterward. Update preserved local
Teammate overrides to **2.9.0** explicitly; ordinary managed companion
registrations migrate automatically.

---

## Historical v0.32.1 notes (not v0.33.0 acceptance)

# v0.32.1 — Dependency Repairs & Runtime Hardening

> Scoped release validation: 268 focused tests passed, with one existing
> platform skip; all nine unchanged workspace tarballs match npm. Native
> verification is limited to Windows x64 / Node 22.22.0; minimum Node and
> macOS/Linux remain unverified.

## Overview

Flow **0.32.1**, Teammate **2.8.1**, Cockpit **0.24.3**, and Backends
**0.1.7** deliver dependency repairs and runtime hardening. Backend-Core **0.1.5**,
Settings-Core **0.2.3**, and Fabric/Fabric-Core **0.1.0** are unchanged from
0.32.0. The baseline feature notes below are retained: human-scoped Plan
preauthorization, advisory decision routing, exact Goal evidence, and
multi-listener browser bridging.
The validation baseline is **Pi 0.99.0**. Legacy **0.87–0.98** compatibility
remains explicitly version-gated; optional host peers keep their `*` ranges.
Missing native APIs do not authorize a second legacy runtime on a native host.

## Dependency repairs

- Flow keeps the `active-win` import key via
  `npm:@dyw1234/active-win@9.0.1`, a compatibility/security fork of
  `active-win@9.0.0` (MIT). Native assets still use upstream `v9.0.0` identity;
  a scoped package name does not imply new upstream binaries or official support.
- Flow keeps `@nut-tree-fork/nut-js` via `npm:@dyw1234/nut-js@4.2.7`.
  Its `@nut-tree-fork/shared` and `@nut-tree-fork/provider-interfaces` keys
  resolve through aliases to `@dyw1234/nut-shared@4.2.7` and
  `@dyw1234/nut-provider-interfaces@4.2.7`. These Apache-2.0 forks derive from
  the corresponding `@nut-tree-fork` 4.2.6 packages, not upstream official releases.
- Provenance and retained licensing are recorded in
  `packages/maestro-active-win/UPSTREAM.json` / `PROVENANCE.md` and each
  `packages/maestro-nut-*/PROVENANCE.json`, `LICENSE`, and `NOTICE`.
- Node.js minimum remains **22.19.0**; the engine range is
  **`maestro-flow >=0.5.91`**, not an exact pin. Registry latest was **0.5.91**
  at release preflight; installation is not model inference validation.

## Runtime hardening since 0.32.0

- **Task-scoped Advisor supervision** — optional `/advisor todo` settings
  monitor host-owned root/local-child Todo progress, pause active-time accounting
  during tools and human/capacity waits, and fence stale task/model/session results.
  Supervision defaults off; shadow records classifications only. Active mode
  provides bounded reflection/escalation advice without aborting tools, changing
  Todo status, or granting approval (`src/advisor/todo-review*.ts`).
- **Bounded search and session history** — root-wide literal/regex search uses
  time-bounded ripgrep; FFF session candidates are verified against visible
  transcript projections with bounded fallback, and an unavailable host transcript
  reports an error instead of a misleading complete empty result
  (`src/tools/fff.ts`, `src/tools/session-history.ts`). Native FFF indexing
  now runs in an isolated plain-Node worker; cancellation and shutdown retain
  worker ownership until close is confirmed, with literal/regex fallback.
- **Consistent teammate tool cards** — call/result renderers share the same
  bounded grammar in normal and quiet modes, including resumed histories;
  Cockpit avoids duplicate shell chrome (`pi-maestro-teammate/src/tui/render.ts`,
  `pi-cockpit/src/quiet-tools.ts`).

- **Classifier settings and diagnostics** — unified configuration UI,
  configured/effective model reporting, session-scoped runtime quotas, and
  bounded handoff advice (`src/classifier/`, `src/decision-policy/`,
  `pi-maestro-teammate/src/classify/`). Advice is not human approval.
- **SSH PowerShell transport** — a static `-Command` bootstrap decodes a
  bounded payload without `-EncodedCommand` or reading the protocol stdin.
  Unicode output, literal working directories, explicit/final exit status,
  and repeated stdio exchanges have real Windows regressions
  (`src/ssh-manager/executor.ts`).
- **UTF-8 background output** — independent stdout/stderr decoders retain
  split Chinese/emoji characters, count raw bytes, truncate on character
  boundaries, and flush exactly once on terminal events
  (`src/ssh-manager/ssh-bg.ts`).
- **Bounded teammate recovery** — child prompts and compaction checkpoints
  preserve the dispatched task, cumulative search budget, negative results,
  caller/output contract, and exact child/publication identities. Recovery
  must not restart discovery or infer live child state from an old summary.
- **Image layout compatibility** — the Nut repair uses Jimp 1.6.1, preserves
  copied RGB/BGR data and alpha, and keeps three-channel buffer layouts
  consistent with channels/stride metadata across conversion paths.

- **Outcome-first orchestration** — Plan, planner, Monitor, and compaction
  recovery distinguish human-locked requirements from revisable implementation
  means. Blocking dependencies need a requirement or confirmed defect; correction
  budgets stay cumulative across workers and resets. Existing approval and
  lifecycle gates remain authoritative.

## Baseline feature highlights (0.32.0)

### Human-scoped Plan auto and advisory policy

- **Plan-auto is default off** — a human in the parent TUI can enable it during
  the current Plan cycle with `/plan-auto on` or `Alt+Shift+A`. The host-memory
  grant is scoped to session/cwd/cycle/generation; RPC, extension messages,
  children, history replay, reload, and a new Plan cycle cannot create or restore
  it. `/plan-auto off` revokes future automatic decisions, not already-started
  execution (`src/tools/plan-auto.ts`).
- **Exact approval, fixed execution** — the next `plan-confirm` uses the normal
  durable approval transaction and executes **standalone/current** only: no
  inherited Workflow, New Context, or decision-document authority. Revocation
  before handoff preserves committed approval but prevents execution; it does
  not silently retry (`src/tools/plan.ts`).
- **Advisory decision policy** — manually invoke `/skill:decision-policy` in the
  parent interactive session to propose and human-confirm a revision-checked
  `.pi/decision-policy.json`. Ask and self-evolve domains support `off`, `shadow`,
  and `enforce`. Classification can use the configured native classifier or a
  bounded LLM fallback; advice remains an LLM recommendation. Machine decisions
  are explicitly **not user answers or approval**; uncertain/external results,
  low confidence, unavailable models, exhausted budgets, and sensitive decisions
  remain human (`src/decision-policy/`, `src/tools/ask.ts`).

### Browser Bridge: explicit modes and shared resources

- **Multi-listener discovery** — each Pi listener binds an available loopback
  port in `19222..19231`; the MV3 extension discovers and maintains multiple
  listeners rather than replacing a live peer. A custom
  `PI_BROWSER_BRIDGE_PORT` shifts the ten-port server range; add the actual
  listening port in popup **Advanced** because Chrome cannot read Pi's env.
- **NONE is not authentication** — explicitly start Pi with
  `PI_BROWSER_BRIDGE_AUTH_MODE=none` for a token-free continuity handshake.
  Ready status is `transportReady:true`, `authenticatedConnected:false`, with
  no pending pairing and no token/pair step. Default `paired` mode still needs
  matching requestId/code approval followed by authenticated reconnection.
  NONE deliberately removes credential authorization; loopback/Origin filtering
  is not protection from malicious local processes (`src/tools/browser/bridge-server.ts`).
- **Real capability boundaries** — select `app.channel` explicitly:
  `managed | profile | cdp | extension`. Extension supports limited
  URL/title/goto/evaluate, raw CDP/batch, cookies, tabs, and screenshots, not full
  Puppeteer parity. Per-entry leases fence physical tabs across listeners;
  busy/draining does not prove work stopped. Cookies/login state remain shared,
  not isolated (`optional/browser-bridge/background.js`, `src/tools/browser/manager.ts`).
- **Profile attachment** — auto-launch uses `--remote-debugging-port=0` and
  `DevToolsActivePort`, or attaches a recorded endpoint. Chrome 136+ blocks
  debugging its default user-data directory even after windows close. Choose
  a non-default profile explicitly, or use extension for the daily browser;
  profiles are never copied or switched automatically. See
  `optional/BROWSER-BRIDGE-SETUP.md` and the browser guide.

### Exact Goal evidence and bounded review

- **Requirement-bound evidence** — `goal complete` accepts up to 16
  `evidenceRefs`, each with a requirement and exactly one explicit local path or
  exact `session://.../entry/...` / `agent://...` URI. Bounded resource pages
  preserve `nextPage` recovery; agent evidence pins an immutable publication.
  Missing/unauthorized/ambiguous evidence cannot become a passing verdict.
  Acceptance commands remain primary; fallback verifiers have a bounded read
  budget and may not replace exact evidence with broad workspace exploration
  (`src/tools/goal-evidence.ts`, `src/tools/goal-verification.ts`).
- **OpenCodeReview runner** — the external `ocr` CLI now has a bounded timeout,
  a combined 10 MiB stdout/stderr cap, abort and process-tree cleanup, and bounded
  stderr diagnostics. Windows npm/native launcher resolution follows the selected
  PATH installation; cleanup failures are errors, not success. This is code
  review, not browser image OCR (`src/ocr-review/runner.ts`).

### Scoped Codex Fast and native runtime safety

- **Codex Fast** — `/fast on|off|status` persists a project preference in
  `.pi/codex-fast.json`; `--fast` enables it for a launch. Only matching
  `openai-codex` / `openai-codex-responses` request payloads receive
  `service_tier:"priority"`; this may consume more quota and is not a latency
  guarantee. Teammate supports boolean `fast` at task/dispatch, taskType routing,
  and role levels; explicit false is authoritative. Child hooks are installed
  even on `--no-extensions` launches (`src/providers/codex-fast.ts`,
  `pi-maestro-teammate/src/shared/codex-fast.ts`, `src/extension/child-codex-fast.ts`).
- **Native classifier safety** — resolve the effective model before caching,
  validate native stop reason and question schema, and fence stale in-flight
  decisions. Classifier settings publish atomically with conflict/ownership
  checks and keep configured values separate from effective environment overrides
  (`pi-maestro-teammate/src/classify/`, `src/classifier/settings-provider.ts`).
- **Local TUI survives remote transport errors** — failed Ask/Plan transport
  promises do not count as user cancellation; the local prompt stays usable and
  pending remote requests remain available for reconnect. Explicit cancel and
  abort still clean up the race (`src/tools/ask.ts`, `src/tools/plan.ts`).
- **Host/provider polish** — Cockpit refreshes native host compatibility and
  status badges; Anthropic-compatible model discovery uses `/v1/models`.

### Self-evolve remains advisory and governed

- **Grounded enrichment and policy routing** — capture/review policy uses
  exact signalId/traceHash/sessionId joins and separate append-only sidecars;
  raw heuristic signals remain intact. Hybrid enrichment batches bounded model
  calls and references supplied evidence IDs only. Stale session/config/policy
  results cannot publish (`src/self-evolve/extension.ts`, `src/self-evolve/enrichment.ts`).
- **No automatic promotion** — policy off preserves the heuristic path;
  shadow is diagnostic; enforce can route grounded internal capture/review,
  not approve spec promotion. Self-evolve stays disabled by default, dry-run
  remains the default mode, and auto-deposit only stages reviewed candidates.
  Closeout must request explicit approval for concrete knowledge candidates;
  approved work or machine recommendations are not promotion authority.

## Package versions

| Package | Version | Release scope |
|---|---|---|
| pi-maestro-flow | 0.32.1 | this release |
| pi-maestro-teammate | 2.8.1 | this release |
| pi-cockpit | 0.24.3 | this release |
| pi-maestro-settings-core | 0.2.3 | unchanged |
| pi-maestro-backends | 0.1.7 | this release |
| pi-maestro-backend-core | 0.1.5 | unchanged |
| @dyw1234/active-win | 9.0.1 | published repair fork |
| @dyw1234/nut-shared | 4.2.7 | published repair fork |
| @dyw1234/nut-provider-interfaces | 4.2.7 | published repair fork |
| @dyw1234/nut-js | 4.2.7 | published repair fork |
| pi-maestro-fabric | 0.1.0 | unchanged |
| pi-maestro-fabric-core | 0.1.0 | unchanged |
| pi-fluent-tui | 0.1.2 | unchanged |

The external engine requirement is **`maestro-flow >=0.5.91`**.
The four forks are compatibility/security repairs, not official upstream
releases or a claim of upstream support. No model inference proof is claimed.

The DSH SDK is now an **optional peer** (`*`): install
`@deepseek-ai/dsh-sdk-client` manually when using DSH. The development baseline
is **0.1.0-rc.6**; ordinary Pi users do not need that SDK.

## Baseline scope (0.32.0; not repair-diff statistics)

Pre-release feature range: **`v0.31.3..aa054f450da2440c44b604bb8e6d3e1f41ced0a3`**.
It contains **12 commits, 130 files changed, +11,047 / −1,491 lines**.
These statistics exclude the 0.32.0 baseline's version, lockfile, and documentation
preparation and any later release or repair changes; they are not final-tag statistics.

## Repair validation status

- Focused Flow SSH/compaction regressions: **287/287 passed**. Teammate prompt
  regressions: **34 passed, 1 existing skip**. Active-win immutable-upstream
  contracts: **4/4 passed**.
- Three Nut source builds matched checked-in dist byte-for-byte. Following
  review, three-channel conversion was corrected, dist rebuilt, and the image
  regressions passed **7/7** in a real registry-alias consumer.
- Fresh Windows registry consumer executed native install scripts, loaded
  all four active-win APIs and Nut native providers, and observed windows
  without input injection. Its production audit returned **0 vulnerabilities**;
  this result is scoped to the fork consumer, not the entire Flow graph.
- All nine unchanged publishable workspaces, including the four repair forks,
  match their existing registry tarballs in this release preflight.
- Current scoped regressions: search/history/recovery/package resources **113/113**;
  Plan decomposition/lifecycle **54/54**; Advisor/history **70/70**; Teammate
  Monitor/permissions **31 passed, 1 existing Windows skip**. Two TypeScript
  inference errors were fixed with explicit result types, without runtime changes.
- Flow, Teammate, Cockpit, and Backends typechecks and Teammate declaration
  consistency passed. Passing focused results are reused; the broad root
  `test:release`, repeated native tests, and documentation build were not rerun
  for this fast release. Documentation changes were inspected as Markdown.
- Publication uses immutable tarballs matching these locked dry-run SHAs,
  in order Backends → Teammate → Cockpit → Flow. Registry SHA equality and
  a fresh registry-consumer Pi startup smoke are required before tagging.

### Locked 0.32.1 artifacts

| Package | Files | Packed / unpacked bytes | SHA-1 |
|---|---:|---:|---|
| pi-maestro-backends@0.1.7 | 20 | 58,017 / 200,470 | `4e5f2f45e189a7cca01eadda6028cbd0f24a006b` |
| pi-maestro-teammate@2.8.1 | 487 | 1,241,126 / 5,561,837 | `616c5afaaa92dc62076bb146fdec967312c72aea` |
| pi-cockpit@0.24.3 | 115 | 332,409 / 1,247,872 | `0d327d36e1f39ab85b02c393058d7678f3ba8563` |
| pi-maestro-flow@0.32.1 | 1,164 | 3,810,245 / 14,687,734 | `16b1601b711b46fb7ca24fb344b63cad55f43b8a` |
- Active-win acceptance on Node 22.19.0, macOS, and Linux remains unverified;
  the user explicitly approved a release limited to the verified scope.
  No cross-platform native or whole-graph audit-zero claim is made.

### Historical 0.32.0 preparation evidence (not 0.32.1 acceptance)

The following prior preparation notes are retained only as baseline history;
changed dependency versions invalidate reuse as final repair acceptance.

- All selected `test:release` targets passed. The initial command stopped on
  stale integration contracts and a missing Codex Fast barrel export; those
  boundaries were corrected and rerun individually, then the unexecuted gate
  stages resumed. Unchanged passing targets were reused, not rerun wholesale.
- Changed Flow boundaries omitted from the root gate were additionally checked:
  Plan-auto/decision policy, exact Goal evidence, bounded OCR, browser bridge and
  profile attachment, classifier configuration, Codex Fast, and self-evolve.
- Real-tarball packed consumer and packed child Todo discovery passed. Two
  earlier packed attempts timed out during external npm/Python downloads;
  official PyPI wheels were cached in an isolated temporary directory for the
  successful attempt. Test contents and timeout limits were not weakened.
- One Windows Chromium screenshot-cleanup timing assertion failed in the gate
  and passed in its focused reproduction without changing production code.
  Credential-dependent DSH integration and platform-inapplicable POSIX tests
  retained their existing skips; one existing Vitest case is also skipped.
- Documentation-site `npm run build` (`tsc && vite build`) passed after the final
  homepage copy change: Vite **25.60s**, with only its >500 kB chunk-size advisory.
  Managed-browser checks confirmed the Chinese/English v0.32.0 banner, dismiss
  persistence, no horizontal overflow, and the updated browser bridge guide.
- Four unchanged workspace package dry-run SHAs matched their registry versions.

These historical results are not reused for changed dependency boundaries;
current-request evidence above and the final registry smoke govern this repair.

## Historical 0.32.0 preparation artifacts (not repair artifacts)

The prior preparation recorded matching dry-run/tarball SHAs and passing
`npm publish --dry-run` for the tarballs below. They are not locked 0.32.1
artifacts and do not validate the changed dependency graph. The prior notes
recorded no bundled private Pi host SDK/typebox copy.

| Package | Files | Packed / unpacked bytes | SHA-1 |
|---|---:|---:|---|
| pi-maestro-backend-core@0.1.5 | 7 | 13,165 / 38,757 | `bbaa0d5620a15d32da0343e9f6be9a7d7a614a91` |
| pi-maestro-backends@0.1.6 | 20 | 58,015 / 200,470 | `a78ade2163511c9715c062ec17a5f9041282effc` |
| pi-maestro-teammate@2.8.0 | 485 | 1,235,399 / 5,536,921 | `aa0dbfaf37d11a48291c92b61b39502337f01b74` |
| pi-cockpit@0.24.2 | 115 | 332,557 / 1,248,528 | `427d4097afe3da0ac74a874915a45bed7cc7eaec` |
| pi-maestro-flow@0.32.0 | 1,154 | 3,765,034 / 14,520,453 | `c203fe91c562921875f9b59ad734ded2adeffaf4` |

## Install / upgrade

Requires **Node.js ≥ 22.19.0**. Use **Pi 0.99.0** as the validation baseline;
legacy Pi **0.87–0.98** uses version-gated compatibility paths.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:pi-maestro-flow@0.32.1
pi list
```

Close running Pi processes before upgrading, then restart Pi. Flow-managed
companion registrations migrate automatically; preserved local development
overrides must be upgraded or removed explicitly to match this suite.
