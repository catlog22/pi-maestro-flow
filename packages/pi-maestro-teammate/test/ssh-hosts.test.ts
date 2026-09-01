import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SshHostProfile } from "pi-maestro-backend-core/v1/ssh";
import {
  SshHostProviderError,
  getSshHostProvider,
  listSshHostRefs,
  registerSshHostProvider,
  resolveSshHostRef,
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
