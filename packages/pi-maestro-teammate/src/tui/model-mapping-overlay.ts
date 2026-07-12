import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
  TEAMMATE_TASK_TYPES,
  TEAMMATE_TASK_TYPE_META,
  getProjectModelRoutingPath,
  loadModelRoutingConfig,
  saveProjectModelMapping,
  type TeammateTaskType,
} from "../models/model-routing.ts";

async function selectOverlay(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title))));

    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close")));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center", width: 76, maxHeight: 22 },
  });
}

export async function showModelMappingOverlay(
  ctx: ExtensionContext,
  availableModels: readonly string[],
): Promise<void> {
  let keepOpen = true;
  while (keepOpen) {
    const config = loadModelRoutingConfig(ctx.cwd);
    const taskType = await selectOverlay(
      ctx,
      "Teammate Role & Model Routing",
      TEAMMATE_TASK_TYPES.map((type) => ({
        value: type,
        label: `${TEAMMATE_TASK_TYPE_META[type].label} · ${config.mappings[type] ?? "auto"}`,
        description: `${TEAMMATE_TASK_TYPE_META[type].roles} — ${TEAMMATE_TASK_TYPE_META[type].description}`,
      })),
    ) as TeammateTaskType | null;
    if (!taskType) return;

    const configured = config.mappings[taskType];
    const modelItems: SelectItem[] = [{
      value: "__auto__",
      label: configured ? "auto / agent default" : "auto / agent default (active)",
      description: "Clear the project mapping for this task type",
    }];
    for (const model of availableModels) {
      modelItems.push({
        value: model,
        label: model === configured ? `${model} (active)` : model,
        description: model === configured ? `Current ${taskType} mapping` : undefined,
      });
    }
    if (configured && !availableModels.includes(configured)) {
      modelItems.push({
        value: configured,
        label: `${configured} (unavailable)` ,
        description: "Configured model is not authenticated in this session",
      });
    }

    const model = await selectOverlay(
      ctx,
      `Map ${TEAMMATE_TASK_TYPE_META[taskType].label} (${TEAMMATE_TASK_TYPE_META[taskType].roles})`,
      modelItems,
    );
    if (model === null) return;
    saveProjectModelMapping(ctx.cwd, taskType, model === "__auto__" ? null : model);
    ctx.ui.notify(
      `${taskType} → ${model === "__auto__" ? "auto / agent default" : model}\n${getProjectModelRoutingPath(ctx.cwd)}`,
      "info",
    );
    keepOpen = true;
  }
}
