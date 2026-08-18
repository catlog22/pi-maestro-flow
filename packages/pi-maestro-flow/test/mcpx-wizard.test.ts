import assert from "node:assert/strict";
import test from "node:test";
import { _mcpxWizardInternals, type McpxConfigChanges } from "../src/tui/mcpx-wizard.ts";

const { splitSections, parseListItems, buildChangesYaml } = _mcpxWizardInternals;

const SAMPLE_CONFIG = [
  "server:",
  "    host: 127.0.0.1",
  "    port: 9090",
  "auth:",
  "    mode: open",
  "    token: \"\"",
  "security:",
  "    commands:",
  "        default: allow",
  "        allow:",
  "            - ^ls\\b",
  "            - ^pwd$",
  "        confirm:",
  "            - ^git push",
  "        deny:",
  "            - ^rm -rf /",
  "state:",
  "    retention:",
  "        enabled: true",
  "workspaces:",
  "    - name: demo",
  "      path: D:\\demo",
  "",
].join("\n");

test("splitSections keeps every top-level section", () => {
  const sections = splitSections(SAMPLE_CONFIG);
  const keys = sections.map((section) => section.key);
  assert.deepEqual(keys, ["server", "auth", "security", "state", "workspaces"]);
  assert.match(sections[0].raw, /host: 127\.0\.0\.1/);
});

test("parseListItems reads allow/confirm/deny lists", () => {
  const security = splitSections(SAMPLE_CONFIG).find((section) => section.key === "security")!;
  assert.deepEqual(parseListItems(security, "allow"), ["^ls\\b", "^pwd$"]);
  assert.deepEqual(parseListItems(security, "confirm"), ["^git push"]);
  assert.deepEqual(parseListItems(security, "deny"), ["^rm -rf /"]);
});

test("buildChangesYaml updates port, auth mode and preserves untouched sections", () => {
  const changes: McpxConfigChanges = { port: 9091, authMode: "bearer", authToken: "mcpx_test" };
  const { yaml, summary } = buildChangesYaml(SAMPLE_CONFIG, changes, "D:/demo");
  assert.match(yaml, /port: 9091/);
  assert.match(yaml, /mode: bearer/);
  assert.match(yaml, /token: "mcpx_test"/);
  // untouched sections survive verbatim
  assert.match(yaml, /retention:/);
  assert.match(yaml, /enabled: true/);
  assert.match(yaml, /- name: demo/);
  assert.match(yaml, /path: D:\\demo/);
  assert.ok(summary.some((line) => line.includes("9091")));
  assert.ok(summary.some((line) => line.includes("bearer")));
});

test("buildChangesYaml adds pi allow rule while keeping existing rules", () => {
  const changes: McpxConfigChanges = { allowPi: true, commandsDefault: "confirm" };
  const { yaml } = buildChangesYaml(SAMPLE_CONFIG, changes, "D:/demo");
  assert.match(yaml, /default: confirm/);
  assert.match(yaml, /\^pi\\b/);
  assert.match(yaml, /\^ls\\b/);
  assert.match(yaml, /\^git push/);
  assert.match(yaml, /\^rm -rf \//);
});

test("buildChangesYaml appends skill dirs without duplicates", () => {
  const existing = SAMPLE_CONFIG + [
    "discovery:",
    "    skills:",
    "        enabled: true",
    "        dirs:",
    "            - ~/.mcpx/skills",
    "",
  ].join("\n");
  const changes: McpxConfigChanges = { skillDirs: ["D:/pi-maestro-flow/.pi/skills", "~/.mcpx/skills"] };
  const { yaml, summary } = buildChangesYaml(existing, changes, "D:/demo");
  const dirCount = yaml.split("D:/pi-maestro-flow/.pi/skills").length - 1;
  assert.equal(dirCount, 1);
  assert.equal(yaml.split("~/.mcpx/skills").length - 1, 1); // no duplicate
  assert.ok(summary.some((line) => line.includes("D:/pi-maestro-flow/.pi/skills")));
});

test("buildChangesYaml sets oauth flags on the server section", () => {
  const changes: McpxConfigChanges = { authMode: "oauth", oauthPassword: "secret", oauthServerURL: "https://mcp.example.com" };
  const { yaml } = buildChangesYaml(SAMPLE_CONFIG, changes, "D:/demo");
  assert.match(yaml, /mode: oauth/);
  assert.match(yaml, /password: "secret"/);
  assert.match(yaml, /server_url: "https:\/\/mcp\.example\.com"/);
  assert.match(yaml, /disable_localhost_protection: true/);
  assert.match(yaml, /trust_proxy_headers: true/);
});

test("buildChangesYaml works on an empty (first-run) config", () => {
  const changes: McpxConfigChanges = { port: 9090, authMode: "open", commandsDefault: "confirm", allowPi: true };
  const { yaml } = buildChangesYaml("", changes, "D:/demo");
  assert.match(yaml, /server:/);
  assert.match(yaml, /port: 9090/);
  assert.match(yaml, /auth:/);
  assert.match(yaml, /mode: open/);
  assert.match(yaml, /default: confirm/);
  assert.match(yaml, /\^pi\\b/);
});
