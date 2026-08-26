import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
