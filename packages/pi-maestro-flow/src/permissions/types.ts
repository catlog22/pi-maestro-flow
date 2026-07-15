export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionRuleSettings {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode?: PermissionMode;
  disableBypassPermissionsMode?: "disable";
}

export interface PermissionToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionUpdateRule {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionUpdate {
  type: "addRules" | "replaceRules" | "removeRules" | "setMode";
  behavior?: PermissionBehavior;
  destination?: "session" | "localSettings";
  rules?: PermissionUpdateRule[];
  mode?: PermissionMode;
}

export interface PermissionRequestHookDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
}
