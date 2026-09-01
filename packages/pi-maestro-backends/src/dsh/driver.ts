/**
 * The real SDK driver behind the dsh backend.
 *
 * Kept apart from the backend so the capability declarations, configuration
 * rules, and outcome mapping stay testable without spawning a runtime.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessClientOptions } from "@deepseek-ai/dsh-sdk-client";
import type { ConfigValue } from "pi-maestro-backend-core/v1/backend";
import { targetChildEnvironment } from "../child-env.ts";
import type { DshDriverOptions, DshHarnessDriver } from "./backend.ts";

/** Read a string setting, or undefined when unset. */
function text(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a number setting, or undefined when unset. */
function count(config: Record<string, ConfigValue>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" ? value : undefined;
}

/** Read a string-list setting, or an empty list when unset. */
function names(config: Record<string, ConfigValue>, key: string): readonly string[] {
  const value = config[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Host variables every child needs to start at all.
 *
 * Deliberately short. The runtime resolves its own credential from its own
 * configuration, so nothing provider-related belongs here; a deployment that
 * needs more names one with `envPassthrough`.
 *
 * `SSH_AUTH_SOCK` is here because an ssh launch's local child is the ssh
 * process itself, which authenticates against the host's agent. The name
 * matches the secret gate (`_AUTH_`), so listing it in the allowlist alone
 * would be silently dropped — `childEnv` therefore also forwards the value
 * through the additions channel, which is the path deliberate hand-overs take.
 */
const PROCESS_ESSENTIAL_ENV: readonly string[] = process.platform === "win32"
  ? [
    "APPDATA", "COMSPEC", "LOCALAPPDATA", "OS", "PATH", "PATHEXT", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "SSH_AUTH_SOCK", "SystemDrive", "SystemRoot",
    "TEMP", "TMP", "USERPROFILE", "windir",
  ]
  : ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "SSH_AUTH_SOCK", "TMPDIR", "TZ", "USER"];

/**
 * The child's complete environment.
 *
 * The SDK inherits the parent environment verbatim when given nothing, and
 * states that callers own credential policy. Inheriting is the wrong default
 * here: this child runs model-directed shell commands, and the host process
 * holds credentials for every provider and service it talks to — none of which
 * the runtime needs, because it reads its own key from its own configuration.
 *
 * @param config - the backend's resolved configuration.
 * @param extras - per-run variables, passed by value.
 * @returns the variables the child is given, and nothing else.
 *
 * A per-run value belongs in `extras` and nowhere else. Routing one through
 * this process's own environment would make it visible to every concurrent
 * attempt, and the values that need this path — an endpoint URL carrying an
 * actor-bound token — would then let one attempt act as another. Nothing in
 * `extras` is looked up again here; the caller's value is the value.
 *
 * Both `envPassthrough` and `extras` travel the shared model's `additions`
 * channel, so both get the launch-policy gate and the NUL gate. The secret gate
 * is open on that channel — `allowSecretAdditions: true` is inherent to
 * `targetChildEnvironment` — and this backend depends on it: the todo endpoint
 * URL is carried in `PI_MAESTRO_TODO_MCP_SECRET_URL`, whose name matches
 * `SECRET_ENV_NAME`'s `(?:^|_)SECRET(?:_|$)`, so closing that gate would make
 * every dsh task carrying todos throw `is secret-bearing` from `start()`. A
 * secret-bearing `envPassthrough` name is refused at `resolveConfig` instead,
 * where an operator can still read the rejection.
 *
 * @internal Exported so the scrub can be asserted without spawning a runtime.
 */
export function childEnv(config: Record<string, ConfigValue>, extras: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const agentSocket = process.env.SSH_AUTH_SOCK;
  const result = targetChildEnvironment(
    names(config, "envPassthrough"),
    agentSocket === undefined ? extras : { SSH_AUTH_SOCK: agentSocket, ...extras },
    PROCESS_ESSENTIAL_ENV,
  );
  // Windows environment names are case-insensitive, but Node's enumeration
  // may expose them in a different case than the declared contract. Re-add
  // only the named essentials under their canonical spelling; this preserves
  // the scrub while keeping SystemRoot/ProgramFiles available to the child.
  for (const name of PROCESS_ESSENTIAL_ENV) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * POSIX-quote a single argv token so a remote command survives shell wrapping.
 *
 * Mirrors the remote bridge's `shellQuote`: wrap in single quotes, with the
 * closing-quote/escaped-quote/opening-quote dance for embedded quotes. Every
 * other byte — spaces, `$`, backticks, newlines — is literal inside single
 * quotes, which is what makes a hostile token one argument instead of a
 * command.
 */
export function posixQuoteToken(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a remote argv into the shell command an ssh session runs.
 *
 * `cd '<cwd>' && exec '<argv...>'`, or plain `exec '<argv...>'` when no
 * working directory is configured — the remote runtime then starts wherever
 * the host's sshd drops it, which is the honest default for a deployment that
 * configured no cwd.
 *
 * @param argv - the remote argv; each token is quoted independently.
 * @param cwd - the remote working directory, when one is configured.
 * @returns the command string, ready to follow `ssh ... --`.
 */
export function buildRemoteCommand(argv: readonly string[], cwd?: string): string {
  const joined = argv.map((token) => posixQuoteToken(token)).join(" ");
  return cwd === undefined ? `exec ${joined}` : `cd ${posixQuoteToken(cwd)} && exec ${joined}`;
}

/** Seconds the ssh TCP connection may take to establish before giving up. */
const SSH_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Compose the subprocess launch a dsh driver runs.
 *
 * A local registration returns exactly the launch the driver has always
 * built: the configured command (or the reference runtime) with the cordis
 * config as its one argument, the resolved working directory, and the scrubbed
 * child environment. An ssh registration composes the OpenSSH command line
 * instead: strict host-key checking and batch mode so a missing key or an
 * unknown host fails closed rather than prompting a turn to death, the
 * optional identity file with `IdentitiesOnly`, a bounded connect timeout,
 * `SendEnv` for every passthrough name this host actually resolves, and then —
 * after `--`, so ssh cannot reinterpret the destination — the quoted remote
 * command that cds to the working directory and `exec`s the runtime.
 *
 * @param config - the backend's resolved configuration.
 * @param baseCwd - the run's effective directory, when the registration
 * names no `cwd` of its own.
 * @param pinning - the pinned known_hosts file from {@link pinHostKey}, when
 * the registration pins a fingerprint; ssh is pointed at the file via
 * `UserKnownHostsFile`.
 * @returns the launch for `DeepSeekHarness`, command through timeout.
 */
export function composeDshLaunch(
  config: Record<string, ConfigValue>,
  baseCwd?: string,
  pinning?: HostKeyPin,
): HarnessClientOptions {
  const cordisConfig = text(config, "cordisConfig");
  if (cordisConfig === undefined) {
    throw new Error('dsh backend requires "cordisConfig"; the runtime has no built-in fallback');
  }
  const command = text(config, "command") ?? "dsh-jsonrpc-agent";
  // Deployment override, then the run's effective directory, which `start()`
  // has already resolved from the task's own `cwd`.
  const cwd = text(config, "cwd") ?? baseCwd;
  const requestTimeoutMs = count(config, "requestTimeoutMs");
  // The same environment either way: under ssh the child is the ssh process
  // itself, and the scrub keeps host credentials away from it just the same.
  const env = childEnv(config);

  if (text(config, "mode") !== "ssh") {
    return {
      command,
      args: [cordisConfig],
      cwd,
      env,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    };
  }

  const host = text(config, "host");
  const user = text(config, "user");
  // `resolveConfig` refuses an incomplete or token-splitting destination at
  // load; repeat the same boundary here for callers that compose directly.
  if ((host ?? "").trim().length === 0) {
    throw new Error('"host" is required when "mode" is "ssh"');
  }
  if ((user ?? "").trim().length === 0) {
    throw new Error('"user" is required when "mode" is "ssh"');
  }
  if (/\s|\p{Cc}/u.test(host!) || /\s|\p{Cc}/u.test(user!)) {
    throw new Error('SSH "host" and "user" must not contain whitespace or control characters');
  }

  const args: string[] = [];
  const port = count(config, "port");
  if (port !== undefined) args.push("-p", String(port));
  const identityFile = text(config, "identityFile");
  if (identityFile !== undefined) args.push("-i", identityFile);
  // No prompts, ever: this child is unattended, so anything ssh would ask
  // about is a failure, not a question.
  args.push("-o", "BatchMode=yes");
  if (identityFile !== undefined) args.push("-o", "IdentitiesOnly=yes");
  args.push("-o", "StrictHostKeyChecking=yes");
  if (pinning !== undefined) args.push("-o", `UserKnownHostsFile=${pinning.knownHostsFile}`);
  args.push("-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`);
  // Only names this host resolves are forwarded. Values remain in the scrubbed
  // child environment and never enter argv, where process inspection and crash
  // tooling could expose them; OpenSSH reads them through SendEnv instead.
  for (const name of names(config, "envPassthrough")) {
    if (process.env[name] === undefined) continue;
    args.push("-o", `SendEnv=${name}`);
  }
  args.push("--", `${user}@${host}`, buildRemoteCommand([command, cordisConfig], cwd));
  return {
    command: "ssh",
    args,
    // `cwd` is the remote runtime directory; the ssh client itself must start
    // from the local run directory, which may not contain that remote path.
    cwd: baseCwd,
    env,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

/** A pinned known_hosts file an ssh launch must be pointed at. */
export interface HostKeyPin {
  /** The single-entry known_hosts file ssh reads instead of the user's own. */
  readonly knownHostsFile: string;
  /** Remove the file; idempotent, and safe after a failed write. */
  dispose(): void;
}

/** What one keyscan run reported. `code` is the exit code, `null` if killed by a signal. */
export interface KeyscanResult {
  code: number | null;
  stdout: string;
}

/** Runs `ssh-keyscan`; injectable so the pin is testable without a network. */
export type KeyscanRunner = (argv: readonly string[]) => Promise<KeyscanResult>;

/** The OpenSSH SHA256 fingerprint form `ssh-keygen -l` prints. */
const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;

/** Strip the base64 padding a configured fingerprint may carry. */
function unpadded(value: string): string {
  return value.replace(/=+$/, "");
}

/**
 * Parse every keyscan record into its OpenSSH SHA256 fingerprint.
 *
 * All records are parsed, not just the first: a host routinely presents
 * several key types (ed25519 alongside RSA), and a pin may name any of them.
 * Lines that are blank or comments are skipped; every other line must be a
 * parseable record — a malformed line fails closed rather than being ignored.
 * The caller decides whether what remains is enough.
 *
 * @param stdout - one `ssh-keyscan` run's stdout.
 * @returns each parseable record's original line, algorithm, and fingerprint.
 */
function parseKeyscanRecords(stdout: string): { line: string; algorithm: string; fingerprint: string }[] {
  const records: { line: string; algorithm: string; fingerprint: string }[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      throw new Error(`ssh-keyscan returned an unparseable record: ${JSON.stringify(line)}`);
    }
    const [hostField, algorithm, blob] = fields;
    if (hostField === undefined || algorithm === undefined || blob === undefined) {
      throw new Error(`ssh-keyscan returned an unparseable record: ${JSON.stringify(line)}`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
      throw new Error(`ssh-keyscan returned an unparseable record: ${JSON.stringify(line)}`);
    }
    // The OpenSSH fingerprint is the unpadded base64 of the SHA-256 of the
    // wire key blob — the same bytes the base64 field decodes to.
    const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
    records.push({ line, algorithm, fingerprint: `SHA256:${unpadded(digest)}` });
  }
  return records;
}

let pinSerial = 0;

/**
 * Materialize the matched records as a known_hosts file.
 *
 * Same-directory temp write plus rename, so a reader — ssh itself — never
 * observes a half-written file. The rename target is a name no other run
 * picks, so on Windows, where renaming onto an existing file fails, the
 * rename is always onto fresh ground.
 */
function writeKnownHosts(lines: readonly string[]): HostKeyPin {
  const knownHostsFile = path.join(os.tmpdir(), `dsh-known-hosts.${process.pid}.${Date.now()}.${pinSerial++}.tmp`);
  const staging = `${knownHostsFile}.staging`;
  try {
    fs.writeFileSync(staging, `${lines.join("\n")}\n`, "utf8");
    fs.renameSync(staging, knownHostsFile);
  } catch (cause) {
    for (const leftover of [staging, knownHostsFile]) {
      try {
        fs.rmSync(leftover, { force: true });
      } catch {
        // Nothing depends on the cleanup succeeding; the failure below is the
        // fact that matters.
      }
    }
    throw new Error(`could not materialize the pinned known_hosts file: ${String(cause)}`);
  }
  return {
    knownHostsFile,
    dispose(): void {
      try {
        fs.rmSync(knownHostsFile, { force: true });
      } catch {
        // Already gone is the dispose goal, not a failure.
      }
    },
  };
}

/** Scan the host's public keys with the OpenSSH CLI. */
function defaultKeyscanRunner(argv: readonly string[]): Promise<KeyscanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * Scan a host and pin it to the key matching the configured fingerprint.
 *
 * Fail-closed throughout: a scan that exited nonzero, came back empty,
 * carried nothing parseable, or presented no key with the pinned fingerprint
 * throws instead of returning a pin — a launch without a verified host key is
 * exactly the machine-in-the-middle this field exists to prevent. Every
 * parseable record is compared, so a pin naming any key type the host offers
 * matches.
 *
 * @param options - the host, its port, the pinned `SHA256:...` fingerprint,
 * and an optional keyscan runner (tests inject one; production runs the CLI).
 * @returns the pin whose `knownHostsFile` the launch must pass as
 * `UserKnownHostsFile`, and whose `dispose` removes it when the run ends.
 */
export async function pinHostKey(options: {
  host: string;
  port?: number;
  fingerprint: string;
  runScan?: KeyscanRunner;
}): Promise<HostKeyPin> {
  const host = options.host;
  const fingerprint = options.fingerprint.trim();
  if (!HOST_KEY_FINGERPRINT.test(fingerprint)) {
    throw new Error(`"hostKeySha256" is not an OpenSSH SHA256 fingerprint: ${JSON.stringify(options.fingerprint)}`);
  }
  const expected = unpadded(fingerprint);
  const argv = [
    "ssh-keyscan",
    ...(options.port === undefined ? [] : ["-p", String(options.port)]),
    host,
  ];
  const scan = await (options.runScan ?? defaultKeyscanRunner)(argv);
  if (scan.code !== 0) {
    throw new Error(`ssh-keyscan exited ${String(scan.code)} for ${host}; refusing to launch unpinned`);
  }
  const records = parseKeyscanRecords(scan.stdout);
  if (records.length === 0) {
    throw new Error(`ssh-keyscan returned no parseable host keys for ${host}; refusing to launch unpinned`);
  }
  const matched = records.filter((record) => record.fingerprint === expected);
  if (matched.length === 0) {
    throw new Error(
      `none of the ${records.length} host key(s) ${host} presented matches the pinned ${expected}; refusing to launch`,
    );
  }
  // The original lines are written verbatim, so ssh reads exactly what
  // keyscan produced — including the `[host]:port` form for non-standard ports.
  return writeKnownHosts(matched.map((record) => record.line));
}

/**
 * Build a driver that spawns a real dsh runtime.
 *
 * The runtime resolves its own credential from its own configuration — in the
 * reference deployment, an `.env` beside its `cordis.yml` — so this process
 * neither reads the key nor checks whether it is set. A presence check here
 * would be worse than useless: the key is legitimately absent from this process,
 * and failing on that would reject a correctly configured deployment.
 *
 * @param config - the backend's resolved configuration.
 * @param options - the run options, for cancellation and correlation.
 * @returns a driver owning one runtime subprocess.
 */
export async function createDshDriver(
  config: Record<string, ConfigValue>,
  options: DshDriverOptions,
): Promise<DshHarnessDriver> {
  const cordisConfig = text(config, "cordisConfig");
  if (cordisConfig === undefined) {
    throw new Error('dsh backend requires "cordisConfig"; the runtime has no built-in fallback');
  }
  // Pinned before composing: the composed argv must name the known_hosts file
  // the pin wrote, and a scan that fails closed throws before any subprocess
  // exists. A registration that pins nothing gets no pin and no scan.
  const fingerprintConfig = text(config, "hostKeySha256");
  const pinning = text(config, "mode") === "ssh" && fingerprintConfig !== undefined
    ? await pinHostKey({
      host: text(config, "host") ?? "",
      port: count(config, "port"),
      fingerprint: fingerprintConfig,
    })
    : undefined;
  let harness: DeepSeekHarness;
  try {
    const launch = composeDshLaunch(config, options.baseCwd, pinning);
    const runtimeCwd = text(config, "cwd") ?? options.baseCwd;
    harness = new DeepSeekHarness({
      // The per-run variables ride on top of the composed environment; the
      // todo endpoint URL is one of these, and a caller value wins over an
      // ambient one.
      launch: { ...launch, env: { ...launch.env, ...(options.envExtras ?? {}) } },
      cwd: runtimeCwd,
      ...(text(config, "provider") === undefined ? {} : { provider: text(config, "provider")! }),
      ...(text(config, "model") === undefined ? {} : { model: text(config, "model")! }),
      ...(count(config, "maxTokens") === undefined ? {} : { maxTokens: count(config, "maxTokens")! }),
    });
  } catch (cause) {
    // Nothing owns the temp file yet, so this path cleans up after itself.
    pinning?.dispose();
    throw cause;
  }

  return {
    async run(input, runOptions) {
      const result = await harness.run(input, {
        sessionId: runOptions.sessionId,
        ...(runOptions.onNotification === undefined ? {} : { onNotification: runOptions.onNotification }),
      });
      return {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        events: result.events as unknown as readonly Record<string, unknown>[],
      };
    },
    close: () =>
      // The pinned file lives exactly as long as the ssh processes that read
      // it: removed when the runtime is gone, even if closing fails.
      harness.close().finally(() => pinning?.dispose()),
  };
}
