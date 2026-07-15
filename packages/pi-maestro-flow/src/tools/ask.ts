import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTeammateChild, requestTeammateInteraction } from "../permissions/teammate-relay.ts";
import {
  BracketedPasteDecoder,
  removeLastGrapheme,
  sanitizeSingleLineInput,
  type DecodedInputToken,
} from "../tui/input-text.ts";

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

  if (isTeammateChild()) {
    const relayed = await requestTeammateInteraction<{
      action: "answer" | "cancel";
      answers?: AskAnswer[];
    }>("question", { questions });
    if (relayed?.action === "answer" && Array.isArray(relayed.answers)) {
      return askSuccess(relayed.answers);
    }
    if (relayed?.action === "cancel") return cancelledAsk();
    return askError("The parent session did not answer the teammate questionnaire.");
  }

  if (!ctx.hasUI) {
    return askError("Interactive questions require a dialog-capable Pi mode.");
  }

  const mode = (ctx as ExtensionContext & { mode?: string }).mode;
  const terminalUi = mode === "tui"
    || (mode === undefined && Boolean(ctx.ui.setWidget) && Boolean(ctx.ui.onTerminalInput));
  if (!terminalUi) {
    const answers = await showAskDialogs(questions, ctx);
    return answers ? askSuccess(answers) : cancelledAsk();
  }

  const answers = await showAskWizard(questions, ctx);
  if (!answers) {
    return cancelledAsk();
  }

  return askSuccess(answers);
}

function cancelledAsk(): AskToolResult {
  return {
    content: [{ type: "text", text: "Questionnaire cancelled by the user." }],
    details: { answers: [], cancelled: true },
  };
}

/** RPC/JSON-safe dialog path; Pi maps these calls to extension_ui_request. */
async function showAskDialogs(
  questions: QuestionSpec[],
  ctx: ExtensionContext,
): Promise<AskAnswer[] | undefined> {
  const answers: AskAnswer[] = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const title = `${question.header ?? `Question ${index + 1}`}\n${question.question}`;
    const baseOptions = question.options ?? [];
    if (baseOptions.length === 0) {
      const text = await ctx.ui.input(title, "Enter response");
      if (text === undefined) return undefined;
      answers.push({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        selected: [],
        ...(text.trim() ? { text: text.trim() } : {}),
      });
      continue;
    }

    const options = baseOptions.some((option) => option.label === NONE_OPTION_LABEL)
      ? baseOptions
      : [...baseOptions, { label: NONE_OPTION_LABEL }];
    const selected = question.multiSelect
      ? await selectMultipleDialog(ctx, title, options)
      : await selectOneDialog(ctx, title, options);
    if (!selected) return undefined;
    answers.push({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      selected,
    });
  }
  return answers;
}

async function selectOneDialog(
  ctx: ExtensionContext,
  title: string,
  options: QuestionOption[],
): Promise<string[] | undefined> {
  const labels = options.map((option, index) =>
    `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`
  );
  const choice = await ctx.ui.select(title, labels);
  const index = choice ? labels.indexOf(choice) : -1;
  return index >= 0 ? [options[index].label] : undefined;
}

async function selectMultipleDialog(
  ctx: ExtensionContext,
  title: string,
  options: QuestionOption[],
): Promise<string[] | undefined> {
  const selected = new Set<number>();
  while (true) {
    const labels = options.map((option, index) =>
      `${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}`
    );
    const done = `Done (${selected.size})`;
    const choice = await ctx.ui.select(title, [...labels, done]);
    if (choice === undefined) return undefined;
    if (choice === done) {
      return [...selected].sort((a, b) => a - b).map((index) => options[index].label);
    }
    const index = labels.indexOf(choice);
    if (index < 0) continue;
    if (options[index].label === NONE_OPTION_LABEL) {
      selected.clear();
      selected.add(index);
      continue;
    }
    const noneIndex = options.findIndex((option) => option.label === NONE_OPTION_LABEL);
    if (noneIndex >= 0) selected.delete(noneIndex);
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }
}

function askSuccess(answers: AskAnswer[]): AskToolResult {
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
      let lastWidth = 80;
      const pasteDecoder = new BracketedPasteDecoder();
      let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;

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

      function visibleChoiceWindow(
        groups: Array<{ cursorIndex: number; lines: string[] }>,
        cursor: number,
        maxRows: number,
      ): string[] {
        if (groups.length === 0) return [];
        const active = Math.max(0, groups.findIndex((group) => group.cursorIndex === cursor));
        let start = active;
        let end = active + 1;
        let used = groups[active].lines.length;
        while (used < maxRows && (start > 0 || end < groups.length)) {
          const after = end < groups.length && (start === 0 || end - active <= active - start);
          const candidate = after ? groups[end] : groups[start - 1];
          if (!candidate || used + candidate.lines.length > maxRows) break;
          used += candidate.lines.length;
          if (after) end++;
          else start--;
        }
        return groups.slice(start, end).flatMap((group) => group.lines).slice(0, maxRows);
      }

      function actionFooter(width: number, segments: string[]): string {
        let value = "";
        for (const segment of segments.filter(Boolean)) {
          const next = value ? `${value} · ${segment}` : segment;
          if (truncateToWidth(next, width, "") === next) value = next;
        }
        return truncateToWidth(value || segments.find(Boolean) || "", width, "…");
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
          const choiceGroups: Array<{ cursorIndex: number; lines: string[] }> = [];
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
            const optionLines = [truncateToWidth(
              `${marker} ${i + 1}. ${selection}${selection ? " " : ""}${label}${description}`,
              width,
              "…",
            )];
            if (checked) {
              const custom = textValues[step]
                ? `: ${textValues[step]}`
                : " (press d to add)";
              optionLines.push(truncateToWidth(
                `     ${theme.fg("muted", `Add details${custom}`)}`,
                width,
                "…",
              ));
            }
            choiceGroups.push({ cursorIndex: i, lines: optionLines });
          }

          let specialIndex = options.length;
          if (q.multiSelect && options.length > 1) {
            const noneIndex = noneOptionIndex(q);
            const selectableCount = options.length - (noneIndex >= 0 ? 1 : 0);
            const allSelected = selected[step].size === selectableCount && !selected[step].has(noneIndex);
            const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
            const check = allSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            choiceGroups.push({
              cursorIndex: specialIndex,
              lines: [truncateToWidth(`${marker} ${specialIndex + 1}. ${check} Select all`, width, "…")],
            });
            specialIndex++;
          }

          const reservedRows = lines.length + (feedback ? 2 : 1);
          const choiceBudget = Math.max(1, 10 - reservedRows);
          lines.push(...visibleChoiceWindow(choiceGroups, cursor, choiceBudget));
        }

        if (feedback) {
          lines.push(truncateToWidth(theme.fg("warning", `! ${feedback}`), width, "…"));
        }
        lines.push(theme.fg("dim", actionFooter(width, typing
          ? ["Esc back", "Enter save"]
          : q.multiSelect
            ? ["Esc cancel", "Enter next", "↑↓ move", "Space toggle", "d details"]
            : ["Esc cancel", "Enter next", "↑↓ move", "1-9 choose", "d details"])));
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
        lines.push(theme.fg("dim", actionFooter(width, ["Esc back", "Enter submit"])));
        return lines.slice(0, 10);
      }

      function maxCursor(q: QuestionSpec): number {
        const optionCount = questionOptions(q).length;
        const selectAllRows = q.multiSelect && optionCount > 1 ? 1 : 0;
        return optionCount + selectAllRows - 1;
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
          input = removeLastGrapheme(input);
          feedback = "";
          tui.requestRender();
          return;
        }
        const printable = sanitizeSingleLineInput(data);
        if (printable && !data.startsWith("\x1b")) {
          input += printable;
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

      function dispatchDecodedToken(token: DecodedInputToken): void {
        if (token.kind === "paste") {
          if (step < questions.length && !typing) {
            typing = true;
            input = textValues[step];
          }
          if (step < questions.length) handleTyping(token.text);
          return;
        }
        const value = token.text;
        if (step === questions.length) {
          if (value === "\r" || value === "\n" || value === "\x1bOM") done(collectAnswers());
          else if (value === "\x1b" || value === "h" || value === "\x1b[D" || value === "\x1bOD") enterStep(step - 1);
          return;
        }
        if (typing) {
          handleTyping(value);
          return;
        }
        if (value === "\x1b" || value === "h" || value === "\x1b[D" || value === "\x1bOD") {
          if (step > 0) enterStep(step - 1);
          else done(undefined);
          return;
        }
        handleChoice(value === "\x1bOM" ? "\r" : value);
      }

      function decodeInput(data: string): void {
        if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
        for (const token of pasteDecoder.feed(data)) dispatchDecodedToken(token);
        if (pasteDecoder.hasPending()) {
          pasteFlushTimer = setTimeout(() => {
            pasteFlushTimer = undefined;
            for (const token of pasteDecoder.flushPending()) dispatchDecodedToken(token);
          }, 16);
        }
      }

      const createdPanel = {
        render(width: number): string[] {
          const safeWidth = Math.max(1, Math.min(width, 110));
          lastWidth = safeWidth;
          const lines = step === questions.length
            ? renderSubmit(safeWidth)
            : renderQuestion(safeWidth);
          return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
        },

        handleInput(data: string): void {
          if (lastWidth < 20) {
            if (data === "\x1b") done(undefined);
            return;
          }
          decodeInput(data);
        },

        invalidate() {},
        dispose() {
          if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
          done(undefined);
        },
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
