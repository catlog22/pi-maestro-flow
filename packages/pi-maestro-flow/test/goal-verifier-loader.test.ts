import assert from "node:assert/strict";
import test from "node:test";
import { afterEach } from "node:test";
import {
  getRunTeammate,
  setGoalVerifierModuleLoaderForTest,
  type RunTeammateFn,
} from "../src/tools/goal-verification.ts";

function moduleNotFoundError(): NodeJS.ErrnoException {
  const error = new Error("Cannot find module 'pi-maestro-teammate/v1/execution'") as NodeJS.ErrnoException;
  error.code = "MODULE_NOT_FOUND";
  return error;
}

const fakeRunner: RunTeammateFn = async () => [] as never;

afterEach(() => {
  setGoalVerifierModuleLoaderForTest(undefined);
});

test("module-not-found is not cached: a later successful import re-enables the verifier", async () => {
  let loads = 0;
  setGoalVerifierModuleLoaderForTest(async () => {
    loads++;
    throw moduleNotFoundError();
  });

  assert.equal(await getRunTeammate(), undefined);
  assert.equal(await getRunTeammate(), undefined);
  assert.equal(loads, 2, "each call must re-import after a transient module-not-found");

  // The companion package becomes resolvable (e.g. after registration): the
  // next completion must pick it up without a host restart.
  setGoalVerifierModuleLoaderForTest(async () => {
    loads++;
    return { runTeammate: fakeRunner };
  });
  assert.equal(await getRunTeammate(), fakeRunner);
  assert.equal(loads, 3);

  // Success is cached: no further import.
  assert.equal(await getRunTeammate(), fakeRunner);
  assert.equal(loads, 3);
});

test("a resolved module without runTeammate is not cached", async () => {
  let loads = 0;
  setGoalVerifierModuleLoaderForTest(async () => {
    loads++;
    return { runTeammate: undefined };
  });

  assert.equal(await getRunTeammate(), undefined);
  assert.equal(await getRunTeammate(), undefined);
  assert.equal(loads, 2);
});

test("non-module errors propagate and are not cached", async () => {
  let loads = 0;
  setGoalVerifierModuleLoaderForTest(async () => {
    loads++;
    throw new Error("boom");
  });

  await assert.rejects(() => getRunTeammate(), /boom/);
  await assert.rejects(() => getRunTeammate(), /boom/);
  assert.equal(loads, 2);
});

test("setGoalVerifierModuleLoaderForTest(undefined) restores the real import path", async () => {
  setGoalVerifierModuleLoaderForTest(async () => ({ runTeammate: fakeRunner }));
  assert.equal(await getRunTeammate(), fakeRunner);

  setGoalVerifierModuleLoaderForTest(undefined);
  const restored = await getRunTeammate();
  assert.equal(typeof restored, "function", "the real pi-maestro-teammate module must resolve");
});
