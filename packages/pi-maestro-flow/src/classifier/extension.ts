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
  classify,
  bindClassifierRuntime,
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
  saveClassifierConfig,
  type FlowClassifierConfig,
} from "./config.ts";
import { buildDomainTestInput, signalTypeDomain } from "./domains.ts";
import {
  createClassifierSettingsProvider,
  registerClassifierSettingsProvider,
} from "./settings-provider.ts";
import { classifierStatus as engineStatus } from "pi-maestro-teammate/v1/classify";

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

  // Eager registration so `/classifier` works before the first session_start.
  registerBuiltinClassifyDomains();
  registerClassifyDomain(signalTypeDomain);

  // Settings shell surface — same event-bus protocol as the other providers.
  // `apply` hot-pushes committed config into the engine (activation: live).
  if (pi.events) {
    registerClassifierSettingsProvider(pi.events, createClassifierSettingsProvider({
      getDomains: () => {
        const status = engineStatus();
        return listClassifyDomains().map((name) => ({
          name,
          modes: status.domains[name]?.supportedModes ?? DOMAIN_MODES,
        }));
      },
      apply: (_effective, configured) => applyConfig(configured),
    }));
  }

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
    if (configCwd === cwd) return config;
    bindClassifierRuntime({ hostVersion: VERSION, runtime: ctx.modelRegistry });
    configCwd = cwd;
    const loaded = await loadClassifierConfig(cwd, { applyEnv: false });
    applyConfig(loaded);
    return config;
  }

  async function persistConfig(next: FlowClassifierConfig, ctx: ExtensionContext): Promise<void> {
    // Never publish runtime changes (or persist env overrides) before saving succeeds.
    await saveClassifierConfig(next, ctx.cwd);
    applyConfig(next);
  }

  function formatStatus(): string {
    const status = classifierStatus();
    const lines = [
      `Classifier: ${status.enabled ? "enabled" : "disabled"}${status.apiKeyPresent ? "" : " (no API key)"}`,
      `Config: ${classifierConfigPath(configCwd)}${envOverrideForClassifier(process.env[CLASSIFIER_ENV_FLAG]) !== undefined ? ` · env ${CLASSIFIER_ENV_FLAG}` : ""}`,
      `Endpoint: ${status.endpoint ?? "auto"} · Model: ${status.model ?? "default"} · Calls: ${status.callsUsed}/${status.maxCalls} · Cache: ${status.cacheSize}`,
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

  pi.on("session_start", (_event, ctx) => {
    configCwd = undefined;
    registerBuiltinClassifyDomains();
    registerClassifyDomain(signalTypeDomain);
    void ensureConfig(ctx);
  });

  pi.registerCommand("classifier", {
    description: "Classifier: /classifier status | on | off | mode <domain> <off|shadow|jev> | test <domain> <text> | reset",
    async handler(args, ctx) {
      await ensureConfig(ctx);
      const [head, ...rest] = args.trim().split(/\s+/);
      const cmd = (head ?? "status").toLowerCase();

      if (cmd === "status" || head === undefined) {
        ctx.ui.notify(formatStatus(), "info");
        return;
      }
      if (cmd === "on" || cmd === "off") {
        await persistConfig({ ...config, enabled: cmd === "on", domains: { ...config.domains } }, ctx);
        const enabled = applyClassifierEnvOverrides(config).enabled;
        const override = envOverrideForClassifier(process.env[CLASSIFIER_ENV_FLAG]);
        ctx.ui.notify(`Classifier ${enabled ? "enabled" : "disabled"} (saved ${cmd} to .pi/classifier.json${override === undefined ? "" : `; overridden by ${CLASSIFIER_ENV_FLAG}`}).`, "info");
        return;
      }
      if (cmd === "reset") {
        await persistConfig({ ...DEFAULT_CLASSIFIER_CONFIG, domains: { ...DEFAULT_CLASSIFIER_CONFIG.domains } }, ctx);
        ctx.ui.notify(`Classifier config reset to defaults.\n${formatStatus()}`, "info");
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
        const result = await classify(domain, buildDomainTestInput(domain, text));
        ctx.ui.notify(
          `[${domain}] ${result.label} (layer=${result.layer}, confidence=${result.confidence.toFixed(2)}${result.model ? `, model=${result.model}` : ""}${result.degradedReason ? `, degraded=${result.degradedReason}` : ""})`,
          "info",
        );
        return;
      }
      ctx.ui.notify(
        "Usage: /classifier status | on | off | mode <domain> <off|shadow|jev> | test <domain> <text> | reset",
        "error",
      );
    },
  });
}
