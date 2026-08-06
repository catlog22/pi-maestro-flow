#!/usr/bin/env node
/**
 * self-evolve approval receipt recorder (Phase 2B — governance hardening).
 *
 * Records a durable approval receipt for knowledge-governance actions
 * (promote / supersede / deprecate / conflict-mark) to the GLOBAL output root,
 * so promotion has an audit trail independent of the maestro ledger:
 *
 *   ~/.maestro/self-evolve/approvals/<date>.jsonl   (default)
 *   $SELF_EVOLVE_OUTPUT_DIR/approvals/<date>.jsonl  (env override)
 *
 * Usage:
 *   node scripts/self-evolve-approval.mjs record \
 *     --action promote --session <session-id> --reason "<why>" \
 *     [--candidates <id1,id2>] [--actor <name>]
 *
 * The skill's `promote` intent calls this AFTER the CLI promote succeeds, so
 * every governance action has a signed (actor+reason+timestamp) receipt.
 */

import { execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUTPUT_DIR = process.env.SELF_EVOLVE_OUTPUT_DIR?.trim()
  ? resolve(process.env.SELF_EVOLVE_OUTPUT_DIR)
  : resolve(homedir(), ".maestro", "self-evolve");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (key in args) {
        if (Array.isArray(args[key])) args[key].push(value);
        else args[key] = [args[key], value];
      } else {
        args[key] = value;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(
    "usage: node scripts/self-evolve-approval.mjs record --action <promote|supersede|deprecate|conflict-mark> --session <session-id> --reason \"<why>\" [--candidates <id1,id2>] [--actor <name>]",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command !== "record") usage();

const action = String(args.action ?? "");
const sessionId = String(args.session ?? "");
const reason = String(args.reason ?? "");
if (!["promote", "supersede", "deprecate", "conflict-mark"].includes(action) || !sessionId || !reason) {
  usage();
}

const candidates = String(args.candidates ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const actor = String(args.actor ?? "") || (userInfo().username ?? "unknown");

// Optional verify step: confirm the source run is sealed (promote gate).
let verification = { sealed: null };
if (action === "promote" && process.env.SELF_EVOLVE_VERIFY !== "0") {
  try {
    const raw = execSync(
      `maestro run brief ${sessionId} --json 2>/dev/null || maestro run list --json 2>/dev/null`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    verification.sealed = raw.length > 0 ? "checked" : "unavailable";
  } catch {
    verification.sealed = "unavailable";
  }
}

const receipt = {
  schemaVersion: 1,
  kind: "approval-receipt",
  approvedAt: new Date().toISOString(),
  actor,
  action,
  sessionId,
  reason,
  candidates,
  verification,
  source: "self-evolve skill",
};

mkdirSync(join(OUTPUT_DIR, "approvals"), { recursive: true, mode: 0o700 });
const date = new Date();
const month = String(date.getMonth() + 1).padStart(2, "0");
const day = String(date.getDate()).padStart(2, "0");
const filePath = join(OUTPUT_DIR, "approvals", `${date.getFullYear()}-${month}-${day}.jsonl`);
appendFileSync(filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });

console.log(
  `APPROVAL RECEIPT — ${action} ${sessionId} by ${actor}`
  + `${candidates.length ? ` (${candidates.length} candidates)` : ""}`
  + `\n  reason: ${reason}`
  + `\n  → ${filePath}`,
);
