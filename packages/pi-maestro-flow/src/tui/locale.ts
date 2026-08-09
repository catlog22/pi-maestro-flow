import {
  SETTINGS_LOCALE_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  detectSystemSettingsLocale,
  resolveSettingsLocale,
  type SettingsLocaleEventV1,
  type SupportedSettingsLocale,
  type SystemSettingsLocaleOptions,
} from "pi-maestro-settings-core/v1";

export interface TuiLocaleEventBus {
  on(event: string, handler: (payload: unknown) => void): void | (() => void);
}

const FLOW_TUI_CATALOGS = {
  en: {
    "surface.needTui": "{surface} requires interactive TUI mode.",
    "compaction.opening": "Opening compaction settings…",
    "failover.opening": "Opening model failover settings…",
    "response.opening": "Switching Agent response language…",
    "response.zh": "Switched Agent replies to Chinese",
    "response.default": "Switched Agent replies to the default language",
    "skills.opening": "Opening Skill Manager…",
    "skills.reload": "Skill changes will apply after the extension reloads.",
    "mcp.opening": "Opening MCP Manager…",
    "mcp.unavailable": "MCP adapter is unavailable.",
    "hooks.opening": "Opening Hooks Manager…",
  },
  "zh-CN": {
    "surface.needTui": "{surface} 需要交互式 TUI。",
    "compaction.opening": "打开压缩设置…",
    "failover.opening": "打开模型故障转移设置…",
    "response.opening": "切换 Agent 回复语言…",
    "response.zh": "已切换到中文回复",
    "response.default": "已切换到默认回复语言",
    "skills.opening": "打开 Skill 管理器…",
    "skills.reload": "Skill 更改将在扩展重载后生效。",
    "mcp.opening": "打开 MCP 管理器…",
    "mcp.unavailable": "MCP 适配器不可用。",
    "hooks.opening": "打开 Hooks 管理器…",
  },
} as const;

export type FlowTuiCatalogKey = keyof (typeof FLOW_TUI_CATALOGS)["en"];

export class RuntimeTuiLocale {
  private locale: SupportedSettingsLocale;

  constructor(system: SystemSettingsLocaleOptions = {}) {
    this.locale = detectSystemSettingsLocale(system);
  }

  get current(): SupportedSettingsLocale {
    return this.locale;
  }

  resolve(explicit?: string | null): SupportedSettingsLocale {
    return explicit === undefined || explicit === null
      ? this.locale
      : resolveSettingsLocale(explicit);
  }

  updateFromEvent(payload: unknown): payload is SettingsLocaleEventV1 {
    if (!isSettingsLocaleEvent(payload)) return false;
    this.locale = resolveSettingsLocale(payload.locale);
    return true;
  }

  bind(events: TuiLocaleEventBus): () => void {
    const result = events.on(SETTINGS_LOCALE_EVENT, (payload) => {
      this.updateFromEvent(payload);
    });
    return () => { if (typeof result === "function") result(); };
  }
}

const runtimeTuiLocale = new RuntimeTuiLocale();

export function getTuiLocale(explicit?: string | null): SupportedSettingsLocale {
  return runtimeTuiLocale.resolve(explicit);
}

export function flowTuiText(
  key: FlowTuiCatalogKey,
  vars?: Readonly<Record<string, string | number>>,
  explicitLocale?: string | null,
): string {
  const locale = getTuiLocale(explicitLocale);
  const template = FLOW_TUI_CATALOGS[locale]?.[key] ?? FLOW_TUI_CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export function registerTuiLocaleEvents(events: TuiLocaleEventBus | undefined): () => void {
  if (!events || typeof events.on !== "function") return () => undefined;
  return runtimeTuiLocale.bind(events);
}

function isSettingsLocaleEvent(payload: unknown): payload is SettingsLocaleEventV1 {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = payload as Partial<SettingsLocaleEventV1>;
  return event.version === SETTINGS_PROTOCOL_VERSION
    && (event.locale === "en" || event.locale === "zh-CN")
    && typeof event.generation === "string"
    && event.generation.trim().length > 0;
}
