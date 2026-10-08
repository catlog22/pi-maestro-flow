/**
 * Classifier extension entry — unified rules+JEV classification control.
 *
 * Registered as a separate pi extension entry (`package.json` `pi.extensions`),
 * so it never touches the main maestro extension's registration surface.
 *
 * Behavior (default DISABLED — zero behavior impact):
 *   1. disabled until `PI_CLASSIFIER=1` (env), `.pi/classifier.json`
 *      `{ "enabled": true }`, or `/classifier on` (writes config).
 *   2. when enabled, each registered domain obeys its mode:
 *      - `off`    — L0 rules only (identical to today);
 *      - `shadow` — rules decide; JEV judges the same input in the background
 *                   and the pair is appended to
 *                   `~/.maestro/classifier/shadow/<date>.jsonl` for offline eval;
 *      - `jev`    — async callers escalate non-terminal rule results to JEV.
 *   3. `/classifier` command: status | on | off | mode <domain> <mode> |
 *      test <domain> <text> | reset.
 *
 * API keys come from `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` env vars —
 * never from the config file or command arguments.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  bindClassifierRuntime,
  probeClassifierRuntime,
  classifierStatus,
  configureClassifier,
  listClassifyDomains,
  registerBuiltinClassifyDomains,
  registerClassifyDomain,
  type ClassifierDomainMode,
} from "pi-maestro-teammate/v1/classify";
import {
  applyClassifierEnvOverrides,
  CLASSIFIER_ENV_FLAG,
  classifierConfigPath,
  DEFAULT_CLASSIFIER_CONFIG,
  envOverrideForClassifier,
  loadClassifierConfig,
  type FlowClassifierConfig,
} from "./config.ts";
import { signalTypeDomain } from "./domains.ts";
import {
  createClassifierSettingsProvider,
  registerClassifierSettingsProvider,
} from "./settings-provider.ts";
import { classifierStatus as engineStatus } from "pi-maestro-teammate/v1/classify";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";
import { showClassifierDiagnostics, showClassifierSettings } from "../tui/classifier-settings.ts";
import { refreshClassifierPanelModels, saveClassifierPanel } from "./panel-model.ts";
import { businessPolicyDiagnostic, classifierBusinessStatus, diagnosticText, diagnosticWait, rawClassifierDiagnostic, readClassifierShadow } from "./diagnostics.ts";
import type { SettingsChange } from "pi-maestro-settings-core/v1";

const ownersSymbol = Symbol.for("pi-maestro-flow.classifier.panel-owners");
const globals = globalThis as typeof globalThis & { [ownersSymbol]?: WeakMap<ExtensionAPI, () => void> };
const panelOwners = globals[ownersSymbol] ??= new WeakMap();

const DOMAIN_MODES: readonly ClassifierDomainMode[] = ["off", "shadow", "jev"];

/** Global shadow output root (`~/.maestro/classifier`; config stays project-scoped). */
function classifierOutputRoot(): string {
  return resolve(homedir(), ".maestro", "classifier");
}

function shadowFilePath(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(classifierOutputRoot(), "shadow", `${date.getFullYear()}-${month}-${day}.jsonl`);
}

export default function registerClassifier(pi: ExtensionAPI): void {
  let config: FlowClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG, domains: { ...DEFAULT_CLASSIFIER_CONFIG.domains } };
  let configCwd: string | undefined;
  let configSession: string | undefined;
  let configRuntime: unknown;
  let configLoad: Promise<FlowClassifierConfig> | undefined;
  panelOwners.get(pi)?.();
  let generation = 0;
  let disposed = false;
  let panelController: AbortController | undefined;
  const fence = (): void => { generation++; panelController?.abort(); panelController = undefined; };
  panelOwners.set(pi, () => { disposed = true; fence(); });

  // Eager registration so `/classifier` works before the first session_start.
  registerBuiltinClassifyDomains();
  registerClassifyDomain(signalTypeDomain);

  // Settings shell surface — same event-bus protocol as the other providers.
  // `apply` hot-pushes committed config into the engine (activation: live).
  const settingsProvider = createClassifierSettingsProvider({
    getDomains: () => {
      const status = engineStatus();
      return listClassifyDomains().map((name) => ({ name, modes: status.domains[name]?.supportedModes ?? DOMAIN_MODES }));
    },
    apply: (_effective, configured) => applyConfig(configured),
  });
  if (pi.events) registerClassifierSettingsProvider(pi.events, settingsProvider);

  const appendShadow = (line: string): void => {
    const path = shadowFilePath();
    void mkdir(dirname(path), { recursive: true })
      .then(() => appendFile(path, `${line}\n`, "utf8"))
      .catch(() => undefined);
  };

  function applyConfig(configured: FlowClassifierConfig): void {
    config = configured;
    const next = applyClassifierEnvOverrides(configured);
    configureClassifier({
      enabled: next.enabled,
      ...(next.endpoint ? { endpoint: next.endpoint } : {}),
      ...(next.model ? { model: next.model } : {}),
      ...(next.timeoutMs !== undefined ? { timeoutMs: next.timeoutMs } : {}),
      ...(next.cacheTtlMs !== undefined ? { cacheTtlMs: next.cacheTtlMs } : {}),
      ...(next.maxCallsPerSession !== undefined ? { maxCallsPerSession: next.maxCallsPerSession } : {}),
      domains: { ...next.domains },
      onShadow: (record) => appendShadow(JSON.stringify(record)),
    });
  }

  async function ensureConfig(ctx: ExtensionContext): Promise<FlowClassifierConfig> {
    let cwd: string;
    try {
      cwd = ctx.cwd;
    } catch {
      return config;
    }
    const sessionId = ctx.sessionManager?.getSessionId();
    if (configCwd === cwd && configSession === sessionId && configRuntime === ctx.modelRegistry) {
      if (configLoad) await configLoad;
      return config;
    }
    bindClassifierRuntime({ hostVersion: VERSION, runtime: ctx.modelRegistry, sessionId, cwd });
    configSession = sessionId;
    configRuntime = ctx.modelRegistry;
    configCwd = cwd;
    const epoch = generation;
    const loading = loadClassifierConfig(cwd, { applyEnv: false });
    configLoad = loading;
    try {
      const loaded = await loading;
      if (!disposed && epoch === generation && configCwd === cwd && ctx.cwd === cwd && ctx.sessionManager?.getSessionId() === sessionId) applyConfig(loaded);
      return config;
    } finally { if (configLoad === loading) configLoad = undefined; }
  }

  async function persistConfig(next: FlowClassifierConfig, ctx: ExtensionContext, reset = false): Promise<void> {
    const cwd = ctx.cwd;
    const epoch = generation;
    const assertFresh = (): void => {
      if (disposed || generation !== epoch || ctx.signal?.aborted || ctx.cwd !== cwd) throw new Error("Classifier command cancelled or stale.");
    };
    const before = reset ? await loadClassifierConfig(cwd, { applyEnv: false }) : config;
    assertFresh();
    const changes: SettingsChange[] = [];
    for (const field of ["enabled", "endpoint", "model", "timeoutMs", "cacheTtlMs", "maxCallsPerSession"] as const) {
      if (!reset && before[field] === next[field]) continue;
      const value = next[field];
      changes.push(value === undefined
        ? { operation: "unset", scope: "project", key: `classifier.${field}` }
        : { operation: "set", scope: "project", key: `classifier.${field}`, value });
    }
    for (const name of new Set([...Object.keys(before.domains), ...Object.keys(next.domains)])) {
      if (!reset && before.domains[name] === next.domains[name]) continue;
      const value = next.domains[name];
      changes.push(value === undefined
        ? { operation: "unset", scope: "project", key: `classifier.domains.${name}` }
        : { operation: "set", scope: "project", key: `classifier.domains.${name}`, value });
    }
    const context = { cwd, locale: "en" as const };
    const snapshot = await settingsProvider.read({ context });
    await saveClassifierPanel(settingsProvider, context, snapshot, changes, assertFresh, reset);
  }

  function formatStatus(): string {
    const status = classifierStatus();
    const lines = [
      `Classifier: ${status.enabled ? "enabled" : "disabled"} · runtime=${status.runtimeStatus ?? "unknown"} · ${diagnosticText(status.runtimeReason) || "ready"}`,
      `Config: ${classifierConfigPath(configCwd)}${envOverrideForClassifier(process.env[CLASSIFIER_ENV_FLAG]) !== undefined ? ` · env ${CLASSIFIER_ENV_FLAG}` : ""}`,
      `Endpoint: ${status.endpoint ?? "auto"} · Model pin: ${diagnosticText(status.model) || "auto"} · selected: ${diagnosticText(status.effectiveModel) || "none"} · Calls: ${status.callsUsed}/${status.maxCalls} · Cache: ${status.cacheSize}`,
      "Domains:",
    ];
    const names = listClassifyDomains();
    if (names.length === 0) lines.push("  (none registered)");
    for (const name of names) {
      const domain = status.domains[name];
      if (!domain) continue;
      const modes = domain.supportedModes.join("|");
      lines.push(`  ${name}: ${domain.mode}  (supports: ${modes})`);
    }
    lines.push("", `Shadow log: ${join(classifierOutputRoot(), "shadow", "<date>.jsonl")}`);
    return lines.join("\n");
  }

  pi.on("session_before_switch", () => fence());
  pi.on("session_before_fork", () => fence());
  pi.on("session_shutdown", () => fence());
  pi.on("session_start", (_event, ctx) => {
    fence();
    configCwd = undefined;
    registerBuiltinClassifyDomains();
    registerClassifyDomain(signalTypeDomain);
    void ensureConfig(ctx);
  });

  pi.registerCommand("classifier", {
    description: "Classifier panel (F5 diagnostics, F6 model refresh); status | on | off | mode | test | businessdiagnose | business | shadow | handoff | diagnostics | modelrefresh | cancel | reset",
    async handler(args, ctx) {
      if (args.trim().toLowerCase() === "cancel") { fence(); ctx.ui.notify("Classifier operation cancelled; no quota reset.", "info"); return; }
      const invocationGeneration = generation;
      const invocationCwd = ctx.cwd;
      const invocationSession = ctx.sessionManager?.getSessionId();
      await ensureConfig(ctx);
      if (disposed || invocationGeneration !== generation || ctx.signal?.aborted || ctx.cwd !== invocationCwd
        || ctx.sessionManager?.getSessionId() !== invocationSession) throw new Error("Classifier command cancelled or stale.");
      const [head, ...rest] = args.trim().split(/\s+/);
      const cmd = (head || "panel").toLowerCase();
      fence();
      const controller = new AbortController();
      panelController = controller;
      const epoch = generation;
      const assertFresh = (): void => {
        if (disposed || generation !== epoch || controller.signal.aborted || ctx.signal?.aborted || ctx.cwd !== invocationCwd || ctx.sessionManager?.getSessionId() !== invocationSession) {
          controller.abort(); throw new Error("Classifier operation cancelled or stale.");
        }
      };
      const abort = () => controller.abort();
      ctx.signal?.addEventListener("abort", abort, { once: true });
      try {
      if (["panel", "config", "diagnostics", "handoff"].includes(cmd)) {
        await diagnosticWait(probeClassifierRuntime(controller.signal), controller.signal);
        assertFresh();
        if (!supportsCustomOverlay(ctx)) {
          ctx.ui.notify(`Classifier panel unavailable: requires interactive TUI; showing status.\n${formatStatus()}`, "info");
          return;
        }
        if (cmd === "diagnostics" || cmd === "handoff") await showClassifierDiagnostics(ctx, controller, assertFresh, cmd === "handoff" ? "handoff" : undefined);
        else await showClassifierSettings(ctx, settingsProvider, controller, assertFresh);
        return;
      }

      if (cmd === "status" || cmd === "modelrefresh") {
        const refreshed = cmd === "modelrefresh" ? await diagnosticWait(refreshClassifierPanelModels(VERSION, ctx.modelRegistry, controller.signal), controller.signal) : undefined;
        if (!refreshed) await diagnosticWait(probeClassifierRuntime(controller.signal), controller.signal);
        assertFresh();
        ctx.ui.notify(`${formatStatus()}${refreshed ? `\n${refreshed.classifierModels.unavailable ?? "Classifier catalog refreshed."} ${refreshed.llmModels.unavailable ?? "LLM catalog refreshed."} Pins unchanged.` : ""}`, "info");
        return;
      }
      if (cmd === "on" || cmd === "off") {
        await persistConfig({ ...config, enabled: cmd === "on", domains: { ...config.domains } }, ctx);
        assertFresh();
        const enabled = applyClassifierEnvOverrides(config).enabled;
        const override = envOverrideForClassifier(process.env[CLASSIFIER_ENV_FLAG]);
        ctx.ui.notify(`Classifier ${enabled ? "enabled" : "disabled"} (saved ${cmd} to .pi/classifier.json${override === undefined ? "" : `; overridden by ${CLASSIFIER_ENV_FLAG}`}).`, "info");
        return;
      }
      if (cmd === "reset") {
        await persistConfig({ ...DEFAULT_CLASSIFIER_CONFIG, domains: { ...DEFAULT_CLASSIFIER_CONFIG.domains } }, ctx, true);
        assertFresh();
        ctx.ui.notify(`Classifier config reset to defaults; spent session quota is not cleared.\n${formatStatus()}`, "info");
        return;
      }
      if (cmd === "mode") {
        const [domain, mode] = rest;
        const status = classifierStatus();
        if (!domain || !status.domains[domain]) {
          ctx.ui.notify(`Unknown domain "${domain ?? ""}". Registered: ${listClassifyDomains().join(", ") || "(none)"}.`, "error");
          return;
        }
        if (!mode || !(DOMAIN_MODES as readonly string[]).includes(mode)) {
          ctx.ui.notify(`Mode must be one of: ${DOMAIN_MODES.join(", ")}.`, "error");
          return;
        }
        if (!status.domains[domain]!.supportedModes.includes(mode as ClassifierDomainMode)) {
          ctx.ui.notify(
            `Domain "${domain}" does not support "${mode}" (supports: ${status.domains[domain]!.supportedModes.join(", ")}).`,
            "error",
          );
          return;
        }
        await persistConfig({ ...config, domains: { ...config.domains, [domain]: mode as ClassifierDomainMode } }, ctx);
        assertFresh();
        ctx.ui.notify(`Domain "${domain}" mode → ${mode} (saved).`, "info");
        return;
      }
      if (cmd === "test") {
        const [domain, ...textParts] = rest;
        const text = textParts.join(" ").trim();
        const status = classifierStatus();
        if (!domain || !status.domains[domain]) {
          ctx.ui.notify(`Unknown domain "${domain ?? ""}". Registered: ${listClassifyDomains().join(", ") || "(none)"}.`, "error");
          return;
        }
        if (!text) {
          ctx.ui.notify("Usage: /classifier test <domain> <text>", "error");
          return;
        }
        const result = await rawClassifierDiagnostic(ctx, domain, text, controller.signal);
        assertFresh();
        ctx.ui.notify(result.join("\n"), "info");
        return;
      }
      if (cmd === "businessdiagnose") {
        const [domain, ...text] = rest;
        if (!["ask", "evolve-capture", "evolve-review"].includes(domain ?? "")) throw new Error("Usage: /classifier businessdiagnose <ask|evolve-capture|evolve-review> <text>");
        const lines = await businessPolicyDiagnostic(ctx, domain as "ask" | "evolve-capture" | "evolve-review", text.join(" "), controller.signal);
        assertFresh(); ctx.ui.notify(lines.join("\n"), "info"); return;
      }
      if (cmd === "business" || cmd === "shadow") {
        const lines = cmd === "business" ? await classifierBusinessStatus(ctx) : (await readClassifierShadow()).lines;
        assertFresh(); ctx.ui.notify(lines.join("\n"), "info"); return;
      }
      ctx.ui.notify("Usage: /classifier panel | status | on | off | mode <domain> <off|shadow|jev> | test <domain> <text> | businessdiagnose <policy-domain> <text> | business | shadow | handoff | diagnostics | modelrefresh | cancel | reset", "error");
      } catch (error) {
        if (!disposed && generation === epoch && (!controller.signal.aborted || !/cancelled|aborted|stale/i.test(String(error))) && !ctx.signal?.aborted && ctx.cwd === invocationCwd && ctx.sessionManager?.getSessionId() === invocationSession) ctx.ui.notify(diagnosticText(error, 2000), "error");
      } finally {
        ctx.signal?.removeEventListener("abort", abort);
        controller.abort();
        if (panelController === controller) panelController = undefined;
      }
    },
  });
}
