/** Canonical UI-facing client for Gateway lifecycle, workspaces, config, journal, and tunnel state. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  GatewayControlClient,
  locateGatewayBinary,
  resetGatewayBinaryCache,
  type GatewayControlStatus,
} from "./control-client.ts";
import type { GatewayWorkspace } from "./contracts.ts";
import { loadGatewayConfig, loadGatewayConfigSync, writeGatewayConfigPatch, type GatewayConfigPatch } from "./config.ts";
import { SessionStore } from "./session-store.ts";
import type { CollaborativeSessionStateV1 } from "./session-contracts.ts";
import { buildGatewayChangesYaml, type GatewayConfigChanges } from "../tui/gateway-wizard.ts";
import { gatewayConfigPath } from "./state-paths.ts";
import type { GatewayTaskJournalRecord } from "./task-journal.ts";
import type { GatewayTunnelPublicState } from "./tunnel/provider.ts";

const GATEWAY_CONFIG_PATH = gatewayConfigPath;
const registeredPaths = new Set<string>();
const registeredWorkspaces = new Map<string, GatewayWorkspace>();
const workspaceRegistrationPromises = new Map<string, Promise<boolean>>();

export const LEASE_TTL_SECONDS = 300; // lease length; heartbeat renews every minute
const HEARTBEAT_MS = 60_000;

let leaseTimer: NodeJS.Timeout | undefined;
let leaseCwd: string | undefined;
let leaseGeneration = 0;

let defaultGatewayControl: GatewayControlClient | undefined;
let gatewayControlOverride: GatewayControlClient | undefined;

function gatewayControl(cwd?: string): GatewayControlClient {
  if (gatewayControlOverride) return gatewayControlOverride;
  if (!defaultGatewayControl || (cwd && defaultGatewayControl.cwd !== absoluteRoot(cwd))) {
    defaultGatewayControl = new GatewayControlClient({ cwd: absoluteRoot(cwd) });
  }
  return defaultGatewayControl;
}

/** @deprecated Compatibility name; resolves only a verified built-in Gateway binary. */
export function locateGateway(): string | undefined {
  return locateGatewayBinary()?.path;
}

function absoluteRoot(root: string | undefined): string {
  const rawRoot = root ?? process.cwd();
  return isAbsolute(rawRoot) ? resolve(rawRoot) : resolve(process.cwd(), rawRoot);
}

/**
 * Register `root` (defaults to process.cwd()) with the local Gateway runtime
 * under a lease. The CLI call is deferred by one event-loop turn, but the
 * returned promise settles after the config write completes. Deduplicated per
 * path so bursty callers only spawn one registration.
 */
export async function ensureGatewayWorkspace(
  root?: string,
  ttlSeconds: number = LEASE_TTL_SECONDS,
  generation?: number,
): Promise<boolean> {
  const absRoot = absoluteRoot(root);
  if (generation !== undefined && generation !== leaseGeneration) return false;
  if (registeredPaths.has(absRoot)) return true;
  const existing = workspaceRegistrationPromises.get(absRoot);
  if (existing) return existing;
  const registration = (async () => {
    registeredPaths.add(absRoot);
    const registered = await renewWorkspaceLease(absRoot, ttlSeconds, generation);
    if (!registered) registeredPaths.delete(absRoot);
    else registeredWorkspaces.set(absRoot, registered);
    return registered !== undefined;
  })();
  workspaceRegistrationPromises.set(absRoot, registration);
  try {
    return await registration;
  } finally {
    if (workspaceRegistrationPromises.get(absRoot) === registration) {
      workspaceRegistrationPromises.delete(absRoot);
    }
  }
}

/**
 * Renew the lease for an already-registered root. This bypasses the
 * per-path dedupe set: the heartbeat must actually re-register so the
 * TTL is extended while the window stays alive.
 */
function renewWorkspaceLease(absRoot: string, ttlSeconds: number, generation?: number): Promise<GatewayWorkspace | undefined> {
  return new Promise((resolve) => {
    setImmediate(async () => {
      if (generation !== undefined && generation !== leaseGeneration) {
        resolve(undefined);
        return;
      }
      try {
        const registered = await gatewayControl().registerWorkspace(absRoot, ttlSeconds);
        if (generation === undefined || generation === leaseGeneration) registeredWorkspaces.set(absRoot, registered);
        resolve(registered);
      } catch (error) {
        console.warn(`[pi-maestro-flow] Gateway workspace registration skipped: ${error instanceof Error ? error.message : String(error)}`);
        resolve(undefined);
      }
    });
  });
}

/** Unregister `root` (defaults to process.cwd()) from the local Gateway runtime. */
export function removeGatewayWorkspace(root?: string): void {
  const absRoot = absoluteRoot(root);
  registeredPaths.delete(absRoot);
  const registration = registeredWorkspaces.get(absRoot);
  registeredWorkspaces.delete(absRoot);
  const fence = registration?.mode === "lease" && registration.ownerToken
    ? { expectedGeneration: registration.generation, ownerToken: registration.ownerToken }
    : undefined;
  void gatewayControl().unregisterWorkspace(absRoot, fence).catch((error) => {
    console.warn(`[pi-maestro-flow] Gateway workspace removal skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Start a lease for `cwd`: register immediately, then renew every minute so
 * the workspace stays alive while this window is running. When the window
 * goes offline the heartbeat stops and Gateway drops the workspace at expiry.
 * Resolves after the initial registration command has completed.
 */
export async function startWorkspaceLease(cwd: string, ttlSeconds: number = LEASE_TTL_SECONDS): Promise<boolean> {
  stopWorkspaceLease();
  leaseCwd = cwd;
  leaseGeneration++;
  const generation = leaseGeneration;
  const absRoot = absoluteRoot(cwd);
  registeredPaths.delete(absRoot);
  const registered = await ensureGatewayWorkspace(cwd, ttlSeconds, generation);
  if (generation === leaseGeneration) {
    leaseTimer = setInterval(() => { void renewWorkspaceLease(absoluteRoot(cwd), ttlSeconds, generation); }, HEARTBEAT_MS);
    leaseTimer.unref?.(); // never keep the process alive on shutdown
    console.log(`[pi-maestro-flow] Gateway workspace lease started (ttl ${ttlSeconds}s, heartbeat ${HEARTBEAT_MS / 1000}s): ${cwd}`);
  }
  return registered;
}

/** Stop the lease heartbeat (used when the window is unregistered or closed). */
export function stopWorkspaceLease(): void {
  leaseGeneration++; // invalidate any heartbeat renewal already enqueued via setImmediate
  if (leaseTimer) {
    clearInterval(leaseTimer);
    leaseTimer = undefined;
  }
  leaseCwd = undefined;
}

/**
 * Register `cwd` permanently (no TTL lease): the entry has no expires_at and
 * survives window close until explicitly removed. Any active lease heartbeat
 * for the previous registration is stopped first. Resolves after the register
 * command completes.
 */
export async function registerGatewayWorkspacePermanent(cwd: string): Promise<boolean> {
  stopWorkspaceLease();
  const absRoot = absoluteRoot(cwd);
  registeredPaths.delete(absRoot); // force a real re-register even if a lease entry exists
  return ensureGatewayWorkspace(cwd, 0);
}

/** Test hook: reset the in-process deduplication state. */
export function _resetGatewayWorkspaceClientState(): void {
  registeredPaths.clear();
  registeredWorkspaces.clear();
  workspaceRegistrationPromises.clear();
  stopWorkspaceLease();
  defaultGatewayControl = undefined;
  gatewayControlOverride = undefined;
  resetGatewayBinaryCache();
}

/** Focused-test seam; production callers always use the authenticated control client. */
export function setGatewayControlClientForTest(client: GatewayControlClient | undefined): () => void {
  const previous = gatewayControlOverride;
  gatewayControlOverride = client;
  return () => { gatewayControlOverride = previous; };
}

/** Test hook retained for compatibility. */
export function _resetGatewayBinaryCache(): void {
  resetGatewayBinaryCache();
}

/** Test hook retained for compatibility. */
export function _resetGatewayDetectionCache(): void {
  resetGatewayBinaryCache();
}

// --- Native tunnel state and control (shared by overlay + wizard + extension) ---

export type TunnelHealth = "ok" | "auth" | "dead" | "unknown";

export interface TunnelState {
  provider: "cloudflare" | "openai";
  instance: string;
  generation: number;
  phase: "stopped" | "starting" | "ready" | "degraded" | "quiescing" | "failed";
  pid?: number;
  url?: string;
  opaqueId?: string;
  alive: boolean;
  health: TunnelHealth;
  detail?: string;
}

export interface CloudflareTunnelFence {
  generation: number;
  endpoint: string;
}

function publicTunnelState(value: GatewayTunnelPublicState | { providers: unknown[] }): GatewayTunnelPublicState | undefined {
  if ("providers" in value) return undefined;
  return value;
}

function projectTunnelState(state?: GatewayTunnelPublicState, provider: TunnelState["provider"] = "cloudflare"): TunnelState {
  const phase = state?.observed.phase ?? "stopped";
  const detail = state?.observed.detail;
  const health: TunnelHealth = phase === "ready"
    ? (detail?.includes("OAuth challenge") ? "auth" : "ok")
    : phase === "starting" || phase === "quiescing" ? "unknown" : "dead";
  return {
    provider,
    instance: state?.instance ?? "default",
    generation: state?.generation ?? 0,
    phase,
    ...(state?.pid === undefined ? {} : { pid: state.pid }),
    ...(state?.observed.endpoint === undefined ? {} : { url: state.observed.endpoint }),
    ...(state?.observed.opaqueId === undefined ? {} : { opaqueId: state.observed.opaqueId }),
    alive: state?.pid !== undefined && (phase === "starting" || phase === "ready" || phase === "degraded" || phase === "quiescing"),
    health,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Read only the supervisor's native state; no PID file or process-name adoption is consulted. */
export async function readTunnelState(): Promise<TunnelState> {
  try {
    return projectTunnelState(publicTunnelState(await gatewayControl().tunnelStatus("cloudflare")));
  } catch (error) {
    return {
      ...projectTunnelState(),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read experimental OpenAI provider state without activating or provisioning it. */
export async function readOpenAiTunnelState(): Promise<TunnelState> {
  try {
    return projectTunnelState(publicTunnelState(await gatewayControl().tunnelStatus("openai")), "openai");
  } catch (error) {
    return { ...projectTunnelState(undefined, "openai"), detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function startQuickTunnel(localPort: number, timeoutMs = 30_000): Promise<GatewayTunnelPublicState> {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw new Error("无效的隧道端口（必须为 1-65535）");
  return gatewayControl().tunnelStart("cloudflare", { timeoutMs, input: { mode: "quick", localPort } });
}

export async function restartQuickTunnel(localPort: number, timeoutMs = 30_000, expectedGeneration?: number): Promise<string> {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw new Error("无效的隧道端口（必须为 1-65535）");
  const state = await gatewayControl().tunnelRestart("cloudflare", {
    timeoutMs,
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    input: { mode: "quick", localPort },
  });
  const endpoint = state.observed.endpoint;
  if (state.observed.phase !== "ready" || !endpoint) throw new Error(state.observed.detail ?? "Cloudflare Quick Tunnel 未就绪");
  return endpoint;
}

export async function stopQuickTunnel(expectedGeneration?: number): Promise<void> {
  await gatewayControl().tunnelStop("cloudflare", expectedGeneration === undefined ? {} : { expectedGeneration });
}

export interface OpenAiTunnelStartOptions {
  localPort: number;
  binaryPath?: string;
  tunnelIdEnv: string;
  runtimeKeyEnv: string;
  timeoutMs?: number;
}

/** Start the explicitly configured OpenAI provider; values are references, never secret material. */
export async function startOpenAiTunnel(options: OpenAiTunnelStartOptions): Promise<GatewayTunnelPublicState> {
  if (!Number.isSafeInteger(options.localPort) || options.localPort < 1 || options.localPort > 65_535) throw new Error("无效的隧道端口（必须为 1-65535）");
  return gatewayControl().tunnelStart("openai", {
    timeoutMs: options.timeoutMs ?? 30_000,
    input: {
      enabled: true,
      experimental: true,
      localPort: options.localPort,
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      tunnelIdEnv: options.tunnelIdEnv,
      runtimeKeyEnv: options.runtimeKeyEnv,
    },
  });
}

export async function stopOpenAiTunnel(expectedGeneration?: number): Promise<void> {
  await gatewayControl().tunnelStop("openai", expectedGeneration === undefined ? {} : { expectedGeneration });
}

async function assertCurrentCloudflareTunnel(fence: CloudflareTunnelFence): Promise<void> {
  const state = publicTunnelState(await gatewayControl().tunnelStatus("cloudflare"));
  if (!state || state.generation !== fence.generation || state.observed.phase !== "ready" || state.observed.endpoint !== fence.endpoint) {
    throw Object.assign(new Error("Cloudflare tunnel generation is stale; refusing to write its endpoint"), { code: "stale_generation" });
  }
}

/**
 * Whether the initial wizard configuration has been completed: the native Gateway config
 * exists with a concrete auth.mode (bearer/oauth/dual). Used by the overlay's
 * register-window action to decide whether to auto-open the wizard.
 *
 * Mirrors gateway's EffectiveAuthMode: an empty mode with a non-empty token is
 * bearer (a valid, usable configuration), so accept that as configured too.
 * `open` is intentionally excluded — it is not safe for window registration on
 * a runtime that may be exposed, so an open-mode user is still routed to the
 * wizard to pick bearer/oauth.
 */
export function isGatewayConfigured(): boolean {
  if (!existsSync(GATEWAY_CONFIG_PATH())) return false;
  try {
    const auth = loadGatewayConfigSync(GATEWAY_CONFIG_PATH()).auth;
    if (auth.mode === "bearer") return Boolean(auth.token);
    if (auth.mode === "dual") return Boolean(auth.token && auth.oauth?.serverUrl);
    if (auth.mode === "oauth") return Boolean(auth.oauth?.serverUrl);
    return false;
  } catch {
    return false;
  }
}

/**
 * Read the OAuth ops password (运维口令) from the native Gateway config.
 * gateway auto-generates one at startup when this is empty (kept in memory + the
 * startup log only). Persisting it here makes it stable across restarts and
 * lets the board show it for the authorize page.
 * Returns undefined when not set in config (the runtime still has an in-memory one).
 */
export function readGatewayOpsPassword(): string | undefined {
  try { return loadGatewayConfigSync(GATEWAY_CONFIG_PATH()).auth.oauth?.password || undefined; }
  catch { return undefined; }
}

/** Read a configured bearer token for local Runtime calls. OAuth passwords are not tokens. */
export function readGatewayBearerToken(): string | undefined {
  try {
    const auth = loadGatewayConfigSync(GATEWAY_CONFIG_PATH()).auth;
    return auth.mode === "bearer" || auth.mode === "dual" ? auth.token : undefined;
  } catch {
    return undefined;
  }
}

/** Structured view of the editable gateway config fields, for the inline /gateway
 *  config editor. Reads the native Gateway config once and surfaces every field the
 *  overlay can edit; missing fields default to gateway's documented defaults so
 *  the editor shows a complete form even on a hand-trimmed config. */
export interface GatewayConfigView {
  server: { host: string; port: number; disableLocalhostProtection: boolean; trustProxyHeaders: boolean };
  auth: { mode: "open" | "bearer" | "oauth" | string; token: string; oauthPassword: string; oauthServerURL: string };
  commands: {
    default: "allow" | "confirm" | "deny" | string;
    allow: string[];
    confirm: string[];
    deny: string[];
    autoAllowReadonly: boolean | null;
  };
  files: {
    maxReadBytes: number;
    maxPatchFiles: number;
    allow: string[];
    confirm: string[];
    deny: string[];
  };
  tunnels: {
    openai: {
      enabled: boolean;
      binaryPath: string;
      tunnelIdEnv: string;
      runtimeKeyEnv: string;
      minimumVersion: string;
      credentialTtlMs: number;
    };
  };
}

/** Read the editable fields of the native Gateway config into a structured view. */
export function readGatewayConfigView(): GatewayConfigView | undefined {
  try {
    const config = loadGatewayConfigSync(GATEWAY_CONFIG_PATH());
    return {
      server: {
        host: config.server.host,
        port: config.server.port,
        disableLocalhostProtection: config.server.disableLocalhostProtection,
        trustProxyHeaders: config.server.trustProxyHeaders,
      },
      auth: {
        mode: config.auth.mode,
        token: config.auth.token ?? "",
        oauthPassword: config.auth.oauth?.password ?? "",
        oauthServerURL: config.auth.oauth?.serverUrl ?? "",
      },
      commands: structuredClone(config.security.commands),
      files: structuredClone(config.security.files),
      tunnels: {
        openai: {
          enabled: config.tunnels.openai.enabled,
          binaryPath: config.tunnels.openai.binaryPath ?? "",
          tunnelIdEnv: config.tunnels.openai.tunnelIdEnv,
          runtimeKeyEnv: config.tunnels.openai.runtimeKeyEnv,
          minimumVersion: config.tunnels.openai.minimumVersion,
          credentialTtlMs: config.tunnels.openai.credentialTtlMs,
        },
      },
    };
  } catch {
    return undefined;
  }
}

/** Apply partial UI edits through the canonical config patcher.
 * Omitted fields are preserved, arrays replace, and null clears the key. */
export async function writeGatewayConfigChanges(changes: GatewayConfigChanges, tunnelFence?: CloudflareTunnelFence): Promise<{ yaml: string; summary: string[] }> {
  if (changes.tunnelUrl && tunnelFence) await assertCurrentCloudflareTunnel(tunnelFence);
  const current = loadGatewayConfigSync(GATEWAY_CONFIG_PATH());
  const patch: GatewayConfigPatch = {};
  const server: Record<string, unknown> = {};
  const http: Record<string, unknown> = {};
  if (changes.host !== undefined) { server.host = changes.host; http.host = changes.host; }
  if (changes.port !== undefined) { server.port = changes.port; http.port = changes.port; }
  if (changes.authMode === "oauth" || changes.tunnelUrl) {
    server.disable_localhost_protection = true;
    server.trust_proxy_headers = true;
  }
  if (changes.disableLocalhostProtection !== undefined) server.disable_localhost_protection = changes.disableLocalhostProtection;
  if (changes.trustProxyHeaders !== undefined) server.trust_proxy_headers = changes.trustProxyHeaders;
  if (Object.keys(server).length > 0) patch.server = server as never;
  if (Object.keys(http).length > 0) patch.transport = { http } as never;

  const auth: Record<string, unknown> = {};
  if (changes.authMode !== undefined) auth.mode = changes.authMode;
  if (changes.authToken !== undefined) auth.token = changes.authToken || null;
  const oauth: Record<string, unknown> = {};
  if (changes.oauthPassword !== undefined) oauth.password = changes.oauthPassword || null;
  if (changes.oauthServerURL !== undefined) oauth.server_url = changes.oauthServerURL || null;
  if (changes.tunnelUrl) {
    if (!changes.authMode || changes.authMode === "open") auth.mode = "oauth";
    oauth.server_url = changes.oauthServerURL || changes.tunnelUrl;
  }
  if (changes.authMode === "oauth" && Object.keys(oauth).length === 0 && !current.auth.oauth) oauth.tokenTtlMs = 86_400_000;
  if (Object.keys(oauth).length > 0) auth.oauth = oauth;
  if (Object.keys(auth).length > 0) patch.auth = auth as never;

  const commands: Record<string, unknown> = {};
  if (changes.commandsDefault !== undefined) commands.default = changes.commandsDefault;
  if (changes.commandsAllow !== undefined) commands.allow = changes.commandsAllow;
  if (changes.commandsConfirm !== undefined) commands.confirm = changes.commandsConfirm;
  if (changes.commandsDeny !== undefined) commands.deny = changes.commandsDeny;
  if (changes.commandsAutoReadonly !== undefined) commands.auto_allow_readonly = changes.commandsAutoReadonly;
  if (changes.allowPi) commands.allow = [...new Set([...current.security.commands.allow, "^pi\\b"])];
  const files: Record<string, unknown> = {};
  if (changes.filesMaxReadBytes !== undefined) files.max_read_bytes = changes.filesMaxReadBytes;
  if (changes.filesMaxPatchFiles !== undefined) files.max_patch_files = changes.filesMaxPatchFiles;
  if (changes.filesAllow !== undefined) files.allow = changes.filesAllow;
  if (changes.filesConfirm !== undefined) files.confirm = changes.filesConfirm;
  if (changes.filesDeny !== undefined) files.deny = changes.filesDeny;
  const security: Record<string, unknown> = {};
  if (Object.keys(commands).length > 0) security.commands = commands;
  if (Object.keys(files).length > 0) security.files = files;
  if (changes.skillDirs !== undefined && changes.skillDirs.length > 0) {
    security.skills = {
      enabled: true,
      external_skill_roots: [...new Set([...current.security.skills.externalSkillRoots, ...changes.skillDirs])],
    };
  }
  if (Object.keys(security).length > 0) patch.security = security as never;

  const openai: Record<string, unknown> = {};
  if (changes.openAiTunnelEnabled !== undefined) openai.enabled = changes.openAiTunnelEnabled;
  if (changes.openAiTunnelBinaryPath !== undefined) openai.binary_path = changes.openAiTunnelBinaryPath || null;
  if (changes.openAiTunnelIdEnv !== undefined) openai.tunnel_id_env = changes.openAiTunnelIdEnv;
  if (changes.openAiRuntimeKeyEnv !== undefined) openai.runtime_key_env = changes.openAiRuntimeKeyEnv;
  if (changes.openAiMinimumVersion !== undefined) openai.minimum_version = changes.openAiMinimumVersion;
  if (changes.openAiCredentialTtlMs !== undefined) openai.credential_ttl_ms = changes.openAiCredentialTtlMs;
  if (Object.keys(openai).length > 0) patch.tunnels = { openai } as never;

  const existing = existsSync(GATEWAY_CONFIG_PATH()) ? readFileSync(GATEWAY_CONFIG_PATH(), "utf8") : "";
  const summary = buildGatewayChangesYaml(existing, changes, process.cwd()).summary;
  if (Object.keys(openai).length > 0) summary.push("OpenAI Tunnel 配置");
  const document = await writeGatewayConfigPatch(GATEWAY_CONFIG_PATH(), patch);
  return { yaml: document.raw, summary };
}

/** Compatibility name: report only a verified packaged Gateway binary. */
export function detectGateway(): { installed: boolean; version?: string } {
  const binary = locateGatewayBinary();
  return binary ? { installed: true, version: binary.version } : { installed: false };
}

export async function removeGatewayWorkspaceByPath(path: string): Promise<{ ok: boolean; message: string }> {
  try {
    const absRoot = absoluteRoot(path);
    const registration = registeredWorkspaces.get(absRoot);
    const fence = registration?.mode === "lease" && registration.ownerToken
      ? { expectedGeneration: registration.generation, ownerToken: registration.ownerToken }
      : undefined;
    const removed = await gatewayControl().unregisterWorkspace(absRoot, fence);
    if (removed) {
      registeredPaths.delete(absRoot);
      registeredWorkspaces.delete(absRoot);
    }
    return removed
      ? { ok: true, message: "已移除 Gateway workspace" }
      : { ok: false, message: "Gateway workspace 不存在" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function listGatewayWorkspaces(): Promise<GatewayWorkspace[]> {
  return gatewayControl().listWorkspaces();
}

/** Read the workspace-local collaboration authority for the `/gateway` UI.
 * This is intentionally separate from Pi Todo and never reads its store. */
export async function readGatewayCollaborativeSessions(cwd: string): Promise<CollaborativeSessionStateV1[]> {
  const config = await loadGatewayConfig();
  const sessionsRoot = config.state.sessionsRoot ?? (config.state.rootDir ? join(config.state.rootDir, "sessions") : undefined);
  return new SessionStore({ cwd, sessionsRoot }).list();
}

// --- Gateway task journal (metadata only; no legacy delegated-task aggregation) ---

export type GatewayJournalTask = GatewayTaskJournalRecord;

export async function readGatewayTasks(cwd?: string): Promise<GatewayJournalTask[] | undefined> {
  try {
    const tasks = await gatewayControl(cwd).listTasks();
    tasks.sort((left, right) => right.createdAt - left.createdAt);
    return tasks.length > 0 ? tasks : undefined;
  } catch {
    return undefined;
  }
}

// --- Tunnel endpoint config sync ---

function replaceConfigAtomically(next: string): void {
  const path = GATEWAY_CONFIG_PATH();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.gateway-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best-effort */ }
  }
}

/** Restore a previously-read config snapshot after a failed tunnel transaction. */
export function restoreGatewayConfig(raw: string): void {
  if (!raw) throw new Error("config.yaml 快照为空");
  replaceConfigAtomically(raw);
}

/** Update auth.oauth.server_url in the native Gateway config (in place, section-preserving). */
export async function updateGatewayConfigServerURL(url: string, tunnelFence?: CloudflareTunnelFence): Promise<void> {
  if (tunnelFence) await assertCurrentCloudflareTunnel(tunnelFence);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("无效的隧道 URL: " + url); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("隧道 URL 必须是 http/https: " + url);
  const path = GATEWAY_CONFIG_PATH();
  const raw = readFileSync(path, "utf8");
  const pattern = /^(\s{2,}server_url:\s*).*/m;
  if (!pattern.test(raw)) throw new Error("config.yaml 无 server_url 字段");
  const next = raw.replace(pattern, (_match, prefix: string) => `${prefix}${parsed.href.replace(/\/$/, "")}`);
  replaceConfigAtomically(next);
}

export async function readGatewayControlStatus(cwd?: string): Promise<GatewayControlStatus> {
  return gatewayControl(cwd).status();
}

export async function startGateway(cwd?: string): Promise<GatewayControlStatus> {
  return gatewayControl(cwd).start();
}

export async function restartGateway(cwd?: string): Promise<GatewayControlStatus> {
  return gatewayControl(cwd).restart();
}

export async function stopGateway(cwd?: string): Promise<void> {
  await gatewayControl(cwd).stop();
}
