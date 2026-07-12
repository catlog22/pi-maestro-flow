import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface QuestionOption {
  label: string;
  description?: string;
}

const NONE_OPTION_LABEL = "None of the above";

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
      text: [
        `Collected ${answers.length} answer${answers.length === 1 ? "" : "s"}.`,
        ...answers.flatMap((answer, index) => {
          const finalChoice = [...answer.selected, ...(answer.text ? [answer.text] : [])].join(" — ");
          return [`${index + 1}. ${answer.question}`, `   ${finalChoice}`];
        }),
        JSON.stringify({ answers }, null, 2),
      ].join("\n"),
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

      function questionOptions(q: QuestionSpec): QuestionOption[] {
        const options = q.options ?? [];
        if (options.length === 0 || options.some((option) => option.label === NONE_OPTION_LABEL)) {
          return options;
        }
        return [...options, { label: NONE_OPTION_LABEL }];
      }

      function noneOptionIndex(q: QuestionSpec): number {
        return questionOptions(q).findIndex((option) => option.label === NONE_OPTION_LABEL);
      }

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
          typing = questionOptions(q).length === 0;
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
        if (questions.length === 1) {
          done(collectAnswers());
          return;
        }
        enterStep(step + 1);
      }

      function collectAnswers(): AskAnswer[] {
        return questions.map((q, index) => {
          const values = [...selected[index]]
            .sort((a, b) => a - b)
            .map((optionIndex) => questionOptions(q)[optionIndex]?.label)
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
        const options = questionOptions(q);
        const questionLines = wrapTextWithAnsi(theme.bold(q.question), width).slice(0, 2);
        const lines: string[] = [breadcrumb(width), ...questionLines];
        const modeLabel = q.multiSelect
          ? "Multi-select · Space toggles"
            : options.length > 0
            ? "Single-select · number chooses · details optional"
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
            const labelText = `${options[i].label}${checked ? "  selected" : ""}`;
            const coloredLabel = checked || active ? theme.fg("success", labelText) : labelText;
            const label = checked
              ? theme.bg("selectedBg", theme.bold(` ${coloredLabel} `))
              : coloredLabel;
            const selection = q.multiSelect
              ? checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]")
              : "";
            const description = options[i].description
              ? theme.fg("muted", ` · ${options[i].description}`)
              : "";
            choiceRows.push(truncateToWidth(
              `${marker} ${i + 1}. ${selection}${selection ? " " : ""}${label}${description}`,
              width,
              "…",
            ));
            if (checked) {
              const custom = textValues[step]
                ? `: ${textValues[step]}`
                : " (press d to add)";
              choiceRows.push(truncateToWidth(
                `     ${theme.fg("muted", `Add details${custom}`)}`,
                width,
                "…",
              ));
            }
          }

          let specialIndex = options.length;
          if (q.multiSelect && options.length > 1) {
            const noneIndex = noneOptionIndex(q);
            const selectableCount = options.length - (noneIndex >= 0 ? 1 : 0);
            const allSelected = selected[step].size === selectableCount && !selected[step].has(noneIndex);
            const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
            const check = allSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            choiceRows.push(truncateToWidth(`${marker} ${specialIndex + 1}. ${check} Select all`, width, "…"));
            specialIndex++;
          }

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
              ? "↑↓ move · Space toggle · d details · Enter next"
              : "↑↓/keypad move · 1-9 choose · d details · Enter next"),
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
          const values = [...answer.selected, ...(answer.text ? [answer.text] : [])].join(" — ");
          lines.push(truncateToWidth(
            `${theme.bold(`${i + 1}. ${answer.question}`)}  ${theme.fg("muted", values)}`,
            width,
            "…",
          ));
        }
        lines.push(truncateToWidth(`${theme.fg("success", "›")} ${theme.bold("Submit")}`, width, "…"));
        lines.push(truncateToWidth(theme.fg("dim", "Enter submit · Esc back"), width, "…"));
        return lines.slice(0, 10);
      }

      function maxCursor(q: QuestionSpec): number {
        const optionCount = questionOptions(q).length;
        const selectAllRows = q.multiSelect && optionCount > 1 ? 1 : 0;
        return optionCount + selectAllRows - 1;
      }

      function removeLastCodePoint(value: string): string {
        return [...value].slice(0, -1).join("");
      }

      function handleTyping(data: string): void {
        const q = currentQuestion();
        const hasOptions = questionOptions(q).length > 0;
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
        const options = questionOptions(q);
        const noneIndex = noneOptionIndex(q);
        const cursor = cursors[step];
        const allIndex = q.multiSelect && options.length > 1 ? options.length : -1;

        if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
          cursors[step] = Math.max(0, cursor - 1);
          feedback = "";
          tui.requestRender();
          return;
        }
        if (data === "\x1b[B" || data === "\x1bOB" || data === "j" || data === "\t") {
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
            if (requested < options.length) {
              if (q.multiSelect) {
                if (selected[step].has(requested)) {
                  selected[step].delete(requested);
                } else if (requested === noneIndex) {
                  selected[step].clear();
                  selected[step].add(requested);
                } else {
                  selected[step].delete(noneIndex);
                  selected[step].add(requested);
                }
              } else {
                selected[step].clear();
                selected[step].add(requested);
              }
            }
            tui.requestRender();
          }
          return;
        }
        if (data === "d" && selected[step].size > 0) {
          typing = true;
          input = textValues[step];
          feedback = "";
          tui.requestRender();
          return;
        }
        if (data !== " " && data !== "\r" && data !== "\n") return;

        if (cursor < options.length) {
          if (q.multiSelect) {
            if ((data === "\r" || data === "\n") && selected[step].size > 0) {
              advance();
              return;
            }
            if (selected[step].has(cursor)) {
              selected[step].delete(cursor);
            } else if (cursor === noneIndex) {
              selected[step].clear();
              selected[step].add(cursor);
            } else {
              selected[step].delete(noneIndex);
              selected[step].add(cursor);
            }
            feedback = "";
            tui.requestRender();
          } else {
            selected[step].clear();
            selected[step].add(cursor);
            feedback = "";
            if (data === " ") tui.requestRender();
            else advance();
          }
          return;
        }

        if (cursor === allIndex) {
          const selectableIndexes = options
            .map((_, index) => index)
            .filter((index) => index !== noneIndex);
          const selectAll = selectableIndexes.some((index) => !selected[step].has(index));
          selected[step].clear();
          if (selectAll) selectableIndexes.forEach((index) => selected[step].add(index));
          feedback = "";
          tui.requestRender();
          return;
        }
        if ((data === "\r" || data === "\n") && selected[step].size > 0) {
          advance();
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
            if (data === "\r" || data === "\n" || data === "\x1bOM") done(collectAnswers());
            else if (data === "\x1b" || data === "h" || data === "\x1b[D" || data === "\x1bOD") enterStep(step - 1);
            return;
          }
          if (typing) {
            handleTyping(data);
            return;
          }
          if (data === "\x1b" || data === "h" || data === "\x1b[D" || data === "\x1bOD") {
            if (step > 0) enterStep(step - 1);
            else done(undefined);
            return;
          }
          handleChoice(data === "\x1bOM" ? "\r" : data);
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
