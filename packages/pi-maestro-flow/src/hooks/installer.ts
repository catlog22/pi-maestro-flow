import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MaestroHookInstallerStore } from "./installer-store.ts";
import { sanitizeHookDisplayText } from "./review.ts";
import {
  MaestroHookInstallerOverlay,
  type MaestroHookInstallerAction,
  type MaestroHookInstallerUiState,
} from "./installer-tui.ts";

export interface MaestroHookInstallerResult {
  changed: boolean;
}

export async function runMaestroHookInstaller(
  ctx: ExtensionContext,
  store = new MaestroHookInstallerStore(ctx.cwd),
): Promise<MaestroHookInstallerResult> {
  let snapshot = await store.load();
  let uiState: Partial<MaestroHookInstallerUiState> = {
    query: "",
    selectedNames: snapshot.suggestedNames,
    basePreset: snapshot.installedNames.length === 0
      ? "standard"
      : snapshot.installedPreset === "custom" ? "standard" : snapshot.installedPreset,
    custom: snapshot.installedPreset === "custom",
  };
  let notice: string | undefined;
  let changed = false;

  while (true) {
    const action = await openInstallerOverlay(ctx, snapshot, uiState, notice);
    uiState = action.uiState;
    if (action.kind === "close") return { changed };

    if (action.kind === "uninstall" || action.uiState.selectedNames.length === 0) {
      if (snapshot.installedNames.length === 0) {
        notice = "没有已安装的 Maestro Flow Hook";
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        "卸载 Maestro Flow Hooks？",
        `配置：${sanitizeHookDisplayText(snapshot.configPath)}\n仅移除 ${snapshot.installedNames.length} 个 Maestro 条目；其他 Hook 保持不变。`,
      );
      if (!confirmed) {
        notice = "已取消卸载";
        continue;
      }
      ctx.ui.setStatus("maestro-hook-installer", "Hooks · 正在卸载…");
      try {
        snapshot = await store.uninstall();
        changed = true;
        notice = "已卸载 Maestro Flow Hooks · 其他 Hook 已保留";
        uiState = {
          ...action.uiState,
          selectedNames: [],
          basePreset: "none",
          custom: false,
        };
      } catch (error) {
        notice = `卸载失败 · ${sanitizeHookDisplayText(errorMessage(error))}`;
      } finally {
        ctx.ui.setStatus("maestro-hook-installer", undefined);
      }
      continue;
    }

    const confirmed = await ctx.ui.confirm(
      "安装 Maestro Flow Hooks？",
      [
        `配置：${sanitizeHookDisplayText(snapshot.configPath)}`,
        `将安装：${action.uiState.selectedNames.length} 个 Hook`,
        `保留：${snapshot.thirdPartyHandlers} 个非 Maestro Hook`,
        "安装会改变配置 hash，完成后必须重新审查并信任。",
      ].join("\n"),
    );
    if (!confirmed) {
      notice = "已取消安装";
      continue;
    }

    ctx.ui.setStatus("maestro-hook-installer", "Hooks · 正在安装…");
    try {
      snapshot = await store.apply(action.uiState.selectedNames);
      changed = true;
      notice = `已安装 ${snapshot.installedNames.length} 个 Maestro Flow Hook · 等待审查信任`;
      uiState = {
        ...action.uiState,
        selectedNames: snapshot.installedNames,
        custom: snapshot.installedPreset === "custom",
        ...(snapshot.installedPreset === "custom" ? {} : { basePreset: snapshot.installedPreset }),
      };
    } catch (error) {
      notice = `安装失败 · ${sanitizeHookDisplayText(errorMessage(error))}`;
    } finally {
      ctx.ui.setStatus("maestro-hook-installer", undefined);
    }
  }
}

async function openInstallerOverlay(
  ctx: ExtensionContext,
  snapshot: Awaited<ReturnType<MaestroHookInstallerStore["load"]>>,
  initialState: Partial<MaestroHookInstallerUiState>,
  notice: string | undefined,
): Promise<MaestroHookInstallerAction> {
  return ctx.ui.custom<MaestroHookInstallerAction>((tui, theme, _keybindings, done) =>
    new MaestroHookInstallerOverlay({
      snapshot,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
