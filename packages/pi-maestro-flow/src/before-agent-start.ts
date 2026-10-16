export type BeforeAgentStartInput =
  | { messageType?: "user"; prompt: string }
  | {
      messageType: "custom";
      message: {
        customType: string;
        content: string | readonly { type: string; text?: string }[];
      };
    };

export function normalizeBeforeAgentStartInput(event: BeforeAgentStartInput):
  | { messageType: "user"; text: string }
  | { messageType: "custom"; text: string; customType: string } {
  // Pi before 1.2.0 emits user events without a messageType discriminator.
  if (event.messageType !== "custom") return { messageType: "user", text: event.prompt };
  const content = event.message.content;
  return {
    messageType: "custom",
    customType: event.message.customType,
    text: typeof content === "string"
      ? content
      : content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"),
  };
}
