#!/usr/bin/env node
// Materialize pi-maestro-settings-core into the package being packed so npm
// includes it in the tarball (bundledDependencies). npm only bundles deps
// present in the package's own node_modules; workspace hoisting keeps them at
// the repo root, so pack would otherwise omit the shared settings protocol.
// Run from a package directory: node ../../scripts/bundle-settings-core.mjs
// (npm runs prepack/postpack with cwd = package root). Use --clean to remove it.
import { existsSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "packages", "pi-maestro-settings-core");
const target = join(process.cwd(), "node_modules", "pi-maestro-settings-core");
const clean = process.argv.includes("--clean");

if (clean) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  process.exit(0);
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
if (!existsSync(source)) {
  console.error(`bundle-settings-core: missing source ${source}`);
  process.exit(1);
}
cpSync(source, target, { recursive: true });
console.log(`bundle-settings-core: materialized ${target}`);
