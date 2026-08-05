#!/usr/bin/env node
// tbench21 eval summary: aggregate results.jsonl -> per-task table + accuracy
// Usage: node scripts/tbench21/summary.mjs [results.jsonl]
import fs from "node:fs";

const jsonl = process.argv[2] || ".cache/tb21-pibench/results.jsonl";
if (!fs.existsSync(jsonl)) {
  console.error(`no results file: ${jsonl}`);
  process.exit(1);
}

const lines = fs.readFileSync(jsonl, "utf-8").split("\n").filter(Boolean);
const recs = [];
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    if (o.task) recs.push(o);
  } catch {}
}

const order = { pass: 0, fail: 1, timeout: 2, error: 3 };
// dedupe: keep the LAST record per task (reruns supersede earlier crash-fails)
const byTask = new Map();
for (const r of recs) byTask.set(r.task, r);
const final = [...byTask.values()];
final.sort((a, b) => a.task.localeCompare(b.task));

const byStatus = { pass: 0, fail: 0, timeout: 0, error: 0 };
let totalMs = 0;
for (const r of final) { byStatus[r.status] = (byStatus[r.status] || 0) + 1; totalMs += r.duration_ms; }

console.log(`\n== Terminal-Bench style eval (via pi harness) — ${final.length} tasks ==`);
console.log(`model=${final[0]?.model || "?"} thinking=${final[0]?.thinking || "?"}\n`);
console.log("task".padEnd(42) + "status".padEnd(9) + "dur(s)".padEnd(8) + "verify-first-line");
for (const r of final) {
  const first = (r.verify_output || "").split("\n")[0].slice(0, 70) || "-";
  console.log(
    r.task.padEnd(42) + r.status.padEnd(9) + (r.duration_ms / 1000).toFixed(1).padEnd(8) + first
  );
}

const n = final.length;
const acc = n ? ((byStatus.pass / n) * 100).toFixed(1) : "0";
console.log(`\naccuracy: ${byStatus.pass}/${n} = ${acc}%   (fail=${byStatus.fail} timeout=${byStatus.timeout} error=${byStatus.error})`);
console.log(`avg duration: ${(totalMs / 1000 / Math.max(n, 1)).toFixed(0)}s/task  total: ${(totalMs / 1000 / 60).toFixed(1)}min`);
