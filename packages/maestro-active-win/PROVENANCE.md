# @dyw1234/active-win 9.0.1

Compatibility/security fork of Sindre Sorhus's MIT-licensed `active-win@9.0.0`.
The upstream author, license, repository, funding, README, public exports and
TypeScript declarations remain intact. `UPSTREAM.json` records the immutable
npm tarball, SHA-512 integrity, SHA-1 and upstream git identity.

All 12 upstream non-manifest files are byte-identical, including native Windows
source, `binding.gyp`, macOS executable `main`, platform loaders and the two
upstream macOS N-API 6 binaries. They are imported from the verified registry
tarball, not copied from an installed/generated native binding.

## Manifest changes

- Package identity: `@dyw1234/active-win@9.0.1`; Node floor: `>=22.19.0`.
- Optional native tooling pinned to `@mapbox/node-pre-gyp@2.0.3` and
  `node-gyp@12.4.0`; optional peer accepts `^12.4.0`. No node-gyp 13.
- `node-addon-api` remains `^8.0.0`.
- Direct runtime `tar: ^7.5.22` sets the patched floor without relying on
  package-level overrides being inherited. Verify every resolved tar copy in
  the fresh consumer graph; this declaration is not a whole-graph guarantee.
- Binary host, module name/path, package name and N-API 9 identity are unchanged;
  `remote_path: v9.0.0` deliberately uses upstream release assets, not v9.0.1.
- Removed obsolete development-only `node-pre-gyp-github` release tooling.
- Replace unshipped upstream test commands with focused fork contracts. Keep
  all native build/install commands. Include provenance in the published files.

## Focused verification

Run `node test/fetch-upstream.mjs`, then `node --test test/contracts.test.mjs`.
The fetcher verifies both pinned digests, reuses only a digest-verified archive,
extracts into ignored `.verification/upstream`, and never overwrites fork source.
`test/windows-consumer.cjs <isolated-consumer-directory>` asserts an actual
loadable native binding before checking all four asynchronous/synchronous APIs,
ESM and Node 22 CommonJS loading. It prints counts rather than window titles;
there are no activation or input actions.

Use an independently packed tarball in a fresh isolated consumer, install with
scripts, retain raw install/audit/dependency-tree logs, and separately force a
source build (`node-pre-gyp rebuild --build-from-source`). A missing Windows
compiler/SDK is a resource blocker, not grounds to claim fallback success.

No macOS or Linux native runner is available in this repair lane. Byte equality
and metadata checks do not constitute native tests on those systems. Platform
acceptance must be completed using real runners before claiming cross-platform
native compatibility. See `VERIFICATION.md` for this lane's actual results and
artifact locations. No publication, commit or root dependency integration is
performed here.
