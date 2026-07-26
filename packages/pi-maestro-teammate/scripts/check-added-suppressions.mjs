import process from "node:process";

let diff = "";
for await (const chunk of process.stdin) diff += chunk;

const forbidden = [
  ["TypeScript suppression", /@ts-(?:ignore|expect-error)/],
  ["ESLint suppression", /eslint-disable/],
  ["any assertion", /\bas\s+any\b/],
  ["double unknown assertion", /\bas\s+unknown\s+as\b/],
  ["skipped test", /\b(?:test|it|describe)\.skip\b|\bskip\s*:\s*true\b/],
  ["tsconfig paths alias", /["']paths["']\s*:/],
  ["ambient module alias", /\bdeclare\s+module\s+["']/],
  ["non-null assertion", /[A-Za-z0-9_$)\]]!\s*[.[;]/],
];

const findings = [];
for (const [index, line] of diff.split(/\r?\n/).entries()) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  for (const [label, pattern] of forbidden) {
    if (pattern.test(line.slice(1))) findings.push(`${index + 1}: ${label}: ${line.slice(1)}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
}
