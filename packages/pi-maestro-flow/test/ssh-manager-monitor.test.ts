import assert from "node:assert/strict";
import test from "node:test";
import type { SshExecuteOptions, SshConnectionTestResult } from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";
import { SshStatusMonitor, type SshStatusMonitorClock } from "../src/ssh-manager/status-monitor.ts";

const PIN = `SHA256:${"A".repeat(43)}`;

function host(id: string, overrides: Partial<SshHost> = {}): SshHost {
  return {
    id, label: id, host: `${id}.example`, user: "user", port: 22, shell: "bash",
    hostKey: PIN, auth: { kind: "password", password: "secret" }, tags: [],
    jumpHostId: null, monitorEnabled: true, ...overrides,
  };
}

class Source {
  locked = false;
  hosts: SshHost[] = [];
  digests = new Map<string, string>();
  getHosts(): SshHost[] { if (this.locked) throw new Error("locked"); return structuredClone(this.hosts); }
  checkoutKey(): never { throw new Error("unused"); }
  getEffectiveHostDigest(id: string): string {
    if (this.locked) throw new Error("locked");
    const digest = this.digests.get(id);
    if (!digest) throw new Error("missing");
    return digest;
  }
}

class FakeClock implements SshStatusMonitorClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.time = target;
  }
}

interface Call {
  id: string;
  signal: AbortSignal | undefined;
  resolve(value?: SshConnectionTestResult): void;
  reject(): void;
}

class FakeExecutor {
  calls: Call[] = [];
  testConnection(id: unknown, options: SshExecuteOptions = {}): Promise<SshConnectionTestResult> {
    return new Promise((resolve, reject) => this.calls.push({
      id: String(id), signal: options.signal,
      resolve: (value = {}) => resolve(value as SshConnectionTestResult),
      reject: () => reject(new Error("raw secret failure")),
    }));
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function fixture(hosts: SshHost[], options: { intervalMs?: number; timeoutMs?: number; concurrency?: number } = {}) {
  const source = new Source(); source.hosts = hosts;
  for (const value of hosts) source.digests.set(value.id, `digest-${value.id}`);
  const executor = new FakeExecutor();
  const clock = new FakeClock();
  const monitor = new SshStatusMonitor(source, executor, { clock, ...options });
  return { source, executor, clock, monitor };
}

test("reconcile exposes disabled/untrusted states and contacts only enabled pinned hosts immediately", async () => {
  const f = fixture([
    host("enabled"),
    host("disabled", { monitorEnabled: false }),
    host("untrusted", { hostKey: null }),
  ]);
  f.monitor.reconcile(); await flush();
  assert.deepEqual(f.monitor.getStatus("enabled"), { status: "checking", checkedAt: null });
  assert.deepEqual(f.monitor.getStatus("disabled"), { status: "disabled", checkedAt: null });
  assert.deepEqual(f.monitor.getStatus("untrusted"), { status: "untrusted", checkedAt: null });
  assert.deepEqual(f.executor.calls.map((call) => call.id), ["enabled"]);
  f.executor.calls[0]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-enabled" });
  await flush();
  assert.deepEqual(f.monitor.getStatus("enabled"), { status: "online", checkedAt: new Date(0).toISOString() });
});

test("periodic ticks are 60 seconds and never overlap a probe for the same host", async () => {
  const f = fixture([host("one")]);
  f.monitor.reconcile(); await flush();
  f.clock.advance(59_999); await flush();
  assert.equal(f.executor.calls.length, 1);
  f.clock.advance(1); await flush();
  assert.equal(f.executor.calls.length, 1);
  f.executor.calls[0]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-one" }); await flush();
  assert.equal(f.executor.calls.length, 2, "queued periodic probe starts only after prior probe settles");
  f.executor.calls[1]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-one" }); await flush();
});

test("global network concurrency is bounded at five", async () => {
  const f = fixture(Array.from({ length: 7 }, (_, index) => host(`h${index}`)));
  f.monitor.reconcile(); await flush();
  assert.equal(f.executor.calls.length, 5);
  f.executor.calls[0]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-h0" }); await flush();
  assert.equal(f.executor.calls.length, 6);
  f.executor.calls[1]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-h1" }); await flush();
  assert.equal(f.executor.calls.length, 7);
  for (const call of f.executor.calls.slice(2)) call.resolve({ fingerprint: PIN, effectiveDigest: `digest-${call.id}` });
  await flush();
});

test("digest changes and deletion discard late results after exact snapshot revalidation", async () => {
  const f = fixture([host("changed"), host("deleted")]);
  f.monitor.reconcile(); await flush();
  f.source.digests.set("changed", "new-digest");
  f.source.hosts = f.source.hosts.filter((value) => value.id !== "deleted");
  f.source.digests.delete("deleted");
  f.executor.calls.find((call) => call.id === "changed")!.resolve({ fingerprint: PIN, effectiveDigest: "digest-changed" });
  f.executor.calls.find((call) => call.id === "deleted")!.reject();
  await flush();
  assert.deepEqual(f.monitor.getStatus("changed"), { status: "checking", checkedAt: null });
  assert.deepEqual(f.monitor.getStatus("deleted"), { status: "checking", checkedAt: null });
});

test("reconcile generation aborts old probes and prevents their publication", async () => {
  const f = fixture([host("one")]);
  f.monitor.reconcile(); await flush();
  const old = f.executor.calls[0]!;
  f.source.digests.set("one", "replacement");
  f.monitor.reconcile(); await flush();
  assert.equal(old.signal?.aborted, true);
  assert.equal(f.executor.calls.length, 1, "same host remains excluded until aborted executor settles");
  old.resolve({ fingerprint: PIN, effectiveDigest: "digest-one" }); await flush();
  assert.equal(f.executor.calls.length, 2);
  assert.deepEqual(f.monitor.getStatus("one"), { status: "checking", checkedAt: null });
  f.executor.calls[1]!.resolve({ fingerprint: PIN, effectiveDigest: "replacement" }); await flush();
  assert.equal(f.monitor.getStatus("one")?.status, "online");
});

test("timeout publishes only offline status and retains overlap/concurrency fences until settlement", async () => {
  const f = fixture([host("slow")], { timeoutMs: 30_000 });
  f.monitor.reconcile(); await flush();
  f.clock.advance(30_000); await flush();
  assert.deepEqual(f.monitor.getStatus("slow"), { status: "offline", checkedAt: new Date(30_000).toISOString() });
  assert.deepEqual(Object.keys(f.monitor.getStatus("slow")!), ["status", "checkedAt"]);
  f.clock.advance(30_000); await flush();
  assert.equal(f.executor.calls.length, 1);
  assert.equal(f.executor.calls[0]!.signal?.aborted, true);
  f.executor.calls[0]!.reject(); await flush();
  assert.equal(f.executor.calls.length, 2);
  f.executor.calls[1]!.resolve({ fingerprint: PIN, effectiveDigest: "digest-slow" }); await flush();
});

test("lock and shutdown abort probes, cancel timers, clear state, and shutdown is final", async () => {
  const f = fixture([host("one")]);
  f.monitor.reconcile(); await flush();
  const first = f.executor.calls[0]!;
  f.monitor.lock();
  assert.equal(first.signal?.aborted, true);
  assert.equal(f.monitor.getStatuses().size, 0);
  f.clock.advance(120_000); await flush();
  assert.equal(f.executor.calls.length, 1);
  first.reject(); await flush();

  f.monitor.reconcile(); await flush();
  const second = f.executor.calls[1]!;
  f.monitor.shutdown();
  assert.equal(second.signal?.aborted, true);
  assert.equal(f.monitor.getStatuses().size, 0);
  second.reject(); await flush();
  f.monitor.reconcile(); f.clock.advance(120_000); await flush();
  assert.equal(f.executor.calls.length, 2);
});
