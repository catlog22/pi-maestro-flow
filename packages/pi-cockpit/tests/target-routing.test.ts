import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_TARGET_SEND_MODE,
	MAX_TARGET_BODY_CHARS,
	TARGET_SEND_MODES,
	applyTargetSelectorCompletion,
	buildTargetSelectorItems,
	encodeTargetId,
	parseAndResolveTargetInput,
	parseTargetInput,
	parseTargetSelector,
	resolveTargetId,
	type TargetDescriptor,
} from "../src/target-routing.ts";

const AGENT_ALPHA = "pi-session/v1/workspace/owner/nonce/agent/alpha";
const AGENT_ALPINE = "pi-session/v1/workspace/owner/nonce/agent/alpine";
const AGENT_BUILDER = "pi-session/v1/workspace/owner/nonce/agent/builder/1";
const WINDOW_BUILD = "pi-session/v1/workspace/owner-a/nonce-a/root";
const WINDOW_REVIEW = "pi-session/v1/workspace/owner-b/nonce-b/root";
const SSH_ID = "server-1";

const targets: TargetDescriptor[] = [
	{ kind: "agent", id: AGENT_BUILDER, label: "builder", description: "local worker", current: true },
	{ kind: "agent", id: AGENT_ALPHA, label: "alpha" },
	{ kind: "agent", id: AGENT_ALPINE, label: "alpine" },
	{ kind: "window", id: WINDOW_REVIEW, label: "Review" },
	{ kind: "window", id: WINDOW_BUILD, label: "Build", current: true },
	{ kind: "ssh", id: SSH_ID, label: "Production" },
];

function ref(kind: "agent" | "window" | "ssh", id: string, body = "request"): string {
	return `#${kind}:${encodeTargetId(id)}${body === "" ? "" : ` ${body}`}`;
}

function direct(kind: "agent" | "window", id: string, tail: string, mode?: string): string {
	return `#direct-send:${kind}:${encodeTargetId(id)}${mode === undefined ? "" : `:${mode}`} ${tail}`;
}

test("canonical target parser accepts encoded references and direct sends in a table", () => {
	const cases = [
		{
			name: "agent reference",
			input: ref("agent", AGENT_ALPHA, "inspect the build"),
			expect: { form: "reference", direct: false, kind: "agent", id: AGENT_ALPHA, request: "inspect the build" },
		},
		{
			name: "window reference with horizontal padding",
			input: `  ${ref("window", WINDOW_BUILD, "show status")}  `,
			expect: { form: "reference", direct: false, kind: "window", id: WINDOW_BUILD, request: "show status" },
		},
		{
			name: "ssh reference allows an empty request for picker follow-up",
			input: ref("ssh", SSH_ID, ""),
			expect: { form: "reference", direct: false, kind: "ssh", id: SSH_ID, request: "" },
		},
		{
			name: "default direct-send mode",
			input: direct("agent", AGENT_BUILDER, "continue"),
			expect: { form: "direct-send", direct: true, kind: "agent", id: AGENT_BUILDER, mode: DEFAULT_TARGET_SEND_MODE, message: "continue" },
		},
		{
			name: "explicit direct-send mode and trimmed tail",
			input: direct("window", WINDOW_REVIEW, "  review the tail  ", "steer"),
			expect: { form: "direct-send", direct: true, kind: "window", id: WINDOW_REVIEW, mode: "steer", message: "review the tail" },
		},
		{
			name: "interrupt direct-send",
			input: direct("agent", AGENT_ALPHA, "stop now", "interrupt"),
			expect: { form: "direct-send", direct: true, kind: "agent", id: AGENT_ALPHA, mode: "interrupt", message: "stop now" },
		},
	] as const;

	for (const scenario of cases) {
		const result = parseTargetInput(scenario.input);
		assert.ok(result?.ok, scenario.name);
		assert.deepEqual(
			Object.fromEntries(Object.keys(scenario.expect).map((key) => [key, (result as unknown as Record<string, unknown>)[key]])),
			scenario.expect,
			scenario.name,
		);
	}
});

test("parser returns explicit data for invalid grammar, ids, bodies, modes, and unsupported SSH direct-send", () => {
	const cases = [
		{ input: "#agent:missing-body", reason: "body-required", code: "body" },
		{ input: "#window:", reason: "id", code: "invalid" },
		{ input: "#agent:pi-session/v1/agent/a request", reason: "id-encoding", code: "invalid" },
		{ input: "#agent:bad%2 request", reason: "id-encoding", code: "invalid" },
		{ input: "#agent:bad%20id request", reason: "id", code: "invalid" },
		{ input: "#direct-send:ssh:server-1 run", reason: "direct-kind", code: "unsupported" },
		{ input: "#direct-send:agent:a:abort stop", reason: "mode", code: "invalid" },
		{ input: "#direct-send:agent:a:steer:extra stop", reason: "syntax", code: "invalid" },
		{ input: `#agent:a ${"x".repeat(MAX_TARGET_BODY_CHARS + 1)}`, reason: "body-too-long", code: "body" },
	];
	for (const scenario of cases) {
		const result = parseTargetInput(scenario.input);
		assert.ok(result && !result.ok, scenario.input);
		assert.equal(result.reason, scenario.reason, scenario.input);
		assert.equal(result.code, scenario.code, scenario.input);
		assert.equal(result.matched, true, scenario.input);
	}
	assert.equal(parseTargetInput("ordinary text"), undefined);
	// Incomplete bare categories belong to the selector stage, not submission.
	assert.equal(parseTargetInput("#ssh"), undefined);
});

test("parser keeps a bounded, control-safe request tail", () => {
	const result = parseTargetInput(`#ssh:${encodeTargetId(SSH_ID)} first line\nsecond line`);
	assert.ok(result?.ok && "request" in result);
	assert.equal(result.request, "first line\nsecond line");
	const control = parseTargetInput(`#ssh:${encodeTargetId(SSH_ID)} ok\u0001no`);
	assert.ok(control && !control.ok);
	assert.equal(control.reason, "body-invalid");
});

test("resolution is exact first, then unique same-kind prefix, with explicit stale and ambiguity", () => {
	const exact = resolveTargetId("agent", AGENT_ALPHA, targets);
	assert.equal(exact.code, "resolved");
	assert.equal(exact.match, "exact");
	assert.equal(exact.target.id, AGENT_ALPHA);

	const unique = resolveTargetId("agent", `${AGENT_BUILDER.slice(0, -2)}`, targets);
	assert.equal(unique.code, "resolved");
	assert.equal(unique.match, "prefix");
	assert.equal(unique.target.id, AGENT_BUILDER);

	const ambiguous = resolveTargetId("agent", "pi-session/v1/workspace/owner/nonce/agent/al", targets);
	assert.equal(ambiguous.code, "ambiguous");
	assert.equal(ambiguous.candidates.length, 2);

	const stale = resolveTargetId("window", "pi-session/v1/missing/root", targets);
	assert.equal(stale.code, "stale");
	assert.deepEqual(stale.candidates, []);

	// An agent id never resolves through a window catalogue and vice versa.
	assert.equal(resolveTargetId("window", AGENT_ALPHA, targets).code, "stale");
	const resolved = parseAndResolveTargetInput(ref("window", WINDOW_BUILD), targets);
	assert.ok(resolved && resolved.code === "resolved");
	assert.equal(resolved.target.id, WINDOW_BUILD);
});

test("selector starts with canonical category ordering and stages direct-send kinds", () => {
	assert.deepEqual(
		buildTargetSelectorItems("#").map((item) => item.value),
		["#agent:", "#window:", "#ssh:", "#direct-send:"],
	);
	assert.deepEqual(buildTargetSelectorItems("#w").map((item) => item.value), ["#window:"]);
	assert.deepEqual(
		buildTargetSelectorItems("#direct-send:", targets).map((item) => item.value),
		["#direct-send:agent:", "#direct-send:window:"],
	);
	assert.deepEqual(buildTargetSelectorItems("#direct-send:s", targets), []);
	assert.deepEqual(parseTargetSelector("#direct-send:"), {
		stage: "kind",
		text: "#direct-send:",
		prefix: "",
		fragment: "direct-send:",
	});
});

test("selector target items are canonical, current-marked, encoded, and trailing-space terminated", () => {
	const items = buildTargetSelectorItems("#agent:", targets);
	assert.deepEqual(items.map((item) => item.id), [AGENT_ALPHA, AGENT_ALPINE, AGENT_BUILDER]);
	assert.equal(items[2]?.current, true);
	assert.equal(items[2]?.description?.startsWith("current"), true);
	assert.equal(items[0]?.value, `#agent:${encodeTargetId(AGENT_ALPHA)} `);
	assert.equal(items.every((item) => item.value.endsWith(" ")), true);
	assert.equal(items.every((item) => item.value.includes(encodeTargetId(item.id!))), true);
	assert.equal("host" in (items[0] ?? {}), false);
	assert.equal("password" in (items[0] ?? {}), false);

	const windows = buildTargetSelectorItems("#window:", targets);
	assert.deepEqual(windows.map((item) => item.id), [WINDOW_BUILD, WINDOW_REVIEW]);
	assert.equal(windows[0]?.current, true);
	assert.equal(windows[0]?.value, `#window:${encodeTargetId(WINDOW_BUILD)} `);
});

test("selector direct target and mode stages preserve full ids and offer only accepted modes", () => {
	const targetItems = buildTargetSelectorItems("#direct-send:agent:", targets);
	assert.deepEqual(targetItems.map((item) => item.id), [AGENT_ALPHA, AGENT_ALPINE, AGENT_BUILDER]);
	assert.equal(targetItems[0]?.value, `#direct-send:agent:${encodeTargetId(AGENT_ALPHA)} `);
	assert.equal(targetItems[0]?.nextValue, `#direct-send:agent:${encodeTargetId(AGENT_ALPHA)}:`);

	const modeQuery = `#direct-send:agent:${encodeTargetId(AGENT_BUILDER)}:`;
	const modeItems = buildTargetSelectorItems(modeQuery, targets);
	assert.deepEqual(modeItems.map((item) => item.mode), TARGET_SEND_MODES);
	assert.deepEqual(modeItems.map((item) => item.value), TARGET_SEND_MODES.map((mode) =>
		`#direct-send:agent:${encodeTargetId(AGENT_BUILDER)}:${mode} `));
	assert.equal(modeItems[0]?.description, "default");
	assert.deepEqual(buildTargetSelectorItems("#direct-send:ssh:", targets), []);
	assert.equal(buildTargetSelectorItems("#direct-send:agent:unknown:", targets).length, 0);
});

test("selector completion replaces only the current selector and inserts a trailing space", () => {
	const item = buildTargetSelectorItems("  #window:", targets)[0]!;
	const applied = applyTargetSelectorCompletion("  #window:", item);
	assert.deepEqual(applied, {
		text: `  #window:${encodeTargetId(WINDOW_BUILD)} `,
		cursor: `  #window:${encodeTargetId(WINDOW_BUILD)} `.length,
	});
	assert.equal(applyTargetSelectorCompletion("hello #window:", item), undefined);
	assert.equal(applyTargetSelectorCompletion("#window:id body", item), undefined);
});
