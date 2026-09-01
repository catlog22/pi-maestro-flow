import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Mark legacy teammate-send delivery failures as failed Pi tool results. */
export function teammateSendErrorOverride(
  toolName: string,
  details: unknown,
): { isError: true } | undefined {
  if (
    toolName === "teammate-send"
    && details !== null
    && typeof details === "object"
    && "delivered" in details
    && (details as { delivered?: unknown }).delivered === false
  ) {
    return { isError: true };
  }
  return undefined;
}

/** Bridge returned `isError` flags into pi's canonical tool-result error state. */
export function installReturnedToolErrorBridge(pi: ExtensionAPI): void {
  const returnedFailures = new Set<string>();
  const registerTool = pi.registerTool.bind(pi);

  (pi as unknown as { registerTool: (tool: ToolDefinition) => void }).registerTool = (tool) => {
    const execute = tool.execute.bind(tool);
    registerTool({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const result = await execute(toolCallId, params, signal, onUpdate, ctx);
        if ((result as { isError?: unknown }).isError === true) returnedFailures.add(toolCallId);
        return result;
      },
    });
  };

  pi.on("tool_result", (event) => (
    returnedFailures.delete(event.toolCallId)
      ? { isError: true }
      : teammateSendErrorOverride(event.toolName, event.details)
  ));
}
