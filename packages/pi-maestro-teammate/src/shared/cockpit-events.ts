/**
 * Event names published by pi-cockpit's public v1 contract. Kept literal here
 * because pi-maestro-teammate deliberately does not depend on pi-cockpit;
 * tests assert equality against the public contract so a rename cannot drift
 * silently (CS-6).
 */

export const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
export const COCKPIT_PREEMPT_RESIZE_EVENT = "cockpit:preempt-resize";
export const COCKPIT_SESSION_LIST_EVENT = "cockpit:open-session-list";

/**
 * Cockpit → teammate: user command against one agent. The payload carries
 * `{ correlationId, action: "interrupt" | "steer", message? }`; teammate
 * resolves the live agent and injects the command (interrupt = abort the
 * current turn with a canned continue notice; steer = interrupt + inject the
 * user's message).
 */
export const TEAMMATE_AGENT_COMMAND_EVENT = "teammate:agent-command";
