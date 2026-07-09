import type { AgentToolResult } from "@earendil-works/pi-agent-core";

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionSpec {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface AskParams {
  questions: QuestionSpec[];
}

export function executeAsk(params: AskParams): AgentToolResult {
  const { questions } = params;
  if (!questions?.length) {
    return {
      content: [{ type: "text", text: "Error: at least one question is required" }],
      isError: true,
    };
  }

  const blocks: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const header = q.header ? `[${q.header}] ` : "";
    const lines: string[] = [`### ${header}Q${i + 1}: ${q.question}`];

    if (q.options?.length) {
      const selectType = q.multiSelect ? "(multi-select)" : "(single-select)";
      lines.push(`Options ${selectType}:`);
      for (const opt of q.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        lines.push(`- **${opt.label}**${desc}`);
      }
    } else {
      lines.push("(open-ended — user provides free text)");
    }

    blocks.push(lines.join("\n"));
  }

  return {
    content: [
      {
        type: "text",
        text: [
          "Present the following questions to the user and collect their answers.",
          "Wait for the user to respond before proceeding.",
          "",
          ...blocks,
        ].join("\n"),
      },
    ],
  };
}
