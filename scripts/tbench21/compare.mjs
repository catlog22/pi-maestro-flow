#!/usr/bin/env node
// A/B compare: harness (pi + pi-maestro-flow) vs vanilla (bare pi) on the same tasks
// Usage: node scripts/tbench21/compare.mjs <harness.jsonl> <vanilla.jsonl>
import fs from "node:fs";

function load(path) {
  if (!fs.existsSync(path)) {
    console.error(`no results file: ${path}`);
    process.exit(1);
  }
  const byTask = new Map();
  for (const l of fs.readFileSync(path, "utf-8").split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(l);
      if (o.task) byTask.set(o.task, o);
    } catch {}
  }
  return [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task));
}

const hPath = process.argv[2] || ".cache/tb21-ab/harness/results.jsonl";
const vPath = process.argv[3] || ".cache/tb21-ab/vanilla/results.jsonl";
const h = load(hPath);
const v = load(vPath);
const vBy = new Map(v.map((r) => [r.task, r]));

const score = (r) => (r.status === "pass" ? 1 : 0);
const stat = (a) => {
  const s = { pass: 0, fail: 0, timeout: 0, error: 0 };
  for (const r of a) s[r.status] = (s[r.status] || 0) + 1;
  return s;
};

const sh = stat(h), sv = stat(v);
const acc = (s, n) => (n ? ((s.pass / n) * 100).toFixed(1) : "0");
const n = Math.max(h.length, v.length);

console.log(`\n== harness vs vanilla A/B (same tasks, same model) ==`);
console.log(`model=${h[0]?.model || "?"} thinking=${h[0]?.thinking || "?"}`);
console.log(`harness: ${acc(sh, h.length)}% (${sh.pass}/${h.length})   vanilla: ${acc(sv, v.length)}% (${sv.pass}/${v.length})\n`);

console.log("task".padEnd(40) + "harness".padEnd(10) + "vanilla".padEnd(10) + "delta");
let hWin = 0, vWin = 0, tie = 0;
for (const r of h) {
  const rr = vBy.get(r.task);
  if (!rr) continue;
  const hs = r.status, vs = rr.status;
  const hOk = hs === "pass" ? "PASS" : hs.toUpperCase().padEnd(4);
  const vOk = vs === "pass" ? "PASS" : vs.toUpperCase().padEnd(4);
  const d = score(r) - score(rr);
  if (d > 0) hWin++; else if (d < 0) vWin++; else tie++;
  console.log(
    r.task.padEnd(40) +
    hOk.padEnd(10) + vOk.padEnd(10) +
    (d > 0 ? "+1" : d < 0 ? "-1" : "  ")
  );
}

console.log(`\nharness better: ${hWin}   vanilla better: ${vWin}   tie: ${tie}`);
console.log(`avg duration: harness ${(h.reduce((s, r) => s + r.duration_ms, 0) / h.length / 1000).toFixed(0)}s  vanilla ${(v.reduce((s, r) => s + r.duration_ms, 0) / v.length / 1000).toFixed(0)}s`);
