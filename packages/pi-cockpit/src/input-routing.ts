import type { MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";
import type { SessionMessageRequest, SessionMessageResult } from "pi-maestro-teammate/v1/sessions";
import { tuiT } from "./tui-i18n.ts";

export interface AgentInputTarget {
	correlationId: string;
	label: string;
	/** Canonical endpoint selector when supplied by EndpointStore. */
	endpointId?: string;
	routeSelector?: string;
}

export interface AgentInputEvent {
	text: string;
	source: "interactive" | "rpc" | "extension";
	images?: readonly unknown[];
	streamingBehavior?: "steer" | "followUp";
}

export interface AgentInputUi {
	notify(message: string, type: "warning" | "error"): void;
	setEditorText(text: string): void;
}

export interface SessionInputRegistry {
	send?(request: SessionMessageRequest): Promise<SessionMessageResult>;
	router?: { route(request: SessionMessageRequest): Promise<SessionMessageResult> };
}

export interface AgentInputRegistries {
	sessions?: SessionInputRegistry;
	mailbox?: MailboxHostRegistry;
}

export type AgentInputRegistryProvider = MailboxHostRegistry | AgentInputRegistries;

function inputRegistries(provider: AgentInputRegistryProvider | undefined): AgentInputRegistries {
	if (provider && "deliverAgentMessage" in provider) return { mailbox: provider };
	return provider ?? {};
}

/**
 * Route ordinary interactive text to the selected teammate. Commands and bash
 * input remain local. A failed child delivery is still handled so the text can
 * never leak into the main agent; the editable body is restored for retry.
 */
export async function routeAgentInput(
	event: AgentInputEvent,
	target: AgentInputTarget | undefined,
	provider: AgentInputRegistryProvider | undefined,
	ui: AgentInputUi,
): Promise<"continue" | "handled"> {
	const hasImages = (event.images?.length ?? 0) > 0;
	const interactive = event.source === "interactive" && (event.text.trim().length > 0 || hasImages);
	const synthetic = event.text.startsWith("/") || event.text.startsWith("!");
	if (!interactive || synthetic || !target) return "continue";

	if (hasImages) {
		ui.notify(tuiT("notice.agentImage", { label: target.label }), "warning");
		ui.setEditorText(event.text);
		return "handled";
	}

	let error: string | undefined;
	try {
		const registries = inputRegistries(provider);
		const sessionSend = registries.sessions?.send?.bind(registries.sessions)
			?? registries.sessions?.router?.route.bind(registries.sessions.router);
		if (sessionSend) {
			const delivery = await sessionSend({
				selector: target.routeSelector ?? target.endpointId ?? target.correlationId,
				message: event.text,
				mode: event.streamingBehavior === "steer" ? "steer" : "follow_up",
				source: "user",
			});
			if (!delivery.delivered) error = delivery.error ?? tuiT("notice.deliveryRejected");
		} else if (registries.mailbox) {
			const delivery = await registries.mailbox.deliverAgentMessage({
				recipientCorrelationId: target.correlationId,
				recipientLabel: target.label,
				message: event.text,
				mode: event.streamingBehavior === "steer" ? "steer" : "follow_up",
			});
			if (!delivery.delivered) error = delivery.error ?? tuiT("notice.deliveryRejected");
		} else {
			error = tuiT("notice.agentRegistryUnavailable");
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	if (error) {
		ui.notify(tuiT("notice.agentMessageFailed", { label: target.label, message: error }), "error");
		ui.setEditorText(event.text);
	}
	return "handled";
}
