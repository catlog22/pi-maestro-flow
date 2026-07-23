import {
  formatSkillsForPrompt,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { loadSkillConfig, type SkillDefaults } from "./skill-config.ts";
import { SkillManagerStore, type ManagedSkill, type ManagedSkillGroup } from "./skill-manager-store.ts";
import {
  SkillManagerOverlay,
  type SkillManagerAction,
  type SkillManagerUiState,
} from "./skill-manager-tui.ts";

export interface SkillManagerResult {
  configChanged: boolean;
}

export function registerSkillManager(pi: ExtensionAPI): void {
  pi.registerCommand("skills", {
    description: "管理 Skill 的加载状态与模型主动调用权限",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Skill 管理器需要交互式 TUI。", "error");
        return;
      }
      const result = await runSkillManager(ctx, new SkillManagerStore(ctx.cwd));
      if (result.configChanged) {
        await ctx.reload();
        return;
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const { config } = await loadSkillConfig(ctx.cwd);
      const systemPrompt = applySkillModelInvocationConfig(
        event.systemPrompt,
        event.systemPromptOptions.skills ?? [],
        config.skills,
      );
      return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
    } catch (error) {
      console.error(
        `[maestro] Skill model-invocation config warning: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  });
}

export async function runSkillManager(
  ctx: ExtensionContext,
  store: SkillManagerStore,
): Promise<SkillManagerResult> {
  let snapshot = await store.load();
  let uiState: Partial<SkillManagerUiState> = { query: "" };
  let notice = snapshot.skills.length === 0 ? "没有发现 Skill" : undefined;
  let configChanged = false;

  while (true) {
    const action = await openSkillManagerOverlay(ctx, snapshot.skills, snapshot.groups, uiState, notice);
    uiState = action.uiState;
    if (action.kind === "close") break;

    if (action.kind === "create-group") {
      const name = await ctx.ui.input("新建 Skill 分组", "输入分组名称");
      if (!name) {
        notice = "已取消新建分组";
        continue;
      }
      try {
        snapshot = await store.createGroup(name);
        configChanged = true;
        notice = `已新建分组 · ${name.trim()}`;
        uiState = { ...uiState, selectedKey: `group:custom:${name.trim()}` };
      } catch (error) {
        notice = `新建分组失败 · ${error instanceof Error ? error.message : String(error)}`;
      }
      continue;
    }

    const selected = action.skillPath
      ? snapshot.skills.find((skill) => skill.filePath === action.skillPath)
      : undefined;
    const selectedGroup = action.groupName
      ? snapshot.groups.find((group) => group.name === action.groupName && group.custom === action.groupCustom)
      : undefined;

    if (action.kind === "assign-group") {
      if (!selected) {
        notice = "无法移动 · 请选择一个 Skill";
        continue;
      }
      const defaultGroup = "默认前缀分组";
      const customGroups = snapshot.groups.filter((group) => group.custom).map((group) => group.name);
      const target = await ctx.ui.select(`移动 ${selected.name}`, [defaultGroup, ...customGroups]);
      if (!target) {
        notice = "已取消移动";
        continue;
      }
      try {
        snapshot = await store.assignSkillToGroup(selected.name, target === defaultGroup ? undefined : target);
        configChanged = true;
        notice = `已移动 · ${selected.name} → ${target}`;
        uiState = { ...uiState, selectedKey: `skill:${selected.filePath}` };
      } catch (error) {
        notice = `移动失败 · ${error instanceof Error ? error.message : String(error)}`;
      }
      continue;
    }

    if (action.kind === "delete-group") {
      if (!selectedGroup?.custom) {
        notice = "无法删除 · 默认前缀分组由 Skill 名称自动生成";
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        `删除分组「${selectedGroup.name}」？`,
        "组内 Skill 会返回默认前缀分组，Skill 本身不会被删除。",
      );
      if (!confirmed) {
        notice = "已取消删除分组";
        continue;
      }
      try {
        snapshot = await store.deleteGroup(selectedGroup.name);
        configChanged = true;
        notice = `已删除分组 · ${selectedGroup.name}`;
        uiState = { ...uiState, selectedKey: undefined };
      } catch (error) {
        notice = `删除分组失败 · ${error instanceof Error ? error.message : String(error)}`;
      }
      continue;
    }

    if (!selected && !selectedGroup) {
      notice = "无法操作 · 未选择 Skill 或分组";
      continue;
    }

    try {
      if (action.kind === "toggle-enabled") {
        if (selected) {
          ctx.ui.setStatus("skill-manager", `Skill · 正在${selected.enabled ? "停用" : "启用"} ${selected.name}…`);
          snapshot = await store.toggleEnabled(selected);
          notice = `${selected.enabled ? "已停用" : "已启用"} · ${selected.name} · 关闭后重载`;
        } else {
          ctx.ui.setStatus("skill-manager", `Skill · 正在切换分组 ${selectedGroup!.name}…`);
          snapshot = await store.toggleGroupEnabled(selectedGroup!);
          notice = `已切换分组加载状态 · ${selectedGroup!.name} · 关闭后重载`;
        }
      } else {
        if (selected) {
          ctx.ui.setStatus(
            "skill-manager",
            `Skill · 正在${selected.disableModelInvocation ? "允许" : "禁止"}模型调用 ${selected.name}…`,
          );
          snapshot = await store.toggleModelInvocation(selected);
          notice = selected.disableModelInvocation
            ? `已允许模型主动调用 · ${selected.name} · 关闭后重载`
            : `已设为仅手动调用 · ${selected.name} · 关闭后重载`;
        } else {
          ctx.ui.setStatus("skill-manager", `Skill · 正在切换分组模型调用 ${selectedGroup!.name}…`);
          snapshot = await store.toggleGroupModelInvocation(selectedGroup!);
          notice = `已切换分组模型调用状态 · ${selectedGroup!.name} · 关闭后重载`;
        }
      }
      configChanged = true;
      uiState = {
        ...uiState,
        selectedKey: selected ? `skill:${selected.filePath}` : action.uiState.selectedKey,
      };
    } catch (error) {
      notice = `更新失败 · ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      ctx.ui.setStatus("skill-manager", undefined);
    }
  }

  return { configChanged };
}

export function applySkillModelInvocationConfig(
  systemPrompt: string,
  skills: readonly Skill[],
  config: Readonly<Record<string, SkillDefaults>>,
): string {
  const effectiveSkills = skills.map((skill) => {
    const configured = config[skill.name]?.["disable-model-invocation"];
    return configured === undefined
      ? skill
      : { ...skill, disableModelInvocation: configured };
  });
  const originalSection = formatSkillsForPrompt([...skills]);
  const effectiveSection = formatSkillsForPrompt(effectiveSkills);
  if (originalSection === effectiveSection) return systemPrompt;
  if (originalSection && systemPrompt.includes(originalSection)) {
    return systemPrompt.replace(originalSection, effectiveSection);
  }
  if (!effectiveSection) return systemPrompt;
  const dateMarker = "\nCurrent date:";
  const dateIndex = systemPrompt.lastIndexOf(dateMarker);
  return dateIndex >= 0
    ? `${systemPrompt.slice(0, dateIndex)}${effectiveSection}${systemPrompt.slice(dateIndex)}`
    : `${systemPrompt}${effectiveSection}`;
}

async function openSkillManagerOverlay(
  ctx: ExtensionContext,
  skills: ManagedSkill[],
  groups: ManagedSkillGroup[],
  initialState: Partial<SkillManagerUiState>,
  notice: string | undefined,
): Promise<SkillManagerAction> {
  return ctx.ui.custom<SkillManagerAction>((tui, theme, _keybindings, done) =>
    new SkillManagerOverlay({
      skills,
      groups,
      theme,
      notice,
      initialState,
      requestRender: () => tui.requestRender(),
      done,
    }), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
  });
}
