import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SshHostProfile } from "pi-maestro-backend-core/v1/ssh";
import {
  SshHostProviderError,
  activateSshHost,
  getSshHostProvider,
  listSshHostPickerEntries,
  listSshHostRefs,
  registerSshHostProvider,
  resolveSshHostRef,
  type SshHostPickerEntry,
} from "../src/public/v1/ssh-hosts.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function profile(id = "server-1"): SshHostProfile {
  return {
    id,
    label: "Production",
    host: "prod.example.test",
    user: "deploy",
    port: 22,
    shell: "bash",
    hostKeySha256: PIN,
    authentication: { kind: "identity", identityFile: "/home/user/.ssh/id_ed25519" },
  };
}

function pickerEntry(id = "server-1", selected = true): SshHostPickerEntry {
  return {
    id,
    label: "Production",
    host: "prod.example.test",
    user: "deploy",
    port: 22,
    shell: "bash",
    selected,
  };
}

test("registers, lists, resolves, and unregisters a non-secret SSH host provider", async () => {
  const registration = registerSshHostProvider({
    async list() {
      return [{ id: "server-1", label: "Production", compatible: true }];
    },
    async resolve(hostRef) {
      return profile(hostRef);
    },
  });
  disposers.push(registration.dispose);

  assert.ok(getSshHostProvider());
  assert.deepEqual(await listSshHostRefs(), [
    { id: "server-1", label: "Production", compatible: true },
  ]);
  assert.deepEqual(await resolveSshHostRef("server-1"), profile());

  registration.dispose();
  assert.equal(getSshHostProvider(), undefined);
});

test("legacy providers remain usable and report unsupported optional capabilities", async () => {
  const registration = registerSshHostProvider({
    async list() { return [{ id: "server-1", label: "Production", compatible: true }]; },
    async resolve() { return profile(); },
  });
  disposers.push(registration.dispose);

  assert.deepEqual(await listSshHostRefs(), [{ id: "server-1", label: "Production", compatible: true }]);
  await assert.rejects(
    listSshHostPickerEntries(),
    (error: unknown) => error instanceof SshHostProviderError && error.code === "unsupported-capability",
  );
  await assert.rejects(
    activateSshHost("server-1"),
    (error: unknown) => error instanceof SshHostProviderError && error.code === "unsupported-capability",
  );
});

test("a stale registration cannot dispose its replacement", async () => {
  const first = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profile("old"); },
  });
  const second = registerSshHostProvider({
    async list() { return [{ id: "new", label: "New", compatible: true }]; },
    async resolve() { return profile("new"); },
  });
  disposers.push(first.dispose, second.dispose);

  first.dispose();
  assert.deepEqual(await listSshHostRefs(), [{ id: "new", label: "New", compatible: true }]);
});

test("missing providers fail closed with an actionable diagnostic", async () => {
  await assert.rejects(
    resolveSshHostRef("server-1"),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "provider-unavailable"
      && /Open \/ssh/u.test(error.message),
  );
});

test("missing providers fail closed for picker listing and activation too", async () => {
  await assert.rejects(
    listSshHostPickerEntries(),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "provider-unavailable"
      && !error.message.includes("undefined"),
  );
  await assert.rejects(
    activateSshHost("server-1"),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "provider-unavailable"
      && !error.message.includes("undefined"),
  );
});

test("invalid provider profiles are rejected without echoing secret-bearing fields", async () => {
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() {
      return {
        ...profile(),
        password: "top-secret-password",
      } as unknown as SshHostProfile;
    },
  });
  disposers.push(registration.dispose);

  await assert.rejects(
    resolveSshHostRef("server-1"),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "invalid-provider-result"
      && !error.message.includes("top-secret-password"),
  );
});

test("untrusted provider errors are replaced rather than leaking their message", async () => {
  const registration = registerSshHostProvider({
    async list() { throw new Error("top-secret-password"); },
    async resolve() { throw new Error("top-secret-password"); },
  });
  disposers.push(registration.dispose);

  await assert.rejects(
    resolveSshHostRef("server-1"),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "refresh-failed"
      && !error.message.includes("top-secret-password"),
  );
  await assert.rejects(
    listSshHostRefs(),
    (error: unknown) => error instanceof SshHostProviderError
      && !error.message.includes("top-secret-password"),
  );
});

test("picker entries are cloned and preserve only safe connection metadata", async () => {
  const source = [
    pickerEntry("server-1", true),
    { ...pickerEntry("windows-1", false), shell: "powershell" as const },
  ];
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profile(); },
    async listPickerEntries() { return source; },
  });
  disposers.push(registration.dispose);

  const entries = await listSshHostPickerEntries();
  assert.deepEqual(entries, source);
  assert.notEqual(entries, source);
  assert.notEqual(entries[0], source[0]);
  (entries[0] as { label: string }).label = "Mutated clone";
  assert.equal(source[0]?.label, "Production");
});

test("picker entries reject credential-bearing fields and unsafe values", async () => {
  const invalidEntries: unknown[][] = [
    [{ ...pickerEntry(), password: "top-secret-password" }],
    [{ ...pickerEntry(), identityFile: "/secret/id_ed25519" }],
    [{ ...pickerEntry(), hostKeySha256: PIN }],
    [{ ...pickerEntry(), host: "prod.example.test\nmalicious" }],
    [{ ...pickerEntry(), user: "deploy user" }],
    [{ ...pickerEntry(), port: 65_536 }],
    [{ ...pickerEntry(), shell: "zsh" }],
    [{ ...pickerEntry(), selected: "true" }],
    [pickerEntry("duplicate"), pickerEntry("duplicate", false)],
    [pickerEntry("one"), pickerEntry("two", true)],
  ];

  for (const value of invalidEntries) {
    const registration = registerSshHostProvider({
      async list() { return []; },
      async resolve() { return profile(); },
      async listPickerEntries() { return value as SshHostPickerEntry[]; },
    });
    disposers.push(registration.dispose);
    await assert.rejects(
      listSshHostPickerEntries(),
      (error: unknown) => error instanceof SshHostProviderError && error.code === "invalid-provider-result"
        && !error.message.includes("top-secret-password")
        && !error.message.includes("/secret/id_ed25519"),
    );
    registration.dispose();
  }
});

test("activation passes the exact validated host id to capable providers", async () => {
  let activated: string | undefined;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profile(); },
    async activate(hostId) { activated = hostId; },
  });
  disposers.push(registration.dispose);

  await activateSshHost("server-1");
  assert.equal(activated, "server-1");
  await assert.rejects(activateSshHost("server with whitespace"), /SSH host reference is invalid/u);
  assert.equal(activated, "server-1");
});

test("provider activation errors are replaced rather than leaking secrets", async () => {
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { return profile(); },
    async activate() { throw new Error("top-secret-password"); },
  });
  disposers.push(registration.dispose);

  await assert.rejects(
    activateSshHost("server-1"),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "refresh-failed"
      && !error.message.includes("top-secret-password"),
  );
});

test("explicit provider incompatibilities remain bounded non-secret metadata", async () => {
  const issues = [
    "unsupported-managed-key",
    "unsupported-jump-host",
    "unsupported-password-authentication",
    "unsupported-identity-passphrase",
    "unsupported-shell",
    "untrusted-host",
  ] as const;
  const registration = registerSshHostProvider({
    async list() {
      return issues.map((issue, index) => ({
        id: `host-${index}`,
        label: `Host ${index}`,
        compatible: false as const,
        issue,
      }));
    },
    async resolve() { throw new SshHostProviderError("host-incompatible", "SSH host reference is incompatible"); },
  });
  disposers.push(registration.dispose);

  assert.deepEqual((await listSshHostRefs()).map((entry) => entry.issue), issues);
  assert.doesNotMatch(JSON.stringify(await listSshHostRefs()), /password-value|private-key-material|passphrase-value/u);
});

test("invalid and duplicate list entries fail closed", async () => {
  const registration = registerSshHostProvider({
    async list() {
      return [
        { id: "server-1", label: "One", compatible: true },
        { id: "server-1", label: "Duplicate", compatible: true },
      ];
    },
    async resolve() { return profile(); },
  });
  disposers.push(registration.dispose);

  await assert.rejects(listSshHostRefs(), { name: "SshHostProviderError" });
});

test("provider getters and validation proxies cannot leak raw errors", async () => {
  const secret = "top-secret-provider-getter";
  const invalidRegistration = { async list() { return []; }, async resolve() { return profile(); } };
  Object.defineProperty(invalidRegistration, "list", { get() { throw new Error(secret); } });
  assert.throws(
    () => registerSshHostProvider(invalidRegistration),
    (error: unknown) => error instanceof Error && error.message === "Invalid SSH host provider" && !error.message.includes(secret),
  );

  const getterProvider = {
    async list() { return [{ id: "server-1", label: "Production", compatible: true as const }]; },
    async resolve() { return profile(); },
  };
  const getterRegistration = registerSshHostProvider(getterProvider);
  disposers.push(getterRegistration.dispose);
  Object.defineProperty(getterProvider, "list", { get() { throw new Error(secret); } });
  await assert.rejects(
    listSshHostRefs(),
    (error: unknown) => error instanceof SshHostProviderError
      && error.code === "provider-unavailable"
      && !error.message.includes(secret),
  );
  getterRegistration.dispose();

  const proxyRegistration = registerSshHostProvider({
    async list() {
      return new Proxy([{ id: "server-1", label: "Production", compatible: true as const }], {
        get(target, key, receiver) {
          if (key === "length") throw new Error(secret);
          return Reflect.get(target, key, receiver);
        },
      });
    },
    async resolve() {
      return new Proxy(profile(), { ownKeys() { throw new Error(secret); } });
    },
  });
  disposers.push(proxyRegistration.dispose);
  for (const pending of [listSshHostRefs(), resolveSshHostRef("server-1")]) {
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SshHostProviderError
        && error.code === "invalid-provider-result"
        && !error.message.includes(secret),
    );
  }
});

test("resolve rejects non-string references before provider invocation", async () => {
  let called = false;
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { called = true; return profile(); },
  });
  disposers.push(registration.dispose);

  await assert.rejects(resolveSshHostRef(42 as unknown as string), /SSH host reference is invalid/u);
  assert.equal(called, false);
});
