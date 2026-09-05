import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, glob, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";

export const OPENSSH_MAX_FILES = 32;
export const OPENSSH_MAX_DEPTH = 8;
export const OPENSSH_MAX_BYTES = 1024 * 1024;
export const OPENSSH_MAX_ALIASES = 256;

export interface OpenSshImportWarning {
  code: "config_missing" | "unsafe_file" | "include_cycle" | "include_limit" | "depth_limit" | "size_limit" | "alias_limit" | "match_exec" | "unsupported_match" | "ssh_failed" | "multiple_identities" | "complex_proxy_jump" | "proxy_command" | "unsupported_auth";
  message: string;
  path?: string;
  alias?: string;
}

export interface OpenSshIdentityCandidate { path: string }

export interface OpenSshImportCandidate {
  alias: string;
  hostName: string;
  user?: string;
  port: number;
  identities: OpenSshIdentityCandidate[];
  proxyJumpAliases: string[];
  warnings: OpenSshImportWarning[];
}

export interface OpenSshDiscoveryResult {
  configPath: string;
  configFound: boolean;
  scannedFiles: string[];
  candidates: OpenSshImportCandidate[];
  warnings: OpenSshImportWarning[];
}

export type OpenSshCommandRunner = (file: string, args: readonly string[]) => Promise<string>;

export interface DiscoverOpenSshOptions {
  configPath?: string;
  sshPath?: string;
  /** Test seam for `%d`; production callers should use the process home default. */
  homeDirectory?: string;
  /** Test seam; production callers should use the system ssh default. */
  runCommand?: OpenSshCommandRunner;
}

interface ScanState {
  files: string[];
  fileCache: Map<string, string[]>;
  active: Set<string>;
  aliases: string[];
  aliasSet: Set<string>;
  bytes: number;
  warnings: OpenSshImportWarning[];
  fatal: boolean;
  includeBase: string;
  homeDirectory: string;
}

export async function discoverOpenSshConfig(options: DiscoverOpenSshOptions = {}): Promise<OpenSshDiscoveryResult> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const configPath = resolve(expandHome(options.configPath ?? join(homeDirectory, ".ssh", "config"), homeDirectory));
  const state: ScanState = {
    files: [], fileCache: new Map(), active: new Set(), aliases: [], aliasSet: new Set(),
    bytes: 0, warnings: [], fatal: false, includeBase: dirname(configPath), homeDirectory,
  };
  const root = await inspectSafeRegularFile(configPath);
  if (root === "missing") {
    return { configPath, configFound: false, scannedFiles: [], candidates: [], warnings: [warning("config_missing", "OpenSSH config was not found", configPath)] };
  }
  if (root !== "regular") {
    return { configPath, configFound: true, scannedFiles: [], candidates: [], warnings: [warning("unsafe_file", "OpenSSH config and every path component must be regular and non-symlinked", configPath)] };
  }

  const flattened = await scanFile(configPath, 0, state);
  if (state.fatal) return result(configPath, state, []);

  const snapshotDirectory = await mkdtemp(join(tmpdir(), "pi-ssh-config-"));
  const snapshotPath = join(snapshotDirectory, "config");
  const runner = options.runCommand ?? runExecFile;
  const candidates: OpenSshImportCandidate[] = [];
  try {
    if (process.platform !== "win32") await chmod(snapshotDirectory, 0o700);
    await writeFile(snapshotPath, `${flattened.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    for (const alias of state.aliases) {
      try {
        const output = await runner(options.sshPath ?? "ssh", ["-G", "-F", snapshotPath, alias]);
        candidates.push(candidateFromSshG(alias, output, explicitDirectivesForAlias(flattened, alias)));
      } catch {
        state.warnings.push({ code: "ssh_failed", message: "ssh -G could not resolve this alias", alias });
      }
    }
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
  return result(configPath, state, candidates);
}

function result(configPath: string, state: ScanState, candidates: OpenSshImportCandidate[]): OpenSshDiscoveryResult {
  return { configPath, configFound: true, scannedFiles: [...state.files], candidates, warnings: [...state.warnings] };
}

async function scanFile(path: string, depth: number, state: ScanState): Promise<string[]> {
  path = normalize(resolve(path));
  if (depth > OPENSSH_MAX_DEPTH) { fail(state, warning("depth_limit", `OpenSSH Include depth exceeds ${OPENSSH_MAX_DEPTH}`, path)); return []; }
  if (state.active.has(path)) { fail(state, warning("include_cycle", "OpenSSH Include cycle detected", path)); return []; }
  const cached = state.fileCache.get(path);
  if (cached) return [...cached];
  if (state.fatal) return [];
  if (state.files.length >= OPENSSH_MAX_FILES) { fail(state, warning("include_limit", `OpenSSH config includes more than ${OPENSSH_MAX_FILES} files`, path)); return []; }

  let text: string;
  try {
    text = await readBoundedRegularFile(path, OPENSSH_MAX_BYTES - state.bytes);
  } catch (error) {
    const code = (error as Error).message === "size_limit" ? "size_limit" : "unsafe_file";
    fail(state, warning(code, code === "size_limit" ? "OpenSSH config total exceeds 1 MiB" : "Included OpenSSH config and every path component must be regular and non-symlinked", path));
    return [];
  }
  state.bytes += Buffer.byteLength(text, "utf8");
  state.files.push(path);
  state.active.add(path);
  const flattened: string[] = [];
  for (const line of logicalLines(text)) {
    const tokens = tokenize(line);
    if (tokens.length === 0) { flattened.push(line); continue; }
    const key = tokens[0]!.toLowerCase();
    const values = tokens.slice(1);
    if (key === "host") {
      for (const alias of values) {
        if (!alias || /[*?!]/u.test(alias) || alias.startsWith("-") || state.aliasSet.has(alias)) continue;
        if (state.aliases.length >= OPENSSH_MAX_ALIASES) {
          fail(state, warning("alias_limit", `OpenSSH config contains more than ${OPENSSH_MAX_ALIASES} explicit aliases`, path));
          break;
        }
        state.aliasSet.add(alias);
        state.aliases.push(alias);
      }
      flattened.push(line);
    } else if (key === "match") {
      if (values.some((value) => /^(?:!exec|exec)(?:=|$)/iu.test(value))) fail(state, warning("match_exec", "Match exec is unsafe during OpenSSH discovery", path));
      else state.warnings.push(warning("unsupported_match", "Match conditions may not be representable in an imported host", path));
      flattened.push(line);
    } else if (key === "include") {
      for (const pattern of values) {
        let includedPaths: string[];
        try { includedPaths = await expandInclude(pattern, state.includeBase, state.homeDirectory); }
        catch { fail(state, warning("unsafe_file", "OpenSSH Include could not be expanded safely", path)); break; }
        for (const included of includedPaths) flattened.push(...await scanFile(included, depth + 1, state));
      }
    } else {
      flattened.push(line);
    }
    if (state.fatal) break;
  }
  state.active.delete(path);
  if (!state.fatal) state.fileCache.set(path, [...flattened]);
  return flattened;
}

async function expandInclude(pattern: string, includeBase: string, homeDirectory: string): Promise<string[]> {
  const expanded = expandHome(pattern.replaceAll("%d", homeDirectory), homeDirectory);
  if (/%[A-Za-z%]/u.test(expanded)) throw new Error("unsupported Include token");
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(includeBase, expanded);
  if (!/[*?\[]/u.test(absolute)) return [absolute];
  const matches: string[] = [];
  for await (const matched of glob(absolute)) {
    matches.push(normalize(resolve(matched)));
    if (matches.length > OPENSSH_MAX_FILES) throw new Error("Include expansion exceeds file limit");
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

interface ExplicitDirectives {
  identityFile: boolean;
  proxyCommand: boolean;
  unsupportedAuth: boolean;
}

function candidateFromSshG(alias: string, output: string, explicit: ExplicitDirectives): OpenSshImportCandidate {
  const values = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^([^\s]+)\s+(.*)$/u);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const list = values.get(key) ?? []; list.push(match[2]!.trim()); values.set(key, list);
  }
  const hostName = first(values, "hostname") ?? alias;
  const parsedPort = Number(first(values, "port") ?? "22");
  const identities = explicit.identityFile
    ? (values.get("identityfile") ?? []).filter((path) => path && path.toLowerCase() !== "none").map((path) => ({ path }))
    : [];
  const warnings: OpenSshImportWarning[] = [];
  if (identities.length > 1) warnings.push({ code: "multiple_identities", message: "Multiple IdentityFile values require an explicit choice", alias });
  const proxyJump = first(values, "proxyjump");
  let proxyJumpAliases: string[] = [];
  if (proxyJump && proxyJump.toLowerCase() !== "none") {
    const parts = proxyJump.split(",").map((part) => part.trim());
    if (parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part))) proxyJumpAliases = parts;
    else warnings.push({ code: "complex_proxy_jump", message: "ProxyJump contains user, port, pattern, or other non-alias syntax", alias });
  }
  const proxyCommand = first(values, "proxycommand");
  if (explicit.proxyCommand && proxyCommand && proxyCommand.toLowerCase() !== "none") warnings.push({ code: "proxy_command", message: "ProxyCommand is not imported", alias });
  if (explicit.unsupportedAuth) warnings.push({ code: "unsupported_auth", message: "Certificate or PKCS11/security-key configuration is not imported", alias });
  return { alias, hostName, ...(first(values, "user") ? { user: first(values, "user") } : {}), port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535 ? parsedPort : 22, identities, proxyJumpAliases, warnings };
}

function explicitDirectivesForAlias(lines: readonly string[], alias: string): ExplicitDirectives {
  let active = true;
  let identityFile = false;
  let proxyCommand = false;
  let unsupportedAuth = false;
  for (const line of lines) {
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const key = tokens[0]!.toLowerCase();
    if (key === "host") { active = hostPatternsMatch(alias, tokens.slice(1)); continue; }
    if (key === "match") { active = false; continue; }
    if (!active) continue;
    if (key === "identityfile") identityFile = true;
    else if (key === "proxycommand") proxyCommand = true;
    else if (key === "certificatefile" || key === "pkcs11provider" || key === "securitykeyprovider") unsupportedAuth = true;
  }
  return { identityFile, proxyCommand, unsupportedAuth };
}

function hostPatternsMatch(alias: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const value of patterns) {
    const negated = value.startsWith("!");
    const pattern = negated ? value.slice(1) : value;
    const regex = new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`, process.platform === "win32" ? "iu" : "u");
    if (!regex.test(alias)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function first(values: Map<string, string[]>, key: string): string | undefined { return values.get(key)?.[0]; }
function warning(code: OpenSshImportWarning["code"], message: string, path?: string): OpenSshImportWarning { return { code, message, ...(path ? { path } : {}) }; }
function fail(state: ScanState, value: OpenSshImportWarning): void { state.warnings.push(value); state.fatal = true; }
function expandHome(path: string, homeDirectory = homedir()): string { return path === "~" ? homeDirectory : path.startsWith("~/") || path.startsWith("~\\") ? join(homeDirectory, path.slice(2)) : path; }
function escapeRegex(value: string): string { return value.replace(/[|\\{}()[\]^$+.*?]/gu, "\\$&"); }

async function inspectSafeRegularFile(path: string): Promise<"regular" | "missing" | "unsafe"> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  try {
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return "unsafe";
      if (index < segments.length - 1 ? !info.isDirectory() : !info.isFile()) return "unsafe";
    }
    return "regular";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function readBoundedRegularFile(path: string, remainingBytes: number): Promise<string> {
  if (remainingBytes < 0 || await inspectSafeRegularFile(path) !== "regular") throw new Error("unsafe_file");
  const before = await lstat(path);
  if (before.size > remainingBytes) throw new Error("size_limit");
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let bytes: Buffer | undefined;
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size || after.size > remainingBytes) throw new Error(after.size > remainingBytes ? "size_limit" : "unsafe_file");
    bytes = Buffer.alloc(Number(after.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error("unsafe_file");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    try { if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error("unsafe_file"); }
    finally { extra.fill(0); }
    return bytes.toString("utf8");
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

function logicalLines(text: string): string[] {
  const result: string[] = []; let current = "";
  for (const physical of text.split(/\r?\n/u)) {
    const line = stripPhysicalComment(physical);
    current += line;
    if (/\\$/u.test(current)) { current = current.slice(0, -1); continue; }
    result.push(current); current = "";
  }
  if (current) result.push(current);
  return result;
}

function stripPhysicalComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function tokenize(line: string): string[] {
  const tokens: string[] = []; let token = ""; let quote: "'" | '"' | null = null; let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\") {
      const next = line[index + 1];
      if (next !== undefined && (/\s/u.test(next) || next === "#" || next === "\\" || next === "'" || next === '"')) { token += next; index++; }
      else token += "\\";
      started = true; continue;
    }
    if (quote) { if (char === quote) quote = null; else token += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#") break;
    if (/\s/u.test(char)) { if (started) { tokens.push(token); token = ""; started = false; } continue; }
    token += char; started = true;
  }
  if (started) tokens.push(token);
  const separator = tokens[0]?.indexOf("=") ?? -1;
  if (separator > 0) {
    const first = tokens.shift()!;
    const key = first.slice(0, separator);
    const value = first.slice(separator + 1);
    tokens.unshift(key, ...(value ? [value] : []));
  } else if (tokens[0]?.endsWith("=")) {
    tokens[0] = tokens[0].slice(0, -1);
  }
  return tokens;
}

function runExecFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolvePromise(stdout));
  });
}
