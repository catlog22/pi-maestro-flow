import assert from "node:assert/strict";
import test from "node:test";
import { sanitizedChildEnvironment } from "pi-maestro-backends/child-env";

/**
 * The secret gate on `additions`, the channel a caller uses to state what one
 * child must see.
 *
 * The gate is closed by default and opened only by `allowSecretAdditions`, which
 * `targetChildEnvironment` sets because a target's forwarded names come from a
 * trusted, private configuration document. The closed default is what the ACP
 * terminal path relies on: there the additions come from the agent's
 * `createTerminal` request, so a credential-shaped name is either a mistake or
 * an attempt to hand the child something no configuration declared.
 */

test("a secret-shaped addition the caller did not declare is refused", () => {
  assert.throws(
    () => sanitizedChildEnvironment({
      source: {},
      additions: { PROBE_API_KEY: "sk-undeclared" },
    }),
    /PROBE_API_KEY is secret-bearing/,
  );
});

test("the same secret-shaped addition passes once the caller declares it", () => {
  // The contrast is the point: without it the refusal above would also pass for
  // a name the secret gate never matched.
  assert.deepEqual(
    sanitizedChildEnvironment({
      source: {},
      additions: { PROBE_API_KEY: "sk-undeclared" },
      allowSecretAdditions: true,
    }),
    { PROBE_API_KEY: "sk-undeclared" },
  );
});
