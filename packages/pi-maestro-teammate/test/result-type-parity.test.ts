import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/**
 * The two `SingleResult` declarations stay in step.
 *
 * The dispatch writes results through the backend contract's type and returns
 * them as this package's own. TypeScript accepts that — a wider object assigned
 * to a narrower type is legal — so a member the contract has and this package
 * lacks is populated at run time and invisible to every typed consumer. That is
 * how `backend` and `capabilityDeliveries` came to be written by the dispatch
 * and unreadable by anything downstream.
 *
 * Structural comparison rather than a type-level assertion, because the defect
 * is precisely that the type system accepts the mismatch.
 */

/** Member names declared on one `SingleResult` interface. */
function members(source: string): Set<string> {
  const body = source.match(/export interface SingleResult \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "SingleResult declaration not found");
  const names = new Set<string>();
  for (const match of body.matchAll(/^\s{2}(\w+)\??:/gm)) names.add(match[1]!);
  return names;
}

test("every member of the contract's SingleResult exists on the teammate one", () => {
  const contract = members(fs.readFileSync(
    new URL("../../pi-maestro-backend-core/src/public/v1/spec.ts", import.meta.url),
    "utf-8",
  ));
  const local = members(fs.readFileSync(
    new URL("../src/shared/types.ts", import.meta.url),
    "utf-8",
  ));
  const missing = [...contract].filter((name) => !local.has(name));
  assert.deepEqual(
    missing,
    [],
    "the dispatch can write these through the contract type, but no consumer of "
    + "runSingleTeammate's return type can read them",
  );
});
