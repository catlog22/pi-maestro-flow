import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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

export interface AskAnswer {
  question: string;
  header?: string;
  selected: string[];
  text?: string;
}

export interface AskResultDetails {
  answers: AskAnswer[];
  cancelled?: boolean;
}

type AskToolResult = AgentToolResult<AskResultDetails> & { isError?: boolean };

export async function executeAsk(
  params: AskParams,
  ctx: ExtensionContext,
): Promise<AskToolResult> {
  const questions = params.questions?.slice(0, 4) ?? [];
  if (questions.length === 0) {
    return askError("At least one question is required.");
  }

  if (!ctx.hasUI || !ctx.ui.setWidget || !ctx.ui.onTerminalInput) {
    return askError("Interactive questions require Pi TUI mode. Ask the user directly instead.");
  }

  const answers = await showAskWizard(questions, ctx);
  if (!answers) {
    return {
      content: [{ type: "text", text: "Questionnaire cancelled by the user." }],
      details: { answers: [], cancelled: true },
    };
  }

  return {
    content: [{
      type: "text",
      text: `Collected ${answers.length} answer${answers.length === 1 ? "" : "s"}.\n${JSON.stringify({ answers }, null, 2)}`,
    }],
    details: { answers },
  };
}

function askError(message: string): AskToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { answers: [] },
  };
}

async function showAskWizard(
  questions: QuestionSpec[],
  ctx: ExtensionContext,
): Promise<AskAnswer[] | undefined> {
  const widgetKey = "ask-user-question-panel";
  return new Promise<AskAnswer[] | undefined>((resolve) => {
    let panel: {
      render(width: number): string[];
      handleInput(data: string): void;
      invalidate(): void;
      dispose?(): void;
    } | undefined;
    let unsubscribe = () => {};
    let settled = false;

    const done = (result: AskAnswer[] | undefined): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      ctx.ui.setWidget(widgetKey, undefined);
      resolve(result);
    };

    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
      const selected = questions.map(() => new Set<number>());
      const textValues = questions.map(() => "");
      const cursors = questions.map(() => 0);
      let step = 0;
      let typing = (questions[0].options?.length ?? 0) === 0;
      let input = "";
      let feedback = "";

      function questionLabel(index: number): string {
        return questions[index].header?.trim() || `Question ${index + 1}`;
      }

      function currentQuestion(): QuestionSpec {
        return questions[Math.min(step, questions.length - 1)];
      }

      function hasAnswer(index: number): boolean {
        return selected[index].size > 0 || textValues[index].trim().length > 0;
      }

      function enterStep(nextStep: number): void {
        step = Math.max(0, Math.min(nextStep, questions.length));
        feedback = "";
        if (step < questions.length) {
          const q = currentQuestion();
          typing = (q.options?.length ?? 0) === 0;
          input = textValues[step];
        } else {
          typing = false;
          input = "";
        }
        tui.requestRender();
      }

      function advance(): void {
        if (!hasAnswer(step)) {
          feedback = "Choose an option or enter a response before continuing.";
          tui.requestRender();
          return;
        }
        enterStep(step + 1);
      }

      function collectAnswers(): AskAnswer[] {
        return questions.map((q, index) => {
          const values = [...selected[index]]
            .sort((a, b) => a - b)
            .map((optionIndex) => q.options?.[optionIndex]?.label)
            .filter((label): label is string => Boolean(label));
          const text = textValues[index].trim();
          return {
            question: q.question,
            ...(q.header ? { header: q.header } : {}),
            selected: values,
            ...(text ? { text } : {}),
          };
        });
      }

      function breadcrumb(width: number): string {
        const labels = [...questions.map((_, index) => questionLabel(index)), "Submit"];
        const trail = labels.map((label, index) => {
          if (index === step) {
            return theme.bg("selectedBg", theme.fg("success", theme.bold(` ${label} `)));
          }
          return theme.fg(index < step ? "text" : "muted", ` ${label} `);
        }).join(theme.fg("dim", " > "));
        return truncateToWidth(
          `${theme.bold("Asking User")} ${theme.fg("dim", "·")} ${trail}`,
          width,
          "…",
        );
      }

      function visibleWindow(rows: string[], cursor: number, maxRows: number): string[] {
        if (rows.length <= maxRows) return rows;
        const start = Math.max(0, Math.min(rows.length - maxRows, cursor - Math.floor(maxRows / 2)));
        return rows.slice(start, start + maxRows);
      }

      function renderQuestion(width: number): string[] {
        const q = currentQuestion();
        const options = q.options ?? [];
        const questionLines = wrapTextWithAnsi(theme.bold(q.question), width).slice(0, 2);
        const lines: string[] = [breadcrumb(width), ...questionLines];
        const modeLabel = q.multiSelect
          ? "Multi-select · Space toggles"
          : options.length > 0
            ? "Single-select · choose one, then continue"
            : "Free response";
        lines.push(truncateToWidth(theme.fg("dim", modeLabel), width, "…"));

        if (typing) {
          const value = input || theme.fg("dim", "Type your answer…");
          lines.push(truncateToWidth(`${theme.fg("success", "›")} ${value}`, width, "…"));
        } else {
          const cursor = cursors[step];
          const choiceRows: string[] = [];
          for (let i = 0; i < options.length; i++) {
            const active = cursor === i;
            const checked = selected[step].has(i);
            const marker = active ? theme.fg("success", "›") : " ";
            const label = checked || active ? theme.fg("success", options[i].label) : options[i].label;
            const selection = q.multiSelect
              ? checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]")
              : checked ? theme.fg("success", "✓") : " ";
            const description = options[i].description
              ? theme.fg("muted", ` · ${options[i].description}`)
              : "";
            choiceRows.push(truncateToWidth(
              `${marker} ${i + 1}. ${selection} ${label}${description}`,
              width,
              "…",
            ));
          }

          let specialIndex = options.length;
          if (q.multiSelect && options.length > 1) {
            const allSelected = selected[step].size === options.length;
            const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
            const check = allSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            choiceRows.push(truncateToWidth(`${marker} ${specialIndex + 1}. ${check} Select all`, width, "…"));
            specialIndex++;
          }

          const nextMarker = cursor === specialIndex ? theme.fg("success", "›") : " ";
          choiceRows.push(truncateToWidth(
            `${nextMarker} ${specialIndex + 1}. ${theme.bold("Next ›")}`,
            width,
            "…",
          ));
          specialIndex++;

          const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
          const custom = textValues[step] ? `: ${textValues[step]}` : "";
          choiceRows.push(truncateToWidth(
            `${marker} ${specialIndex + 1}. ${theme.bold("Add details")}${theme.fg("muted", custom)}`,
            width,
            "…",
          ));

          const reservedRows = lines.length + (feedback ? 2 : 1);
          const choiceBudget = Math.max(1, 10 - reservedRows);
          lines.push(...visibleWindow(choiceRows, cursor, choiceBudget));
        }

        if (feedback) {
          lines.push(truncateToWidth(theme.fg("warning", `! ${feedback}`), width, "…"));
        }
        lines.push(truncateToWidth(
          theme.fg("dim", typing
            ? "Enter save · Esc back"
            : q.multiSelect
              ? "↑↓ move · Space toggle · Enter activate · Esc back"
              : "↑↓ move · Enter choose/action · Esc back"),
          width,
          "…",
        ));
        return lines.slice(0, 10);
      }

      function renderSubmit(width: number): string[] {
        const lines: string[] = [
          breadcrumb(width),
          truncateToWidth(theme.bold("Review answers"), width, "…"),
        ];
        for (let i = 0; i < questions.length; i++) {
          const answer = collectAnswers()[i];
          const values = [...answer.selected, ...(answer.text ? [answer.text] : [])].join(", ");
          lines.push(truncateToWidth(
            `${theme.fg("success", "✓")} ${theme.bold(questionLabel(i))}  ${theme.fg("muted", values)}`,
            width,
            "…",
          ));
        }
        lines.push(truncateToWidth(`${theme.fg("success", "›")} ${theme.bold("Submit")}`, width, "…"));
        lines.push(truncateToWidth(theme.fg("dim", "Enter submit · Esc back"), width, "…"));
        return lines.slice(0, 10);
      }

      function maxCursor(q: QuestionSpec): number {
        const optionCount = q.options?.length ?? 0;
        const selectAllRows = q.multiSelect && optionCount > 1 ? 1 : 0;
        return optionCount + selectAllRows + 1;
      }

      function removeLastCodePoint(value: string): string {
        return [...value].slice(0, -1).join("");
      }

      function handleTyping(data: string): void {
        const q = currentQuestion();
        const hasOptions = (q.options?.length ?? 0) > 0;
        if (data === "\r" || data === "\n") {
          const value = input.trim();
          if (!value) {
            feedback = "Enter a response before continuing.";
            tui.requestRender();
            return;
          }
          textValues[step] = value;
          feedback = "";
          typing = false;
          if (!hasOptions) advance();
          else tui.requestRender();
          return;
        }
        if (data === "\x1b") {
          if (hasOptions) {
            typing = false;
            input = textValues[step];
            feedback = "";
            tui.requestRender();
          } else if (step > 0) {
            enterStep(step - 1);
          } else {
            done(undefined);
          }
          return;
        }
        if (data === "\x7f" || data === "\b") {
          input = removeLastCodePoint(input);
          feedback = "";
          tui.requestRender();
          return;
        }
        if (data && !data.startsWith("\x1b") && [...data].every((char) => char >= " ")) {
          input += data;
          feedback = "";
          tui.requestRender();
        }
      }

      function handleChoice(data: string): void {
        const q = currentQuestion();
        const options = q.options ?? [];
        const cursor = cursors[step];
        const allIndex = q.multiSelect && options.length > 1 ? options.length : -1;
        const nextIndex = options.length + (allIndex >= 0 ? 1 : 0);
        const textIndex = nextIndex + 1;

        if (data === "\x1b[A" || data === "k") {
          cursors[step] = Math.max(0, cursor - 1);
          feedback = "";
          tui.requestRender();
          return;
        }
        if (data === "\x1b[B" || data === "j" || data === "\t") {
          cursors[step] = Math.min(maxCursor(q), cursor + 1);
          feedback = "";
          tui.requestRender();
          return;
        }
        if (/^[1-9]$/.test(data)) {
          const requested = Number(data) - 1;
          if (requested <= maxCursor(q)) {
            cursors[step] = requested;
            feedback = "";
            tui.requestRender();
          }
          return;
        }
        if (data !== " " && data !== "\r" && data !== "\n") return;

        if (cursor < options.length) {
          if (q.multiSelect) {
            if (selected[step].has(cursor)) selected[step].delete(cursor);
            else selected[step].add(cursor);
            feedback = "";
            tui.requestRender();
          } else {
            selected[step].clear();
            selected[step].add(cursor);
            feedback = "";
            tui.requestRender();
          }
          return;
        }

        if (cursor === allIndex) {
          const selectAll = selected[step].size !== options.length;
          selected[step].clear();
          if (selectAll) options.forEach((_, index) => selected[step].add(index));
          feedback = "";
          tui.requestRender();
          return;
        }
        if (cursor === nextIndex) {
          advance();
          return;
        }
        if (cursor === textIndex) {
          typing = true;
          input = textValues[step];
          feedback = "";
          tui.requestRender();
        }
      }

      const createdPanel = {
        render(width: number): string[] {
          const safeWidth = Math.max(1, Math.min(width, 110));
          const lines = step === questions.length
            ? renderSubmit(safeWidth)
            : renderQuestion(safeWidth);
          return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
        },

        handleInput(data: string): void {
          if (step === questions.length) {
            if (data === "\r" || data === "\n") done(collectAnswers());
            else if (data === "\x1b" || data === "h" || data === "\x1b[D") enterStep(step - 1);
            return;
          }
          if (typing) {
            handleTyping(data);
            return;
          }
          if (data === "\x1b" || data === "h" || data === "\x1b[D") {
            if (step > 0) enterStep(step - 1);
            else done(undefined);
            return;
          }
          handleChoice(data);
        },

        invalidate() {},
        dispose() {},
      };
      panel = createdPanel;
      return createdPanel;
      },
      { placement: "aboveEditor" },
    );

    unsubscribe = ctx.ui.onTerminalInput((data) => {
      panel?.handleInput(data === "\x03" ? "\x1b" : data);
      return { consume: true };
    });
  });
}
