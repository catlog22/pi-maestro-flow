import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The sandbox must run the Pi build this repository pins, not whichever `pi`
 * happens to be first on PATH. Every piece of Pi-internal evidence behind the
 * segment-completion design was read from the pinned dist, so a silent version
 * swap invalidates that evidence chain without failing anything.
 */
test("sandbox pi binary resolves inside the repository", () => {
  const pinnedBin = new URL("../../../node_modules/.bin/pi", import.meta.url);
  assert.doesNotThrow(
    () => accessSync(pinnedBin, constants.X_OK),
    "the repository-pinned pi shim must exist and be executable; run npm install",
  );

  const script = readFileSync(new URL("../../../dev-local-pi.sh", import.meta.url), "utf8");
  assert.match(script, /PI_BIN="\$\{PI_MAESTRO_DEV_PI:-\$REPO_ROOT\/node_modules\/\.bin\/pi\}"/);
  assert.doesNotMatch(script, /packages\/pi-maestro-flow\/node_modules\/\.bin\/pi/);
});

test("sandbox pi fallback names both versions instead of falling back silently", () => {
  const script = readFileSync(new URL("../../../dev-local-pi.sh", import.meta.url), "utf8");
  assert.match(script, /differs from repo-pinned/);
  assert.match(script, /--require-pinned-pi/);
  assert.match(script, /REQUIRE_PINNED_PI=1/);
  // The strict flag must reject rather than warn.
  assert.match(script, /if \(\(REQUIRE_PINNED_PI\)\); then\s*\n\s*die "\$PI_VERSION_MESSAGE"/);
  // Every launch leaves the resolved binary and its version in the summary.
  assert.match(script, /pi:\s+\$PI_BIN \(\$ACTUAL_PI_VERSION, repo-pinned \$PINNED_PI_VERSION\)/);
});

test("the pinned pi shim resolves into the locked pi-coding-agent package", () => {
  const shimTarget = realpathSync(fileURLToPath(new URL("../../../node_modules/.bin/pi", import.meta.url)));
  assert.ok(
    shimTarget.includes(`@earendil-works${sep}pi-coding-agent${sep}`),
    `the pinned pi shim must point into the locked package, got ${shimTarget}`,
  );

  const pinned = JSON.parse(
    readFileSync(new URL("../../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.match(pinned.version, /^\d+\.\d+\.\d+/);
});
