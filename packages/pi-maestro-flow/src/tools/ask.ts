import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTeammateChild, requestTeammateInteraction } from "../permissions/teammate-relay.ts";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
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

const NONE_OPTION_LABEL = "以上都不是";

const TWO_COL_MIN_WIDTH = 84;
const TWO_COL_MIN_ROWS = 16;
let nextQuestionAttentionId = 0;

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
  /** Per-option supplementary details keyed by option label. */
  details?: Record<string, string>;
  /** Free-form response: open-ended questions or a "以上都不是" custom answer. */
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
  options: { onUserAttention?: UserAttentionHandler; requestId?: string; signal?: AbortSignal } = {},
): Promise<AskToolResult> {
  const questions = params.questions?.slice(0, 4) ?? [];
  if (questions.length === 0) {
    return askError("At least one question is required.");
  }
  const signal = options.signal ?? ctx.signal;
  if (signal?.aborted) return cancelledAsk();

  if (isTeammateChild()) {
    const relay = await requestTeammateInteraction<{
      action: "answer" | "cancel";
      answers?: AskAnswer[];
    }>("question", { questions }, undefined, signal);
    if (!relay.ok) {
      if (relay.reason === "aborted") return cancelledAsk();
      const detail = relay.error ? `: ${relay.error}` : "";
      return askError(`Teammate questionnaire relay ${relay.reason}${detail}.`);
    }
    const relayed = relay.result;
    if (relayed.action === "answer" && Array.isArray(relayed.answers)) {
      return askSuccess(relayed.answers);
    }
    if (relayed.action === "cancel") return cancelledAsk();
    return askError("The parent session returned an invalid teammate questionnaire response.");
  }

  if (!ctx.hasUI) {
    return askError("Interactive questions require a dialog-capable Pi mode.");
  }

  options.onUserAttention?.({
    id: options.requestId ?? `question:${++nextQuestionAttentionId}`,
    kind: "question",
  }, ctx);

  const mode = (ctx as ExtensionContext & { mode?: string }).mode;
  const terminalUi = mode === "tui"
    || (mode === undefined && Boolean(ctx.ui.custom) && Boolean(ctx.ui.onTerminalInput));
  if (!terminalUi) {
    const answers = await showAskDialogs(questions, ctx, signal);
    return answers ? askSuccess(answers) : cancelledAsk();
  }

  const answers = await showAskWizard(questions, ctx, signal);
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
  signal?: AbortSignal,
): Promise<AskAnswer[] | undefined> {
  const answers: AskAnswer[] = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const title = `${question.header ?? `问题 ${index + 1}`}\n${question.question}`;
    const baseOptions = question.options ?? [];
    if (baseOptions.length === 0) {
      const text = await ctx.ui.input(title, "输入回答", { signal });
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
      ? await selectMultipleDialog(ctx, title, options, signal)
      : await selectOneDialog(ctx, title, options, signal);
    if (!selected) return undefined;
    let text: string | undefined;
    if (selected.includes(NONE_OPTION_LABEL)) {
      const custom = await ctx.ui.input(title, "你想要什么方案？（可选）", { signal });
      if (custom === undefined) return undefined;
      text = custom.trim() || undefined;
    }
    answers.push({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      selected,
      ...(text ? { text } : {}),
    });
  }
  return answers;
}

async function selectOneDialog(
  ctx: ExtensionContext,
  title: string,
  options: QuestionOption[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const labels = options.map((option, index) =>
    `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`
  );
  const choice = await ctx.ui.select(title, labels, { signal });
  const index = choice ? labels.indexOf(choice) : -1;
  return index >= 0 ? [options[index].label] : undefined;
}

async function selectMultipleDialog(
  ctx: ExtensionContext,
  title: string,
  options: QuestionOption[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const selected = new Set<number>();
  while (true) {
    const labels = options.map((option, index) =>
      `${selected.has(index) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}`
    );
    const done = `完成（${selected.size}）`;
    const choice = await ctx.ui.select(title, [...labels, done], { signal });
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
          const chosen = answer.selected.map((label) => {
            const detail = answer.details?.[label];
            return detail ? `${label} (${detail})` : label;
          });
          const finalChoice = [...chosen, ...(answer.text ? [answer.text] : [])].join(" — ");
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
  signal?: AbortSignal,
): Promise<AskAnswer[] | undefined> {
  if (signal?.aborted) return undefined;
  // Rendered as an in-composer interactive panel (the default ui.custom
  // path), not an overlay: the cockpit's ambient ←/→/Shift+↑↓ hooks yield
  // to any custom component holding input focus, so the wizard owns those
  // keys while it is up without covering the rest of the UI.
  return ctx.ui.custom<AskAnswer[] | undefined>(
    (tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (result: AskAnswer[] | undefined) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        done(result);
      };
      const onAbort = () => finish(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) queueMicrotask(onAbort);

      const optionsList = questions.map((q) => {
        const options = q.options ?? [];
        if (options.length === 0 || options.some((option) => option.label === NONE_OPTION_LABEL)) {
          return options;
        }
        return [...options, { label: NONE_OPTION_LABEL }];
      });
      const selected = questions.map(() => new Set<number>());
      const optionDetails = optionsList.map((options) => options.map(() => ""));
      const freeText = questions.map(() => "");
      const cursors = questions.map(() => 0);
      const nonePrompted = questions.map(() => false);
      let step = 0;
      let typing = optionsList[0].length === 0;
      let detailCursor = -1;
      let input = "";
      let feedback = "";
      let lastWidth = 80;
      let previewScroll = 0;
      let lastPreviewMaxScroll = 0;
      let lastPreviewInnerH = 6;
      let reviewCursor = 0;
      let submitActionCursor = 0;
      const pasteDecoder = new BracketedPasteDecoder();
      let pasteFlushTimer: ReturnType<typeof setTimeout> | undefined;

      const term = (tui as unknown as { terminal?: { columns?: number; rows?: number } }).terminal;
      function termCols(): number {
        return term?.columns ?? 0;
      }
      function termRows(): number {
        return term?.rows ?? 24;
      }
      function twoColEnabled(width: number): boolean {
        return width >= TWO_COL_MIN_WIDTH
          && termCols() >= TWO_COL_MIN_WIDTH
          && termRows() >= TWO_COL_MIN_ROWS;
      }

      function noneOptionIndex(index: number): number {
        return optionsList[index].findIndex((option) => option.label === NONE_OPTION_LABEL);
      }

      function questionLabel(index: number): string {
        return questions[index].header?.trim() || `问题 ${index + 1}`;
      }

      function currentQuestion(): QuestionSpec {
        return questions[Math.min(step, questions.length - 1)];
      }

      function hasAnswer(index: number): boolean {
        if (selected[index].size > 0) return true;
        return optionsList[index].length === 0 && freeText[index].trim().length > 0;
      }

      function enterStep(nextStep: number): void {
        step = Math.max(0, Math.min(nextStep, questions.length));
        feedback = "";
        detailCursor = -1;
        previewScroll = 0;
        if (step === questions.length) {
          reviewCursor = 0;
          submitActionCursor = 0;
        }
        if (step < questions.length) {
          typing = optionsList[step].length === 0;
          input = typing ? freeText[step] : "";
        } else {
          typing = false;
          input = "";
        }
        tui.requestRender();
      }

      function advance(): void {
        if (!hasAnswer(step)) {
          feedback = "请先选择一项或输入内容再继续。";
          tui.requestRender();
          return;
        }
        enterStep(step + 1);
      }

      function collectAnswers(): AskAnswer[] {
        return questions.map((q, index) => {
          const options = optionsList[index];
          const noneIndex = noneOptionIndex(index);
          const values = [...selected[index]]
            .sort((a, b) => a - b)
            .map((optionIndex) => options[optionIndex]?.label)
            .filter((label): label is string => Boolean(label));
          const details: Record<string, string> = {};
          for (const optionIndex of selected[index]) {
            if (optionIndex === noneIndex) continue;
            const label = options[optionIndex]?.label;
            const detail = optionDetails[index][optionIndex]?.trim();
            if (label && detail) details[label] = detail;
          }
          const noneSelected = noneIndex >= 0 && selected[index].has(noneIndex);
          const text = noneSelected
            ? optionDetails[index][noneIndex]?.trim() ?? ""
            : options.length === 0
              ? freeText[index].trim()
              : "";
          return {
            question: q.question,
            ...(q.header ? { header: q.header } : {}),
            selected: values,
            ...(Object.keys(details).length > 0 ? { details } : {}),
            ...(text ? { text } : {}),
          };
        });
      }

      function breadcrumb(width: number): string {
        const labels = [...questions.map((_, index) => questionLabel(index)), "提交"];
        const trail = labels.map((label, index) => {
          if (index === step) {
            return theme.bg("selectedBg", theme.fg("success", theme.bold(` ${label} `)));
          }
          if (index < questions.length && hasAnswer(index)) {
            // Answered questions are marked in the tab bar so the completion
            // state of every step is visible while switching with ←/→/Tab.
            return theme.fg("success", ` ✓${label} `);
          }
          return theme.fg(index < step ? "text" : "muted", ` ${label} `);
        }).join(theme.fg("dim", " > "));
        return truncateToWidth(
          `${theme.bold("询问用户")} ${theme.fg("dim", "·")} ${trail}`,
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
        const options = optionsList[step];
        const questionLines = wrapTextWithAnsi(theme.bold(q.question), width).slice(0, 2);
        const lines: string[] = [breadcrumb(width), ...questionLines];
        const modeLabel = q.multiSelect
          ? "多选 · 空格切换"
            : options.length > 0
            ? "单选 · 数字键选择 · 可附说明"
            : "自由输入";
        const picked = [...selected[step]].map((i) => options[i]?.label).filter(Boolean);
        const statusText = picked.length > 0
          ? theme.fg("success", `已选：${picked.join("、")}`)
          : theme.fg("muted", "未选择（可 →/Tab 跳过）");
        lines.push(truncateToWidth(
          `${theme.fg("dim", modeLabel)} · ${statusText}`,
          width,
          "…",
        ));

        if (typing) {
          const editingLabel = options.length > 0 && detailCursor >= 0
            ? theme.fg("muted", `${options[detailCursor].label} › `)
            : "";
          const placeholder = options.length > 0
            ? "输入附加说明…"
            : "输入你的回答…";
          const value = input || theme.fg("dim", placeholder);
          lines.push(truncateToWidth(`${theme.fg("success", "›")} ${editingLabel}${value}`, width, "…"));
        } else {
          const cursor = cursors[step];
          const choiceGroups: Array<{ cursorIndex: number; lines: string[] }> = [];
          for (let i = 0; i < options.length; i++) {
            const active = cursor === i;
            const checked = selected[step].has(i);
            const marker = active ? theme.fg("success", "›") : " ";
            const labelText = `${options[i].label}${checked ? "  已选" : ""}`;
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
              const detail = optionDetails[step][i]?.trim();
              const prompt = i === noneOptionIndex(step)
                ? "描述你想要的方案"
                : "附加说明";
              const custom = detail ? `：${detail}` : "（按 d 添加）";
              optionLines.push(truncateToWidth(
                `     ${theme.fg("muted", `${prompt}${custom}`)}`,
                width,
                "…",
              ));
            }
            choiceGroups.push({ cursorIndex: i, lines: optionLines });
          }

          let specialIndex = options.length;
          if (q.multiSelect && options.length > 1) {
            const noneIndex = noneOptionIndex(step);
            const selectableCount = options.length - (noneIndex >= 0 ? 1 : 0);
            const allSelected = selected[step].size === selectableCount && !selected[step].has(noneIndex);
            const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
            const check = allSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            choiceGroups.push({
              cursorIndex: specialIndex,
              lines: [truncateToWidth(`${marker} ${specialIndex + 1}. ${check} 全选`, width, "…")],
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
          ? ["Esc 返回", "Enter 保存"]
          : q.multiSelect
            ? ["Esc 取消", "Enter 确认/下一步", "→/Tab 跳过", "↑↓ 移动", "空格 切换", "d 附加说明"]
            : ["Esc 取消", "Enter 选择/确认", "→/Tab 跳过", "↑↓ 移动", "1-9 选择", "d 附加说明"])));
        return lines.slice(0, 10);
      }

      function renderSubmit(width: number): string[] {
        const lines: string[] = [
          breadcrumb(width),
          truncateToWidth(theme.bold("核对答案"), width, "…"),
        ];
        for (let i = 0; i < questions.length; i++) {
          const answer = collectAnswers()[i];
          const active = i === reviewCursor;
          const chosen = answer.selected.map((label) => {
            const detail = answer.details?.[label];
            return detail ? `${label} (${detail})` : label;
          });
          const values = [...chosen, ...(answer.text ? [answer.text] : [])].join(" — ") || theme.fg("muted", "（未选择）");
          const marker = active ? theme.fg("success", "›") : " ";
          const label = `${i + 1}. ${answer.question}`;
          lines.push(truncateToWidth(
            `${marker} ${active ? theme.fg("success", theme.bold(label)) : theme.bold(label)}  ${values}`,
            width,
            "…",
          ));
        }
        lines.push(...renderSubmitActions(width));
        lines.push(theme.fg("dim", actionFooter(width, ["Esc 返回", "↑↓/Tab 选择操作", "←→ 切换问题", "Enter 确认"])));
        return lines.slice(0, 10);
      }

      function renderSubmitActions(width: number): string[] {
        return ["提交", "取消"].map((label, index) => {
          const active = submitActionCursor === index;
          const marker = active ? theme.fg("success", "›") : " ";
          const text = active
            ? theme.bg("selectedBg", theme.fg("success", theme.bold(` ${label} `)))
            : ` ${label} `;
          return truncateToWidth(`${marker} ${text}`, width, "…");
        });
      }

      function clampInt(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
      }

      function padCell(text: string, width: number): string {
        return truncateToWidth(text, width, "", true);
      }

      function fillRule(text: string, width: number, ch: string): string {
        const used = visibleWidth(text);
        return used >= width ? text : text + ch.repeat(width - used);
      }

      function frameTop(width: number, title: string): string {
        const inner = Math.max(0, width - 2);
        return "┌" + truncateToWidth(fillRule(`─ ${title} `, inner, "─"), inner, "") + "┐";
      }

      function frameBottom(width: number, status: string): string {
        const inner = Math.max(0, width - 2);
        if (!status) return "└" + "─".repeat(inner) + "┘";
        const label = ` ${status} `;
        const left = Math.max(1, inner - visibleWidth(label) - 1);
        return "└" + truncateToWidth(fillRule("─".repeat(left) + label, inner, "─"), inner, "") + "┘";
      }

      function choiceRow(i: number, leftW: number, q: QuestionSpec): string {
        const options = optionsList[step];
        const active = cursors[step] === i;
        const checked = selected[step].has(i);
        const marker = active ? theme.fg("success", "›") : " ";
        const labelText = `${options[i].label}${checked ? "  已选" : ""}`;
        const coloredLabel = checked || active ? theme.fg("success", labelText) : labelText;
        const label = checked ? theme.bg("selectedBg", theme.bold(` ${coloredLabel} `)) : coloredLabel;
        const selection = q.multiSelect ? (checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]")) : "";
        return truncateToWidth(`${marker} ${i + 1}. ${selection}${selection ? " " : ""}${label}`, leftW, "…");
      }

      function renderInputRow(leftW: number): string {
        const options = optionsList[step];
        const editingLabel = options.length > 0 && detailCursor >= 0
          ? theme.fg("muted", `${options[detailCursor].label} › `)
          : "";
        const placeholder = options.length > 0 ? "输入附加说明…" : "输入你的回答…";
        const value = input || theme.fg("dim", placeholder);
        return truncateToWidth(`${theme.fg("success", "›")} ${editingLabel}${value}`, leftW, "…");
      }

      function buildChoiceRows(leftW: number, bodyBudget: number): string[] {
        const q = currentQuestion();
        const options = optionsList[step];
        const cursor = cursors[step];
        const rows: string[] = [];

        if (typing && options.length === 0) {
          rows.push(renderInputRow(leftW));
          while (rows.length < bodyBudget) rows.push("");
          return rows;
        }

        const inputRows = typing ? 1 : 0;
        const optionBudget = Math.max(1, bodyBudget - inputRows);
        const groups: Array<{ cursorIndex: number; lines: string[] }> = [];
        for (let i = 0; i < options.length; i++) {
          groups.push({ cursorIndex: i, lines: [choiceRow(i, leftW, q)] });
        }
        let specialIndex = options.length;
        if (q.multiSelect && options.length > 1) {
          const noneIndex = noneOptionIndex(step);
          const selectableCount = options.length - (noneIndex >= 0 ? 1 : 0);
          const allSelected = selected[step].size === selectableCount && !selected[step].has(noneIndex);
          const marker = cursor === specialIndex ? theme.fg("success", "›") : " ";
          const check = allSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
          groups.push({
            cursorIndex: specialIndex,
            lines: [truncateToWidth(`${marker} ${specialIndex + 1}. ${check} 全选`, leftW, "…")],
          });
          specialIndex++;
        }
        rows.push(...visibleChoiceWindow(groups, cursor, optionBudget));
        if (typing) rows.push(renderInputRow(leftW));
        while (rows.length < bodyBudget) rows.push("");
        return rows.slice(0, bodyBudget);
      }

      function buildPreviewLines(textW: number): string[] {
        const q = currentQuestion();
        const options = optionsList[step];
        const out: string[] = [];
        const push = (text: string): void => {
          if (text === "") {
            out.push("");
            return;
          }
          out.push(...wrapTextWithAnsi(text, textW));
        };

        if (options.length === 0) {
          push(theme.fg("muted", "回答"));
          push("");
          push(typing ? (input || theme.fg("dim", "开始输入…")) : (freeText[step] || theme.fg("dim", "尚无回答。")));
          push("");
          push(theme.fg("muted", "问题"));
          push(q.question);
          return out;
        }

        const ci = typing && detailCursor >= 0 ? detailCursor : cursors[step];
        const opt = options[ci];
        if (!opt) return out;
        push(theme.bold(opt.label));
        push("");
        if (opt.description) {
          push(opt.description);
        } else {
          push(theme.fg("dim", "此选项暂无描述。"));
        }
        const stored = optionDetails[step][ci]?.trim() ?? "";
        const editingThis = typing && detailCursor === ci;
        if (editingThis || stored) {
          push("");
          push(theme.fg("muted", "附加说明"));
          push(editingThis ? (input || theme.fg("dim", "…")) : stored);
        }
        push("");
        push(theme.fg("muted", "问题"));
        push(q.question);
        return out;
      }

      function renderPreviewPane(preview: string[], innerH: number, textW: number, rightW: number): string[] {
        const pane: string[] = [frameTop(rightW, "预览")];
        for (let i = 0; i < innerH; i++) {
          const raw = preview[previewScroll + i] ?? "";
          pane.push(`│ ${padCell(raw, textW)} │`);
        }
        let status = "";
        if (preview.length > innerH) {
          const from = previewScroll + 1;
          const to = Math.min(previewScroll + innerH, preview.length);
          status = `${from}-${to} / ${preview.length}`;
        }
        pane.push(frameBottom(rightW, status));
        return pane;
      }

      function renderQuestionWide(width: number): string[] {
        const q = currentQuestion();
        const options = optionsList[step];

        const header: string[] = [breadcrumb(width)];
        header.push(...wrapTextWithAnsi(theme.bold(q.question), width).slice(0, 4));
        const modeLabel = q.multiSelect
          ? "多选 · 空格切换"
          : options.length > 0
            ? "单选 · 数字键选择 · 可附说明"
            : "自由输入";
        const picked = [...selected[step]].map((i) => options[i]?.label).filter(Boolean);
        const statusText = picked.length > 0
          ? theme.fg("success", `已选：${picked.join("、")}`)
          : theme.fg("muted", "未选择（可 →/Tab 跳过）");
        header.push(truncateToWidth(
          `${theme.fg("dim", modeLabel)} · ${statusText}`,
          width,
          "…",
        ));

        const footer: string[] = [];
        if (feedback) footer.push(truncateToWidth(theme.fg("warning", `! ${feedback}`), width, "…"));
        footer.push(truncateToWidth(theme.fg("dim", actionFooter(width, q.multiSelect
          ? ["Esc 取消", "Enter 确认/下一步", "→/Tab 跳过", "↑↓ 移动", "空格 切换", "d 附加说明", "PgDn/Shift+↓ 滚动"]
          : options.length > 0
            ? ["Esc 取消", "Enter 选择/确认", "→/Tab 跳过", "↑↓ 移动", "1-9 选择", "d 附加说明", "PgDn/Shift+↓ 滚动"]
            : ["Esc 返回", "Enter 保存"])), width, "…"));

        const bodyBudget = clampInt(termRows() - header.length - footer.length - 9, 5, 18);
        const rightW = Math.max(34, Math.round(width * 0.55));
        const leftW = width - 1 - rightW;
        const innerH = bodyBudget - 2;
        const textW = rightW - 4;

        const leftRows = buildChoiceRows(leftW, bodyBudget);
        const preview = buildPreviewLines(textW);
        const maxScroll = Math.max(0, preview.length - innerH);
        previewScroll = Math.min(previewScroll, maxScroll);
        lastPreviewMaxScroll = maxScroll;
        lastPreviewInnerH = innerH;
        const pane = renderPreviewPane(preview, innerH, textW, rightW);

        const lines: string[] = [...header, theme.fg("dim", "─".repeat(width))];
        for (let i = 0; i < bodyBudget; i++) {
          lines.push(padCell(leftRows[i] ?? "", leftW) + " " + (pane[i] ?? padCell("", rightW)));
        }
        lines.push(...footer);
        return lines;
      }

      function renderSubmitWide(width: number): string[] {
        const answers = collectAnswers();
        const header: string[] = [
          breadcrumb(width),
          truncateToWidth(theme.bold("核对答案"), width, "…"),
          ...renderSubmitActions(width),
        ];
        const footer: string[] = [
          truncateToWidth(theme.fg("dim", actionFooter(width, ["Esc 返回", "↑↓/Tab 选择操作", "←→ 切换问题", "PgDn/Shift+↓ 滚动", "Enter 确认"])), width, "…"),
        ];
        const bodyBudget = clampInt(termRows() - header.length - footer.length - 9, 4, 18);
        const rightW = Math.max(34, Math.round(width * 0.55));
        const leftW = width - 1 - rightW;
        const innerH = bodyBudget - 2;
        const textW = rightW - 4;

        const idx = Math.min(reviewCursor, answers.length - 1);
        const leftRows = answers.map((answer, i) => {
          const active = i === idx;
          const marker = active ? theme.fg("success", "›") : " ";
          const label = answer.header || answer.question;
          const value = [...answer.selected, ...(answer.text ? [answer.text] : [])].join(", ") || "（未选择）";
          return truncateToWidth(
            `${marker} ${i + 1}. ${active ? theme.fg("success", label) : label}  ${theme.fg("muted", value)}`,
            leftW,
            "…",
          );
        });
        while (leftRows.length < bodyBudget) leftRows.push("");

        const answer = answers[idx];
        const preview: string[] = [];
        const push = (text: string): void => {
          if (text === "") {
            preview.push("");
            return;
          }
          preview.push(...wrapTextWithAnsi(text, textW));
        };
        if (answer) {
          push(theme.bold(answer.header || answer.question));
          push("");
          push(theme.fg("muted", "问题"));
          push(answer.question);
          push("");
          push(theme.fg("muted", "答案"));
          const values = answer.selected.map((label) => {
            const detail = answer.details?.[label];
            return detail ? `${label} — ${detail}` : label;
          });
          push([...values, ...(answer.text ? [answer.text] : [])].join("\n") || theme.fg("dim", "（无）"));
        }
        const maxScroll = Math.max(0, preview.length - innerH);
        previewScroll = Math.min(previewScroll, maxScroll);
        lastPreviewMaxScroll = maxScroll;
        lastPreviewInnerH = innerH;
        const pane = renderPreviewPane(preview, innerH, textW, rightW);

        const lines: string[] = [...header, theme.fg("dim", "─".repeat(width))];
        for (let i = 0; i < bodyBudget; i++) {
          lines.push(padCell(leftRows[i] ?? "", leftW) + " " + (pane[i] ?? padCell("", rightW)));
        }
        lines.push(...footer);
        return lines;
      }

      function scrollPreview(down: boolean): void {
        if (!twoColEnabled(lastWidth)) return;
        const stepSize = Math.max(1, Math.floor(lastPreviewInnerH / 2));
        previewScroll = down
          ? Math.min(lastPreviewMaxScroll, previewScroll + stepSize)
          : Math.max(0, previewScroll - stepSize);
        tui.requestRender();
      }

      function isScrollDown(data: string): boolean {
        return data === "\x1b[6~" || data.startsWith("\x1b[6;") || data === "\x1b[1;2B" || data === "]";
      }

      function isScrollUp(data: string): boolean {
        return data === "\x1b[5~" || data.startsWith("\x1b[5;") || data === "\x1b[1;2A" || data === "[";
      }

      function maxCursor(index: number): number {
        const optionCount = optionsList[index].length;
        const selectAllRows = questions[index].multiSelect && optionCount > 1 ? 1 : 0;
        return optionCount + selectAllRows - 1;
      }

      function handleTyping(data: string): void {
        const hasOptions = optionsList[step].length > 0;
        if (data === "\r" || data === "\n") {
          const value = input.trim();
          if (!hasOptions) {
            if (!value) {
              feedback = "请先输入内容再继续。";
              tui.requestRender();
              return;
            }
            freeText[step] = value;
            feedback = "";
            typing = false;
            advance();
            return;
          }
          if (detailCursor >= 0) optionDetails[step][detailCursor] = value;
          feedback = "";
          typing = false;
          detailCursor = -1;
          tui.requestRender();
          return;
        }
        if (data === "\x1b") {
          if (hasOptions) {
            typing = false;
            detailCursor = -1;
            feedback = "";
            tui.requestRender();
          } else if (step > 0) {
            enterStep(step - 1);
          } else {
            finish(undefined);
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
        const options = optionsList[step];
        const noneIndex = noneOptionIndex(step);
        const cursor = cursors[step];
        const allIndex = q.multiSelect && options.length > 1 ? options.length : -1;

        if (isScrollDown(data) || isScrollUp(data)) {
          scrollPreview(isScrollDown(data));
          return;
        }
        if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
          cursors[step] = Math.max(0, cursor - 1);
          previewScroll = 0;
          feedback = "";
          tui.requestRender();
          return;
        }
        if (data === "\x1b[B" || data === "\x1bOB" || data === "j") {
          cursors[step] = Math.min(maxCursor(step), cursor + 1);
          previewScroll = 0;
          feedback = "";
          tui.requestRender();
          return;
        }
        if (/^[1-9]$/.test(data)) {
          const requested = Number(data) - 1;
          if (requested <= maxCursor(step)) {
            cursors[step] = requested;
            previewScroll = 0;
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
        if (data === "d" && cursor < options.length && selected[step].has(cursor)) {
          detailCursor = cursor;
          if (cursor === noneIndex) nonePrompted[step] = true;
          typing = true;
          input = optionDetails[step][cursor];
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
            const wasSelected = selected[step].has(cursor);
            selected[step].clear();
            selected[step].add(cursor);
            feedback = "";
            if (data === " ") {
              tui.requestRender();
            } else if (cursor === noneIndex && !nonePrompted[step]) {
              nonePrompted[step] = true;
              detailCursor = cursor;
              typing = true;
              input = optionDetails[step][cursor];
              tui.requestRender();
            } else if (wasSelected) {
              advance();
            } else {
              tui.requestRender();
            }
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
            if (optionsList[step].length === 0) {
              input = freeText[step];
            } else {
              detailCursor = cursors[step];
              input = optionDetails[step][cursors[step]] ?? "";
            }
          }
          if (step < questions.length) handleTyping(token.text);
          return;
        }
        const value = token.text;
        if (step === questions.length) {
          if (value === "\r" || value === "\n" || value === "\x1bOM") {
            finish(submitActionCursor === 0 ? collectAnswers() : undefined);
          } else if (value === "\x1b") {
            enterStep(step - 1);
          } else if (value === "k" || value === "\x1b[A" || value === "\x1bOA") {
            submitActionCursor = 0;
            tui.requestRender();
          } else if (value === "j" || value === "\x1b[B" || value === "\x1bOB") {
            submitActionCursor = 1;
            tui.requestRender();
          } else if (value === "\t" || value === "\x1b[Z") {
            submitActionCursor = submitActionCursor === 0 ? 1 : 0;
            tui.requestRender();
          } else if (value === "h" || value === "\x1b[D" || value === "\x1bOD") {
            reviewCursor = Math.max(0, reviewCursor - 1);
            previewScroll = 0;
            tui.requestRender();
          } else if (value === "l" || value === "\x1b[C" || value === "\x1bOC") {
            reviewCursor = Math.min(questions.length - 1, reviewCursor + 1);
            previewScroll = 0;
            tui.requestRender();
          } else if (isScrollDown(value) || isScrollUp(value)) {
            scrollPreview(isScrollDown(value));
          }
          return;
        }
        if (typing) {
          handleTyping(value);
          return;
        }
        if (value === "\x1b") {
          if (step > 0) enterStep(step - 1);
          else finish(undefined);
          return;
        }
        if (value === "h" || value === "\x1b[D" || value === "\x1bOD" || value === "\x1b[Z") {
          if (step > 0) enterStep(step - 1);
          return;
        }
        if (value === "\x1bOM") {
          handleChoice("\r");
          return;
        }
        if (value === "\x1b[C" || value === "\x1bOC" || value === "\t") {
          // Pure navigation: →/Tab move to the next question without selecting
          // the highlighted option. Unanswered questions may be skipped.
          enterStep(step + 1);
          return;
        }
        handleChoice(value);
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
          const lines = twoColEnabled(safeWidth)
            ? step === questions.length
              ? renderSubmitWide(safeWidth)
              : renderQuestionWide(safeWidth)
            : step === questions.length
              ? renderSubmit(safeWidth)
              : renderQuestion(safeWidth);
          return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
        },

        handleInput(data: string): void {
          if (lastWidth < 20) {
            if (data === "\x1b" || data === "\x03") finish(undefined);
            return;
          }
          decodeInput(data === "\x03" ? "\x1b" : data);
        },

        invalidate() {},
        dispose() {
          if (pasteFlushTimer) clearTimeout(pasteFlushTimer);
          finish(undefined);
        },
      };
      return createdPanel;
    },
  );
}

