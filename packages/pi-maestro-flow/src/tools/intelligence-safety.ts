const BLOCKED_LSP_ACTIONS = new Set(["rename", "rename_file", "reload", "request"]);

export function blockIntelligenceToolCallInPlan(event: {
  toolName: string;
  input: Record<string, unknown>;
}): { block: true; reason: string } | undefined {
  const action = typeof event.input?.action === "string" ? event.input.action : "";
  if (event.toolName === "computer_use") {
    return { block: true, reason: `Plan mode blocks computer_use action "${action || "unknown"}" because desktop operations can affect external runtime state.` };
  }
  if (event.toolName === "browser") {
    return { block: true, reason: "Plan mode blocks browser control because it can navigate, execute host-level code, and create screenshots." };
  }
  if (event.toolName !== "lsp") return;
  if (!action || BLOCKED_LSP_ACTIONS.has(action) || (action === "code_actions" && event.input?.apply === true)) {
    return { block: true, reason: `Plan mode blocks LSP action "${action || "unknown"}" because it may modify files or runtime state.` };
  }
}
