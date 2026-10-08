# Repair lane verification — 2026-10-08

## Result

Implementation is deliverable; native acceptance is **resource-blocked** for
Node 22.19.0 and for macOS/Linux. Do not claim cross-platform or minimum-Node
native success. Windows x64 on Node 22.22.0 passed real fresh-install and native
source-build checks. No input actions, publication, commit, push, global update,
root install or root manifest/lock edit was performed by this lane.

Pre-write baseline was clean at `a5a07b54c3ff850dbf196224e8f759b047ada986`.
`npm view @dyw1234/active-win@9.0.1 version --registry=https://registry.npmjs.org`
returned E404 before source import (00:51 UTC): target unoccupied at that time,
not a reservation. Recheck before later publication.

Knowledge gate: `maestro search "active-win native tooling node-pre-gyp security"`,
`maestro search active-win`, and `maestro load --type spec --category coding` ran
before editing. No relevant active-win repair guidance was returned. Read three
relevant API patterns: upstream public dispatch/types, Windows pre-gyp native
binding and async/sync exports, and Flow's optional loader + `openWindows` /
`activeWindowSync` consumption. Flow consumer source was read-only.

## Commands and actual outcomes

All paths below are relative to `packages/maestro-active-win` unless stated.
Raw artifacts are ignored in `.verification`, not included in npm output.

| Command / working directory | Outcome | Raw evidence |
| --- | --- | --- |
| `node test/fetch-upstream.mjs` (lane) | PASS, immutable SHA-512 + SHA-1 | `.verification/logs/upstream.log` and `.verification/upstream/active-win-9.0.0.tgz` |
| `node --test test/contracts.test.mjs` (lane, actual Node 22.22.0) | PASS 4/4; all 12 upstream non-manifest files identical; exact manifest delta; JS syntax | `.verification/logs/contracts-node22.22.log` |
| `npm pack --workspaces=false --json --pack-destination .verification/pack` (lane) | PASS; 15 files; no test/build/log artifacts | `.verification/logs/pack.json` |
| `npm install --workspaces=false --omit=dev --foreground-scripts --loglevel=verbose --registry=https://registry.npmjs.org` (`.verification/consumer`) | PASS, actual lifecycle downloaded upstream `v9.0.0/napi-9-win32-unknown-x64.tar.gz` | `.verification/logs/install-node22.22.log` |
| `node test/windows-consumer.cjs .verification/consumer` (lane) | PASS; actual binding, ESM + CommonJS, all four APIs; 23 windows, active present; 0 input actions | `.verification/logs/apis-node22.22.json` |
| `npm ls --all --workspaces=false --json` / `npm audit --omit=dev --workspaces=false --json --registry=https://registry.npmjs.org` (`.verification/consumer`) | PASS, audit total 0 | `.verification/logs/tree-initial-node22.22.json`, `audit-initial-node22.22.json` |
| `npm_config_build_from_source=true npm install --workspaces=false --omit=dev --foreground-scripts --loglevel=verbose --registry=https://registry.npmjs.org` (`.verification/fallback`) | PASS, independent empty consumer source compile; MSVC 2022 + Python 3.14.2 | `.verification/logs/install-fallback-node22.22.log` |
| `npm_config_node_gyp=<absolute consumer node-gyp/bin/node-gyp.js> node ../../@mapbox/node-pre-gyp/bin/node-pre-gyp rebuild --build-from-source --loglevel=verbose` (`.verification/fallback/node_modules/@dyw1234/active-win`) | PASS on attempt 2 with **node-gyp 12.4.0**, 0 compile errors, 5 unchanged upstream warnings | `.verification/logs/rebuild-explicit-node-gyp12.4-node22.22-attempt2.log` |
| `node test/windows-consumer.cjs .verification/fallback` (lane, after explicit 12.4.0 rebuild) | PASS, actual newly compiled binding and all four APIs | `.verification/logs/apis-explicit-node-gyp12.4-node22.22.json` |
| `node test/dependency-graph.cjs .verification/fallback` (lane) | PASS; pre-gyp 2.0.3, gyp 12.4.0, addon-api 8.9.2; only tar 7.5.22; legacy install-chain modules absent | `.verification/logs/graph-fallback-node22.22.json` |
| final `npm ls --all --workspaces=false --json` / `npm audit --omit=dev --workspaces=false --json --registry=https://registry.npmjs.org` (`.verification/fallback`) | PASS, audit total 0 | `.verification/logs/tree-final-fallback-node22.22.json`, `audit-final-fallback-node22.22.json` |

The independently built consumer explicitly requires `node-gyp@12.4.0` to keep
npm from silently dropping it as optional. The first prebuilt consumer install
silently removed optional node-gyp during fetching; the prebuilt native module
still loaded. The first source-install lifecycle used npm 11.7.0's inherited
`npm_config_node_gyp` and selected npm-bundled **12.1.0**, NOT the declared 12.4.0.
Therefore it is not used as 12.4.0 proof. The separate explicit rebuild selected
12.4.0 and passed. This fork cannot upgrade an externally supplied npm toolchain;
consumers requiring the patched build tool must select the installed 12.4.0.
No global npm changes were made.

Explicit rebuild attempt 1 compiled successfully but pre-gyp's post-build rename
failed with Windows EPERM. An unchanged retry passed. Both logs are retained.
Original importer attempt 1 hit GNU tar's Windows drive-colon interpretation;
using extraction working-directory + relative archive fixed it. A subsequent
network ECONNRESET was avoided by reusing only the already digest-verified tgz.

## Minimum Node acquisition blocker (three attempts, stopped)

1. Isolated `npm install` of `node@22.19.0`: nested architecture fetch ECONNRESET;
   no runner obtained. `.verification/logs/install-min-node-runner.log`.
2. Same isolated install retry: incomplete Windows executable download, still
   running after several minutes; job was terminated. No partial binary was run.
   `.verification/logs/install-min-node-runner-attempt2.log`.
3. Official HTTPS ZIP acquisition:
   `curl --fail --location --connect-timeout 15 --max-time 120 --output node-v22.19.0-win-x64.zip https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip`
   timed out with curl 28 after **2,079,488 / 35,424,607 bytes**. Official SHA-256
   expected `ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86`;
   partial file hash `d25f7cab6886780ce612365ea7f35b141de8888b52cc908cfe5db2999934caf1`.
   The enclosing shell ended 0 because later checksum-list commands succeeded;
   this is **NOT a successful download/test**. Raw curl failure is in
   `.verification/logs/download-min-node-official.log`; checksums/partial ZIP are
   in `.verification/min-node`. No extraction or execution of partial ZIP.

Node floor is enforced by manifest contract, not claimed as a native test.
Needed resource: complete trusted Windows x64 Node 22.19.0 runner. Then repeat
focused contracts and tarball consumer install/APIs with its executable/PATH.
macOS/Linux native runners (and required permissions/display resources) are also
absent. Static upstream byte equality is not a substitute.

## Artifact identity and recovery

Consumer-tested tarball:
`.verification/pack/dyw1234-active-win-9.0.1.tgz` (61,704 bytes), integrity
`sha512-kxQ6JSLQd+HpuH14C7dAnx7XqtZAVe2/y9gUgiwcVeObP72kAenRy8b4BFz6U8j2pTDFAP575B54Byle6KkNfA==`.
Adding excluded test/report files does not change its contents. Preserve or copy
ignored raw artifacts before cleaning this worktree. Exact new-source patch and
file hashes are recorded in `.verification/source.patch` and
`.verification/source-files.json`; upstream manifest-only delta is
`.verification/upstream-manifest.patch`.

Recovery: obtain missing runners, execute actual native acceptance without input
injection, and re-audit fresh packed consumer graphs. Later root-owned tasks
perform whole-graph integration/tar locking/review and publication authorization.
Concurrent root/other-lane dirty files were observed and left untouched.
