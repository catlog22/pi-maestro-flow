import { useEffect, useId, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// TuiSimulator — interactive HTML replicas of the pi-maestro-flow terminal UIs.
// Faithful to the real keymaps and config items (sourced from the plugin code).
// These are visual/interactive mockups, NOT the real terminal TUIs.
// ---------------------------------------------------------------------------

export type TuiEditor = 'boolean' | 'enum' | 'integer' | 'number' | 'string' | 'json' | 'action' | 'list' | 'overview';

export interface TuiItem {
  key: string;
  label: string;
  editor: TuiEditor;
  value: unknown;
  options?: string[];
  min?: number;
  max?: number;
  scope?: 'global' | 'project' | 'both';
  badge?: { text: string; tone?: 'blue' | 'green' | 'yellow' | 'red' | 'gray' };
  checked?: boolean;
}

interface SimPreset {
  title: string;
  footer: string;
  dirtyFooter?: string;
  layout: 'list' | 'panes' | 'grid';
  rightLabel?: string;
  items: TuiItem[];
  rightItems?: TuiItem[];
  grid?: Array<{ name: string; colors: string[] }>;
  showScope?: boolean;
  notes?: string[];
}

// ─── 各面板配置数据（与插件源码一致）────────────────────────────────────────

const THEME_GRID = [
  { name: 'notion', colors: ['#ffffff', '#f7f8fa', '#e1e4e8', '#0366d6'] },
  { name: 'github-dark', colors: ['#0d1117', '#161b22', '#30363d', '#58a6ff'] },
  { name: 'dracula', colors: ['#282a36', '#44475a', '#6272a4', '#bd93f9'] },
  { name: 'nord', colors: ['#2e3440', '#3b4252', '#4c566a', '#88c0d0'] },
  { name: 'solarized-dark', colors: ['#002b36', '#073642', '#586e75', '#268bd2'] },
  { name: 'gruvbox-dark', colors: ['#282828', '#3c3836', '#665c54', '#b8bb26'] },
  { name: 'ayu-dark', colors: ['#0f1419', '#131721', '#253340', '#e6b450'] },
  { name: 'one-dark', colors: ['#282c34', '#2c313a', '#3e4451', '#61afef'] },
  { name: 'monokai', colors: ['#272822', '#383830', '#49483e', '#a6e22e'] },
];

const PRESETS: Record<string, SimPreset> = {
  settings: {
    title: '● 设置面板 · Esc 关闭',
    footer: '←→ 插件 · ↑↓ 设置 · Tab 范围 · Enter 修改 · Space 开关 · Ctrl+S 应用 · Esc 关闭',
    dirtyFooter: '←→ 插件 · ↑↓ 设置 · Tab 范围 · Enter 修改 · Space 开关 · Ctrl+S 应用 · 再次 Esc 放弃',
    layout: 'list',
    showScope: true,
    items: [
      { key: 'compaction.enabled', label: 'Compaction 总开关', editor: 'boolean', value: true, scope: 'both' },
      { key: 'compaction.reserveTokens', label: '响应预留 Token', editor: 'integer', value: 16384, scope: 'both' },
      { key: 'compaction.keepRecentTokens', label: '保留近期 Token', editor: 'integer', value: 20000, scope: 'both' },
      { key: 'compaction.model', label: '压缩摘要模型', editor: 'string', value: '（跟随会话模型）', scope: 'both' },
      { key: 'compaction.soft.enabled', label: '软压缩开关', editor: 'boolean', value: true, scope: 'both' },
      { key: 'compaction.soft.nudgeRatio', label: '提示压缩满度比', editor: 'number', value: 0.7, scope: 'both' },
      { key: 'compaction.soft.pruneRatio', label: '开始修剪满度比', editor: 'number', value: 0.8, scope: 'both' },
      { key: 'compaction.soft.lossless.enabled', label: '无损格式折叠', editor: 'boolean', value: true, scope: 'both' },
      { key: 'failover.enabled', label: '模型故障转移', editor: 'boolean', value: false, scope: 'both' },
      { key: 'failover.fallbackModels', label: '备用模型链', editor: 'json', value: {}, scope: 'both' },
      { key: 'compaction.manage', label: '管理 Compaction', editor: 'action', value: '打开压缩 TUI', scope: 'project' },
      { key: 'failover.manage', label: '管理故障转移', editor: 'action', value: '打开故障转移 TUI', scope: 'project' },
      { key: 'responseLanguage.manage', label: '响应语言', editor: 'enum', value: 'default', options: ['default', 'zh-CN'], scope: 'project' },
      { key: 'permissions.manage', label: '权限设置', editor: 'action', value: '打开权限 TUI', scope: 'project' },
      { key: 'skills.manage', label: '技能管理', editor: 'action', value: '打开技能 TUI', scope: 'project' },
      { key: 'mcp.manage', label: 'MCP 管理', editor: 'action', value: '打开 MCP TUI', scope: 'project' },
      { key: 'hooks.manage', label: 'Hooks 管理', editor: 'action', value: '打开 Hooks TUI', scope: 'project' },
    ],
  },
  cockpit: {
    title: '● Cockpit 设置 · Esc 关闭',
    footer: '↑↓ 选择 · Enter 编辑 · 输入保存 · 清空恢复默认 · Esc 关闭',
    dirtyFooter: '↑↓ 选择 · Enter 编辑 · 输入保存 · 清空恢复默认 · 再次 Esc 放弃',
    layout: 'list',
    items: [
      { key: 'enabled', label: '启用 Cockpit', editor: 'boolean', value: true },
      { key: 'quietMode', label: 'Quiet 模式（压缩工具输出/折叠思考）', editor: 'boolean', value: false },
      { key: 'quietSymbols', label: 'Quiet 字形', editor: 'enum', value: 'check', options: ['check', 'dot'] },
      { key: 'toolPalette', label: '工具调色板', editor: 'enum', value: 'classic', options: ['classic', 'family', 'readwrite', 'search', 'mono'] },
      { key: 'agentsMode', label: 'Agent 列表密度', editor: 'enum', value: 'list', options: ['list', 'compact'] },
      { key: 'todoMode', label: 'Todo 列表密度', editor: 'enum', value: 'list', options: ['list', 'compact'] },
      { key: 'todoExpanded', label: 'Todo 默认展开', editor: 'boolean', value: false },
      { key: 'hideNativeAgents', label: '隐藏原生 Agent 组件', editor: 'boolean', value: true },
      { key: 'sidebar.mode', label: '侧栏模式', editor: 'enum', value: 'auto', options: ['auto', 'on', 'off'] },
      { key: 'sidebar.width', label: '侧栏宽度', editor: 'integer', value: 40, min: 32, max: 56 },
      { key: 'sidebar.density', label: '侧栏密度', editor: 'enum', value: 'comfortable', options: ['comfortable', 'compact'] },
      { key: 'icons.mode', label: '图标模式', editor: 'enum', value: 'auto', options: ['auto', 'nerd', 'ascii'] },
      { key: 'title.enabled', label: '终端标题', editor: 'boolean', value: true },
      { key: 'title.generationModel', label: '标题生成模型', editor: 'string', value: '（规则提取）' },
      { key: 'theme', label: '主题覆盖', editor: 'action', value: '打开 /theme 选择器' },
    ],
  },
  api: {
    title: '● API Manager · Esc 关闭',
    footer: '↑↓/Tab 选择 · Enter 编辑 · ←→/Space 切换 · Ctrl+S 继续 · Esc 取消',
    dirtyFooter: '↑↓/Tab 选择 · Enter 编辑 · ←→/Space 切换 · Ctrl+S 继续 · 再次 Esc 放弃',
    layout: 'list',
    items: [
      { key: 'maestro-openai', label: 'OpenAI Responses', editor: 'string', value: 'gpt-5.4 · 400K ctx', badge: { text: '启用', tone: 'green' } },
      { key: 'maestro-qwen', label: 'Qwen Max Preview', editor: 'string', value: 'qwen3.8-max · vision', badge: { text: '启用', tone: 'green' } },
      { key: 'maestro-deepseek', label: 'DeepSeek V4 Flash', editor: 'string', value: 'deepseek-v4-flash', badge: { text: '停用', tone: 'gray' } },
      { key: 'custom-relay', label: '自定义中继', editor: 'string', value: 'baseUrl · modelId', badge: { text: '启用', tone: 'green' } },
      { key: 'retry.enabled', label: 'API 重试', editor: 'boolean', value: true },
      { key: 'retry.maxRetries', label: '最大重试次数', editor: 'integer', value: 12, min: 0, max: 12 },
      { key: 'effort', label: '默认思考级别', editor: 'enum', value: 'medium', options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
  failover: {
    title: '● 模型故障转移 · Esc 关闭',
    footer: 'Esc 关闭 · E 启停 · Tab/←→ 分栏 · ↑↓ 选择 · Space 增删 · Ctrl+↑↓ 排序 · Ctrl+S 保存',
    dirtyFooter: 'Esc 关闭 · E 启停 · Tab/←→ 分栏 · ↑↓ 选择 · Space 增删 · Ctrl+↑↓ 排序 · Ctrl+S 保存 · 再次 Esc 放弃',
    layout: 'panes',
    rightLabel: '备用链',
    items: [
      { key: 'maestro-openai/gpt-5.6-sol', label: '主模型', editor: 'action', value: '启用', badge: { text: '熔断: 正常', tone: 'green' } },
      { key: 'maestro-openai/gpt-5.6-luna', label: '候选', editor: 'action', value: '备用', badge: { text: '熔断: 正常', tone: 'green' } },
      { key: 'maestro-qwen/qwen3.8-max-preview', label: '候选', editor: 'action', value: '备用', badge: { text: '熔断: 正常', tone: 'green' } },
      { key: 'maestro-deepseek/deepseek-v4-flash', label: '候选', editor: 'action', value: '备用', badge: { text: '熔断: 正常', tone: 'green' } },
    ],
    rightItems: [
      { key: 'fallback[1]', label: '→ maestro-openai/gpt-5.6-luna', editor: 'action', value: 'Space 移除' },
      { key: 'fallback[2]', label: '→ maestro-qwen/qwen3.8-max-preview', editor: 'action', value: 'Space 移除' },
    ],
  },
  smartsearch: {
    title: '● Smart Search 配置 · Esc 关闭',
    footer: '输入筛选 · PgUp/PgDn · Enter 编辑 · Tab 来源 · Ctrl+S 同步 · Esc',
    dirtyFooter: '输入筛选 · PgUp/PgDn · Enter 编辑 · Tab 来源 · Ctrl+S 同步 · 再次 Esc 放弃',
    layout: 'list',
    items: [
      { key: 'PERPLEXITY_API_KEY', label: 'Perplexity', editor: 'string', value: 'pplx-••••', badge: { text: '✓ synced', tone: 'green' } },
      { key: 'EXA_API_KEY', label: 'Exa（零配置）', editor: 'string', value: 'MCP 代理', badge: { text: '✓ synced', tone: 'green' } },
      { key: 'BRAVE_API_KEY', label: 'Brave', editor: 'string', value: 'BSA-••••', badge: { text: '→ smart-only', tone: 'yellow' } },
      { key: 'GEMINI_API_KEY', label: 'Gemini', editor: 'string', value: 'AIza••••', badge: { text: '✓ synced', tone: 'green' } },
      { key: 'SEARXNG_BASE_URL', label: 'SearXNG（自托管）', editor: 'string', value: 'https://search.example.com', badge: { text: '← web-only', tone: 'gray' } },
      { key: 'VALIDATION_LEVEL', label: '验证级别', editor: 'enum', value: 'balanced', options: ['fast', 'balanced', 'strict'] },
      { key: 'FALLBACK_MODE', label: '降级模式', editor: 'enum', value: 'auto', options: ['auto', 'off'] },
      { key: 'SSRF_ALLOW_RANGES', label: 'SSRF 白名单', editor: 'string', value: '198.18.0.0/16,…' },
    ],
  },
  mcp: {
    title: '● MCP 管理器 · Esc 关闭',
    footer: '↑↓ 选择 · Enter 选中/认证 · Ctrl+A 认证 · Ctrl+R 重载 · Ctrl+S 保存 · Esc',
    dirtyFooter: '↑↓ 选择 · Enter 选中/认证 · Ctrl+A 认证 · Ctrl+R 重载 · Ctrl+S 保存 · 再次 Esc 放弃',
    layout: 'list',
    items: [
      { key: 'github-mcp', label: 'GitHub MCP · stdio', editor: 'action', value: '已连接', badge: { text: '● 启用', tone: 'green' } },
      { key: 'server-a', label: 'OAuth 服务器 · Streamable HTTP', editor: 'action', value: '未认证', badge: { text: 'OAuth', tone: 'yellow' } },
      { key: 'filesystem', label: '文件系统 · stdio', editor: 'action', value: '已连接', badge: { text: '● 启用', tone: 'green' } },
      { key: 'legacy-ss', label: '旧服务器 · SSE', editor: 'action', value: '停用', badge: { text: '○ 停用', tone: 'gray' } },
    ],
  },
  hooks: {
    title: '● Hooks 安装器 · Esc 关闭',
    footer: '↑↓ 选择 · / 筛选 · Space 勾选 · A 应用 · U 卸载 · Esc',
    dirtyFooter: '↑↓ 选择 · / 筛选 · Space 勾选 · A 应用 · U 卸载 · 再次 Esc 放弃',
    layout: 'list',
    items: [
      { key: 'spec-injector', label: '规范注入 · PreToolUse', editor: 'action', value: '', checked: true, badge: { text: 'standard', tone: 'blue' } },
      { key: 'preflight-guard', label: '前置检查 · PreToolUse', editor: 'action', value: '', checked: true, badge: { text: 'standard', tone: 'blue' } },
      { key: 'spec-validator', label: '规范校验 · PostToolUse', editor: 'action', value: '', checked: false, badge: { text: 'advanced', tone: 'yellow' } },
      { key: 'delegate-monitor', label: '委派监控 · AgentLifecycle', editor: 'action', value: '', checked: false, badge: { text: 'advanced', tone: 'yellow' } },
      { key: 'team-monitor', label: '团队监控 · AgentLifecycle', editor: 'action', value: '', checked: false, badge: { text: 'advanced', tone: 'yellow' } },
      { key: 'session-context', label: '会话上下文 · PreToolUse', editor: 'action', value: '', checked: true, badge: { text: 'standard', tone: 'blue' } },
      { key: 'kg-sync', label: '知识库同步 · AgentLifecycle', editor: 'action', value: '', checked: false, badge: { text: 'advanced', tone: 'yellow' } },
      { key: 'prompt-guard', label: '提示守卫 · PreToolUse', editor: 'action', value: '', checked: false, badge: { text: 'advanced', tone: 'yellow' } },
    ],
  },
  routing: {
    title: '● 模型映射 · Esc 关闭',
    footer: '↑↓ 选择 · Enter 编辑映射 · 输入筛选 · Esc',
    layout: 'list',
    items: [
      { key: 'explore', label: '代码探索', editor: 'string', value: 'auto / gpt-5.6-sol' },
      { key: 'analysis', label: '技术分析', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'debug', label: '调试', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'planning', label: '规划', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'development', label: '开发', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'review', label: '评审', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'testing', label: '测试', editor: 'string', value: 'qwen3.8-max-preview' },
      { key: 'verification', label: '验证', editor: 'string', value: '（无回退）' },
      { key: 'custom-review', label: '自定义类型', editor: 'string', value: '新增映射…' },
    ],
  },
  bgjobs: {
    title: '● 后台任务 · Alt+J 关闭',
    footer: '↑↓ 选择 · Enter 查看输出 · Esc 关闭',
    layout: 'list',
    items: [
      { key: 'bg-3', label: 'npm run test:e2e', editor: 'action', value: '2m 14s', badge: { text: '● 运行中', tone: 'green' } },
      { key: 'bg-2', label: 'npm run dev', editor: 'action', value: '持续运行', badge: { text: '● 运行中', tone: 'green' } },
      { key: 'bg-1', label: 'npm run build', editor: 'action', value: '38s', badge: { text: '✓ 完成', tone: 'green' } },
      { key: 'bg-4', label: 'curl health check', editor: 'action', value: '3s', badge: { text: '✗ 失败', tone: 'red' } },
    ],
  },
  theme: {
    title: '● 主题选择 · Esc 取消',
    footer: '↑↓ 选择 · ←→ 预览 · Enter 应用 · Esc 取消（恢复原主题）',
    layout: 'grid',
    items: [],
    grid: THEME_GRID,
  },
};

// ─── 渲染辅助 ──────────────────────────────────────────────────────────────

function formatValue(item: TuiItem, editing: boolean, draft: string): string {
  if (editing) return draft;
  if (item.editor === 'boolean') return String(item.value) === 'true' ? '● 开' : '○ 关';
  if (item.editor === 'json') return JSON.stringify(item.value);
  return String(item.value);
}

function editorHint(item: TuiItem): string {
  switch (item.editor) {
    case 'boolean': return '[bool]';
    case 'enum': return `[${(item.options ?? []).join('|')}]`;
    case 'integer': return `[int${item.min != null ? ` ${item.min}-${item.max ?? ''}` : ''}]`;
    case 'number': return '[num]';
    case 'string': return '[text]';
    case 'json': return '[json]';
    case 'action': return '[action]';
    case 'list': return '[list]';
    case 'overview': return '[view]';
    default: return '';
  }
}

const BADGE_TONES: Record<string, string> = {
  green: 'bg-[#0d3320] text-[#3fb950]',
  yellow: 'bg-[#332b00] text-[#d29922]',
  red: 'bg-[#3d1112] text-[#f85149]',
  blue: 'bg-[#0c2d6b] text-[#58a6ff]',
  gray: 'bg-[#21262d] text-[#8b949e]',
};

// 同一页面多个模拟器共存时，仅"激活"（最后点击/聚焦）的那个响应键盘。
let ACTIVE_SIM: string | null = null;
function claimActive(id: string) {
  ACTIVE_SIM = id;
}

// ─── 主组件 ────────────────────────────────────────────────────────────────

export function TuiSimulator({ preset = 'settings' }: { preset?: string }) {
  const config = PRESETS[preset] ?? PRESETS.settings;
  const simId = useId();
  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<'left' | 'right'>('left');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [dirty, setDirty] = useState(false);
  const [closed, setClosed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');

  const items = useMemo(() => {
    const list = config.layout === 'panes' && pane === 'right' ? config.rightItems ?? [] : config.items;
    if (!filter) return list;
    const q = filter.toLowerCase();
    return list.filter((it) => `${it.key} ${it.label}`.toLowerCase().includes(q));
  }, [config, pane, filter]);

  const current = items[Math.min(selected, items.length - 1)];

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(''), 2600);
  };

  useEffect(() => {
    setSelected(0);
    setEditing(null);
    setDraft('');
  }, [preset, pane]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closed) return;
      if (ACTIVE_SIM !== simId) return;   // 仅激活的模拟器响应键盘
      const k = e.key;
      const meta = e.ctrlKey || e.metaKey;
      e.preventDefault();

      // 全局保存/语言
      if (meta && (k === 's' || k === 'S')) { setDirty(false); flash('✓ 已保存（模拟）'); return; }
      if (meta && (k === 'l' || k === 'L') && config.showScope) { flash('已切换界面语言（模拟）'); return; }
      if (meta && (k === 'a' || k === 'A') && preset === 'mcp') { flash('[server-a] 启动 OAuth 认证流程…（模拟）'); return; }
      if (meta && (k === 'r' || k === 'R') && preset === 'mcp') { flash('重载 MCP 元数据…（模拟）'); return; }

      // Esc
      if (k === 'Escape') {
        if (editing) { setEditing(null); setDraft(''); return; }
        if (filter) { setFilter(''); flash('已清除筛选'); return; }
        if (dirty) { setDirty(false); flash('已放弃未应用修改'); return; }
        setClosed(true);
        return;
      }
      // 编辑态
      if (editing) {
        if (k === 'Enter') { setEditing(null); setDirty(true); flash(`已修改 ${editing}（模拟）`); return; }
        if (k === 'Backspace') { setDraft((d) => d.slice(0, -1)); return; }
        if (meta && (k === 'u' || k === 'U')) { setDraft(''); return; }
        if (k.length === 1) { setDraft((d) => d + k); return; }
        return;
      }
      // 列表态
      if (preset === 'theme') {
        if (k === 'ArrowUp' || k === 'ArrowDown') { setSelected((s) => Math.max(0, Math.min(THEME_GRID.length - 1, s + (k === 'ArrowDown' ? 1 : -1)))); return; }
        if (k === 'Enter') { setDirty(false); flash(`已应用主题 ${THEME_GRID[selected].name}（模拟）`); return; }
        return;
      }
      if (preset === 'failover' && (k === 'Tab' || k === 'ArrowLeft' || k === 'ArrowRight')) {
        setPane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (preset === 'failover' && (k === 'e' || k === 'E')) { setDirty(true); flash('已切换自动故障转移（模拟）'); return; }
      if (preset === 'failover' && meta && (k === 'ArrowUp' || k === 'ArrowDown') && pane === 'right') { flash('已调整备用链顺序（模拟）'); return; }
      if (preset === 'hooks' && (k === 'a' || k === 'A')) { setDirty(true); flash('已应用所选钩子（模拟）'); return; }
      if (preset === 'hooks' && (k === 'u' || k === 'U')) { setDirty(true); flash('已卸载选中钩子（模拟）'); return; }
      if (k === '/') { setFilter(''); flash('筛选模式：输入名称/事件/级别…'); return; }

      switch (k) {
        case 'ArrowUp': setSelected((s) => Math.max(0, s - 1)); break;
        case 'ArrowDown': setSelected((s) => Math.min(Math.max(items.length - 1, 0), s + 1)); break;
        case 'ArrowLeft': if (preset === 'settings') setPluginFlip(-1); break;
        case 'ArrowRight': if (preset === 'settings') setPluginFlip(1); break;
        case 'Tab': if (config.showScope) setScope((s) => (s === 'global' ? 'project' : 'global')); else if (preset === 'smartsearch') flash('已切换配置源（Smart Search ↔ web-search.json）（模拟）'); break;
        case ' ':
        case 'Spacebar': {
          if (!current) break;
          if (current.editor === 'boolean') { setDirty(true); flash(`已切换 ${current.label}（模拟）`); }
          else if (preset === 'hooks') { flash(`已${current.checked ? '取消' : '勾选'} ${current.key}（模拟）`); }
          else if (preset === 'failover' && pane === 'right') { flash('已增删备用链成员（模拟）'); }
          else flash('Space 仅对布尔/勾选项生效（模拟）');
          break;
        }
        case 'Enter': {
          if (!current) break;
          if (current.editor === 'boolean') { setDirty(true); flash(`已切换 ${current.label}（模拟）`); }
          else if (current.editor === 'enum') { setDirty(true); flash(`已切换到下一个选项（模拟）`); }
          else if (current.editor === 'integer' || current.editor === 'string' || current.editor === 'json' || current.editor === 'number') {
            setEditing(current.key); setDraft(String(current.value));
          }
          else if (current.editor === 'action') {
            if (preset === 'mcp') flash(`[${current.key}] ${current.badge?.text === 'OAuth' ? '启动 OAuth 认证…' : '连接/查看详情'}（模拟）`);
            else if (preset === 'bgjobs') flash(`[${current.key}] 查看输出尾部…（模拟）`);
            else flash(`[${current.label}] 在真实终端打开外部 TUI…`);
          }
          else if (current.editor === 'overview') flash(`[${current.label}] 只读诊断视图`);
          break;
        }
        default:
          if (k.length === 1) { setFilter((f) => f + k); flash(`筛选：${filter + k}`); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closed, editing, dirty, current, items, filter, config, preset, pane, scope, simId]);

  const setPluginFlip = (dir: number) => {
    flash(dir > 0 ? '已切换插件（模拟）' : '已切换插件（模拟）');
  };

  if (closed) {
    return (
      <div className="my-[var(--spacing-4)] rounded-[var(--radius-lg)] border border-border overflow-hidden">
        <div className="flex items-center justify-between px-[var(--spacing-4)] py-[var(--spacing-3)] bg-[#0d1117]">
          <span className="text-[length:13px] text-[#8b949e] font-mono">{config.title.replace('· Esc 关闭', '（已关闭）')}</span>
          <button
            type="button"
            onClick={() => setClosed(false)}
            className="text-[length:12px] px-[var(--spacing-3)] py-[var(--spacing-1)] rounded bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d]"
          >
            重新打开
          </button>
        </div>
      </div>
    );
  }

  const showScopeDot = (item: TuiItem) => {
    if (!config.showScope || !item.scope) return false;
    return scope === 'global' ? item.scope !== 'project' : item.scope !== 'global';
  };

  return (
    <div
      className="my-[var(--spacing-4)] rounded-[var(--radius-lg)] border border-[#30363d] overflow-hidden bg-[#0d1117] font-mono text-[13px] leading-[1.6] select-none"
      role="application"
      aria-label={`${preset} 面板交互模拟器`}
      tabIndex={0}
      onClick={() => claimActive(simId)}
      onFocus={() => claimActive(simId)}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] text-[#8b949e]">
        <span>{config.title}</span>
        {config.showScope && <span className="text-[#58a6ff]">{scope === 'global' ? '[global 全局]' : '[project 项目]'}</span>}
        <span>{dirty ? '✎ 未应用' : '✓ 已应用'}</span>
      </div>

      {/* failover 双分栏头 */}
      {config.layout === 'panes' && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[#30363d] text-[12px]">
          <button type="button" onClick={() => setPane('left')} className={['px-2 py-0.5 rounded', pane === 'left' ? 'bg-[#1f6feb] text-white' : 'text-[#8b949e] hover:bg-[#21262d]'].join(' ')}>
            {config.title.includes('故障') ? '模型列表' : '左栏'}
          </button>
          <span className="text-[#8b949e]">↔</span>
          <button type="button" onClick={() => setPane('right')} className={['px-2 py-0.5 rounded', pane === 'right' ? 'bg-[#1f6feb] text-white' : 'text-[#8b949e] hover:bg-[#21262d]'].join(' ')}>
            {config.rightLabel ?? '右栏'}
          </button>
          {preset === 'failover' && <span className="ml-auto text-[#8b949e]">E 启停 · Tab/←→ 分栏</span>}
        </div>
      )}

      {/* 主题网格 */}
      {config.layout === 'grid' && config.grid && (
        <div className="grid grid-cols-3 gap-2 p-3">
          {config.grid.map((t, i) => (
            <button
              key={t.name}
              type="button"
              onClick={() => setSelected(i)}
              onDoubleClick={() => flash(`已应用主题 ${t.name}（模拟）`)}
              className={['text-left p-2 rounded border transition-colors', i === selected ? 'border-[#1f6feb] bg-[#161b22]' : 'border-[#30363d] hover:border-[#8b949e]'].join(' ')}
            >
              <div className="flex gap-1 mb-1">
                {t.colors.slice(0, 4).map((c, ci) => (
                  <span key={ci} className="flex-1 h-3 rounded-sm" style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className={`text-[12px] ${i === selected ? 'text-[#58a6ff]' : 'text-[#c9d1d9]'}`}>{t.name}</div>
            </button>
          ))}
        </div>
      )}

      {/* 列表 */}
      {config.layout !== 'grid' && (
        <div className="px-2 py-1">
          {items.length === 0 && <div className="px-2 py-3 text-[#8b949e]">无匹配项（模拟）</div>}
          {items.map((item, i) => {
            const isSel = i === selected;
            const isEditing = editing === item.key;
            const active = isSel || isEditing;
            return (
              <div
                key={`${item.key}-${i}`}
                onClick={() => { setSelected(i); }}
                onDoubleClick={() => {
                  setSelected(i);
                  if (item.editor === 'integer' || item.editor === 'string' || item.editor === 'json' || item.editor === 'number') {
                    setEditing(item.key); setDraft(String(item.value));
                  } else if (item.editor === 'boolean') { setDirty(true); flash(`已切换 ${item.label}（模拟）`); }
                }}
                className={[
                  'flex items-center gap-2 px-2 py-[3px] rounded cursor-pointer whitespace-nowrap',
                  active ? 'bg-[#1f6feb] text-white' : 'text-[#c9d1d9] hover:bg-[#161b22]',
                ].join(' ')}
              >
                <span className={isSel ? 'text-white' : 'text-transparent'}>›</span>
                {preset === 'hooks' && (
                  <span className={item.checked ? 'text-[#3fb950]' : 'text-[#6e7681]'}>{item.checked ? '☑' : '☐'}</span>
                )}
                <span className={isEditing ? 'text-[#ffd33d]' : ''}>{item.key}</span>
                <span className={active ? 'text-white/70' : 'text-[#8b949e]'}>{item.label}</span>
                {item.badge && (
                  <span className={`px-1.5 py-[1px] rounded text-[10px] ${BADGE_TONES[item.badge.tone ?? 'gray']}`}>{item.badge.text}</span>
                )}
                <span className={active ? 'text-white/60' : 'text-[#6e7681]'}>{editorHint(item)}</span>
                <span className="ml-auto">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { setEditing(null); setDirty(true); }
                        if (e.key === 'Escape') { setEditing(null); setDraft(''); }
                        e.stopPropagation();
                      }}
                      className="bg-[#0d1117] border border-[#30363d] text-[#ffd33d] px-1 rounded outline-none"
                    />
                  ) : (
                    <span className={active ? 'text-[#3fb950]' : 'text-[#3fb950]/80'}>{formatValue(item, false, '')}</span>
                  )}
                </span>
                {showScopeDot(item) && (
                  <span className={active ? 'text-white/50' : 'text-[#6e7681]'} title="当前范围下可编辑">
                    {item.scope === 'both' ? '◐' : '●'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 通知行 */}
      <div className="px-3 py-1 text-[#ffd33d] min-h-[22px] border-t border-[#21262d]">
        {notice || '\u00a0'}
      </div>

      {/* 底部帮助行 */}
      <div className="px-3 py-1.5 bg-[#161b22] text-[#8b949e] text-[12px]">
        {dirty ? config.dirtyFooter ?? config.footer : config.footer}
      </div>
    </div>
  );
}
