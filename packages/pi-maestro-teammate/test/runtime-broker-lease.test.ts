import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RuntimeBrokerError } from "../src/runtime-broker/contracts.ts";
import { RuntimeBrokerLeaseManager } from "../src/runtime-broker/lease-manager.ts";
import { RuntimeBrokerSqliteStore } from "../src/runtime-broker/sqlite-store.ts";

function hasCode(code: RuntimeBrokerError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RuntimeBrokerError && error.code === code;
}

test("lease acquire, heartbeat, CAS, release, and takeover preserve fencing epochs", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-"));
  let nonce = 0;
  let now = 100;
  const store = new RuntimeBrokerSqliteStore(join(directory, "broker.sqlite"), {
    now: () => now,
    nonce: () => `nonce-${++nonce}`,
  });
  const leases = new RuntimeBrokerLeaseManager(store);
  try {
    const first = leases.acquire({ actorId: "actor-1", holderId: "holder-1", ttlMs: 100, now: 900_000 });
    assert.deepEqual(first, {
      actorId: "actor-1",
      streamId: "actor-1",
      holderId: "holder-1",
      epoch: 1,
      nonce: "nonce-1",
      acquiredAt: 100,
      heartbeatAt: 100,
      expiresAt: 200,
    });
    now = 150;
    assert.throws(
      () => leases.acquire({ actorId: "actor-1", holderId: "holder-2", ttlMs: 100, now: 900_000 }),
      hasCode("lease_unavailable"),
    );

    const heartbeat = leases.heartbeat({ actorId: "actor-1", lease: first, ttlMs: 100, now: 1 });
    assert.equal(heartbeat.epoch, first.epoch);
    assert.equal(heartbeat.nonce, first.nonce);
    assert.equal(heartbeat.expiresAt, 250);
    assert.deepEqual(store.readEvents("actor-1"), []);

    now = 160;
    const second = leases.compareAndSwap({
      actorId: "actor-1",
      lease: first,
      nextHolderId: "holder-2",
      ttlMs: 100,
      now: 900_000,
    });
    assert.equal(second.epoch, 2);
    assert.equal(second.nonce, "nonce-2");
    assert.equal(second.holderId, "holder-2");
    now = 170;
    assert.throws(
      () => leases.heartbeat({ actorId: "actor-1", lease: first, ttlMs: 100, now: 1 }),
      hasCode("stale_lease"),
    );

    leases.release({ actorId: "actor-1", lease: second, now: 900_000 });
    const third = leases.takeover({ actorId: "actor-1", holderId: "holder-3", ttlMs: 100, now: 1 });
    assert.equal(third.epoch, 3);
    assert.equal(third.nonce, "nonce-3");
    now = 200;
    assert.throws(
      () => leases.takeover({ actorId: "actor-1", holderId: "holder-4", ttlMs: 100, now: 900_000 }),
      hasCode("lease_unavailable"),
    );

    now = 270;
    const fourth = leases.acquire({ actorId: "actor-1", holderId: "holder-4", ttlMs: 100, now: 1 });
    assert.equal(fourth.epoch, 4);
    assert.equal(fourth.nonce, "nonce-4");
    assert.deepEqual(leases.current("actor-1"), fourth);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one stream has one live actor authority and expired ownership rotates its epoch", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-stream-"));
  let now = 100;
  const store = new RuntimeBrokerSqliteStore(join(directory, "broker.sqlite"), { now: () => now });
  const leases = new RuntimeBrokerLeaseManager(store);
  try {
    const first = leases.acquire({ actorId: "actor-a", streamId: "stream-shared", holderId: "holder-a", ttlMs: 100 });
    assert.throws(
      () => leases.acquire({ actorId: "actor-b", streamId: "stream-shared", holderId: "holder-b", ttlMs: 100 }),
      hasCode("lease_unavailable"),
    );
    now = 200;
    const second = leases.acquire({ actorId: "actor-b", streamId: "stream-shared", holderId: "holder-b", ttlMs: 100 });
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(store.getLease("actor-a"), undefined);
    assert.deepEqual(store.getLease("actor-b"), second);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease request receipts recover lost acquire, CAS, and takeover responses exactly", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-receipts-"));
  const path = join(directory, "broker.sqlite");
  let now = 100;
  let nonce = 0;
  let store = new RuntimeBrokerSqliteStore(path, {
    now: () => now,
    nonce: () => `receipt-nonce-${++nonce}`,
  });
  try {
    const acquireRequest = { actorId: "actor", streamId: "stream", holderId: "holder-a", ttlMs: 100 };
    const acquired = store.acquireLease(acquireRequest, "lost-acquire");
    assert.deepEqual(store.acquireLease(acquireRequest, "lost-acquire"), acquired);
    assert.equal(nonce, 1);
    assert.throws(
      () => store.acquireLease({ ...acquireRequest, holderId: "different" }, "lost-acquire"),
      hasCode("idempotency_conflict"),
    );

    const casRequest = { actorId: "actor", lease: acquired, nextHolderId: "holder-b", ttlMs: 100 };
    const swapped = store.compareAndSwapLease(casRequest, "lost-cas");
    assert.deepEqual(store.compareAndSwapLease(casRequest, "lost-cas"), swapped);
    assert.equal(nonce, 2);

    store.releaseLease({ actorId: "actor", lease: swapped }, "release-before-takeover");
    const takeoverRequest = { actorId: "actor", streamId: "stream", holderId: "holder-c", ttlMs: 100 };
    const taken = store.takeoverLease(takeoverRequest, "lost-takeover");
    store.close();
    store = new RuntimeBrokerSqliteStore(path, {
      now: () => now,
      nonce: () => `receipt-nonce-${++nonce}`,
    });
    assert.deepEqual(store.takeoverLease(takeoverRequest, "lost-takeover"), taken);
    assert.equal(nonce, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease receipt pruning enforces configured bounded capacity", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-receipt-capacity-"));
  const path = join(directory, "broker.sqlite");
  const store = new RuntimeBrokerSqliteStore(path, { now: () => 100, receiptCapacity: 2 });
  try {
    for (let index = 0; index < 3; index += 1) {
      store.acquireLease({
        actorId: `actor-${index}`,
        streamId: `stream-${index}`,
        holderId: "holder",
        ttlMs: 100,
      }, `request-${index}`);
    }
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM mutation_receipts").get()!.count, 2);
      assert.equal(inspection.prepare("SELECT 1 FROM mutation_receipts WHERE request_id = 'request-0'").get(), undefined);
    } finally {
      inspection.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persisted logical time preserves remaining TTL across wall-clock rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-clock-"));
  const path = join(directory, "broker.sqlite");
  let wallNow = 1_000;
  let monotonicNow = 0;
  let store = new RuntimeBrokerSqliteStore(path, { now: () => wallNow, monotonicNow: () => monotonicNow });
  try {
    const first = store.acquireLease({ actorId: "actor-a", streamId: "stream", holderId: "holder-a", ttlMs: 100 });
    assert.equal(first.expiresAt, 1_100);
    store.close();

    wallNow = 500;
    monotonicNow = 0;
    store = new RuntimeBrokerSqliteStore(path, { now: () => wallNow, monotonicNow: () => monotonicNow });
    assert.throws(
      () => store.takeoverLease({ actorId: "actor-b", streamId: "stream", holderId: "holder-b", ttlMs: 100 }),
      hasCode("lease_unavailable"),
    );
    monotonicNow = 99;
    assert.throws(
      () => store.takeoverLease({ actorId: "actor-b", streamId: "stream", holderId: "holder-b", ttlMs: 100 }),
      hasCode("lease_unavailable"),
    );
    store.close();
    monotonicNow = 0;
    store = new RuntimeBrokerSqliteStore(path, { now: () => wallNow, monotonicNow: () => monotonicNow });
    assert.throws(
      () => store.takeoverLease({ actorId: "actor-b", streamId: "stream", holderId: "holder-b", ttlMs: 100 }),
      hasCode("lease_unavailable"),
    );
    monotonicNow = 1;
    const second = store.takeoverLease({ actorId: "actor-b", streamId: "stream", holderId: "holder-b", ttlMs: 100 });
    assert.equal(second.acquiredAt, 1_100);
    assert.equal(second.epoch, first.epoch + 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("client-provided future timestamps cannot force lease takeover", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-future-"));
  let now = 100;
  const store = new RuntimeBrokerSqliteStore(join(directory, "broker.sqlite"), { now: () => now });
  const leases = new RuntimeBrokerLeaseManager(store);
  try {
    const lease = leases.acquire({ actorId: "actor-1", holderId: "holder-1", ttlMs: 100, now: 1_000_000 });
    assert.equal(lease.expiresAt, 200);
    now = 150;
    assert.throws(
      () => leases.takeover({ actorId: "actor-1", holderId: "holder-2", ttlMs: 100, now: 1_000_000 }),
      hasCode("lease_unavailable"),
    );
    assert.deepEqual(leases.current("actor-1"), lease);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lease expiry and nonce mismatches fail closed using broker time", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-broker-lease-stale-"));
  let now = 10;
  const store = new RuntimeBrokerSqliteStore(join(directory, "broker.sqlite"), { now: () => now });
  const leases = new RuntimeBrokerLeaseManager(store);
  try {
    const lease = leases.acquire({ actorId: "actor-1", holderId: "holder-1", ttlMs: 10, now: 50_000 });
    now = 15;
    assert.throws(
      () => leases.release({ actorId: "actor-1", lease: { ...lease, nonce: "wrong" }, now: 1 }),
      hasCode("stale_lease"),
    );
    now = 20;
    assert.throws(
      () => leases.heartbeat({ actorId: "actor-1", lease, ttlMs: 10, now: 1 }),
      hasCode("stale_lease"),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
