import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";
import { routeAgentInput } from "../src/input-routing.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";

cockpitTuiLocale.setLocale("en");

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

test("SessionHostRegistry sender is preferred and receives the canonical endpoint selector", async () => {
	const host = ui();
	const sessionRequests: unknown[] = [];
	let mailboxDeliveries = 0;
	const action = await routeAgentInput(
		{ text: "continue", source: "interactive", streamingBehavior: "followUp" },
		{ ...target, endpointId: "pi-session/v1/workspace/owner/nonce/agent/corr-builder" },
		{
			sessions: {
				async send(request) {
					sessionRequests.push(request);
					return { delivered: true, endpointId: request.selector };
				},
			},
			mailbox: registry(async () => {
				mailboxDeliveries++;
				return { delivered: true };
			}),
		},
		host.value,
	);
	assert.equal(action, "handled");
	assert.deepEqual(sessionRequests, [{
		selector: "pi-session/v1/workspace/owner/nonce/agent/corr-builder",
		message: "continue",
		mode: "follow_up",
		source: "user",
	}]);
	assert.equal(mailboxDeliveries, 0);
});

test("MessageRouter route is used when the registry does not expose send", async () => {
	const host = ui();
	const selectors: string[] = [];
	await routeAgentInput(
		{ text: "steer now", source: "interactive", streamingBehavior: "steer" },
		{ ...target, routeSelector: "canonical-agent" },
		{
			sessions: {
				router: {
					async route(request) {
						selectors.push(request.selector);
						return { delivered: true };
					},
				},
			},
		},
		host.value,
	);
	assert.deepEqual(selectors, ["canonical-agent"]);
});

test("registry rejection is definitive and never retries through Mailbox", async () => {
	const host = ui();
	let mailboxDeliveries = 0;
	await routeAgentInput(
		{ text: "do not duplicate", source: "interactive" },
		target,
		{
			sessions: { send: async () => ({ delivered: false, error: "settled" }) },
			mailbox: registry(async () => {
				mailboxDeliveries++;
				return { delivered: true };
			}),
		},
		host.value,
	);
	assert.equal(mailboxDeliveries, 0);
	assert.deepEqual(host.restored, ["do not duplicate"]);
	assert.match(host.notifications[0]?.message ?? "", /settled/);
});
