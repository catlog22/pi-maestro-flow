import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-site-extract-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
await writeFile(join(root, "web-search.json"), JSON.stringify({
  ssrf: { allowRanges: ["127.0.0.1/32"] },
}));

const mod = await import("../src/tools/web-access/site-extract.ts");
const {
  extractArxivAbs,
  extractStackOverflowQuestion,
  extractNvdCve,
  extractOsvVuln,
  extractCisaKev,
  extractSiteContent,
  setSiteApiBaseOverride,
} = mod;

const ARXIV_HTML = `<!DOCTYPE html>
<html><head>
<meta name="citation_title" content="A Test Paper on Structured Extraction">
<meta name="citation_author" content="Alice Example">
<meta name="citation_abstract" content="We study structured extraction from web sources.">
<meta name="citation_date" content="2024/01/15">
<meta property="arxiv:primary_category" content="cs.CL">
</head><body>
<h1 class="title">Title: A Test Paper on Structured Extraction</h1>
<div class="authors"><a href="/a/alice_example_1">Alice Example</a>, <a href="/a/bob_example_2">Bob Example</a></div>
<blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span> We study structured extraction from web sources.</blockquote>
</body></html>`;

const SO_HTML = `<!DOCTYPE html>
<html><head><title>How to parse JSON in bash? - Stack Overflow</title></head>
<body>
<div id="question-header"><h1 itemprop="name"><a href="/questions/123456/how-to-parse-json-in-bash">How to parse JSON in bash?</a></h1></div>
<div id="question" class="question">
  <div class="js-vote-count">42</div>
  <div class="post-text"><p>I need to parse JSON in bash without jq.</p></div>
  <div class="post-tag">bash</div><div class="post-tag">json</div>
</div>
<div id="answers">
  <div class="answer">
    <div class="js-vote-count">17</div>
    <div class="post-text"><p>Use python3 -c to parse JSON safely.</p></div>
  </div>
  <div class="answer">
    <div class="js-vote-count">3</div>
    <div class="post-text"><p>Or install jq.</p></div>
  </div>
</div>
</body></html>`;

const NVD_JSON = {
  resultsPerPage: 1,
  totalResults: 1,
  vulnerabilities: [{
    cve: {
      id: "CVE-2024-1234",
      published: "2024-03-01T00:00:00.000",
      lastModified: "2024-04-01T00:00:00.000",
      descriptions: [{ lang: "en", value: "A test vulnerability in example software." }],
      cvssMetricV31: [{
        cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL", vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      }],
      cvssMetricV2: [{ cvssData: { baseScore: 10.0, baseSeverity: "HIGH" } }],
      weaknesses: [{ description: [{ value: "CWE-89" }] }],
      references: [{ url: "https://example.com/advisory/CVE-2024-1234", source: "vendor" }],
    },
  }],
};

const OSV_JSON = {
  id: "OSV-2024-123",
  summary: "Out-of-bounds write in example-lib",
  details: "A crafted input triggers an out-of-bounds write.",
  aliases: ["CVE-2024-9999"],
  published: "2024-02-01T00:00:00Z",
  modified: "2024-02-02T00:00:00Z",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
  affected: [{
    package: { name: "example-lib", ecosystem: "crates.io" },
    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.3" }] }],
  }],
  references: [{ type: "ADVISORY", url: "https://example.com/advisory/OSV-2024-123" }],
};

const KEV_JSON = {
  title: "CISA Catalog of Known Exploited Vulnerabilities",
  catalogVersion: "2024.03.04",
  dateReleased: "2024-03-04T00:00:00.000Z",
  count: 2,
  vulnerabilities: [
    {
      cveID: "CVE-2024-0001",
      vendorProject: "Acme",
      product: "Widget",
      vulnerabilityName: "Acme Widget RCE",
      dateAdded: "2024-03-04",
      shortDescription: "Exploited in the wild.",
      requiredAction: "Apply vendor mitigations.",
      dueDate: "2024-03-25",
      knownRansomwareCampaignUse: "Known",
    },
    {
      cveID: "CVE-2023-9999",
      vendorProject: "OldCorp",
      product: "Legacy",
      vulnerabilityName: "OldCorp Legacy XSS",
      dateAdded: "2023-12-01",
      shortDescription: "Exploited in the wild.",
      requiredAction: "Apply vendor mitigations.",
      dueDate: "2023-12-22",
      knownRansomwareCampaignUse: "Unknown",
    },
  ],
};

let port: number;
const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (status: number, body: string, contentType = "application/json"): void => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  };

  if (url.pathname === "/abs/2401.12345") return send(200, ARXIV_HTML, "text/html");
  if (url.pathname.startsWith("/questions/123456")) return send(200, SO_HTML, "text/html");
  if (url.pathname === "/rest/json/cves/2.0") return send(200, JSON.stringify(NVD_JSON));
  if (url.pathname === "/v1/vulns/OSV-2024-123") return send(200, JSON.stringify(OSV_JSON));
  if (url.pathname === "/sites/default/files/feeds/known_exploited_vulnerabilities.json") {
    return send(200, JSON.stringify(KEV_JSON));
  }
  send(404, "not found", "text/plain");
});

before(async () => {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  port = address.port;
  setSiteApiBaseOverride("nvd", `http://127.0.0.1:${port}/rest/json/cves/2.0`);
  setSiteApiBaseOverride("osv", `http://127.0.0.1:${port}/v1/vulns`);
  setSiteApiBaseOverride("cisa", `http://127.0.0.1:${port}/sites/default/files/feeds/known_exploited_vulnerabilities.json`);
});

after(async () => {
  setSiteApiBaseOverride("nvd", "");
  setSiteApiBaseOverride("osv", "");
  setSiteApiBaseOverride("cisa", "");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("arxiv abs page extracts structured title, authors, and abstract", async () => {
  const result = await extractArxivAbs(new URL(`http://127.0.0.1:${port}/abs/2401.12345`));
  assert.ok(result);
  assert.equal(result.error, null);
  assert.match(result.title, /Test Paper on Structured Extraction/);
  assert.match(result.content, /Alice Example, Bob Example/);
  assert.match(result.content, /We study structured extraction/);
  assert.match(result.content, /arXiv: 2401\.12345/);
  assert.match(result.content, /Submitted: 2024\/01\/15/);
});

test("stack overflow question extracts question, tags, and answers", async () => {
  const result = await extractStackOverflowQuestion(new URL(`http://127.0.0.1:${port}/questions/123456/how-to-parse-json-in-bash`));
  assert.ok(result);
  assert.equal(result.error, null);
  assert.match(result.title, /How to parse JSON in bash/);
  assert.match(result.content, /bash, json/);
  assert.match(result.content, /Votes: 42/);
  assert.match(result.content, /Answers \(2\)/);
  assert.match(result.content, /Use python3 -c to parse JSON safely/);
  assert.match(result.content, /Or install jq/);
});

test("nvd CVE page renders severity, description, and references", async () => {
  const result = await extractNvdCve(new URL(`http://127.0.0.1:${port}/vuln/detail/CVE-2024-1234`));
  assert.ok(result);
  assert.equal(result.error, null);
  assert.match(result.title, /CVE-2024-1234/);
  assert.match(result.content, /9\.8 CRITICAL/);
  assert.match(result.content, /CVSS v2\.0: 10 HIGH/);
  assert.match(result.content, /CWE-89/);
  assert.match(result.content, /A test vulnerability in example software/);
  assert.match(result.content, /https:\/\/example\.com\/advisory\/CVE-2024-1234/);
});

test("osv vulnerability renders summary, severity, and affected ranges", async () => {
  const result = await extractOsvVuln(new URL(`http://127.0.0.1:${port}/vulnerability/OSV-2024-123`));
  assert.ok(result);
  assert.equal(result.error, null);
  assert.match(result.title, /OSV-2024-123/);
  assert.match(result.content, /Out-of-bounds write in example-lib/);
  assert.match(result.content, /crates\.io\/example-lib/);
  assert.match(result.content, /introduced 0 → fixed 1\.2\.3/);
  assert.match(result.content, /CVE-2024-9999/);
});

test("cisa KEV catalog summarizes entries and supports ?cve= filter", async () => {
  const all = await extractCisaKev(new URL(`http://127.0.0.1:${port}/known-exploited-vulnerabilities-catalog`));
  assert.ok(all);
  assert.equal(all.error, null);
  assert.match(all.content, /Total entries: 2/);
  assert.match(all.content, /CVE-2023-9999/);

  const filtered = await extractCisaKev(new URL(`http://127.0.0.1:${port}/known-exploited-vulnerabilities-catalog?cve=CVE-2024-0001`));
  assert.ok(filtered);
  assert.match(filtered.content, /CVE-2024-0001 — Acme Widget RCE/);
  assert.doesNotMatch(filtered.content, /CVE-2023-9999/);
});

test("extractSiteContent returns null for non-matching sites without network", async () => {
  assert.equal(await extractSiteContent("https://example.com/some/page"), null);
  assert.equal(await extractSiteContent("not a url"), null);
  assert.equal(await extractSiteContent("/local/path"), null);
});
