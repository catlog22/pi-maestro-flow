import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENSSH_MAX_ALIASES,
  OPENSSH_MAX_BYTES,
  OPENSSH_MAX_DEPTH,
  OPENSSH_MAX_FILES,
  discoverOpenSshConfig,
  type OpenSshCommandRunner,
} from "../src/ssh-manager/openssh-config.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openssh-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function output(lines: string[]): string { return `${lines.join("\n")}\n`; }

function recordingRunner(outputs: Record<string, string>, calls: Array<{ file: string; args: readonly string[] }>): OpenSshCommandRunner {
  return async (file, args) => {
    calls.push({ file, args: [...args] });
    const alias = args.at(-1)!;
    if (!(alias in outputs)) throw new Error("unexpected alias");
    return outputs[alias]!;
  };
}

test("missing config reports no host config and never infers hosts from key files", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "id_ed25519"), "not-read-private-key");
  await writeFile(join(root, "known_hosts"), "server.test key");
  let ran = false;
  const result = await discoverOpenSshConfig({ configPath: join(root, "config"), runCommand: async () => { ran = true; return ""; } });
  assert.equal(result.configFound, false);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.warnings[0]?.code, "config_missing");
  assert.equal(ran, false);
});

test("Include recursion discovers only explicit aliases while wildcard Host supplies inherited ssh -G values", async (t) => {
  const root = await fixture(t);
  const parts = join(root, "parts"); await mkdir(parts);
  const config = join(root, "config");
  await writeFile(config, `Include "parts/*.conf"\nHost *\n  User inherited\n  Port 2200\nHost direct\n  HostName first.example\n  HostName ignored.example\n`);
  await writeFile(join(parts, "a.conf"), "Host included\n  HostName included.example\nHost wildcard-* ?single !negated\n");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner = recordingRunner({
    included: output(["host included", "hostname included.example", "user inherited", "port 2200"]),
    direct: output(["host direct", "hostname first.example", "user inherited", "port 2200"]),
  }, calls);
  const result = await discoverOpenSshConfig({ configPath: config, sshPath: "custom-ssh", runCommand: runner });
  assert.deepEqual(result.candidates.map((candidate) => candidate.alias), ["included", "direct"]);
  assert.equal(result.candidates[1]?.hostName, "first.example", "ssh -G effective first-value output is authoritative");
  assert.equal(result.candidates[1]?.user, "inherited");
  assert.equal(result.candidates[1]?.port, 2200);
  assert.equal(result.scannedFiles.length, 2);
  assert.deepEqual(calls.map((call) => call.file), ["custom-ssh", "custom-ssh"]);
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["-G", "-F"]);
  assert.notEqual(calls[0]?.args[2], config, "ssh -G must read the validated private snapshot, not the mutable source");
});

test("%d Includes are expanded from home and ssh reads only the flattened validated snapshot", async (t) => {
  const root = await fixture(t);
  const sshDirectory = join(root, ".ssh");
  const parts = join(sshDirectory, "parts");
  await mkdir(parts, { recursive: true });
  const config = join(sshDirectory, "config");
  await writeFile(config, "Include %d/.ssh/parts/*.conf\n");
  await writeFile(join(parts, "host.conf"), "Host imported\n  HostName imported.example\n");
  const result = await discoverOpenSshConfig({
    configPath: config,
    homeDirectory: root,
    runCommand: async (_file, args) => {
      const snapshot = await readFile(String(args[2]), "utf8");
      assert.doesNotMatch(snapshot, /^Include\b/m);
      assert.match(snapshot, /^Host imported$/m);
      return "hostname imported.example\nport 22\n";
    },
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.alias), ["imported"]);
  assert.equal(result.scannedFiles.length, 2);
});

test("Include cycles and recursive scan bounds fail closed before ssh runs", async (t) => {
  const root = await fixture(t); let runs = 0;
  const runner = async () => { runs++; return "hostname no.test\n"; };
  const a = join(root, "a"); const b = join(root, "b");
  await writeFile(a, `Include ${b}\nHost a\n`); await writeFile(b, `Include ${a}\n`);
  const cycle = await discoverOpenSshConfig({ configPath: a, runCommand: runner });
  assert.equal(cycle.warnings.at(-1)?.code, "include_cycle"); assert.deepEqual(cycle.candidates, []);

  const deep = Array.from({ length: OPENSSH_MAX_DEPTH + 2 }, (_, index) => join(root, `deep-${index}`));
  for (let index = 0; index < deep.length; index++) await writeFile(deep[index]!, index + 1 < deep.length ? `Include ${deep[index + 1]}\n` : "Host deep\n");
  const depth = await discoverOpenSshConfig({ configPath: deep[0], runCommand: runner });
  assert.equal(depth.warnings.at(-1)?.code, "depth_limit");

  const manyRoot = join(root, "many");
  const includes: string[] = [];
  for (let index = 0; index < OPENSSH_MAX_FILES; index++) { const path = join(root, `many-${index}`); includes.push(path); await writeFile(path, "# file\n"); }
  await writeFile(manyRoot, includes.map((path) => `Include ${path}`).join("\n"));
  const count = await discoverOpenSshConfig({ configPath: manyRoot, runCommand: runner });
  assert.equal(count.warnings.at(-1)?.code, "include_limit");
  assert.equal(runs, 0);
});

test("aggregate byte limit and non-regular or symlink config fail closed", async (t) => {
  const root = await fixture(t);
  const oversized = join(root, "oversized"); await writeFile(oversized, Buffer.alloc(OPENSSH_MAX_BYTES + 1, 32));
  assert.equal((await discoverOpenSshConfig({ configPath: oversized })).warnings.at(-1)?.code, "size_limit");
  assert.equal((await discoverOpenSshConfig({ configPath: root })).warnings.at(-1)?.code, "unsafe_file");
  const target = join(root, "target"); const link = join(root, "link"); await writeFile(target, "Host safe\n");
  try { await symlink(target, link, "file"); }
  catch { t.diagnostic("symlink creation unavailable; symlink assertion skipped"); return; }
  assert.equal((await discoverOpenSshConfig({ configPath: link })).warnings.at(-1)?.code, "unsafe_file");

  const external = join(root, "external");
  const linkedDirectory = join(root, "linked-directory");
  await mkdir(external);
  await writeFile(join(external, "host.conf"), "Host external\n");
  try { await symlink(external, linkedDirectory, "junction"); }
  catch { t.diagnostic("directory symlink creation unavailable; path-component assertion skipped"); return; }
  const throughDirectoryLink = join(root, "through-directory-link");
  await writeFile(throughDirectoryLink, `Include ${join(linkedDirectory, "*.conf")}\n`);
  assert.equal((await discoverOpenSshConfig({ configPath: throughDirectoryLink })).warnings.at(-1)?.code, "unsafe_file");
});

test("recursive Match exec rejection happens before ssh -G, while other Match is warned", async (t) => {
  const root = await fixture(t); const config = join(root, "config"); const nested = join(root, "nested"); let runs = 0;
  await writeFile(config, `Include ${nested}\nHost safe\n`); await writeFile(nested, `Match host safe exec "touch ${join(root, "pwned")}"\n`);
  const rejected = await discoverOpenSshConfig({ configPath: config, runCommand: async () => { runs++; return "hostname safe\n"; } });
  assert.equal(rejected.warnings.at(-1)?.code, "match_exec"); assert.equal(runs, 0); assert.deepEqual(rejected.candidates, []);
  await writeFile(nested, "Match !exec false\n");
  assert.equal((await discoverOpenSshConfig({ configPath: config, runCommand: async () => { runs++; return ""; } })).warnings.at(-1)?.code, "match_exec");
  assert.equal(runs, 0);
  await writeFile(nested, "Match=exec true\n");
  assert.equal((await discoverOpenSshConfig({ configPath: config, runCommand: async () => { runs++; return ""; } })).warnings.at(-1)?.code, "match_exec");
  assert.equal(runs, 0);
  await writeFile(nested, "Host safe # \\\nMatch exec true\n");
  assert.equal((await discoverOpenSshConfig({ configPath: config, runCommand: async () => { runs++; return ""; } })).warnings.at(-1)?.code, "match_exec");
  assert.equal(runs, 0);
  await writeFile(nested, "Match host safe\n  User conditional\n");
  const warned = await discoverOpenSshConfig({ configPath: config, runCommand: async () => { runs++; return "hostname safe.example\nport 22\n"; } });
  assert.ok(warned.warnings.some((warning) => warning.code === "unsupported_match")); assert.equal(runs, 1);
});

test("identity, ProxyJump, ProxyCommand, certificate and Windows paths remain explicit preview-only data", async (t) => {
  const root = await fixture(t); const config = join(root, "config");
  await writeFile(config, [
    "Host target",
    "  IdentityFile C:\\Users\\Alice\\.ssh\\id\\ one",
    "  IdentityFile ~/.ssh/id_two",
    "  ProxyJump bastion,edge",
    "  ProxyCommand ssh relay",
    "  CertificateFile ~/.ssh/id-cert.pub",
    "  PKCS11Provider C:\\token.dll",
    "Host complex",
    "  IdentityFile none",
    "  ProxyJump ops@bastion:2222",
    "",
  ].join("\n"));
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const result = await discoverOpenSshConfig({ configPath: config, runCommand: recordingRunner({
    target: output(["hostname target.example", "user deploy", "port 2222", "identityfile C:\\Users\\Alice\\.ssh\\id one", "identityfile ~/.ssh/id_two", "proxyjump bastion,edge", "proxycommand ssh relay", "certificatefile ~/.ssh/id-cert.pub", "pkcs11provider C:\\token.dll"]),
    complex: output(["hostname complex.example", "port 22", "identityfile none", "proxyjump ops@bastion:2222"]),
  }, calls) });
  const target = result.candidates[0]!;
  assert.deepEqual(target.identities, [{ path: "C:\\Users\\Alice\\.ssh\\id one" }, { path: "~/.ssh/id_two" }]);
  assert.deepEqual(target.proxyJumpAliases, ["bastion", "edge"]);
  assert.deepEqual(target.warnings.map((warning) => warning.code), ["multiple_identities", "proxy_command", "unsupported_auth"]);
  assert.deepEqual(result.candidates[1]?.proxyJumpAliases, []);
  assert.ok(result.candidates[1]?.warnings.some((warning) => warning.code === "complex_proxy_jump"));
});

test("argv option injection aliases are rejected and valid aliases are passed as one argv with shell-free runner contract", async (t) => {
  const root = await fixture(t); const config = join(root, "config");
  await writeFile(config, "Host -oProxyCommand=touch-pwned\nHost safe;touch-pwned\n");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const result = await discoverOpenSshConfig({ configPath: config, runCommand: recordingRunner({ "safe;touch-pwned": "hostname safe.example\nport 22\n" }, calls) });
  assert.deepEqual(result.candidates.map((candidate) => candidate.alias), ["safe;touch-pwned"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["-G", "-F"]);
  assert.notEqual(calls[0]?.args[2], config);
  assert.equal(calls[0]?.args[3], "safe;touch-pwned");
});

test("explicit alias count is bounded before invoking ssh", async (t) => {
  const root = await fixture(t);
  const config = join(root, "config");
  await writeFile(config, Array.from({ length: OPENSSH_MAX_ALIASES + 1 }, (_, index) => `Host host-${index}`).join("\n"));
  let calls = 0;
  const result = await discoverOpenSshConfig({ configPath: config, runCommand: async () => { calls++; return ""; } });
  assert.equal(result.warnings.at(-1)?.code, "alias_limit");
  assert.equal(calls, 0);
});

test("OpenSSH defaults are not reported as explicit identity or security-key configuration", async (t) => {
  const root = await fixture(t);
  const config = join(root, "config");
  await writeFile(config, "Host minimal\n  HostName minimal.example\n");
  const result = await discoverOpenSshConfig({
    configPath: config,
    runCommand: async () => output([
      "hostname minimal.example",
      "port 22",
      "identityfile ~/.ssh/id_rsa",
      "identityfile ~/.ssh/id_ed25519",
      "securitykeyprovider internal",
    ]),
  });
  assert.deepEqual(result.candidates[0]?.identities, []);
  assert.deepEqual(result.candidates[0]?.warnings, []);
});
