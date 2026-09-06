import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  openTeammateRemoteChannel,
  registerSshHostProvider,
  SshHostProviderError,
  TEAMMATE_REMOTE_GATEWAY_COMMAND,
} from "pi-maestro-teammate/v1/ssh-hosts";
import {
  TeammateRemoteChannelBroker,
  sshHostReferenceIssue,
} from "../src/ssh-manager/remote-channel.ts";
import type { SshCommandChannel } from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const compatibleHost: SshHost = {
  id: "server-1",
  label: "Production",
  host: "secret-host.example.test",
  user: "secret-user",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "agent" },
  tags: [],
  jumpHostId: null,
  monitorEnabled: false,
};

class FakeStore {
  locked = false;
  revision = 4;
  hosts: SshHost[] = [compatibleHost];
  digest = "d".repeat(64);
  reloadCount = 0;
  onReload?: (count: number) => void;
  async reload(): Promise<void> {
    this.reloadCount++;
    this.onReload?.(this.reloadCount);
  }
  getHosts(): SshHost[] { return this.hosts.map((host) => structuredClone(host)); }
  getEffectiveHostDigest(hostId: string): string {
    if (!this.hosts.some((host) => host.id === hostId)) throw new Error("missing secret-host.example.test");
    return this.digest;
  }
}

function fakeChannel(digest = "d".repeat(64)): SshCommandChannel & { closeCount: number } {
  const channel = new PassThrough() as PassThrough & { stderr: PassThrough };
  channel.stderr = new PassThrough();
  const result = {
    channel: channel as SshCommandChannel["channel"],
    effectiveDigest: digest,
    closeCount: 0,
    close() {
      result.closeCount++;
      channel.destroy();
      channel.stderr.destroy();
    },
  };
  return result;
}

function assertProviderCode(code: SshHostProviderError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SshHostProviderError && error.code === code;
}

test("broker opens only the fixed teammate command and returns bounded non-secret metadata", async () => {
  const store = new FakeStore();
  const opened = fakeChannel();
  const calls: unknown[] = [];
  const broker = new TeammateRemoteChannelBroker(store, {
    async openChannel(hostRef, request, options) {
      calls.push({ hostRef, request, signal: options?.signal instanceof AbortSignal });
      return opened;
    },
  });
  const handle = await broker.open("server-1");
  assert.deepEqual(calls, [{
    hostRef: "server-1",
    request: { command: TEAMMATE_REMOTE_GATEWAY_COMMAND },
    signal: true,
  }]);
  assert.equal(handle.stream, opened.channel);
  assert.equal(handle.digest, store.digest);
  assert.equal(handle.fence, `${store.revision}:${store.digest}`);
  assert.doesNotMatch(JSON.stringify({ fence: handle.fence, digest: handle.digest }), /secret-host|secret-user|SHA256/u);
  handle.close();
});

test("broker rejects locked, missing, and teammate-incompatible hosts before execution", async () => {
  const cases: Array<{ mutate(store: FakeStore): void; code: SshHostProviderError["code"] }> = [
    { mutate: (store) => { store.locked = true; }, code: "manager-locked" },
    { mutate: (store) => { store.hosts = []; }, code: "host-not-found" },
    { mutate: (store) => { store.hosts = [{ ...compatibleHost, shell: "powershell" }]; }, code: "host-incompatible" },
    { mutate: (store) => { store.hosts = [{ ...compatibleHost, auth: { kind: "password", password: "do-not-leak" } }]; }, code: "host-incompatible" },
  ];
  for (const entry of cases) {
    const store = new FakeStore();
    entry.mutate(store);
    let executions = 0;
    const broker = new TeammateRemoteChannelBroker(store, {
      async openChannel() { executions++; return fakeChannel(); },
    });
    await assert.rejects(broker.open("server-1"), assertProviderCode(entry.code));
    assert.equal(executions, 0);
  }
  assert.equal(sshHostReferenceIssue({ ...compatibleHost, hostKey: null }), "untrusted-host");
});

test("broker closes and rejects a channel when revision, digest, or executor fences race", async () => {
  for (const race of ["revision", "digest", "executor-digest"] as const) {
    const store = new FakeStore();
    const opened = fakeChannel(race === "executor-digest" ? "e".repeat(64) : store.digest);
    if (race !== "executor-digest") {
      store.onReload = (count) => {
        if (count === 2) {
          if (race === "revision") store.revision++;
          else store.digest = "f".repeat(64);
        }
      };
    }
    const broker = new TeammateRemoteChannelBroker(store, {
      async openChannel() { return opened; },
    });
    await assert.rejects(broker.open("server-1"), assertProviderCode("refresh-failed"));
    assert.equal(opened.closeCount, 1, `${race} closes the raced channel`);
  }
});

test("broker rejects channels closed during fencing without releasing another channel's admission", async () => {
  const store = new FakeStore();
  const active = fakeChannel();
  const raced = fakeChannel();
  const replacement = fakeChannel();
  let calls = 0;
  const broker = new TeammateRemoteChannelBroker(store, {
    async openChannel() {
      calls += 1;
      return calls === 1 ? active : calls === 2 ? raced : replacement;
    },
  }, { maxPerHost: 2 });

  const activeHandle = await broker.open("server-1");
  store.onReload = (count) => {
    if (count === 4) raced.channel.destroy();
  };
  await assert.rejects(broker.open("server-1"), assertProviderCode("refresh-failed"));
  assert.equal(raced.closeCount, 1);

  store.onReload = undefined;
  const replacementHandle = await broker.open("server-1");
  await assert.rejects(broker.open("server-1"), assertProviderCode("provider-unavailable"));
  assert.equal(calls, 3, "the raced admission must not free the still-active channel's slot");

  activeHandle.close();
  replacementHandle.close();
  assert.equal(active.closeCount, 1);
  assert.equal(replacement.closeCount, 1);
});

test("broker bounds per-host and global admission and idempotent close releases capacity", async () => {
  const second = { ...compatibleHost, id: "server-2", label: "Staging" };
  const store = new FakeStore();
  store.hosts = [compatibleHost, second];
  const channels: Array<ReturnType<typeof fakeChannel>> = [];
  const broker = new TeammateRemoteChannelBroker(store, {
    async openChannel() {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    },
  }, { maxPerHost: 1, maxGlobal: 2 });

  const first = await broker.open("server-1");
  await assert.rejects(broker.open("server-1"), assertProviderCode("provider-unavailable"));
  const secondHandle = await broker.open("server-2");
  await assert.rejects(broker.open("server-1"), assertProviderCode("provider-unavailable"));
  first.close();
  first.close();
  assert.equal(channels[0]!.closeCount, 1);
  const replacement = await broker.open("server-1");
  replacement.close();
  secondHandle.close();
});

test("connect abort applies only through handoff while broker shutdown closes live channels", async () => {
  const store = new FakeStore();
  const channels: Array<ReturnType<typeof fakeChannel>> = [];
  const broker = new TeammateRemoteChannelBroker(store, {
    async openChannel() {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    },
  });
  const abort = new AbortController();
  const first = await broker.open("server-1", abort.signal);
  abort.abort();
  assert.equal(channels[0]!.closeCount, 0, "post-handoff abort must not close an established channel");
  first.close();
  assert.equal(channels[0]!.closeCount, 1);

  await broker.open("server-1");
  broker.close();
  broker.close();
  assert.equal(channels[1]!.closeCount, 1);
  await assert.rejects(broker.open("server-1"), assertProviderCode("provider-unavailable"));
});

test("provider boundary redacts executor failures and registration disposal plus shutdown are safe", async () => {
  const store = new FakeStore();
  const sentinel = "PASSWORD-private-key-secret-host.example.test";
  const broker = new TeammateRemoteChannelBroker(store, {
    async openChannel() { throw new Error(sentinel); },
  });
  const registration = registerSshHostProvider({
    async list() { return []; },
    async resolve() { throw new Error("unused"); },
    openTeammateRemoteChannel: (hostRef, signal) => broker.open(hostRef, signal),
  });
  try {
    await assert.rejects(openTeammateRemoteChannel("server-1"), (error: unknown) => {
      assert.ok(error instanceof SshHostProviderError);
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    });
    broker.close();
  } finally {
    registration.dispose();
  }
  assert.equal(await openTeammateRemoteChannel("server-1"), undefined);
});
