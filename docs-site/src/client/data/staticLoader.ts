// ---------------------------------------------------------------------------
// staticLoader — Vite-based static file loader for markdown guide content
// Uses import.meta.glob to load all guide files at build time
// ---------------------------------------------------------------------------

export interface GuideContent {
  slug: string;
  title: string;
  description: string;
  title_zh?: string;
  description_zh?: string;
  icon: string;
  rawContent: string;
}

// Guide category definitions
export interface GuideCategory {
  id: string;
  title: string;
  title_zh: string;
  description: string;
  description_zh: string;
}

export const guideCategories: GuideCategory[] = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    title_zh: '入门上手',
    description: 'Install, first workflow, and core concepts',
    description_zh: '安装、第一个工作流、核心概念',
  },
  {
    id: 'core',
    title: 'Core Features',
    title_zh: '核心功能',
    description: 'Parallel dispatch, goals, plans, tasks, shell, and cockpit',
    description_zh: '并行调度、目标、计划、任务、Shell、可视化',
  },
  {
    id: 'orchestration',
    title: 'Orchestration',
    title_zh: '编排调度',
    description: 'Agents, permissions, knowledge, hooks, and model routing',
    description_zh: 'Agent 角色、权限、知识、Hook、模型路由',
  },
  {
    id: 'connectivity',
    title: 'Connectivity & Tools',
    title_zh: '连接与工具',
    description: 'MCP, LSP, browser control, and web search',
    description_zh: 'MCP、LSP、浏览器控制、网络搜索',
  },
  {
    id: 'configuration',
    title: 'Configuration Reference',
    title_zh: '配置参考',
    description: 'Detailed settings, providers, and environment variables',
    description_zh: '详细功能配置说明 — 设置、Provider、环境变量',
  },
  {
    id: 'changelog',
    title: 'Changelog',
    title_zh: '版本更新',
    description: 'Release highlights, behavior changes, fixes, and upgrade notes',
    description_zh: '版本亮点、行为变化、问题修复与升级说明',
  },
];

// Guide registry — bilingual metadata for each guide.
// file = Chinese content (default), file_en = English content (optional)
export const guideRegistry: Array<{
  slug: string;
  file: string;
  file_en?: string;
  title: string;
  description: string;
  title_zh: string;
  description_zh: string;
  icon: string;
  category: string;
}> = [
  // ─── Getting Started ───────────────────────────────────────────────────────
  {
    slug: 'quick-start',
    file: 'quick-start.md',
    title: 'Quick Start',
    description: 'Get started in 10 minutes — install, first task, key concepts',
    title_zh: '10 分钟快速入门',
    description_zh: '安装 → 第一个任务 → 核心概念，最短路径上手',
    icon: 'rocket',
    category: 'getting-started',
  },
  {
    slug: 'install',
    file: 'install.md',
    title: 'Install & Setup',
    description: 'Prerequisites, plugin install, upgrade, and verification',
    title_zh: '安装与初始化',
    description_zh: '前置条件、插件安装、升级迁移、验证步骤',
    icon: 'download',
    category: 'getting-started',
  },
  {
    slug: 'architecture',
    file: 'architecture.md',
    title: 'Architecture & Concepts',
    description: 'Flow / Teammate / Cockpit three layers, tool surface, and lifecycle',
    title_zh: '架构与核心概念',
    description_zh: 'Flow / Teammate / Cockpit 三层、工具面、生命周期',
    icon: 'layers',
    category: 'getting-started',
  },
  // ─── Core Features ─────────────────────────────────────────────────────────
  {
    slug: 'teammate-dispatch',
    file: 'teammate-dispatch.md',
    title: 'Parallel Multi-Agent Dispatch',
    description: 'teammate tool — single task, parallel fan-out, DAG dependencies, structured output',
    title_zh: '并行多智能体调度',
    description_zh: 'teammate 工具 — 单任务、并行扇出、DAG 依赖、结构化输出',
    icon: 'shuffle',
    category: 'core',
  },
  {
    slug: 'goal-plan-todo',
    file: 'goal-plan-todo.md',
    title: 'Goals · Plans · Tasks',
    description: 'goal long-running objectives, plan-before-act mode, and todo task tracking',
    title_zh: 'Goal 目标 · Plan 计划 · todo 任务',
    description_zh: 'goal 长时目标、plan 先批准再动手、todo 任务分解跟踪',
    icon: 'compass',
    category: 'core',
  },
  {
    slug: 'bash-bg-observe',
    file: 'bash-bg-observe.md',
    title: 'bash_bg & observe',
    description: 'Adaptive shell with auto-backgrounding and three-state blocking observation',
    title_zh: 'bash_bg 自适应 Shell 与 observe 观察',
    description_zh: '长命令自动转后台 + status/wait/watch 三态阻塞观察',
    icon: 'terminal',
    category: 'core',
  },
  {
    slug: 'cockpit',
    file: 'cockpit.md',
    title: 'Pi Cockpit Visualization',
    description: 'Real-time status stack, Starship-style footer, themes, quiet mode, terminal titles',
    title_zh: 'Pi Cockpit 可视化',
    description_zh: '实时状态堆栈、Footer、9 套主题、Quiet 模式、终端标题',
    icon: 'palette',
    category: 'core',
  },
  {
    slug: 'mailbox-session',
    file: 'mailbox-session.md',
    title: 'Mailbox & Session Export',
    description: 'Workspace-isolated persistent message queue and session context export',
    title_zh: 'Mailbox 消息队列与会话导出',
    description_zh: '工作区级持久消息队列、冷恢复同步、会话上下文导出',
    icon: 'send',
    category: 'core',
  },
  // ─── Orchestration ─────────────────────────────────────────────────────────
  {
    slug: 'agents',
    file: 'agents.md',
    title: 'Agent Role System',
    description: '7 built-in + 25 project roles, custom roles, and per-task thinking depth',
    title_zh: 'Agent 角色体系',
    description_zh: '7 内置 + 25 项目级角色、自定义角色、逐任务思考深度',
    icon: 'users',
    category: 'orchestration',
  },
  {
    slug: 'advisor',
    file: 'advisor.md',
    title: 'Advisor Turn-Level Supervision',
    description: 'Background second-model review for turn quality, constraints, and corrective guidance',
    title_zh: 'Advisor 逐轮监督',
    description_zh: '后台第二模型检查主会话质量、约束遵循与方向风险',
    icon: 'shield-check',
    category: 'orchestration',
  },
  {
    slug: 'monitor',
    file: 'monitor.md',
    file_en: 'monitor.en.md',
    title: 'Monitor Cross-Session Supervision',
    description: 'Supervise peer windows, detect stalls and drift, intervene, resume, and inspect metrics',
    title_zh: 'Monitor 跨会话监督',
    description_zh: '监督工作区窗口，检测停滞与偏航，自动干预、恢复并查看指标',
    icon: 'bar-chart-2',
    category: 'orchestration',
  },
  {
    slug: 'self-evolve',
    file: 'self-evolve.md',
    file_en: 'self-evolve.en.md',
    title: 'Self-Evolve Knowledge Automation',
    description: 'Turn runtime traces into governed knowledge candidates with review, health, canary, and proposal flows',
    title_zh: 'Self-Evolve 自进化',
    description_zh: '把运行轨迹转为受治理的知识候选，支持评审、健康检查、canary 与提案流程',
    icon: 'sparkles',
    category: 'orchestration',
  },
  {
    slug: 'permissions',
    file: 'permissions.md',
    title: 'Permission System',
    description: 'Five modes from YOLO to deny, fine-grained allow/ask/deny rules, IPC relay',
    title_zh: '权限系统',
    description_zh: '默认 YOLO 等 5 种模式、细粒度 allow/ask/deny、子进程权限中继',
    icon: 'shield',
    category: 'orchestration',
  },
  {
    slug: 'knowledge',
    file: 'knowledge.md',
    title: 'Knowledge System',
    description: 'Semantic search, spec/knowhow lifecycle, and the mandatory knowledge gate',
    title_zh: '知识系统',
    description_zh: '语义搜索、Spec 规范与 Knowhow 经验沉淀、强制知识门',
    icon: 'brain',
    category: 'orchestration',
  },
  {
    slug: 'model-routing',
    file: 'model-routing.md',
    title: 'Model Routing & Thinking Depth',
    description: 'Per-task model override, thinking levels off→xhigh, and routing precedence',
    title_zh: '模型路由与思考深度',
    description_zh: '逐任务模型覆盖、思考深度 off→xhigh、路由优先级',
    icon: 'sliders',
    category: 'orchestration',
  },
  {
    slug: 'hooks-keybindings',
    file: 'hooks-keybindings.md',
    title: 'Hooks & Keybindings',
    description: 'Project-level hook automation and Shift+Tab conflict detection & repair',
    title_zh: 'Hooks 自动化与快捷键',
    description_zh: '项目级钩子系统、内置安装器、快捷键冲突自动修复',
    icon: 'hook',
    category: 'orchestration',
  },
  // ─── Connectivity & Tools ──────────────────────────────────────────────────
  {
    slug: 'mcp',
    file: 'mcp.md',
    title: 'MCP Integration',
    description: 'Client with OAuth auto-auth, transports, server manager, and lifecycle leases',
    title_zh: 'MCP 集成',
    description_zh: '客户端（含 OAuth 自动认证）、传输协议、服务器管理、生命周期租约',
    icon: 'link',
    category: 'connectivity',
  },
  {
    slug: 'lsp-browser',
    file: 'lsp-browser.md',
    title: 'LSP & Browser Control',
    description: 'Language server diagnostics/definitions and Chromium CDP control',
    title_zh: 'LSP 语言服务器与浏览器控制',
    description_zh: 'LSP 诊断/定义/引用，Chromium CDP 浏览器控制',
    icon: 'workflow',
    category: 'connectivity',
  },
  {
    slug: 'smart-search',
    file: 'smart-search.md',
    title: 'Web Search & Research',
    description: 'smart_search search/research/fetch modes with dual-path fallback',
    title_zh: '网络搜索与深度研究',
    description_zh: 'smart_search 搜索/研究/抓取三模式，双路径自动降级',
    icon: 'search',
    category: 'connectivity',
  },
  // ─── Configuration Reference ───────────────────────────────────────────────
  {
    slug: 'settings-overview',
    file: 'settings-overview.md',
    title: 'Settings System Overview',
    description: 'Versioned settings providers, global/project scopes, and /settings UI',
    title_zh: '设置系统总览',
    description_zh: '版本化设置契约、全局/项目双作用域、设置界面与持久化',
    icon: 'settings',
    category: 'configuration',
  },
  {
    slug: 'tui-guide',
    file: 'tui-guide.md',
    title: 'TUI Operations Guide',
    description: 'Keymaps and workflows for every terminal UI — settings, API manager, failover, search, MCP, hooks',
    title_zh: 'TUI 操作指南',
    description_zh: '全部终端 UI 的按键与操作流程 — 设置、API Manager、故障转移、搜索、MCP、Hooks',
    icon: 'key',
    category: 'configuration',
  },
  {
    slug: 'api-provider-config',
    file: 'api-provider-config.md',
    title: 'API Provider & Failover',
    description: 'Custom providers, model editor, circuit breaker, and failover configuration',
    title_zh: 'API Provider 与模型故障转移',
    description_zh: '自定义 Provider、模型编辑器、熔断器、故障转移配置',
    icon: 'key',
    category: 'configuration',
  },
  {
    slug: 'compaction-config',
    file: 'compaction-config.md',
    title: 'Compaction Capacity Management',
    description: 'Hard/soft compaction thresholds, reserve tokens, link derivation, dedup',
    title_zh: 'Compaction 容量管理',
    description_zh: '硬/软压缩阈值、Token 预留、链接阈值推导、去重',
    icon: 'gauge',
    category: 'configuration',
  },
  {
    slug: 'vision-config',
    file: 'vision-config.md',
    title: 'Vision Multimodal Delegation',
    description: 'describe_image delegation, fallback models, cache, timeout, and retries',
    title_zh: 'Vision 多模态委托',
    description_zh: 'describe_image 委托、回退模型、缓存、超时与重试',
    icon: 'eye',
    category: 'configuration',
  },
  {
    slug: 'smart-search-provider-config',
    file: 'smart-search-provider-config.md',
    title: 'Smart Search Provider Config',
    description: 'Dual-path architecture, provider API keys, credential syntax, TUI operations',
    title_zh: 'Smart Search Provider 配置',
    description_zh: '双路径架构、Provider API Key、凭证源语法、TUI 操作',
    icon: 'cpu',
    category: 'configuration',
  },
  {
    slug: 'env-vars',
    file: 'env-vars.md',
    title: 'Environment Variables',
    description: 'Quick reference of every environment variable consumed by the suite',
    title_zh: '环境变量速查',
    description_zh: '套件读取的全部环境变量速查表',
    icon: 'terminal',
    category: 'configuration',
  },
  // ─── Changelog ────────────────────────────────────────────────────────────
  {
    slug: 'changelog',
    file: 'changelog.md',
    file_en: 'changelog.en.md',
    title: 'Changelog',
    description: 'Detailed release highlights, behavior changes, fixes, and upgrade notes',
    title_zh: '版本更新日志',
    description_zh: '从上一版本到当前版本的详细功能、行为、修复与升级说明',
    icon: 'refresh-cw',
    category: 'changelog',
  },
];

// Use import.meta.glob to load all guide markdown files at build time
const guideModules = import.meta.glob('/src/content/docs/guides/*.md', { query: '?raw', import: 'default' });

/**
 * Load a single guide by slug, with locale-aware file selection.
 * For 'en' locale: tries file_en first, falls back to file (Chinese).
 * For 'zh-CN' locale: uses file directly.
 */
export async function loadGuide(slug: string, locale: string = 'zh-CN'): Promise<GuideContent | null> {
  const entry = guideRegistry.find((g) => g.slug === slug);
  if (!entry) return null;

  const isEn = locale === 'en';

  // Locale-aware fallback chain:
  //   en: guides/{file_en} → guides/{file} (zh)
  //   zh: guides/{file} → guides/{file_en} (en-only graceful degradation)
  let finalLoader: (() => Promise<unknown>) | undefined;
  if (isEn && entry.file_en) {
    const enPath = `/src/content/docs/guides/${entry.file_en}`;
    finalLoader = guideModules[enPath] || guideModules[enPath.replace(/^\//, '')];
  }
  if (!finalLoader) {
    const zhPath = `/src/content/docs/guides/${entry.file}`;
    finalLoader = guideModules[zhPath] || guideModules[zhPath.replace(/^\//, '')];
  }
  if (!finalLoader && entry.file_en) {
    const enOnlyPath = `/src/content/docs/guides/${entry.file_en}`;
    finalLoader = guideModules[enOnlyPath] || guideModules[enOnlyPath.replace(/^\//, '')];
  }

  if (!finalLoader) return null;

  try {
    const markdown = await finalLoader() as string;
    return {
      slug: entry.slug,
      title: entry.title,
      description: entry.description,
      title_zh: entry.title_zh,
      description_zh: entry.description_zh,
      icon: entry.icon,
      rawContent: markdown,
    };
  } catch {
    return null;
  }
}

/**
 * Get all guide metadata (without loading full content)
 */
export function getAllGuideMeta() {
  return guideRegistry;
}
