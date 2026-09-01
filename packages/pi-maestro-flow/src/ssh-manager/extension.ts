import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  SshHostProviderError,
  registerSshHostProvider,
  type SshHostProvider,
} from "pi-maestro-teammate/v1/ssh-hosts";
import type {
  SshHostProfile,
  SshHostReferenceIssue,
  SshHostReferenceSummary,
} from "pi-maestro-backend-core/v1/ssh";
import { EncryptedSshStore, defaultSshManagerStorePath } from "./encrypted-store.ts";
import { SshExecutor, type SshExecutionResult } from "./executor.ts";
import { SshToolParams, type SshToolInput } from "./llm-tool.ts";
import {
  createSshHostId,
  validateSshHost,
  type SshAuth,
  type SshHost,
  type SshShell,
} from "./model.ts";
import {
  MaskedSecretInput,
  SshHostManagerOverlay,
  type SshHostManagerAction,
  type SshManagerTheme,
} from "./tui.ts";

const SSH_STATUS_KEY = "maestro-ssh";

interface SelectedSshHost {
  id: string;
  digest: string;
}

interface SshToolDetails {
  hostId?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export interface RegisterSshManagerOptions {
  storePath?: string;
  store?: EncryptedSshStore;
  executor?: SshExecutor;
}

export function registerSshManager(
  pi: ExtensionAPI,
  options: RegisterSshManagerOptions = {},
): void {
  const store = options.store ?? new EncryptedSshStore({ path: options.storePath ?? defaultSshManagerStorePath() });
  const executor = options.executor ?? new SshExecutor();
  const providerRegistration = registerSshHostProvider(createSshManagerHostProvider(store));
  let selected: SelectedSshHost | undefined;
  let activeContext: ExtensionContext | undefined;

  const clearSelection = (ctx: ExtensionContext | undefined = activeContext): void => {
    selected = undefined;
    ctx?.ui.setStatus(SSH_STATUS_KEY, undefined);
  };

  const selectHost = (host: SshHost, ctx: ExtensionContext): void => {
    activeContext = ctx;
    selected = { id: host.id, digest: sshHostDigest(host) };
    ctx.ui.setStatus(SSH_STATUS_KEY, `SSH · ${host.label}`);
  };

  const currentSelectedHost = (): SshHost => {
    if (!selected) throw new Error("No SSH server is selected. Send #ssh and choose a server first.");
    const host = store.getHosts().find((candidate) => candidate.id === selected!.id);
    if (!host || sshHostDigest(host) !== selected.digest) {
      clearSelection();
      throw new Error("The selected SSH server changed. Send #ssh to select it again.");
    }
    return host;
  };

  const refreshStore = async (): Promise<void> => {
    if (store.locked) throw new Error("SSH manager is locked. Send #ssh or open /ssh to unlock it.");
    await store.reload();
  };

  const sshTool: ToolDefinition<typeof SshToolParams, SshToolDetails> = {
    name: "ssh",
    label: "SSH",
    renderShell: "self",
    description: `Execute a bounded command on the independent SSH server explicitly selected by the user with #ssh.

The tool never accepts host or authentication parameters. Server configuration is stored in the encrypted user-level SSH manager and may be referenced explicitly by trusted teammate connection settings. The current #ssh selection remains independent of teammate, remote-worker, and Monitor routing. The selected server decides whether the command runs through bash or PowerShell.`,
    promptSnippet: "Execute a command on the server selected by the user with #ssh.",
    promptGuidelines: [
      "Use read-only inspection before mutations unless the user explicitly requested a change.",
      "Never read or print private keys, passwords, tokens, credential stores, or host-key material.",
      "Do not claim access to any server other than the current #ssh selection.",
    ],
    parameters: SshToolParams,
    async execute(
      _id: string,
      params: SshToolInput,
      signal: AbortSignal,
    ) {
      const details = (result?: SshExecutionResult, hostId?: string): SshToolDetails => ({
        ...(hostId ? { hostId } : {}),
        exitCode: result?.exitCode ?? null,
        signal: result?.signal ?? null,
        durationMs: result?.durationMs ?? 0,
      });
      try {
        await refreshStore();
        const host = currentSelectedHost();
        const result = await executor.execute(host, params, { signal });
        const output = [
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
          `exit=${result.exitCode ?? "unknown"}${result.signal ? ` signal=${result.signal}` : ""}`,
        ].filter(Boolean).join("\n\n");
        return {
          content: [{ type: "text" as const, text: output }],
          ...(result.exitCode !== 0 ? { isError: true } : {}),
          details: details(result, host.id),
        };
      } catch (error) {
        if (store.locked) clearSelection();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
          details: details(undefined, selected?.id),
        };
      }
    },
    renderCall(_args, _theme, context) {
      return new Text(context.isPartial === false ? "" : "SSH command", 0, 0);
    },
    renderResult(result, options) {
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(options.isPartial ? "" : text, 0, 0);
    },
  };

  pi.registerTool(sshTool);

  pi.registerCommand("ssh", {
    description: "Open the independent encrypted SSH server manager TUI.",
    async handler(_args, ctx) {
      activeContext = ctx;
      await runManager(ctx, store, executor, {
        selectedId: () => selected?.id,
        select: (host) => selectHost(host, ctx),
        clear: () => clearSelection(ctx),
      });
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || (event.images?.length ?? 0) > 0 || event.text.trim().toLowerCase() !== "#ssh") return;
    activeContext = ctx;
    if (!await ensureUnlocked(ctx, store)) return { action: "handled" as const };
    const hosts = store.getHosts();
    if (hosts.length === 0) {
      ctx.ui.notify("No SSH servers configured. Open /ssh and press A to add one.", "warning");
      return { action: "handled" as const };
    }
    const rows = hosts.map((host) => `${selected?.id === host.id ? "● " : ""}${host.label} · ${host.user}@${host.host}:${host.port} · ${host.shell} · id=${host.id}`);
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
    if (!selected || store.locked) return undefined;
    try {
      await store.reload();
      const host = currentSelectedHost();
      return {
        systemPrompt: `${event.systemPrompt}\n\n<ssh-management-context>\nThe user selected the independent encrypted SSH server ${JSON.stringify(host.label)}. Use the ssh tool for server-management requests. The tool is already bound to this server and accepts command, cwd, and timeout only. This #ssh selection does not select or configure teammate routing. The server shell is ${host.shell}. Never enter Monitor, use remote-worker, or expose credentials.\n</ssh-management-context>`,
      };
    } catch {
      clearSelection(ctx);
      return undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    clearSelection(ctx);
  });
  pi.on("session_shutdown", () => {
    selected = undefined;
    providerRegistration.dispose();
    store.lock();
  });
}

/** Build the non-secret runtime provider backed by one unlocked SSH manager. */
export function createSshManagerHostProvider(store: EncryptedSshStore): SshHostProvider {
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

function sshHostReferenceIssue(host: SshHost): SshHostReferenceIssue | undefined {
  if (host.shell !== "bash") return "unsupported-shell";
  if (host.auth.kind === "password") return "unsupported-password-authentication";
  if (host.auth.kind === "identity" && host.auth.passphrase !== undefined) {
    return "unsupported-identity-passphrase";
  }
  return undefined;
}

interface ManagerBindings {
  selectedId: () => string | undefined;
  select: (host: SshHost) => void;
  clear: () => void;
}

async function runManager(
  ctx: ExtensionContext,
  store: EncryptedSshStore,
  executor: SshExecutor,
  bindings: ManagerBindings,
): Promise<void> {
  if (!await ensureUnlocked(ctx, store)) return;
  let query = "";
  let notice: string | undefined;
  while (!store.locked) {
    const action = await showManagerOverlay(ctx, store.getHosts(), query, notice);
    query = action.query;
    notice = undefined;
    if (action.kind === "close") return;
    if (action.kind === "lock") {
      bindings.clear();
      store.lock();
      ctx.ui.notify("SSH manager locked and the in-memory key was cleared.", "info");
      return;
    }
    if (action.kind === "add") {
      const host = await editHostWizard(ctx);
      if (!host) continue;
      try {
        await store.save([...store.getHosts(), host]);
        notice = `Added ${host.label}`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }
      continue;
    }
    const host = store.getHosts().find((candidate) => candidate.id === action.hostId);
    if (!host) {
      notice = "Selected SSH server is no longer available";
      continue;
    }
    if (action.kind === "select") {
      bindings.select(host);
      ctx.ui.notify(`SSH server selected: ${host.label}.`, "info");
      return;
    }
    if (action.kind === "edit") {
      const replacement = await editHostWizard(ctx, host);
      if (!replacement) continue;
      try {
        const hosts = store.getHosts().map((candidate) => candidate.id === host.id ? replacement : candidate);
        await store.save(hosts);
        if (bindings.selectedId() === host.id) bindings.clear();
        notice = `Updated ${replacement.label}; reselect it before execution`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }
      continue;
    }
    if (action.kind === "delete") {
      if (!await ctx.ui.confirm(`Delete ${host.label}?`, "This removes the encrypted server entry.")) continue;
      try {
        await store.save(store.getHosts().filter((candidate) => candidate.id !== host.id));
        if (bindings.selectedId() === host.id) bindings.clear();
        notice = `Deleted ${host.label}`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }
      continue;
    }
    if (action.kind === "test") {
      try {
        const command = host.shell === "powershell" ? "Write-Output '__pi_ssh_ok__'" : "printf '__pi_ssh_ok__'";
        const result = await executor.execute(host, { command, timeout: 10 });
        notice = result.exitCode === 0 && result.stdout.includes("__pi_ssh_ok__")
          ? `Connection succeeded: ${host.label}`
          : `Connection test failed with exit ${result.exitCode ?? "unknown"}`;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

async function ensureUnlocked(ctx: ExtensionContext, store: EncryptedSshStore): Promise<boolean> {
  if (!store.locked) return true;
  const exists = await pathExists(store.path);
  if (!exists) {
    const password = await showSecretInput(ctx, "Create SSH manager", "New master password (minimum 8 characters)");
    if (password === undefined) return false;
    if (password.length < 8) {
      ctx.ui.notify("Master password must contain at least 8 characters.", "warning");
      return false;
    }
    const confirmation = await showSecretInput(ctx, "Create SSH manager", "Confirm master password");
    if (confirmation === undefined) return false;
    if (password !== confirmation) {
      ctx.ui.notify("Master passwords do not match.", "warning");
      return false;
    }
    try {
      await store.create(password);
      return true;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return false;
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

async function editHostWizard(ctx: ExtensionContext, current?: SshHost): Promise<SshHost | undefined> {
  const label = await ctx.ui.input("SSH server label", current?.label ?? "");
  if (label === undefined) return undefined;
  const host = await ctx.ui.input("SSH hostname or IP", current?.host ?? "");
  if (host === undefined) return undefined;
  const user = await ctx.ui.input("SSH username", current?.user ?? "");
  if (user === undefined) return undefined;
  const portText = await ctx.ui.input("SSH port", String(current?.port ?? 22));
  if (portText === undefined) return undefined;
  const shellChoice = await ctx.ui.select("Remote shell", ["bash", "powershell"]);
  if (shellChoice === undefined) return undefined;
  const hostKey = await ctx.ui.input("Pinned host key fingerprint (SHA256:...)", current?.hostKey ?? "");
  if (hostKey === undefined) return undefined;
  const authChoice = await ctx.ui.select("Authentication", ["ssh-agent", "identity file", "password"]);
  if (authChoice === undefined) return undefined;

  let auth: SshAuth;
  if (authChoice === "ssh-agent") {
    auth = { kind: "agent" };
  } else if (authChoice === "identity file") {
    const path = await ctx.ui.input("Local identity file path", current?.auth.kind === "identity" ? current.auth.path : "");
    if (path === undefined) return undefined;
    const existingPassphrase = current?.auth.kind === "identity" ? current.auth.passphrase : undefined;
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
        return undefined;
      }
    } else {
      passphrase = await showSecretInput(ctx, "Identity passphrase", "Optional; leave empty for none");
      if (passphrase === undefined) return undefined;
    }
    auth = { kind: "identity", path, ...(passphrase ? { passphrase } : {}) };
  } else {
    const password = await showSecretInput(ctx, "SSH password", current?.auth.kind === "password"
      ? "Leave empty to keep the existing password, or enter a replacement"
      : "Password");
    if (password === undefined) return undefined;
    const preserved = password || (current?.auth.kind === "password" ? current.auth.password : undefined);
    if (!preserved) {
      ctx.ui.notify("SSH password cannot be empty.", "warning");
      return undefined;
    }
    auth = { kind: "password", password: preserved };
  }

  try {
    return validateSshHost({
      id: current?.id ?? createSshHostId(),
      label: label.trim(),
      host: host.trim(),
      user: user.trim(),
      port: Number(portText),
      shell: shellChoice as SshShell,
      hostKey: hostKey.trim(),
      auth,
    });
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return undefined;
  }
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
  initialQuery: string,
  notice?: string,
): Promise<SshHostManagerAction> {
  return ctx.ui.custom<SshHostManagerAction>((tui, theme, _keybindings, done) => new SshHostManagerOverlay({
    hosts,
    theme: theme as SshManagerTheme,
    requestRender: () => tui.requestRender(),
    done,
    initialQuery,
    ...(notice ? { notice } : {}),
  }), { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" } });
}

function sshHostDigest(host: SshHost): string {
  return createHash("sha256").update(JSON.stringify(host), "utf8").digest("hex");
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
