const BLOCKED_LSP_ACTIONS = new Set(["rename", "rename_file", "reload", "request"]);

export function blockIntelligenceToolCallInPlan(event: {
  toolName: string;
  input: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
  if (event.toolName === "browser") {
    return { block: true, reason: "Plan mode blocks browser control because it can navigate, execute host-level code, and create screenshots." };
  }
  if (event.toolName !== "lsp") return;
  const action = typeof event.input?.action === "string" ? event.input.action : "";
  if (!action || BLOCKED_LSP_ACTIONS.has(action) || (action === "code_actions" && event.input?.apply === true)) {
    return { block: true, reason: `Plan mode blocks LSP action "${action || "unknown"}" because it may modify files or runtime state.` };
  }
}
