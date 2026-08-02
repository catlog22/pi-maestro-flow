import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = resolve(packageRoot, "src/public/v1");

function runtimeGraph(entry: string): { modules: Set<string>; externals: Set<string> } {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (modules.has(absolute)) return;
    modules.add(absolute);
    const source = readFileSync(absolute, "utf8");
    const statement = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:\{[^}]*\}|[^;\n{]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = statement.exec(source))) {
      if (match[1]) continue;
      const specifier = match[2];
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      visit(resolve(dirname(absolute), specifier));
    }
  };
  visit(entry);
  return { modules, externals };
}

test("every public v1 module has a package export", () => {
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  const exports = new Set(Object.values(packageJson.exports ?? {}));
  for (const file of ["events.ts", "provider.ts", "schema.ts", "i18n.ts", "index.ts"]) {
    assert.ok(exports.has(`./src/public/v1/${file}`), `${file} is missing a package export`);
  }
});

test("narrow public modules have no external runtime dependencies", () => {
  for (const file of ["events.ts", "provider.ts", "schema.ts", "i18n.ts"]) {
    const graph = runtimeGraph(resolve(publicRoot, file));
    assert.deepEqual([...graph.externals], [], `${file} must stay runtime dependency-free`);
  }
});
