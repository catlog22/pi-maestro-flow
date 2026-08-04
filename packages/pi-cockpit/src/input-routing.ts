import type { MailboxHostRegistry } from "pi-maestro-teammate/v1/mailbox";

export interface AgentInputTarget {
	correlationId: string;
	label: string;
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

/**
 * Route ordinary interactive text to the selected teammate. Commands and bash
 * input remain local. A failed child delivery is still handled so the text can
 * never leak into the main agent; the editable body is restored for retry.
 */
export async function routeAgentInput(
	event: AgentInputEvent,
	target: AgentInputTarget | undefined,
	registry: MailboxHostRegistry | undefined,
	ui: AgentInputUi,
): Promise<"continue" | "handled"> {
	const hasImages = (event.images?.length ?? 0) > 0;
	const interactive = event.source === "interactive" && (event.text.trim().length > 0 || hasImages);
	const synthetic = event.text.startsWith("/") || event.text.startsWith("!");
	if (!interactive || synthetic || !target) return "continue";

	if (hasImages) {
		ui.notify(`Image input cannot be routed to @${target.label}; attachments were not sent and must be reattached after switching to @main.`, "warning");
		ui.setEditorText(event.text);
		return "handled";
	}

	let error: string | undefined;
	try {
		if (!registry) {
			error = "teammate delivery registry is unavailable";
		} else {
			const delivery = await registry.deliverAgentMessage({
				recipientCorrelationId: target.correlationId,
				recipientLabel: target.label,
				message: event.text,
				mode: event.streamingBehavior === "steer" ? "steer" : "follow_up",
			});
			if (!delivery.delivered) error = delivery.error ?? "delivery was rejected";
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	if (error) {
		ui.notify(`Message to @${target.label} was not sent: ${error}`, "error");
		ui.setEditorText(event.text);
	}
	return "handled";
}
