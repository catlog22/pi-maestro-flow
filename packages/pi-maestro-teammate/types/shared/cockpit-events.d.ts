/**
 * Event names published by pi-cockpit's public v1 contract. Kept literal here
 * because pi-maestro-teammate deliberately does not depend on pi-cockpit;
 * tests assert equality against the public contract so a rename cannot drift
 * silently (CS-6).
 */
export declare const COCKPIT_UI_OWNERSHIP_EVENT = "cockpit:ui-ownership";
export declare const COCKPIT_PREEMPT_RESIZE_EVENT = "cockpit:preempt-resize";
