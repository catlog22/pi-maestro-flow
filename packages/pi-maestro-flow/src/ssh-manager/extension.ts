import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeCardText, toolCallLine, toolResultLine } from "../quiet-render.ts";
import { getVisibleTasks } from "../tools/todo.ts";
import {
  SshHostProviderError,
  registerSshHostProvider,
  type SshHostProvider,
} from "pi-maestro-teammate/v1/ssh-hosts";
import type {
  SshHostProfile,
  SshHostReferenceSummary,
} from "pi-maestro-backend-core/v1/ssh";
import { EncryptedSshStore, defaultSshManagerStorePath } from "./encrypted-store.ts";
import { SshExecutor, type SshExecutionResult } from "./executor.ts";
import {
  SshGatewayClientPool,
  type SshGatewayActionResult,
} from "./gateway-client.ts";
import { pairSshGateway, sshGatewayGuide, unpairSshGateway } from "./guide.ts";
import { SshToolParams, type SshToolInput } from "./llm-tool.ts";
import {
  SSH_HOST_ID_PATTERN,
  SSH_HOST_KEY_PATTERN,
  SSH_MAX_PRIVATE_KEY_BYTES,
  createSshHostId,
  createSshKeyId,
  reverseSshHostDependencyClosure,
  validateSshHost,
  validateSshKey,
  type SshAuth,
  type SshHost,
  type SshKey,
  type SshShell,
} from "./model.ts";
import {
  discoverOpenSshConfig,
  type DiscoverOpenSshOptions,
  type OpenSshDiscoveryResult,
  type OpenSshImportCandidate,
} from "./openssh-config.ts";
import { SshStatusMonitor, type SshHostOperationalStatus } from "./status-monitor.ts";
import {
  TeammateRemoteChannelBroker,
  sshHostReferenceIssue,
} from "./remote-channel.ts";
import {
  CurrentUserPiConfigSource,
  SshPiConfigSyncTransport,
  syncPiConfig,
  type PiConfigLocalSource,
  type PiConfigSyncAudit,
  type PiConfigSyncTransport,
} from "./pi-config-sync.ts";
import {
  MaskedSecretInput,
  SshHostManagerOverlay,
  type SshHostManagerAction,
  type SshManagerTheme,
  type SshManagerView,
} from "./tui.ts";

const SSH_STATUS_KEY = "maestro-ssh";

interface SelectedSshHost {
  id: string;
  digest: string;
}

interface SshToolTargetDetails {
  label: string;
  host: string;
  user: string;
  port: number;
  shell: SshShell;
}

interface SshToolDetails {
  hostId?: string;
  target?: SshToolTargetDetails;
  action?: string;
  tool?: string;
  summary?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export interface RegisterSshManagerOptions {
  storePath?: string;
  store?: EncryptedSshStore;
  executor?: SshExecutor;
  gatewayPool?: SshGatewayClientPool;
  monitor?: SshStatusMonitor;
  discoverOpenSsh?: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>;
  configSource?: PiConfigLocalSource;
  configSyncTransport?: (host: SshHost) => PiConfigSyncTransport;
  configSyncAudit?: PiConfigSyncAudit;
}

export function registerSshManager(
  pi: ExtensionAPI,
  options: RegisterSshManagerOptions = {},
): void {
  const store = options.store ?? new EncryptedSshStore({ path: options.storePath ?? defaultSshManagerStorePath() });
  const executor = options.executor ?? new SshExecutor(undefined, store);
  const gatewayPool = options.gatewayPool ?? new SshGatewayClientPool(executor, { bindingSource: store });
  const monitor = options.monitor ?? new SshStatusMonitor(store, executor);
  const discoverOpenSsh = options.discoverOpenSsh ?? discoverOpenSshConfig;
  const configSource = options.configSource ?? new CurrentUserPiConfigSource();
  const configSyncTransport = options.configSyncTransport ?? ((host: SshHost) => new SshPiConfigSyncTransport(executor, host));
  const remoteChannelBroker = new TeammateRemoteChannelBroker(store, executor);
  let selected: SelectedSshHost | undefined;
  let activeContext: ExtensionContext | undefined;

  const clearSelection = (ctx: ExtensionContext | undefined = activeContext): void => {
    const previous = selected;
    selected = undefined;
    if (previous) void gatewayPool.invalidateHost(previous.id).catch(() => undefined);
    ctx?.ui.setStatus(SSH_STATUS_KEY, undefined);
  };

  const connectionFence = (hostId: string): string => `${store.revision}:${store.getEffectiveHostDigest(hostId)}:${store.getGatewayBindingFence(hostId)}`;

  const selectHost = (host: SshHost, ctx: ExtensionContext): void => {
    activeContext = ctx;
    const next = { id: host.id, digest: connectionFence(host.id) };
    if (selected && (selected.id !== next.id || selected.digest !== next.digest)) {
      void gatewayPool.invalidateHost(selected.id).catch(() => undefined);
    }
    selected = next;
    ctx.ui.setStatus(SSH_STATUS_KEY, `SSH · ${host.label} · ${formatSshAddress(host.host, host.port)}`);
  };

  const selectedHostForDisplay = (): SshHost | undefined => {
    if (!selected || store.locked) return undefined;
    const host = store.getHosts().find((candidate) => candidate.id === selected!.id);
    return host && connectionFence(host.id) === selected.digest ? host : undefined;
  };

  const currentSelectedHost = (): SshHost => {
    if (!selected) throw new Error("No SSH server is selected. Use action=targets with an unlocked manager and pass targetId, or send #ssh to choose a default.");
    const host = selectedHostForDisplay();
    if (!host) {
      clearSelection();
      throw new Error("The selected SSH server changed. Use action=targets or send #ssh to select it again.");
    }
    return host;
  };

  const resolveExecutionHost = (targetId?: string): SshHost => {
    if (targetId === undefined) return currentSelectedHost();
    if (!SSH_HOST_ID_PATTERN.test(targetId)) throw new Error("SSH target id is invalid");
    const host = store.getHosts().find((candidate) => candidate.id === targetId);
    if (!host) throw new Error(`SSH target ${JSON.stringify(targetId)} is unavailable`);
    return host;
  };

  const targetHostForDisplay = (targetId?: string): SshHost | undefined => {
    if (targetId === undefined) return selectedHostForDisplay();
    if (store.locked || !SSH_HOST_ID_PATTERN.test(targetId)) return undefined;
    return store.getHosts().find((candidate) => candidate.id === targetId);
  };

  const refreshStore = async (): Promise<void> => {
    if (store.locked) throw new Error("SSH manager is locked. Send #ssh or open /ssh to unlock it.");
    await store.reload();
  };

  const activateHost = async (hostId: string): Promise<void> => {
    const ctx = activeContext;
    if (!ctx) {
      throw new SshHostProviderError(
        "provider-unavailable",
        "SSH host activation requires an active host session.",
      );
    }
    if (!await ensureUnlocked(ctx, store)) {
      clearSelection(ctx);
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager remains locked because activation was cancelled.",
      );
    }
    let hosts: SshHost[];
    try {
      await refreshStore();
      monitor.reconcile();
      hosts = store.getHosts();
    } catch {
      clearSelection(ctx);
      throw new SshHostProviderError(
        "refresh-failed",
        "SSH manager could not be refreshed. Open /ssh in the host session and verify the encrypted store.",
      );
    }
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) {
      throw new SshHostProviderError(
        "host-not-found",
        `SSH host reference ${JSON.stringify(hostId)} was not found in the unlocked manager.`,
      );
    }
    selectHost(host, ctx);
  };

  const providerRegistration = registerSshHostProvider(createSshManagerHostProvider(store, {
    selectedId: () => selectedHostForDisplay()?.id,
    activate: activateHost,
    openTeammateRemoteChannel: (hostRef, signal) => remoteChannelBroker.open(hostRef, signal),
  }));

  const sshTool: ToolDefinition<typeof SshToolParams, SshToolDetails> = {
    name: "ssh",
    label: "SSH",
    renderShell: "self",
    description: `Execute a bounded command or use the built-in Pi Maestro Gateway on any configured SSH server after the user unlocks the manager.

Use action=targets to list provider-owned target ids, then pass targetId on a command or Gateway action. Omitting targetId preserves the optional #ssh default selection. The tool never accepts host or authentication parameters. Gateway actions and sync_pi_config use fixed remote commands that cannot be overridden. sync_pi_config accepts only fixed categories; the host resolves current-user Pi files internally and never exposes their paths or contents. start_pi snapshots only explicitly selected existing tasks from the current local Pi Todo and launches an independent remote Gateway session; it never synchronizes or completes either Todo authority. Server configuration stays in the encrypted user-level SSH manager. #ssh selection remains independent of teammate and remote-worker routing. Each resolved target decides whether ordinary commands run through bash or PowerShell.`,
    promptSnippet: "List unlocked SSH targets, execute a command, securely sync fixed Pi config categories, launch selected local Todo instructions with start_pi, or use Gateway actions by provider-owned targetId.",
    promptGuidelines: [
      "Use read-only inspection before mutations unless the user explicitly requested a change.",
      "Use action=guide for local Gateway setup instructions; it does not contact a server.",
      "Use action=targets after unlock and pass only a returned targetId; never invent target ids or connection parameters.",
      "For action=call, first use action=describe with the targetId and Gateway tool name; pass the returned tool inputSchema exactly in args. Dynamic call args are intentionally generic at this outer tool boundary.",
      "For session.start-pi, use the returned taskId or monitorHandle as monitor.handle; do not rename it to taskId when calling monitor.",
      "Never read or print private keys, passwords, tokens, credential stores, or host-key material.",
      "Do not claim access while the SSH manager is locked or to a target not returned by action=targets.",
    ],
    parameters: SshToolParams,
    async execute(
      _id: string,
      params: SshToolInput,
      signal: AbortSignal,
    ) {
      const requestedTargetId = "targetId" in params ? params.targetId : undefined;
      const details = (
        result?: SshExecutionResult,
        host?: SshHost,
        gatewayResult?: SshGatewayActionResult,
      ): SshToolDetails => ({
        ...(host
          ? { hostId: host.id, target: sshToolTargetDetails(host) }
          : requestedTargetId === undefined && selected?.id
            ? { hostId: selected.id }
            : {}),
        ...(gatewayResult ? {
          action: gatewayResult.action,
          ...(gatewayResult.tool ? { tool: gatewayResult.tool } : {}),
          summary: gatewayResult.summary,
        } : {}),
        exitCode: result?.exitCode ?? null,
        signal: result?.signal ?? null,
        durationMs: result?.durationMs ?? gatewayResult?.durationMs ?? 0,
      });
      if ("action" in params && params.action === "guide") {
        return {
          content: [{ type: "text" as const, text: sshGatewayGuide() }],
          details: {
            action: "guide",
            summary: "local gateway guide",
            exitCode: null,
            signal: null,
            durationMs: 0,
          },
        };
      }

      let executionHost: SshHost | undefined;
      try {
        await refreshStore();
        if ("action" in params && params.action === "targets") {
          const selectedId = selectedHostForDisplay()?.id;
          const targets = store.getHosts().map((host) => ({
            targetId: host.id,
            label: host.label,
            shell: host.shell,
            selected: host.id === selectedId,
          }));
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ targets }, null, 2) }],
            details: {
              action: "targets",
              summary: `${targets.length} configured target${targets.length === 1 ? "" : "s"}`,
              exitCode: null,
              signal: null,
              durationMs: 0,
            },
          };
        }
        executionHost = resolveExecutionHost(requestedTargetId);
        if ("command" in params) {
          const { targetId: _targetId, ...commandInput } = params;
          const result = await executor.execute(executionHost, commandInput, { signal });
          const output = [
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
            `exit=${result.exitCode ?? "unknown"}${result.signal ? ` signal=${result.signal}` : ""}`,
          ].filter(Boolean).join("\n\n");
          return {
            content: [{ type: "text" as const, text: output }],
            ...(result.exitCode !== 0 ? { isError: true } : {}),
            details: details(result, executionHost),
          };
        }
        if (params.action === "sync_pi_config") {
          const fence = connectionFence(executionHost.id);
          const syncResult = await syncPiConfig({
            categories: params.categories,
            source: configSource,
            transport: configSyncTransport(executionHost),
            signal,
            audit: options.configSyncAudit,
            assertFence: async () => {
              await refreshStore();
              if (connectionFence(executionHost!.id) !== fence) throw new Error("SSH target changed before configuration transfer");
            },
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(syncResult, null, 2) }],
            details: {
              ...details(undefined, executionHost),
              action: "sync_pi_config",
              summary: `${syncResult.receipts.length} configuration categor${syncResult.receipts.length === 1 ? "y" : "ies"} synchronized`,
            },
          };
        }
        const startPiContext = params.action === "start_pi"
          ? {
              piSessionRef: activeContext?.sessionManager.getSessionId?.() ?? "",
              todos: getVisibleTasks(),
            }
          : undefined;
        if (params.action === "start_pi" && !startPiContext?.piSessionRef) {
          throw new Error("start_pi requires an active local Pi session");
        }
        const { targetId: _targetId, ...gatewayInput } = params;
        const gatewayResult = await gatewayPool.execute(
          executionHost,
          store.getEffectiveHostDigest(executionHost.id),
          gatewayInput,
          signal,
          startPiContext,
          connectionFence(executionHost.id),
        );
        return {
          content: [{ type: "text" as const, text: gatewayResult.text }],
          ...(gatewayResult.isError ? { isError: true } : {}),
          details: details(undefined, executionHost, gatewayResult),
        };
      } catch (error) {
        if (store.locked) clearSelection();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          details: {
            ...details(undefined, executionHost),
            ...("action" in params ? {
              action: params.action,
              ...(params.action === "describe" || params.action === "call" ? { tool: params.tool } : {}),
              summary: params.action === "targets" ? "target listing failed" : params.action === "sync_pi_config" ? "configuration sync failed" : "gateway failed",
            } : {}),
          },
        };
      }
    },
    renderCall(args, theme, context) {
      if (context.isPartial === false) return new Text("", 0, 0);
      const targetId = "targetId" in args && typeof args.targetId === "string" ? args.targetId : undefined;
      const target = targetHostForDisplay(targetId);
      return toolCallLine(theme, "ssh", formatSshToolArgument(args, target ? sshToolTargetDetails(target) : undefined));
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text("", 0, 0);
      const details = result.details as SshToolDetails | undefined;
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const isError = (result as { isError?: boolean }).isError === true
        || (typeof details?.exitCode === "number" && details.exitCode !== 0);
      const fallbackHost = selectedHostForDisplay();
      return toolResultLine(theme, {
        name: "ssh",
        ok: !isError,
        arg: formatSshToolArgument(
          context.args,
          details?.target ?? (fallbackHost ? sshToolTargetDetails(fallbackHost) : undefined),
        ),
        summary: formatSshResultSummary(details, isError),
        expanded: options.expanded,
        detail: text,
      });
    },
  };

  pi.registerTool(sshTool);

  pi.registerCommand("ssh", {
    description: "Open the independent encrypted SSH server manager TUI.",
    async handler(args, ctx) {
      activeContext = ctx;
      const management = /^(pair|unpair)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(args.trim());
      if (args.trim() && !management) {
        ctx.ui.notify("Usage: /ssh, /ssh pair <targetId>, or /ssh unpair <targetId>.", "warning");
        return;
      }
      if (management) {
        if (!await ensureUnlocked(ctx, store)) return;
        const hostId = management[2]!;
        try {
          await gatewayPool.invalidateHost(hostId);
          if (management[1] === "pair") {
            const receipt = await pairSshGateway(store, executor, hostId);
            ctx.ui.notify(`Secure Gateway pairing saved for target ${receipt.hostId}; expiry is recorded in the encrypted store.`, "info");
          } else {
            const removed = await unpairSshGateway(store, executor, hostId);
            ctx.ui.notify(removed ? "Secure Gateway pairing removed; stdio fallback is active." : "No Gateway pairing was stored for that target.", "info");
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      await runManager(ctx, store, executor, monitor, discoverOpenSsh, {
        selectedId: () => selected?.id,
        select: (host) => selectHost(host, ctx),
        clear: () => clearSelection(ctx),
        invalidate: (hostId) => gatewayPool.invalidateHost(hostId),
        invalidateAll: () => gatewayPool.close(),
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || (event.images?.length ?? 0) > 0) return;
    const input = event.text.trim();
    const isLegacyPicker = input.toLowerCase() === "#ssh";
    const canonicalMatch = /^#ssh:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(input);
    if (!isLegacyPicker && !canonicalMatch) return;
    activeContext = ctx;

    if (canonicalMatch) {
      try {
        await activateHost(canonicalMatch[1]!);
        const host = currentSelectedHost();
        ctx.ui.notify(`SSH server selected: ${host.label}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      return { action: "handled" as const };
    }

    if (!await ensureUnlocked(ctx, store)) return { action: "handled" as const };
    monitor.reconcile();
    const hosts = store.getHosts();
    if (hosts.length === 0) {
      ctx.ui.notify("No SSH servers configured. Open /ssh and press A to add one.", "warning");
      return { action: "handled" as const };
    }
    const rows = hosts.map((host) => `${host.label}${selected?.id === host.id ? " (current)" : ""} · ${host.user}@${formatSshAddress(host.host, host.port)} · ${host.shell} · id=${host.id}`);
    const answer = await ctx.ui.select("Select SSH server", rows);
    const index = answer === undefined ? -1 : rows.indexOf(answer);
    if (index >= 0) {
      const host = hosts[index]!;
      selectHost(host, ctx);
      ctx.ui.notify(`SSH server selected: ${host.label}. Send the management request in your next message.`, "info");
    }
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    if (store.locked) return undefined;
    try {
      await store.reload();
      const host = selectedHostForDisplay();
      if (selected && !host) clearSelection(ctx);
      const defaultTarget = host
        ? `The optional current #ssh default has id ${JSON.stringify(host.id)}, label ${JSON.stringify(host.label)}, and shell ${host.shell}.`
        : "No default server is selected; call action=targets and pass a returned targetId.";
      const systemPrompt = `${event.systemPrompt}\n\n<ssh-management-context>\nThe independent encrypted SSH manager is unlocked. Gateway endpoint and credentials remain internal and are never included in this prompt. The agent may access any configured server through the ssh tool by first calling action=targets and then passing a provider-owned targetId. ${defaultTarget} targetId never contains host or authentication data, and omission uses only the optional #ssh default. sync_pi_config accepts only targetId and fixed categories (models, auth, teammate); local paths and contents are resolved and transferred by the host outside model-visible arguments and results. start_pi accepts only local todoIds, an optional objective/agent/timeout, targetId, and requestId; the host reads and sanitizes current local Pi Todo tasks and session identity. Gateway actions always use the fixed remote command and never accept host, authentication, command, remote cwd, sessionId, snapshot, or callback overrides. #ssh selection does not select or configure teammate routing. Remote Monitor calls use the returned launch receipt and never update local Pi Todo. Never use remote-worker or expose credentials.\n</ssh-management-context>`;
      return { systemPrompt };
    } catch {
      clearSelection(ctx);
      return undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    clearSelection(ctx);
  });
  pi.on("session_shutdown", async () => {
    selected = undefined;
    providerRegistration.dispose();
    remoteChannelBroker.close();
    monitor.shutdown();
    store.lock();
    await gatewayPool.close();
  });
}

interface SshManagerHostProviderOptions {
  selectedId?: () => string | undefined;
  activate?: (hostId: string) => Promise<void>;
  openTeammateRemoteChannel?: NonNullable<SshHostProvider["openTeammateRemoteChannel"]>;
}

/** Build the non-secret runtime provider backed by one unlocked SSH manager. */
export function createSshManagerHostProvider(
  store: EncryptedSshStore,
  options: SshManagerHostProviderOptions = {},
): SshHostProvider {
  const refreshedHosts = async (): Promise<SshHost[]> => {
    if (store.locked) {
      throw new SshHostProviderError(
        "manager-locked",
        "SSH manager is locked. Open /ssh in the host session to unlock it.",
      );
    }
    try {
      await store.reload();
      return store.getHosts();
    } catch {
      throw new SshHostProviderError(
        "refresh-failed",
        "SSH manager could not be refreshed. Open /ssh in the host session and verify the encrypted store.",
      );
    }
  };

  return {
    async list(): Promise<readonly SshHostReferenceSummary[]> {
      return (await refreshedHosts()).map(summarizeSshHost);
    },
    async listPickerEntries() {
      const hosts = await refreshedHosts();
      const selectedId = options.selectedId?.();
      return hosts.map((host) => ({
        id: host.id,
        label: host.label,
        host: host.host,
        user: host.user,
        port: host.port,
        shell: host.shell,
        selected: host.id === selectedId,
      }));
    },
    ...(options.activate ? { activate: options.activate } : {}),
    ...(options.openTeammateRemoteChannel
      ? { openTeammateRemoteChannel: options.openTeammateRemoteChannel }
      : {}),
    async resolve(hostRef: string): Promise<SshHostProfile> {
      const host = (await refreshedHosts()).find((candidate) => candidate.id === hostRef);
      if (!host) {
        throw new SshHostProviderError(
          "host-not-found",
          `SSH host reference ${JSON.stringify(hostRef)} was not found in the unlocked manager.`,
        );
      }
      return sshHostProfile(host);
    },
  };
}

function summarizeSshHost(host: SshHost): SshHostReferenceSummary {
  const issue = sshHostReferenceIssue(host);
  return issue
    ? { id: host.id, label: host.label, compatible: false, issue }
    : { id: host.id, label: host.label, compatible: true };
}

function sshHostProfile(host: SshHost): SshHostProfile {
  const issue = sshHostReferenceIssue(host);
  if (issue) {
    throw new SshHostProviderError(
      "host-incompatible",
      `SSH host reference ${JSON.stringify(host.id)} is incompatible with teammate SSH consumers: ${issue}.`,
    );
  }
  if (host.hostKey === null) throw new SshHostProviderError("host-incompatible", "SSH host has not been trusted by an explicit Test.");
  let authentication: SshHostProfile["authentication"];
  if (host.auth.kind === "agent") authentication = { kind: "agent" };
  else if (host.auth.kind === "identity") authentication = { kind: "identity", identityFile: host.auth.path };
  else {
    throw new SshHostProviderError("host-incompatible", "SSH host uses unsupported password authentication.");
  }
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    user: host.user,
    port: host.port,
    shell: "bash",
    hostKeySha256: host.hostKey,
    authentication,
  };
}

interface ManagerBindings {
  selectedId: () => string | undefined;
  select: (host: SshHost) => void;
  clear: () => void;
  invalidate: (hostId: string) => Promise<void>;
  invalidateAll: () => Promise<void>;
}

async function runManager(
  ctx: ExtensionContext,
  store: EncryptedSshStore,
  executor: SshExecutor,
  monitor: SshStatusMonitor,
  discoverOpenSsh: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>,
  bindings: ManagerBindings,
): Promise<void> {
  if (!await ensureUnlocked(ctx, store)) return;
  monitor.reconcile();
  let query = "";
  let view: SshManagerView = "hosts";
  let notice: string | undefined;
  while (!store.locked) {
    const action = await showManagerOverlay(ctx, store.getHosts(), store.getKeys(), monitor.getStatuses(), query, view, notice);
    query = action.query;
    view = action.view ?? view;
    notice = undefined;
    if (action.kind === "close") return;
    if (action.kind === "lock") {
      bindings.clear(); monitor.lock(); store.lock();
      try {
        await bindings.invalidateAll();
      } finally {
        ctx.ui.notify("SSH manager locked and the in-memory key was cleared.", "info");
      }
      return;
    }
    try {
      if (action.kind === "add-key") {
        const key = await importManagedKeyWizard(ctx);
        if (key) { await store.addKey(key); monitor.reconcile(); notice = `Imported key ${key.label}`; }
        continue;
      }
      if (action.kind === "edit-key" || action.kind === "replace-key" || action.kind === "delete-key") {
        const key = store.getKeys().find((candidate) => candidate.id === action.keyId);
        if (!key) { notice = "Selected SSH key is no longer available"; continue; }
        const affected = dependencyClosureForKey(store.getHosts(), key.id);
        if (action.kind === "edit-key") {
          const label = await ctx.ui.input("Managed key label", key.label);
          if (label !== undefined) await store.updateKey(key.id, { ...key, label: label.trim() });
          else continue;
        } else if (action.kind === "replace-key") {
          const replacement = await importManagedKeyWizard(ctx, key);
          if (!replacement) continue;
          await store.updateKey(key.id, replacement);
        } else {
          if (!await ctx.ui.confirm(`Delete ${key.label}?`, "Referenced keys cannot be deleted.")) continue;
          await store.deleteKey(key.id);
        }
        await invalidateHostIds(affected, bindings); monitor.reconcile(); notice = `${action.kind === "delete-key" ? "Deleted" : "Updated"} key ${key.label}`;
        continue;
      }
      if (action.kind === "import") {
        notice = await importOpenSshWizard(ctx, store, discoverOpenSsh);
        monitor.reconcile();
        continue;
      }
      if (action.kind === "add") {
        const host = await editHostWizard(ctx, store.getHosts(), store.getKeys());
        if (host) { await store.addHost(host); monitor.reconcile(); notice = `Added ${host.label}`; }
        continue;
      }
      const host = store.getHosts().find((candidate) => candidate.id === action.hostId);
      if (!host) { notice = "Selected SSH server is no longer available"; continue; }
      if (action.kind === "select") { bindings.select(host); ctx.ui.notify(`SSH server selected: ${host.label}.`, "info"); return; }
      if (action.kind === "edit") {
        const before = store.getReverseDependencyClosure(host.id);
        const replacement = await editHostWizard(ctx, store.getHosts(), store.getKeys(), host);
        if (!replacement) continue;
        const affected = new Set([...before, ...store.getReverseDependencyClosure(host.id)]);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.updateHost(host.id, replacement);
        monitor.reconcile(); notice = `Updated ${replacement.label}; affected selections and sessions were cleared`;
        continue;
      }
      if (action.kind === "delete") {
        if (!await ctx.ui.confirm(`Delete ${host.label}?`, "Referenced jump hosts cannot be deleted.")) continue;
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.deleteHost(host.id);
        monitor.reconcile(); notice = `Deleted ${host.label}`;
        continue;
      }
      if (action.kind === "reset") {
        if (!await ctx.ui.confirm(`Reset trust for ${host.label}?`, "The saved host identity will be removed and monitoring disabled.")) continue;
        if (!await ctx.ui.confirm("Confirm trust reset", "A future Test will establish trust again.")) continue;
        const affected = store.getReverseDependencyClosure(host.id);
        await invalidateHostIds(affected, bindings);
        await unpairGatewayHostIds(affected, store, executor);
        await store.updateHost(host.id, { ...host, hostKey: null, monitorEnabled: false });
        monitor.reconcile(); notice = `Trust reset for ${host.label}`;
        continue;
      }
      if (action.kind === "test") {
        notice = await testAndTrustSshHost(ctx, store, executor, host);
        if (notice.startsWith("Connection succeeded")) {
          await invalidateHostIds(store.getReverseDependencyClosure(host.id), bindings);
          monitor.reconcile();
        }
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
  }
}

async function ensureUnlocked(ctx: ExtensionContext, store: EncryptedSshStore): Promise<boolean> {
  if (!store.locked) return true;
  const exists = await pathExists(store.path);
  if (!exists) {
    while (true) {
      const password = await showSecretInput(ctx, "Create SSH manager", "New master password (minimum 8 characters)");
      if (password === undefined) return false;
      if (password.length < 8) {
        ctx.ui.notify("Master password must contain at least 8 characters. Try again or press Esc to cancel.", "warning");
        continue;
      }
      const confirmation = await showSecretInput(ctx, "Create SSH manager", "Confirm master password");
      if (confirmation === undefined) return false;
      if (password !== confirmation) {
        ctx.ui.notify("Master passwords do not match. Try again or press Esc to cancel.", "warning");
        continue;
      }
      try {
        await store.create(password);
        return true;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    }
  }
  const password = await showSecretInput(ctx, "Unlock SSH manager", "Master password");
  if (password === undefined) return false;
  try {
    await store.unlock(password);
    return true;
  } catch {
    ctx.ui.notify("Unable to unlock SSH manager. Check the master password and encrypted file.", "error");
    return false;
  }
}

export type IdentityPassphraseEditAction = "keep" | "replace" | "remove";

export interface SshAuthenticationChoice {
  kind: SshAuth["kind"];
  label: string;
  available: boolean;
}

/** Order authentication choices for the current runtime and explain what each one uses. */
export function sshAuthenticationChoices(
  current: SshAuth["kind"] | undefined,
  agentSocket = process.env.SSH_AUTH_SOCK,
  managedKeys: readonly SshKey[] = [],
): SshAuthenticationChoice[] {
  const agentAvailable = Boolean(agentSocket);
  const defaults: SshAuth["kind"][] = [
    ...(managedKeys.length > 0 ? ["key" as const] : []),
    ...(agentAvailable ? ["agent" as const] : []),
    "identity",
    "password",
  ];
  const order = current === undefined
    ? defaults
    : [current, ...defaults.filter((kind) => kind !== current)];
  return order.map((kind) => {
    if (kind === "agent") {
      return {
        kind,
        label: agentAvailable
          ? "Loaded key via SSH_AUTH_SOCK — advanced (managed by ssh-agent/ssh-add)"
          : "Loaded key via SSH_AUTH_SOCK — currently unavailable",
        available: agentAvailable,
      };
    }
    if (kind === "key") return { kind, label: "Managed encrypted key — stored in this SSH manager", available: managedKeys.length > 0 };
    if (kind === "identity") return { kind, label: "Local private key file — explicit reference only; recommended when ssh user@host already works", available: true };
    return { kind, label: "Server password — store it in the encrypted SSH manager", available: true };
  });
}

/** Find a conventional regular private-key file without reading its contents. */
export async function findDefaultSshIdentityPath(homeDirectory = homedir()): Promise<string | undefined> {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = join(homeDirectory, ".ssh", name);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Apply the explicit identity-passphrase edit selected by the operator. */
export function identityPassphraseAfterEdit(
  current: string | undefined,
  action: IdentityPassphraseEditAction,
  replacement?: string,
): string | undefined {
  if (action === "keep") return current;
  if (action === "remove") return undefined;
  if (!replacement) throw new Error("Replacement identity passphrase cannot be empty");
  return replacement;
}

/** Extract one unambiguous pinned fingerprint from direct or ssh-keygen output. */
export function normalizeSshHostKeyFingerprint(value: string): string {
  const trimmed = value.trim();
  if (SSH_HOST_KEY_PATTERN.test(trimmed)) return trimmed;
  const candidates = [...new Set(trimmed.split(/\s+/u).filter((part) => SSH_HOST_KEY_PATTERN.test(part)))];
  return candidates.length === 1 ? candidates[0]! : trimmed;
}

interface SshHostDraft {
  id: string;
  label: string;
  host: string;
  user: string;
  portText: string;
  shell: SshShell;
  hostKey: string | null;
  auth?: SshAuth;
  tags: string[];
  jumpHostId: string | null;
  monitorEnabled: boolean;
}

async function editHostWizard(
  ctx: ExtensionContext,
  hosts: readonly SshHost[],
  keys: readonly SshKey[],
  current?: SshHost,
): Promise<SshHost | undefined> {
  let draft: SshHostDraft = {
    id: current?.id ?? createSshHostId(), label: current?.label ?? "", host: current?.host ?? "", user: current?.user ?? "",
    portText: String(current?.port ?? 22), shell: current?.shell ?? "bash", hostKey: current?.hostKey ?? null, auth: current?.auth,
    tags: current?.tags ?? [], jumpHostId: current?.jumpHostId ?? null, monitorEnabled: current?.monitorEnabled ?? false,
  };

  while (true) {
    const collected = await collectSshHostDraft(ctx, draft, hosts, keys);
    if (!collected) return undefined;
    draft = collected;
    try {
      return validateSshHost({
        id: draft.id,
        label: draft.label.trim(),
        host: draft.host.trim(),
        user: draft.user.trim(),
        port: Number(draft.portText),
        shell: draft.shell, hostKey: draft.hostKey, auth: draft.auth,
        tags: draft.tags, jumpHostId: draft.jumpHostId, monitorEnabled: draft.monitorEnabled,
      });
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Previous values were kept; correct them or press Esc to cancel.`, "warning");
    }
  }
}

async function collectSshHostDraft(ctx: ExtensionContext, draft: SshHostDraft, hosts: readonly SshHost[], keys: readonly SshKey[]): Promise<SshHostDraft | undefined> {
  const label = await ctx.ui.input("SSH server label", draft.label);
  if (label === undefined) return undefined;
  const host = await ctx.ui.input("SSH hostname or IP", draft.host);
  if (host === undefined) return undefined;
  const user = await ctx.ui.input("SSH username", draft.user);
  if (user === undefined) return undefined;
  const portText = await ctx.ui.input("SSH port", draft.portText);
  if (portText === undefined) return undefined;
  const shellChoices: SshShell[] = draft.shell === "powershell" ? ["powershell", "bash"] : ["bash", "powershell"];
  const shell = await ctx.ui.select("Remote shell", shellChoices);
  if (shell !== "bash" && shell !== "powershell") return undefined;
  const hostKeyInput = await showSecretInput(ctx, "Optional pinned host identity", draft.hostKey
    ? "Leave empty to keep the existing pin; Test is the normal trust entry point"
    : "Optional SHA256 pin; leave empty and use Test for TOFU");
  if (hostKeyInput === undefined) return undefined;
  const normalizedHostKey = hostKeyInput === "" && draft.hostKey ? draft.hostKey : normalizeSshHostKeyFingerprint(hostKeyInput);
  const hostKey = normalizedHostKey === "" ? null : normalizedHostKey;
  let authChoice: SshAuthenticationChoice;
  while (true) {
    const choices = sshAuthenticationChoices(draft.auth?.kind, process.env.SSH_AUTH_SOCK, keys);
    const selected = await ctx.ui.select(
      "Authentication method",
      choices.map((choice) => choice.label),
    );
    if (selected === undefined) return undefined;
    const choice = choices.find((candidate) => candidate.label === selected);
    if (!choice) return undefined;
    if (choice.available) {
      authChoice = choice;
      break;
    }
    ctx.ui.notify(
      "This host uses a key loaded through SSH_AUTH_SOCK, but that key service is not available in this Pi process. Choose a local private key file or restart Pi from an environment with SSH_AUTH_SOCK.",
      "warning",
    );
  }

  let auth: SshAuth;
  if (authChoice.kind === "agent") {
    auth = { kind: "agent" };
  } else if (authChoice.kind === "key") {
    const labels = keys.map((key) => key.label);
    const selected = await ctx.ui.select("Managed key", labels);
    const key = keys.find((candidate) => candidate.label === selected);
    if (!key) return undefined;
    auth = { kind: "key", keyId: key.id };
  } else if (authChoice.kind === "identity") {
    const currentIdentity = draft.auth?.kind === "identity" ? draft.auth : undefined;
    const suggestedPath = currentIdentity?.path ?? await findDefaultSshIdentityPath();
    const path = await ctx.ui.input("Local private key file", suggestedPath ?? "");
    if (path === undefined) return undefined;
    const existingPassphrase = currentIdentity?.passphrase;
    let passphrase: string | undefined;
    if (existingPassphrase) {
      const keep = "Keep existing passphrase";
      const replace = "Replace passphrase";
      const remove = "Remove passphrase";
      const selected = await ctx.ui.select("Identity passphrase", [keep, replace, remove]);
      if (selected === undefined) return undefined;
      const action: IdentityPassphraseEditAction = selected === keep
        ? "keep"
        : selected === replace
          ? "replace"
          : "remove";
      let replacement: string | undefined;
      if (action === "replace") {
        replacement = await showSecretInput(ctx, "Identity passphrase", "Replacement passphrase");
        if (replacement === undefined) return undefined;
      }
      try {
        passphrase = identityPassphraseAfterEdit(existingPassphrase, action, replacement);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return collectSshHostDraft(ctx, draft, hosts, keys);
      }
    } else {
      passphrase = await showSecretInput(ctx, "Identity passphrase", "Optional; leave empty for none");
      if (passphrase === undefined) return undefined;
    }
    auth = { kind: "identity", path, ...(passphrase ? { passphrase } : {}) };
  } else {
    const currentPassword = draft.auth?.kind === "password" ? draft.auth.password : undefined;
    while (true) {
      const password = await showSecretInput(ctx, "SSH password", currentPassword
        ? "Leave empty to keep the existing password, or enter a replacement"
        : "Password");
      if (password === undefined) return undefined;
      const preserved = password || currentPassword;
      if (preserved) {
        auth = { kind: "password", password: preserved };
        break;
      }
      ctx.ui.notify("SSH password cannot be empty. Try again or press Esc to cancel.", "warning");
    }
  }

  const tagsInput = await ctx.ui.input("Tags (comma separated)", draft.tags.join(", "));
  if (tagsInput === undefined) return undefined;
  const tags = tagsInput.split(",").map((tag) => tag.trim()).filter(Boolean);
  const jumpCandidates = hosts.filter((candidate) => candidate.id !== draft.id);
  const jumpLabels = ["Direct connection", ...jumpCandidates.map((candidate) => candidate.label)];
  const jumpChoice = await ctx.ui.select("Jump host", jumpLabels);
  if (jumpChoice === undefined) return undefined;
  const jumpHostId = jumpChoice === jumpLabels[0] ? null : jumpCandidates.find((candidate) => candidate.label === jumpChoice)?.id ?? null;
  const monitorChoice = await ctx.ui.select("Monitoring", ["Off", "On"]);
  if (monitorChoice === undefined) return undefined;
  const monitorEnabled = monitorChoice === "On";
  return { id: draft.id, label, host, user, portText, shell, hostKey, auth, tags, jumpHostId, monitorEnabled };
}

async function unpairGatewayHostIds(ids: Iterable<string>, store: EncryptedSshStore, executor: SshExecutor): Promise<void> {
  for (const id of new Set(ids)) if (store.getGatewayBinding(id)) await unpairSshGateway(store, executor, id);
}

async function invalidateHostIds(ids: Iterable<string>, bindings: ManagerBindings): Promise<void> {
  const unique = [...new Set(ids)];
  await Promise.all(unique.map((id) => bindings.invalidate(id)));
  if (bindings.selectedId() && unique.includes(bindings.selectedId()!)) bindings.clear();
}

function dependencyClosureForKey(hosts: readonly SshHost[], keyId: string): string[] {
  const affected = new Set<string>();
  for (const host of hosts) {
    if (host.auth.kind !== "key" || host.auth.keyId !== keyId) continue;
    for (const id of reverseSshHostDependencyClosure(hosts, host.id)) affected.add(id);
  }
  return [...affected];
}

/** Test is the sole trust-on-first-use entry point and fences persistence by id, digest, pin, and revision. */
export async function testAndTrustSshHost(ctx: ExtensionContext, store: EncryptedSshStore, executor: SshExecutor, snapshot: SshHost): Promise<string> {
  const revision = store.revision;
  const digest = store.getEffectiveHostDigest(snapshot.id);
  const result = await executor.testConnection(snapshot.id);
  if (result.effectiveDigest !== undefined && result.effectiveDigest !== digest) throw new Error("SSH configuration changed during connection test");
  await store.reload();
  let current = store.getHosts().find((host) => host.id === snapshot.id);
  if (!current || !sameHostExceptPin(current, snapshot)) throw new Error("SSH host changed during connection test; trust was not saved");
  if (current.hostKey === result.fingerprint && snapshot.hostKey === null) return `Connection succeeded: ${current.label} (trust was saved concurrently)`;
  if (store.revision !== revision) throw new Error("SSH manager changed during connection test; trust was not saved");
  if (store.getEffectiveHostDigest(snapshot.id) !== digest) throw new Error("SSH configuration changed during connection test");
  if (snapshot.hostKey !== null) return `Connection succeeded: ${snapshot.label}`;
  if (!await ctx.ui.confirm(`Trust ${snapshot.label}?`, "Save the identity observed by this Test?")) return `Connection succeeded without saving trust: ${snapshot.label}`;

  await store.reload();
  current = store.getHosts().find((host) => host.id === snapshot.id);
  if (!current || !sameHostExceptPin(current, snapshot)) throw new Error("SSH host changed while trust confirmation was open; trust was not saved");
  if (current.hostKey === result.fingerprint) return `Connection succeeded: ${current.label} (trust was saved concurrently)`;
  if (current.hostKey !== null) throw new Error("SSH host trust changed while confirmation was open; trust was not saved");
  if (store.revision !== revision) throw new Error("SSH manager changed while trust confirmation was open; trust was not saved");
  if (store.getEffectiveHostDigest(snapshot.id) !== digest) throw new Error("SSH configuration changed while trust confirmation was open; trust was not saved");
  try {
    await store.updateHost(snapshot.id, { ...current, hostKey: result.fingerprint });
  } catch (error) {
    await store.reload().catch(() => undefined);
    const raced = store.locked ? undefined : store.getHosts().find((host) => host.id === snapshot.id);
    if (raced && raced.hostKey === result.fingerprint && sameHostExceptPin(raced, snapshot)) return `Connection succeeded: ${snapshot.label} (trust was saved concurrently)`;
    throw error;
  }
  return `Connection succeeded and trust saved: ${snapshot.label}`;
}

function sameHostExceptPin(left: SshHost, right: SshHost): boolean {
  return JSON.stringify({ ...left, hostKey: null }) === JSON.stringify({ ...right, hostKey: null });
}

async function importManagedKeyWizard(ctx: ExtensionContext, current?: SshKey): Promise<SshKey | undefined> {
  const label = await ctx.ui.input("Managed key label", current?.label ?? "");
  if (label === undefined) return undefined;
  const path = await ctx.ui.input("Private key path (explicit import)", "");
  if (path === undefined) return undefined;
  const passphrase = await showSecretInput(ctx, "Private key passphrase", current?.passphrase ? "Leave empty to keep the existing passphrase" : "Optional; leave empty for none");
  if (passphrase === undefined) return undefined;
  return importManagedSshKey(path, label.trim(), passphrase || current?.passphrase, current);
}

/** Read one explicitly named regular key file, derive only its public fingerprint, and scrub the read buffer. */
export async function importManagedSshKey(path: string, label: string, passphrase?: string, current?: SshKey): Promise<SshKey> {
  const resolvedPath = path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
  const info = await lstat(resolvedPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > SSH_MAX_PRIVATE_KEY_BYTES) throw new Error("Private key must be a bounded regular non-symlink file");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(resolvedPath, flags);
  let bytes: Buffer | undefined;
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size !== info.size) throw new Error("Private key changed during import");
    bytes = Buffer.alloc(Number(after.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Private key changed during import");
      offset += read.bytesRead;
    }
    const fingerprint = await fingerprintPrivateKey(resolvedPath);
    return validateSshKey({
      id: current?.id ?? createSshKeyId(), label, privateKey: bytes.toString("utf8"), ...(passphrase ? { passphrase } : {}),
      publicKeyFingerprint: fingerprint, createdAt: current?.createdAt ?? new Date().toISOString(),
    });
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function fingerprintPrivateKey(path: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => execFile("ssh-keygen", ["-lf", path, "-E", "sha256"], { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, output) => error ? reject(new Error("ssh-keygen could not read the private key")) : resolve(output)));
  const fingerprint = normalizeSshHostKeyFingerprint(stdout);
  if (!SSH_HOST_KEY_PATTERN.test(fingerprint)) throw new Error("ssh-keygen returned no unambiguous SHA256 fingerprint");
  return fingerprint;
}

async function importOpenSshWizard(ctx: ExtensionContext, store: EncryptedSshStore, discover: (options?: DiscoverOpenSshOptions) => Promise<OpenSshDiscoveryResult>): Promise<string> {
  const preview = await discover();
  if (!preview.configFound) {
    const keyNotice = await hasPrivateKeyFiles(dirname(preview.configPath)) ? "; private-key files exist, but no hosts were guessed from their names" : "";
    return `No OpenSSH host config was found${keyNotice}`;
  }
  if (preview.candidates.length === 0) return `OpenSSH config contains no explicit importable Host aliases${preview.warnings.length ? ` (${preview.warnings.length} warnings)` : ""}`;
  const accepted: OpenSshImportCandidate[] = [];
  for (const candidate of preview.candidates) {
    const summary = `${candidate.user ?? "user required"}@${formatSshAddress(candidate.hostName, candidate.port)} · ${candidate.identities.length} identity reference(s) · ${candidate.warnings.length} warning(s)`;
    if (await ctx.ui.confirm(`Import OpenSSH host ${candidate.alias}?`, summary)) accepted.push(candidate);
  }
  if (accepted.length === 0) return "OpenSSH import cancelled";
  if (!await ctx.ui.confirm(`Import ${accepted.length} OpenSSH host(s)?`, "New hosts start untrusted with monitoring off.")) return "OpenSSH import cancelled";
  const existing = store.getHosts();
  const existingKeys = store.getKeys();
  const importedKeys: SshKey[] = [];
  const ids = new Map(accepted.map((candidate) => [candidate.alias, createSshHostId()]));
  const existingAliases = new Map(existing.map((host) => [host.label, host.id]));
  const additions: SshHost[] = [];
  for (const candidate of accepted) {
    const user = candidate.user ?? await ctx.ui.input(`SSH username for ${candidate.alias}`, "");
    if (!user) throw new Error(`OpenSSH host ${candidate.alias} requires an explicit username`);
    let jumpHostId: string | null = null;
    if (candidate.proxyJumpAliases.length > 0) {
      if (candidate.proxyJumpAliases.length !== 1) throw new Error(`OpenSSH host ${candidate.alias} has a ProxyJump chain that must be imported as explicit hosts`);
      const alias = candidate.proxyJumpAliases[0]!;
      jumpHostId = ids.get(alias) ?? existingAliases.get(alias) ?? null;
      if (!jumpHostId) throw new Error(`ProxyJump alias ${alias} is not an accepted or existing host`);
    }
    let auth: SshAuth = { kind: "agent" };
    if (candidate.identities.length > 0) {
      if (candidate.identities.length > 1) throw new Error(`OpenSSH host ${candidate.alias} requires an explicit identity choice`);
      const identityPath = candidate.identities[0]!.path;
      if (await ctx.ui.confirm(`Encrypt identity for ${candidate.alias}?`, "No keeps an explicit path reference; Yes imports the key into this manager.")) {
        const passphrase = await showSecretInput(ctx, "Private key passphrase", "Optional; leave empty for none");
        if (passphrase === undefined) throw new Error("OpenSSH key import cancelled");
        const key = await importManagedSshKey(identityPath, `${candidate.alias} key`, passphrase || undefined);
        importedKeys.push(key);
        auth = { kind: "key", keyId: key.id };
      } else {
        auth = { kind: "identity", path: identityPath };
      }
    }
    additions.push(validateSshHost({ id: ids.get(candidate.alias), label: candidate.alias, host: candidate.hostName, user, port: candidate.port, shell: "bash", hostKey: null, auth, tags: [], jumpHostId, monitorEnabled: false }));
  }
  await store.saveConfiguration([...existing, ...additions], [...existingKeys, ...importedKeys]);
  return `Imported ${additions.length} OpenSSH host(s)${importedKeys.length ? ` and ${importedKeys.length} encrypted key(s)` : "; identities remain explicit path references"}`;
}

async function hasPrivateKeyFiles(directory = join(homedir(), ".ssh")): Promise<boolean> {
  let names: string[];
  try { names = (await readdir(directory)).slice(0, 256); } catch { return false; }
  for (const name of names) {
    if (!/^id_[A-Za-z0-9._-]+$/u.test(name) || name.endsWith(".pub")) continue;
    try { const info = await lstat(join(directory, name)); if (info.isFile() && !info.isSymbolicLink()) return true; } catch { /* ignore */ }
  }
  return false;
}

function showSecretInput(
  ctx: ExtensionContext,
  title: string,
  prompt: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new MaskedSecretInput({
    title,
    prompt,
    theme: theme as SshManagerTheme,
    requestRender: () => tui.requestRender(),
    done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "50%" } });
}

function showManagerOverlay(
  ctx: ExtensionContext,
  hosts: readonly SshHost[],
  keys: readonly SshKey[],
  statuses: ReadonlyMap<string, SshHostOperationalStatus>,
  initialQuery: string,
  initialView: SshManagerView,
  notice?: string,
): Promise<SshHostManagerAction> {
  return ctx.ui.custom<SshHostManagerAction>((tui, theme, _keybindings, done) => new SshHostManagerOverlay({
    hosts, keys, statuses, theme: theme as SshManagerTheme, requestRender: () => tui.requestRender(), done,
    initialQuery, initialView, ...(notice ? { notice } : {}),
  }), { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" } });
}

function sshToolTargetDetails(host: SshHost): SshToolTargetDetails {
  return {
    label: host.label,
    host: host.host,
    user: host.user,
    port: host.port,
    shell: host.shell,
  };
}

function formatSshAddress(host: string, port: number): string {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${address}:${port}`;
}

function formatSshToolArgument(args: Partial<SshToolInput>, target?: SshToolTargetDetails): string {
  const parts: string[] = [];
  if (target) {
    const label = sanitizeCardText(target.label, 128);
    const user = sanitizeCardText(target.user, 128);
    const host = sanitizeCardText(target.host, 253);
    parts.push(`${label} · ${user}@${formatSshAddress(host, target.port)}`, target.shell);
  }
  if ("action" in args && typeof args.action === "string") {
    parts.push(args.action === "targets" ? "targets" : `gateway ${sanitizeCardText(args.action, 32)}`);
    if ((args.action === "describe" || args.action === "call") && typeof args.tool === "string") {
      parts.push(sanitizeCardText(args.tool, 128));
    }
    return parts.join(" · ");
  }
  if ("cwd" in args && typeof args.cwd === "string" && args.cwd) parts.push(`cwd ${sanitizeCardText(args.cwd, 80)}`);
  if ("command" in args && typeof args.command === "string" && args.command) parts.push(sanitizeCardText(args.command, 160));
  return parts.join(" · ");
}

function formatSshResultSummary(details: SshToolDetails | undefined, isError: boolean): string {
  const parts: string[] = [];
  if (details?.summary) parts.push(details.summary);
  else if (typeof details?.exitCode === "number") parts.push(`exit ${details.exitCode}`);
  else if (!details?.signal) parts.push(isError ? "failed" : "exit unknown");
  if (details?.signal) parts.push(`signal ${details.signal}`);
  if (details && details.durationMs > 0) parts.push(`${details.durationMs}ms`);
  return parts.join(" · ");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
