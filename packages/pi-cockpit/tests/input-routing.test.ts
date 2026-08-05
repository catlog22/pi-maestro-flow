import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";
import { routeAgentInput } from "../src/input-routing.ts";

function ui() {
	const notifications: Array<{ message: string; type: string }> = [];
	const restored: string[] = [];
	return {
		notifications,
		restored,
		value: {
			notify: (message: string, type: "warning" | "error") => notifications.push({ message, type }),
			setEditorText: (text: string) => restored.push(text),
		},
	};
}

const target = { correlationId: "corr-builder", label: "builder" };

function registry(deliver: MailboxHostRegistry["deliverAgentMessage"]): MailboxHostRegistry {
	return { deliverAgentMessage: deliver } as MailboxHostRegistry;
}

test("main-session, command, bash and noninteractive input continue normally", async () => {
	const host = ui();
	assert.equal(await routeAgentInput({ text: "hello", source: "interactive" }, undefined, undefined, host.value), "continue");
	assert.equal(await routeAgentInput({ text: "/reload", source: "interactive" }, target, undefined, host.value), "continue");
	assert.equal(await routeAgentInput({ text: "!pwd", source: "interactive" }, target, undefined, host.value), "continue");
	assert.equal(await routeAgentInput({ text: "rpc", source: "rpc" }, target, undefined, host.value), "continue");
});

test("selected-agent input is delivered and handled without restoring text", async () => {
	const host = ui();
	const requests: unknown[] = [];
	const action = await routeAgentInput(
		{ text: "continue the implementation", source: "interactive", streamingBehavior: "steer" },
		target,
		registry(async (request) => {
			requests.push(request);
			return { delivered: true, mode: "steer" };
		}),
		host.value,
	);
	assert.equal(action, "handled");
	assert.deepEqual(requests, [{
		recipientCorrelationId: "corr-builder",
		recipientLabel: "builder",
		message: "continue the implementation",
		mode: "steer",
	}]);
	assert.deepEqual(host.restored, []);
	assert.deepEqual(host.notifications, []);
});

test("missing or rejected delivery restores child-directed text and never continues to main", async () => {
	for (const provider of [
		undefined,
		registry(async () => ({ delivered: false, error: "agent completed" })),
		registry(async () => { throw new Error("mailbox offline"); }),
	]) {
		const host = ui();
		assert.equal(
			await routeAgentInput({ text: "retry me", source: "interactive" }, target, provider, host.value),
			"handled",
		);
		assert.deepEqual(host.restored, ["retry me"]);
		assert.equal(host.notifications[0]?.type, "error");
	}
});

test("image-only input is handled instead of leaking to main", async () => {
	const host = ui();
	assert.equal(
		await routeAgentInput({ text: "", source: "interactive", images: [{}] }, target, undefined, host.value),
		"handled",
	);
	assert.deepEqual(host.restored, [""]);
	assert.equal(host.notifications[0]?.type, "warning");
	assert.match(host.notifications[0]?.message ?? "", /must be reattached/);
});
