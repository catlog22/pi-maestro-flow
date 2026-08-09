import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "../tui/locale.ts";
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

const CATALOGS = {
  en: {
    "notice.noneInstalled": "No Maestro Flow Hooks are installed",
    "confirm.uninstallTitle": "Uninstall Maestro Flow Hooks?",
    "confirm.uninstallDetail": "Config: {path}\nOnly {count} Maestro entries will be removed; other Hooks remain unchanged.",
    "notice.uninstallCancelled": "Uninstall cancelled",
    "status.uninstalling": "Hooks · uninstalling…",
    "notice.uninstalled": "Maestro Flow Hooks uninstalled · other Hooks preserved",
    "notice.uninstallFailed": "Uninstall failed · {message}",
    "confirm.installTitle": "Install Maestro Flow Hooks?",
    "confirm.config": "Config: {path}",
    "confirm.installCount": "Will install: {count} Hooks",
    "confirm.preserveCount": "Preserve: {count} non-Maestro Hooks",
    "confirm.hashWarning": "Installation changes the config hash; review and trust it again afterward.",
    "notice.installCancelled": "Installation cancelled",
    "status.installing": "Hooks · installing…",
    "notice.installed": "Installed {count} Maestro Flow Hooks · awaiting review and trust",
    "notice.installFailed": "Installation failed · {message}",
  },
  "zh-CN": {
    "notice.noneInstalled": "没有已安装的 Maestro Flow Hook",
    "confirm.uninstallTitle": "卸载 Maestro Flow Hooks？",
    "confirm.uninstallDetail": "配置：{path}\n仅移除 {count} 个 Maestro 条目；其他 Hook 保持不变。",
    "notice.uninstallCancelled": "已取消卸载",
    "status.uninstalling": "Hooks · 正在卸载…",
    "notice.uninstalled": "已卸载 Maestro Flow Hooks · 其他 Hook 已保留",
    "notice.uninstallFailed": "卸载失败 · {message}",
    "confirm.installTitle": "安装 Maestro Flow Hooks？",
    "confirm.config": "配置：{path}",
    "confirm.installCount": "将安装：{count} 个 Hook",
    "confirm.preserveCount": "保留：{count} 个非 Maestro Hook",
    "confirm.hashWarning": "安装会改变配置 hash，完成后必须重新审查并信任。",
    "notice.installCancelled": "已取消安装",
    "status.installing": "Hooks · 正在安装…",
    "notice.installed": "已安装 {count} 个 Maestro Flow Hook · 等待审查信任",
    "notice.installFailed": "安装失败 · {message}",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

function translate(
  locale: SupportedSettingsLocale,
  key: CatalogKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export async function runMaestroHookInstaller(
  ctx: ExtensionContext,
  store = new MaestroHookInstallerStore(ctx.cwd),
  explicitLocale?: SupportedSettingsLocale,
): Promise<MaestroHookInstallerResult> {
  const locale = getTuiLocale(explicitLocale);
  const t = (key: CatalogKey, vars?: Readonly<Record<string, string | number>>): string => translate(locale, key, vars);
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
    const action = await openInstallerOverlay(ctx, snapshot, uiState, notice, locale);
    uiState = action.uiState;
    if (action.kind === "close") return { changed };

    if (action.kind === "uninstall" || action.uiState.selectedNames.length === 0) {
      if (snapshot.installedNames.length === 0) {
        notice = t("notice.noneInstalled");
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        t("confirm.uninstallTitle"),
        t("confirm.uninstallDetail", {
          path: sanitizeHookDisplayText(snapshot.configPath),
          count: snapshot.installedNames.length,
        }),
      );
      if (!confirmed) {
        notice = t("notice.uninstallCancelled");
        continue;
      }
      ctx.ui.setStatus("maestro-hook-installer", t("status.uninstalling"));
      try {
        snapshot = await store.uninstall();
        changed = true;
        notice = t("notice.uninstalled");
        uiState = {
          ...action.uiState,
          selectedNames: [],
          basePreset: "none",
          custom: false,
        };
      } catch (error) {
        notice = t("notice.uninstallFailed", { message: sanitizeHookDisplayText(errorMessage(error)) });
      } finally {
        ctx.ui.setStatus("maestro-hook-installer", undefined);
      }
      continue;
    }

    const confirmed = await ctx.ui.confirm(
      t("confirm.installTitle"),
      [
        t("confirm.config", { path: sanitizeHookDisplayText(snapshot.configPath) }),
        t("confirm.installCount", { count: action.uiState.selectedNames.length }),
        t("confirm.preserveCount", { count: snapshot.thirdPartyHandlers }),
        t("confirm.hashWarning"),
      ].join("\n"),
    );
    if (!confirmed) {
      notice = t("notice.installCancelled");
      continue;
    }

    ctx.ui.setStatus("maestro-hook-installer", t("status.installing"));
    try {
      snapshot = await store.apply(action.uiState.selectedNames);
      changed = true;
      notice = t("notice.installed", { count: snapshot.installedNames.length });
      uiState = {
        ...action.uiState,
        selectedNames: snapshot.installedNames,
        custom: snapshot.installedPreset === "custom",
        ...(snapshot.installedPreset === "custom" ? {} : { basePreset: snapshot.installedPreset }),
      };
    } catch (error) {
      notice = t("notice.installFailed", { message: sanitizeHookDisplayText(errorMessage(error)) });
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
  locale: SupportedSettingsLocale,
): Promise<MaestroHookInstallerAction> {
  return ctx.ui.custom<MaestroHookInstallerAction>((tui, theme, _keybindings, done) =>
    new MaestroHookInstallerOverlay({
      snapshot,
      theme,
      notice,
      initialState,
      locale,
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
