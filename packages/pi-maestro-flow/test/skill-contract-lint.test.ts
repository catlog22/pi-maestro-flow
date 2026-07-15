import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SKILL_SESSION_MODES } from "../src/skills/skill-loader.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skillsRoot = join(repoRoot, ".pi", "skills");
const coreSkills = new Set([
  "maestro-next",
  "maestro-ralph",
  "maestro",
  "maestro-session-seal",
]);

interface ContractFinding {
  file: string;
  rule: string;
  detail: string;
}

test("core Session/Run skills satisfy the host mirror contract", () => {
  const findings = [...coreSkills].flatMap((name) => {
    const file = join(skillsRoot, name, "SKILL.md");
    return auditSkill(file, true);
  });
  assert.deepEqual(findings, []);
});

test("non-core skill contract drift is report-only", (t) => {
  const findings = listSkillFiles(skillsRoot)
    .filter((file) => !coreSkills.has(relative(skillsRoot, dirname(file)).split(/[\\/]/)[0] ?? ""))
    .flatMap((file) => auditSkill(file, false));

  t.diagnostic(`non-core skill contract findings: ${findings.length}`);
  for (const finding of findings.slice(0, 20)) {
    t.diagnostic(`${finding.file}: ${finding.rule} — ${finding.detail}`);
  }
  assert.ok(Array.isArray(findings));
});

function auditSkill(file: string, core: boolean): ContractFinding[] {
  const content = readFileSync(file, "utf8");
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const displayPath = relative(repoRoot, file).replaceAll("\\", "/");
  const findings: ContractFinding[] = [];
  const sessionMode = frontmatter["session-mode"];

  if (typeof sessionMode !== "string" || !(SKILL_SESSION_MODES as readonly string[]).includes(sessionMode)) {
    findings.push({
      file: displayPath,
      rule: "session-mode",
      detail: `expected ${SKILL_SESSION_MODES.join("|")}, received ${JSON.stringify(sessionMode)}`,
    });
  }

  const mirrorBlocks = [...content.matchAll(/<host_mirror>([\s\S]*?)<\/host_mirror>/gi)];
  if (core && mirrorBlocks.length !== 1) {
    findings.push({ file: displayPath, rule: "host-mirror", detail: `expected one block, found ${mirrorBlocks.length}` });
  }

  const todoCalls = [...content.matchAll(/todo\s*\(\s*\{[\s\S]*?\}\s*\)/gi)];
  for (const match of todoCalls) {
    const call = match[0];
    const callLine = sourceLineAt(content, match.index ?? 0);
    const negated = /禁止|不得|do not|must not|never/i.test(callLine);
    const action = /action\s*:\s*["']([^"']+)["']/i.exec(call)?.[1];
    if (core && !negated && action !== "next") {
      findings.push({ file: displayPath, rule: "todo-action", detail: `core mirror call must use action=next: ${oneLine(call)}` });
    }
    if (!negated && /\btaskId\b|\bactiveForm\b|status\s*:\s*["']failed["']/i.test(call)) {
      findings.push({ file: displayPath, rule: "todo-schema", detail: oneLine(call) });
    }
  }

  if (core) {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!isDirectCanonicalWrite(line)) continue;
      findings.push({ file: displayPath, rule: "canonical-writer", detail: `line ${index + 1}: ${line.trim()}` });
    }
  }

  return findings;
}

function isDirectCanonicalWrite(line: string): boolean {
  const canonicalFile = /\b(?:state|session|run|artifacts)\.json\b/i;
  const writeVerb = /(?:\bwrite\b|\bedit\b|\brecord\b|\bpersist\b|\bupdate\b|写入|修改|记录|更新)/i;
  if (!canonicalFile.test(line) || !writeVerb.test(line)) return false;
  if (/(?:\bCLI\b|maestro run|禁止|不得|do not|must not|never|只读|读取|\bread\b|由[^。；]*CLI)/i.test(line)) return false;
  const fileIndex = line.search(canonicalFile);
  const verbIndex = line.search(writeVerb);
  return Math.abs(fileIndex - verbIndex) <= 36;
}

function listSkillFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listSkillFiles(path));
    else if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
  }
  return files;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function sourceLineAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end < 0 ? content.length : end);
}
