/**
 * Version 1 aggregate public API.
 *
 * This barrel re-exports every v1 area, including `./extension.ts` — which
 * loads the extension entry point and, transitively, the TUI overlays and the
 * subprocess machinery. Consumers that only need types, the event contract or
 * a single pure area should import the narrow subpath
 * (`pi-maestro-teammate/v1/types`, `/v1/events`, `/v1/retry`, ...) instead of
 * this barrel, and pay for only what they use.
 */
export * from "./agents.ts";
export * from "./backends.ts";
export * from "./child-extensions.ts";
export * from "./cli-tools.ts";
export * from "./completion-durability.ts";
export * from "./events.ts";
export * from "./execution.ts";
export * from "./extension.ts";
export * from "./mailbox.ts";
export * from "./model-routing.ts";
export * from "./monitor-window-state.ts";
export * from "./observation.ts";
export * from "./progress-tree.ts";
export * from "./remote.ts";
export * from "./retry.ts";
export * from "./session-history.ts";
export * from "./scheduler.ts";
export * from "./sessions.ts";
export * from "./ssh-hosts.ts";
export * from "./supervision.ts";
export * from "./todo-context.ts";
export * from "./types.ts";
export * from "./workspace-completion.ts";
export * from "./workspace-projections.ts";
